/**
 * 分层快速扫描。
 *
 * L0 读取已有索引并验活（exe 必须存在；只有 appId 的无法验活，视为有效），刷新 lastSeen。
 * L1 快速系统来源：运行 scripts/scan-apps.ps1（Get-StartApps / 开始菜单 lnk / App Paths / 卸载表）。
 * L2 增量 Program Files：按根目录 mtime 与 index.dirs 比较，未变且已记录就跳过；
 *    限制深度、时间预算和 exe 上限，跳过明显的非应用目录，过滤 unins、update、crash、helper 之类。
 * 最后按 exe/appId 去重合并（L1 名称优先，Program Files 只补缺），生成稳定 id 写入索引。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AppIndex, ScanOptions } from './types.ts';
import { loadIndex, saveIndex } from './store.ts';
import { dedupeCandidates, parseScanOutput, toEntry, type Candidate, type RawScanOutput } from './library.ts';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/scan-apps.ps1', import.meta.url));
const DEFAULT_BUDGET_MS = 12000;
const DEFAULT_MAX_EXE = 6000;
const MAX_DEPTH = 4;
const SCRIPT_TIMEOUT_MS = 20000;

/** 明显不是应用、且遍历很贵的目录。 */
const SKIP_DIRECTORIES = new Set([
  'windowsapps',
  'windows defender',
  'common files',
  'node_modules',
  'installer',
  '$recycle.bin',
  'windows',
  'winsxs',
  'servicing',
  'temp',
  'tmp',
  'cache',
  '.git',
]);

/** 明显是安装器/更新器/崩溃上报之类的 exe，不收。 */
const IGNORED_EXE = [
  /^unins/i,
  /^uninstall/i,
  /^update/i,
  /^updater/i,
  /^crash/i,
  /^helper/i,
  /^setup/i,
  /^install/i,
  /^vcredist/i,
  /^vc_redist/i,
  /^dxsetup/i,
  /^dotnet/i,
  /^notification_helper/i,
  /^elevate/i,
  /^createtemp/i,
];

function isSkippedDir(name: string): boolean {
  return SKIP_DIRECTORIES.has(name.toLowerCase());
}

function isIgnoredExe(name: string): boolean {
  const base = name.toLowerCase();
  return IGNORED_EXE.some((pattern) => pattern.test(base));
}

function safeExists(file: string): boolean {
  try { return existsSync(file); } catch { return false; }
}

function machineName(): string {
  try { return hostname(); } catch { return 'unknown'; }
}

/** 运行 scripts/scan-apps.ps1，返回它的 stdout；超时/非零退出抛错。 */
function runScanScript(): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('scan-apps.ps1 超时'));
    }, SCRIPT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error('scan-apps.ps1 退出码 ' + code + ': ' + stderr.slice(0, 500)));
    });
  });
}

/** 从脚本输出里截出第一个 { 到最后一个 } 之间的 JSON。 */
function parseJsonObject(text: string): RawScanOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('scan-apps.ps1 没有输出 JSON');
  return JSON.parse(text.slice(start, end + 1)) as RawScanOutput;
}

/** 默认 Program Files 根目录：存在才扫。 */
function defaultProgramRoots(): string[] {
  const roots = ['C:\\Program Files', 'C:\\Program Files (x86)'];
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  roots.push(join(local, 'Programs'));
  return roots.filter((root) => {
    try { return existsSync(root) && statSync(root).isDirectory(); } catch { return false; }
  });
}

interface RootScan {
  candidates: Candidate[];
  dirsScanned: number;
  exeFound: number;
  truncated: boolean;
}

/** 深度优先扫一个 Program Files 根目录，受时间预算和 exe 上限约束。 */
function scanProgramRoot(root: string, budgetMs: number, maxExe: number): RootScan {
  const result: RootScan = { candidates: [], dirsScanned: 0, exeFound: 0, truncated: false };
  const deadline = Date.now() + budgetMs;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    if (Date.now() > deadline) { result.truncated = true; break; }
    if (result.exeFound >= maxExe) { result.truncated = true; break; }
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    result.dirsScanned += 1;
    for (const entry of entries) {
      if (result.exeFound >= maxExe) { result.truncated = true; break; }
      if (Date.now() > deadline) { result.truncated = true; break; }
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH && !isSkippedDir(entry.name)) {
          stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
        }
      } else if (entry.isFile() && /\.exe$/i.test(entry.name) && !isIgnoredExe(entry.name)) {
        result.exeFound += 1;
        result.candidates.push({
          name: entry.name.replace(/\.exe$/i, ''),
          source: 'program-files',
          exe: join(current.dir, entry.name),
          installDir: current.dir,
        });
      }
    }
  }
  return result;
}

