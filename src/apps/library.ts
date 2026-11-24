/**
 * 纯函数：解析 scan-apps.ps1 的输出、合并去重、生成稳定 id、名称解析。
 * 这里不碰文件系统、不跑子进程，方便离线单测。
 */
import { createHash } from 'node:crypto';
import { win32 as pathWin32 } from 'node:path';
import type { AppEntry, AppIndex } from './types.ts';

/** 尚未定 exists/lastSeen/id 的候选记录（扫描阶段的中间形态）。 */
export type Candidate = Pick<AppEntry, 'name' | 'source'> &
  Partial<Pick<AppEntry, 'exe' | 'args' | 'appId' | 'installDir' | 'aliases'>>;

/** scan-apps.ps1 输出的 JSON 形状（字段可选，缺了就当空）。 */
export interface RawScanOutput {
  startApps?: { name?: string | null; appId?: string | null }[];
  startMenu?: { name?: string | null; target?: string | null; arguments?: string | null }[];
  appPaths?: { name?: string | null; exe?: string | null }[];
  uninstall?: { name?: string | null; displayIcon?: string | null; installLocation?: string | null }[];
}

/** 来源优先级：数字越小越可信；Program Files 只补缺。 */
const SOURCE_PRIORITY: Record<AppEntry['source'], number> = {
  'start-apps': 0,
  'start-menu': 1,
  'app-paths': 2,
  uninstall: 3,
  'program-files': 4,
};

/** 去首尾空格与引号；空串返回 undefined。 */
function clean(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim().replace(/^"|"$/g, '').trim();
  return text.length > 0 ? text : undefined;
}

/** 从 "C:\x\app.exe" 或 "C:\x\app.exe,0" 里取出 exe 路径；不是 .exe 返回 undefined。 */
export function exeFrom(value: unknown): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  const first = clean(cleaned.split(',')[0]);
  if (!first) return undefined;
  return /\.exe$/i.test(first) ? first : undefined;
}

/** Windows 路径的 basename 去 .exe；用于名称匹配。 */
export function basenameNoExt(file: string): string {
  return pathWin32.basename(file).replace(/\.exe$/i, '');
}

