// src/audit.ts
// 审计落盘：一天一个 audit-YYYY-MM-DD.jsonl（一行一个 JSON 对象）、审计窗每步读的 audit-live.tsv、
// 以及按策略保留的截图。契约见 docs/design/appearance.md：三个窗口读的同一批文件就在这里。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditDir, readAppearance, sharedDataDir } from './appearance.ts';
import { errorText } from './shared/faults.ts';

/** 审计里的一条：桌面一动作、或者一次工具调用。字段和 docs/design/appearance.md 里的 JSONL 一致。 */
export interface AuditEntry {
  at: Date; tool: string; action: string; app: string;
  exe?: string; title?: string;
  x?: number; y?: number; x2?: number; y2?: number;
  double?: boolean; right?: boolean; key?: string; modifiers?: number[];
  text?: string; direction?: string; seconds?: number;
  ok: boolean; result: string;
  /** 这一步为什么做：agent 给的优先，没给就读 activity.json 里最后一段思考。 */
  reason?: string;
  /** 这一步的截图；落不落盘由 appearance.auditLog.screenshots 决定。审计自己会把它存下来。 */
  image?: Buffer;
}

export interface AuditOptions {
  /** 覆盖 activity.json 里记的会话和回合（测试、或者宿主自己知道得更准时用）。 */
  session?: string; turn?: number;
  /** activity.json 的位置；默认 `EVOCU_ACTIVITY_FILE` 或 `~/.evolution-computer-use/activity.json`。 */
  activityFile?: string;
  /** 审计目录；默认 appearance 的 auditDir()（`EVOCU_AUDIT_DIR` 或 `~/.evolution-computer-use/audit`）。 */
  dir?: string;
  /** 写不进审计时说的话；审计永远不弄坏一次操作，所以它只记日志。 */
  log?(text: string): void;
}

export interface Audit {
  /** 记一条。写盘、存图、刷审计窗都失败也不会抛。 */
  record(entry: AuditEntry): void;
  /** 不再记了（进程要结束时调用；已经写的都留在盘上）。 */
  close(): void;
  /** 审计目录。 */
  dir(): string;
}

/** 桌面动作和工具调用都往这里记；turns 只看 screenshots() 决定要不要把图交给它。 */
export interface AuditSink { record(entry: AuditEntry): void; screenshots(): boolean }

/** 审计窗一次最多显示这么多行，最新的在最后。 */
const LIVE_ROWS = 40;
/** 原因最多留这么多字（契约如此）。 */
const REASON_CHARS = 500;
/** 结果也只留这么长：page_read 之类一次能给上万字，审计不该跟着涨。 */
const RESULT_CHARS = 1000;
/** activity.json 一秒最多读一次：一屏动作常常连着来。 */
const ACTIVITY_MS = 1000;
/** 保留策略最多一分钟跑一次，启动时先跑一次。 */
const CLEAN_MS = 60_000;
const DAY_MS = 86_400_000;
const LIVE_FILE = 'audit-live.tsv';
const SHOT_DIR = 'shots';

const DAY_NAME = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const SHOT_NAME = /^(\d{4})(\d{2})(\d{2})-\d{6}-\d{3}-\d+\.png$/;

/** activity.json 的读取视图：写侧是宿主插件，字段都可能缺失。 */
type Activity = { sessionId?: string; turn?: number | string; progress?: { reasoning?: string } };

/** audit-live.tsv 的一行。 */
interface LiveRow { at: string; ok: boolean; action: string; app: string; detail: string; reason: string; shot: string }

const two = (value: number) => String(value).padStart(2, '0');
const three = (value: number) => String(value).padStart(3, '0');