/** 把一条已有索引条目转回候选形态（供重新去重合并）。 */
function entryToCandidate(entry: {
  name: string;
  source: Candidate['source'];
  exe?: string;
  args?: string;
  appId?: string;
  installDir?: string;
  aliases?: string[];
}): Candidate {
  return {
    name: entry.name,
    source: entry.source,
    ...(entry.exe ? { exe: entry.exe } : {}),
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.appId ? { appId: entry.appId } : {}),
    ...(entry.installDir ? { installDir: entry.installDir } : {}),
    ...(entry.aliases && entry.aliases.length > 0 ? { aliases: [...entry.aliases] } : {}),
  };
}

/**
 * 执行分层扫描并写入索引，返回新的 AppIndex。
 * 任一来源失败都只记日志、不让整个扫描失败。
 */
export async function scanApps(options: ScanOptions): Promise<AppIndex> {
  const log = options.log ?? (() => {});
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();

  // L0：读取已有索引并验活。
  const previous = loadIndex(options.dataDir);
  const carriedCandidates: Candidate[] = [];
  if (previous) {
    for (const entry of previous.apps) {
      const alive = entry.exe ? safeExists(entry.exe) : true; // appId 无法验活，视为有效
      if (!alive) continue;
      carriedCandidates.push(entryToCandidate(entry));
    }
    log(`L0 读取索引：${previous.apps.length} 条，验活后保留 ${carriedCandidates.length} 条`);
  } else {
    log('L0 无已有索引');
  }

  // L1：快速系统来源。
  let l1Candidates: Candidate[] = [];
  try {
    const output = options.powershell ? await options.powershell() : await runScanScript();
    l1Candidates = parseScanOutput(parseJsonObject(output));
    log(`L1 系统来源：${l1Candidates.length} 条候选`);
  } catch (error) {
    log(`L1 扫描失败（继续）：${(error as Error).message}`);
  }

  // L2：增量 Program Files。
  const roots = options.programRoots ?? defaultProgramRoots();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxExe = options.maxExe ?? DEFAULT_MAX_EXE;
  const full = options.full === true;
  const dirs: Record<string, { mtimeMs: number; scannedAt: string }> = { ...(previous?.dirs ?? {}) };
  const pfCandidates: Candidate[] = [];
  let dirsScanned = 0;
  let exeFound = 0;
  let truncated = false;

  for (const root of roots) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(root).mtimeMs;
    } catch {
      continue;
    }
    const cached = previous?.dirs?.[root];
    if (!full && cached && cached.mtimeMs === mtimeMs) {
      log(`L2 ${root} 目录 mtime 未变，跳过`);
      continue;
    }
    const scanned = scanProgramRoot(root, budgetMs, maxExe);
    dirsScanned += scanned.dirsScanned;
    exeFound += scanned.exeFound;
    truncated = truncated || scanned.truncated;
    pfCandidates.push(...scanned.candidates);
    dirs[root] = { mtimeMs, scannedAt: new Date().toISOString() };
    log(
      `L2 ${root}: 扫 ${scanned.dirsScanned} 个目录，${scanned.exeFound} 个 exe` +
        (scanned.truncated ? '（预算用尽，已截断）' : ''),
    );
  }

  // 合并去重（L1 优先，Program Files 补缺，缓存条目兜底）。
  const merged = dedupeCandidates([...l1Candidates, ...pfCandidates, ...carriedCandidates]);
  const finishedAt = new Date().toISOString();
  const apps = merged.map((candidate) =>
    toEntry(candidate, candidate.exe ? safeExists(candidate.exe) : true, finishedAt),
  );

  const index: AppIndex = {
    version: 1,
    updatedAt: finishedAt,
    machine: machineName(),
    scan: {
      mode: full ? 'full' : 'incremental',
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedAtDate.getTime(),
      dirsScanned,
      exeFound,
      appEntries: apps.length,
    },
    apps,
    dirs,
  };

  saveIndex(options.dataDir, index);
  log(
    `写入索引：${apps.length} 条（L1 ${l1Candidates.length}，Program Files ${pfCandidates.length}，缓存 ${carriedCandidates.length}）` +
      (truncated ? '；Program Files 扫描被截断' : ''),
  );
  return index;
}