/** 大小写不敏感，忽略空格/连字符/下划线；中文原样保留。 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s\-_]+/g, '');
}

/** 稳定 id：exe 小写路径 sha1 前 16 位；否则 appId；否则 来源+名称。 */
export function candidateId(candidate: Candidate): string {
  const basis = candidate.exe
    ? `exe:${candidate.exe.toLowerCase()}`
    : candidate.appId
      ? `appid:${candidate.appId.toLowerCase()}`
      : `name:${candidate.source}:${candidate.name.toLowerCase()}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** 把 scan-apps.ps1 的 JSON 对象解析成候选数组（保持各来源顺序）。 */
export function parseScanOutput(raw: RawScanOutput): Candidate[] {
  const out: Candidate[] = [];
  for (const item of raw.startApps ?? []) {
    const name = clean(item.name);
    if (!name) continue;
    const appId = clean(item.appId);
    out.push({ name, source: 'start-apps', ...(appId ? { appId } : {}) });
  }
  for (const item of raw.startMenu ?? []) {
    const name = clean(item.name);
    if (!name) continue;
    const exe = exeFrom(item.target);
    const args = clean(item.arguments);
    out.push({
      name,
      source: 'start-menu',
      ...(exe ? { exe, installDir: pathWin32.dirname(exe) } : {}),
      ...(args ? { args } : {}),
    });
  }
  for (const item of raw.appPaths ?? []) {
    const exe = exeFrom(item.exe);
    const name = clean(item.name) ?? (exe ? basenameNoExt(exe) : undefined);
    if (!name) continue;
    out.push({ name, source: 'app-paths', ...(exe ? { exe, installDir: pathWin32.dirname(exe) } : {}) });
  }
  for (const item of raw.uninstall ?? []) {
    const name = clean(item.name);
    if (!name) continue;
    const exe = exeFrom(item.displayIcon);
    const installDir = clean(item.installLocation);
    out.push({
      name,
      source: 'uninstall',
      ...(exe ? { exe } : {}),
      ...(installDir ? { installDir } : {}),
    });
  }
  return out;
}

function hasExe(c: Candidate): boolean {
  return typeof c.exe === 'string' && c.exe.length > 0;
}

function dedupeKey(c: Candidate): string {
  if (hasExe(c)) return 'exe:' + c.exe!.toLowerCase();
  if (c.appId) return 'appid:' + c.appId.toLowerCase();
  return 'name:' + c.source + ':' + c.name.toLowerCase();
}

/** 把 other 里有而 winner 没有的字段补进 winner，并把不同名称收进 aliases。 */
function mergeInto(winner: Candidate, other: Candidate): void {
  if (!winner.exe && other.exe) winner.exe = other.exe;
  if (!winner.appId && other.appId) winner.appId = other.appId;
  if (!winner.args && other.args) winner.args = other.args;
  if (!winner.installDir && other.installDir) winner.installDir = other.installDir;
  const aliases = new Set(winner.aliases ?? []);
  if (other.name && normalizeName(other.name) !== normalizeName(winner.name)) aliases.add(other.name);
  for (const alias of other.aliases ?? []) aliases.add(alias);
  winner.aliases = [...aliases];
}

function pickWinner(group: { c: Candidate; index: number }[]): Candidate {
  const sorted = [...group].sort((a, b) => {
    const byPriority = SOURCE_PRIORITY[a.c.source] - SOURCE_PRIORITY[b.c.source];
    if (byPriority !== 0) return byPriority;
    const byExe = (hasExe(b.c) ? 1 : 0) - (hasExe(a.c) ? 1 : 0);
    if (byExe !== 0) return byExe;
    return a.index - b.index;
  });
  const winner = { ...sorted[0]!.c, aliases: sorted[0]!.c.aliases ? [...sorted[0]!.c.aliases] : undefined };
  for (let i = 1; i < sorted.length; i++) mergeInto(winner, sorted[i]!.c);
  return winner;
}

/**
 * 合并去重：先按 exe（小写）/appId 去重，再按规范化名称合并。
 * 同一组里按来源优先级、是否带 exe、出现顺序选胜者，其余只补字段/别名。
 */
export function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const items = candidates.map((c, index) => ({ c, index: index }));

  const groupBy = (keyFn: (c: Candidate) => string): Candidate[] => {
    const groups = new Map<string, { c: Candidate; index: number }[]>();
    for (const item of items) {
      const key = keyFn(item.c);
      const bucket = groups.get(key);
      if (bucket) bucket.push(item);
      else groups.set(key, [item]);
    }
    return [...groups.values()].map(pickWinner);
  };

  const byKey = groupBy(dedupeKey);
  const keyedItems = byKey.map((c, index) => ({ c, index: index }));
  const nameGroups = new Map<string, { c: Candidate; index: number }[]>();
  for (const item of keyedItems) {
    const key = 'name:' + normalizeName(item.c.name);
    const bucket = nameGroups.get(key);
    if (bucket) bucket.push(item);
    else nameGroups.set(key, [item]);
  }
  return [...nameGroups.values()].map(pickWinner);
}

/** 生成最终 AppEntry（补 id / exists / lastSeen）。 */
export function toEntry(candidate: Candidate, exists: boolean, lastSeen: string): AppEntry {
  const entry: AppEntry = {
    id: candidateId(candidate),
    name: candidate.name,
    source: candidate.source,
    lastSeen,
    exists,
  };
  if (candidate.exe) entry.exe = candidate.exe;
  if (candidate.args) entry.args = candidate.args;
  if (candidate.appId) entry.appId = candidate.appId;
  if (candidate.installDir) entry.installDir = candidate.installDir;
  if (candidate.aliases && candidate.aliases.length > 0) entry.aliases = [...candidate.aliases];
  return entry;
}

/** appId 里能当“显示名”用的片段：整体、'!' 后的入口、按 _ . ! 切出的词。 */
function appIdTokens(appId: string): string[] {
  const tokens = new Set<string>([normalizeName(appId)]);
  for (const part of appId.split(/[!_.]+/)) {
    const normalized = normalizeName(part);
    if (normalized.length > 2) tokens.add(normalized);
  }
  return [...tokens];
}

/**
 * 名称解析：大小写不敏感、忽略空格/连字符/下划线。
 * 依次匹配 name → exe 文件名（去 .exe）→ aliases → appId 的显示名，再做包含匹配。
 * 同一命中集合里优先返回 exists 的条目。
 */
export function resolveApp(name: string, index: AppIndex): AppEntry | undefined {
  const q = normalizeName(name);
  if (!q) return undefined;
  const apps = index.apps ?? [];
  const pick = (predicate: (entry: AppEntry) => boolean): AppEntry | undefined => {
    const matches = apps.filter(predicate);
    if (matches.length === 0) return undefined;
    return matches.find((entry) => entry.exists) ?? matches[0];
  };
  const exeBase = (entry: AppEntry): string => (entry.exe ? normalizeName(basenameNoExt(entry.exe)) : '');
  const aliasMatch = (entry: AppEntry): boolean => (entry.aliases ?? []).some((alias) => normalizeName(alias) === q);
  const appIdMatch = (entry: AppEntry): boolean => (entry.appId ? appIdTokens(entry.appId).includes(q) : false);

  return (
    pick((entry) => normalizeName(entry.name) === q) ??
    pick((entry) => exeBase(entry) === q) ??
    pick(aliasMatch) ??
    pick(appIdMatch) ??
    pick(
      (entry) =>
        normalizeName(entry.name).includes(q) ||
        exeBase(entry).includes(q) ||
        (entry.aliases ?? []).some((alias) => normalizeName(alias).includes(q)),
    )
  );
}