/** 本地打卡：HH:mm:ss。 */
function clock(at: Date): string {
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** 文件名里的时间戳：YYYYMMDD-HHmmss-SSS。 */
function stamp(at: Date): string {
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-${three(at.getMilliseconds())}`;
}

/** 契约要的是本地时间带偏移（+08:00），Date.toISOString 却是 UTC。 */
function localIso(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const size = Math.abs(offset);
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${three(at.getMilliseconds())}${sign}${two(Math.floor(size / 60))}:${two(size % 60)}`;
}

/** 一天一个文件，按本地时区分。 */
function dayFile(at: Date): string {
  return `audit-${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}.jsonl`;
}

const dayStart = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** 截图文件名里的日期；不是截图、或者名字不认识的，用它的 mtime。 */
function shotWhen(file: string, name: string): number {
  const match = SHOT_NAME.exec(name);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  try { return statSync(file).mtimeMs; } catch { return Date.now(); }
}

const DIRECTIONS: Record<string, string> = { up: '↑', down: '↓', left: '←', right: '→' };
const MODIFIERS: Record<string, string> = { ctrl: 'Ctrl', control: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win', meta: 'Win' };
/** 工具名到审计窗里的中文说法。 */
const TOOL_WORDS: Array<[string, string]> = [
  ['computer_use', '找操作'], ['page_open', '打开网址'], ['page_read', '读页面'], ['page_click', '点击页面'],
  ['page_type', '在页面输入'], ['page_press', '页面按键'], ['page_scroll', '滚动页面'], ['page_wait', '等待页面'],
  ['page_shot', '页面截图'], ['page_eval', '跑页面脚本'], ['procedure_run', '运行操作'], ['procedure_save', '保存操作'],
  ['procedure_note', '写目录说明'], ['procedure_routines', '跑例行操作'], ['inbox_read', '看信箱'], ['desktop_mode', '切换桌面模式'],
];

/** 按键写成 Ctrl+S 这样。 */
function pressed(key: string): string {
  const parts = key.split('+').map(part => part.trim()).filter(Boolean);
  const last = parts.pop() ?? '';
  const head = parts.map(part => MODIFIERS[part.toLowerCase()] ?? part).join('+');
  const tail = last.length === 1 ? last.toUpperCase() : last;
  return [head, tail].filter(Boolean).join('+');
}

const point = (x?: number, y?: number) => typeof x === 'number' && typeof y === 'number' ? ` (${x},${y})` : '';

/** 审计窗里的一行话说这一步是什么：点击 (412,238)、按键 Ctrl+S、输入 3 个字、滚动 ↓。 */
export function detailOf(entry: AuditEntry): string {
  switch (entry.action) {
    case 'click': return `${entry.double ? '双击' : entry.right ? '右键' : '点击'}${point(entry.x, entry.y)}`;
    case 'drag': return `拖动${point(entry.x, entry.y)}→(${entry.x2},${entry.y2})`;
    case 'type': {
      const count = [...(entry.text ?? '')].length;
      return count ? `输入 ${count} 个字` : '输入';
    }
    case 'press': return entry.key ? `按键 ${pressed(entry.key)}` : '按键';
    case 'scroll': return `滚动 ${DIRECTIONS[entry.direction ?? ''] ?? entry.direction ?? ''}`.trim();
    case 'move': return `移动鼠标${point(entry.x, entry.y)}`;
    case 'close': return entry.app ? `关闭 ${entry.app}` : '关闭';
    case 'open': return entry.app ? `打开 ${entry.app}` : '打开';
    case 'shot': return '截图';
    case 'zoom': return `放大${point(entry.x, entry.y)}→(${entry.x2},${entry.y2})`;
    case 'record': return typeof entry.seconds === 'number' && entry.seconds > 0 ? `录像 ${entry.seconds} 秒` : '录像';
    case 'review': return '看录好的';
    case 'stop': return '停止录像';
    default: break;
  }
  // 工具调用：action 是「工具名 参数」，这里翻成中文再说一遍。
  const [head, ...rest] = entry.action.split(' ');
  const word = TOOL_WORDS.find(([name]) => name === head)?.[1];
  const line = word ? [word, rest.join(' ')].filter(Boolean).join(' ') : entry.action;
  // 网址之类可以很长；审计窗一行放不下，截一下。
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/**
 * 审计：把 agent 在用户电脑上做的每一步写成文件，给另外两个窗口看。
 * 任何一步失败都只记日志——审计不能弄坏一次操作。
 */
export function createAudit(options: AuditOptions = {}): Audit {
  // 测试进程（node --test）不该往用户真实的审计目录里写：没人指定目录时退到临时目录。
  const testing = !options.dir?.trim() && !process.env.EVOCU_AUDIT_DIR?.trim() && !!process.env.NODE_TEST_CONTEXT;
  const root = options.dir?.trim() || (testing ? join(tmpdir(), `evocu-audit-test-${process.pid}`) : auditDir());
  const log = options.log ?? (() => {});
  const activityFile = options.activityFile?.trim() || process.env.EVOCU_ACTIVITY_FILE?.trim() || join(sharedDataDir(), 'activity.json');
  const livePath = join(root, LIVE_FILE);
  let live: LiveRow[] = [];
  let shots = 0;
  let lastClean = 0;
  let closed = false;
  let activity: { at: number; value: Activity | undefined } = { at: 0, value: undefined };

  /** 审计目录得在；建不出来就说一句，这一次不写。 */
  function ensure(): boolean {
    try { mkdirSync(root, { recursive: true }); return true; }
    catch (error) { log(`审计目录建不出来：${errorText(error)}`); return false; }
  }

  /** activity.json：一秒最多读一次，缺文件、正在写、不是 JSON 都不算错。 */
  function remember(): Activity | undefined {
    const now = Date.now();
    if (now - activity.at < ACTIVITY_MS) return activity.value;
    let value: Activity | undefined;
    try {
      const raw = readFileSync(activityFile, 'utf8').replace(/^\uFEFF/, '');
      if (raw.trim()) value = JSON.parse(raw) as Activity;
    } catch { /* 还没有，或者正写到一半 */ }
    activity = { at: now, value };
    return value;
  }

  /** agent 没说原因时，用 activity.json 里最后一段思考。 */
  function reasoning(): string | undefined {
    const text = remember()?.progress?.reasoning;
    if (typeof text !== 'string') return undefined;
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat ? flat.slice(0, REASON_CHARS) : undefined;
  }

  /** 会话、回合：先看调用方，再看 activity.json。 */
  function identity(): { session: string; turn: number } {
    const found = remember();
    const session = options.session?.trim() || (typeof found?.sessionId === 'string' ? found.sessionId : '');
    let turn = options.turn ?? 0;
    if (options.turn === undefined) {
      if (typeof found?.turn === 'number' && Number.isFinite(found.turn)) turn = found.turn;
      else if (typeof found?.turn === 'string' && found.turn.trim() && Number.isFinite(Number(found.turn))) turn = Number(found.turn);
    }
    return { session, turn };
  }

  /** 截图落到 shots/ 里，返回审计目录下的相对路径；存不下就空着，这一步照记。 */
  function keep(at: Date, image: Buffer): string {
    try {
      const dir = join(root, SHOT_DIR);
      mkdirSync(dir, { recursive: true });
      let name = `${stamp(at)}-${++shots}.png`;
      while (existsSync(join(dir, name))) name = `${stamp(at)}-${++shots}.png`;
      writeFileSync(join(dir, name), image);
      return `${SHOT_DIR}/${name}`;
    } catch (error) { log(`截图没存下来：${errorText(error)}`); return ''; }
  }

  /** 字段里不能有 tab 和换行，审计窗按 tab 分列。 */
  const cell = (value: unknown) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();

  /** 先写 .tmp 再 rename：审计窗永远读不到半行。 */
  function flush(): void {
    const tmp = `${livePath}.${process.pid}.tmp`;
    const body = live.map(row => [row.at, row.ok ? '1' : '0', row.action, row.app, row.detail, row.reason, row.shot].map(cell).join('\t')).join('\n');
    try {
      writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
      renameSync(tmp, livePath);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉也就算了 */ }
      log(`审计窗那一屏没写上：${errorText(error)}`);
    }
  }

  /** 启动时把上一次留下的行接上，窗口不至于空着。 */
  function loadLive(): void {
    try {
      live = readFileSync(livePath, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => {
        const cells = line.split('\t');
        while (cells.length < 7) cells.push('');
        const [at = '', ok = '', action = '', app = '', detail = '', reason = '', shot = ''] = cells;
        return { at, ok: ok.trim() === '1', action, app, detail, reason, shot };
      }).slice(-LIVE_ROWS);
    } catch { live = []; }
  }

  function list(dir: string): string[] {
    try { return readdirSync(dir); } catch { return []; }
  }

  function drop(file: string): void {
    try { rmSync(file, { force: true }); }
    catch (error) { log(`删不掉旧审计文件：${errorText(error)}`); }
  }

  /** retentionDays：过期的日文件和对应的截图都删掉（按文件名的日期，名字不认识就看 mtime）。 */
  function pruneDays(days: number): void {
    if (!(days > 0)) return;
    const cutoff = dayStart(new Date()) - (days - 1) * DAY_MS;
    for (const name of list(root)) {
      const match = DAY_NAME.exec(name);
      if (!match) continue;
      const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
      if (at < cutoff) drop(join(root, name));
    }
    const dir = join(root, SHOT_DIR);
    for (const name of list(dir)) {
      const file = join(dir, name);
      if (shotWhen(file, name) < cutoff) drop(file);
    }
  }

  /** maxScreenshotsMB：超了就从最旧的截图删。 */
  function pruneShots(megabytes: number): void {
    if (!(megabytes > 0)) return;
    const dir = join(root, SHOT_DIR);
    const files = list(dir).map(name => {
      const file = join(dir, name);
      let size = 0;
      try { size = statSync(file).size; } catch { /* 刚被删掉 */ }
      return { file, size, at: shotWhen(file, name) };
    }).sort((left, right) => left.at - right.at);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const limit = megabytes * 1024 * 1024;
    while (total > limit && files.length) {
      const oldest = files.shift()!;
      drop(oldest.file);
      total -= oldest.size;
    }
  }

  /** maxEntries：一天的行数超了就把最旧的丢掉，留最近的那些（先写 .tmp 再换上去）。 */
  function pruneEntries(kept: number): void {
    if (!(kept > 0)) return;
    for (const name of list(root)) {
      if (!DAY_NAME.test(name)) continue;
      const file = join(root, name);
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      if (lines.length <= kept) continue;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, `${lines.slice(-kept).join('\n')}\n`, 'utf8');
        renameSync(tmp, file);
      } catch (error) {
        try { rmSync(tmp, { force: true }); } catch { /* 同上 */ }
        log(`旧审计行没删掉：${errorText(error)}`);
      }
    }
  }

  /** 保留策略：启动一次，之后最多每分钟一次。 */
  function clean(): void {
    try {
      if (!ensure()) return;
      const settings = readAppearance().auditLog;
      pruneDays(settings.retentionDays);
      pruneShots(settings.maxScreenshotsMB);
      pruneEntries(settings.maxEntries);
    } catch (error) { log(`审计清理没做完：${errorText(error)}`); }
  }

  ensure();
  loadLive();
  lastClean = Date.now();
  clean();

  return {
    dir: () => root,
    record(entry: AuditEntry): void {
      if (closed) return;
      try {
        const settings = readAppearance().auditLog;
        if (!settings.enabled || !ensure()) return;
        const at = entry.at instanceof Date ? entry.at : new Date();
        const given = entry.reason?.trim();
        const reason = given ? given.replace(/\s+/g, ' ').trim().slice(0, REASON_CHARS) : reasoning();
        const shot = entry.image && settings.screenshots ? keep(at, entry.image) : '';
        const result = entry.result.length > RESULT_CHARS ? `${entry.result.slice(0, RESULT_CHARS)}…` : entry.result;
        const { session, turn } = identity();
        const line = {
          at: localIso(at), session, turn, tool: entry.tool, action: entry.action, app: entry.app,
          exe: entry.exe ?? '', title: entry.title ?? '',
          x: entry.x ?? null, y: entry.y ?? null, x2: entry.x2 ?? null, y2: entry.y2 ?? null,
          double: entry.double === true, right: entry.right === true,
          key: entry.key ?? '', modifiers: entry.modifiers ?? [], text: entry.text ?? '',
          direction: entry.direction ?? '', seconds: entry.seconds ?? 0,
          ok: entry.ok === true, result, reason: reason ?? '', shot,
        };
        try { appendFileSync(join(root, dayFile(at)), `${JSON.stringify(line)}\n`, 'utf8'); }
        catch (error) { log(`审计没写进去：${errorText(error)}`); }
        live.push({ at: clock(at), ok: entry.ok === true, action: entry.action, app: entry.app, detail: detailOf(entry), reason: reason ?? '', shot });
        if (live.length > LIVE_ROWS) live = live.slice(-LIVE_ROWS);
        flush();
        if (Date.now() - lastClean >= CLEAN_MS) { lastClean = Date.now(); clean(); }
      } catch (error) { log(`审计出错了：${errorText(error)}`); }
    },
    close(): void { closed = true; },
  };
}
