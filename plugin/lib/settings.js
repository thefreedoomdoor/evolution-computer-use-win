/**
 * appearance.json / app-policies.json / 字体上传的纯逻辑与原子写入。
 *
 * 契约是 docs/design/appearance.md；这里的默认值和夹取范围与服务器侧
 * src/appearance.ts、src/policies.ts 逐一对应，保证插件写出去的文件就是
 * 服务器读到的规范值。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 三窗外观的完整默认值（与服务器 src/appearance.ts 的 DEFAULT_APPEARANCE 一致）。 */
export const DEFAULT_APPEARANCE = {
  version: 1,
  banner: {
    text: 'DSH正在操作{app}',
    hint: '连按两下 Esc 停下',
    stop: '停下',
    stopped: '已停下',
    width: 0,
    height: 38,
    opacity: 100,
    position: 'top-center',
    x: null,
    y: null,
    colors: {
      bg: '#EC181A20',
      text: '#F5F7FA',
      hint: '#969CA8',
      dot: '#408CFF',
      stopBg: '#22FFFFFF',
      stopText: '#F0F2F6',
      border: '#00000000',
    },
    fonts: {
      main: { family: 'Microsoft YaHei UI', size: 14, bold: true },
      hint: { family: 'Microsoft YaHei UI', size: 12.5, bold: false },
      stop: { family: 'Microsoft YaHei UI', size: 12.5, bold: false },
    },
    layout: { align: 'center', offsetX: 0, offsetY: 6, gap: 10, padding: 16 },
  },
  audit: {
    enabled: true,
    width: 420,
    height: 340,
    opacity: 88,
    locked: true,
    position: 'left-of-thought',
    x: null,
    y: null,
    colors: {
      bg: '#EB0B0D12',
      border: '#2A3140',
      text: '#E6EAF2',
      muted: '#8A93A3',
      accent: '#4ADE80',
      reason: '#C7B26B',
      shot: '#5B8DEF',
    },
    fonts: {
      title: { family: 'Microsoft YaHei UI', size: 13, bold: true },
      body: { family: 'Microsoft YaHei UI', size: 12.5, bold: false },
    },
    layout: { rows: 12, showTime: true, showReason: true, showThumb: false, padding: 12, gap: 6 },
  },
  thought: {
    width: 360,
    height: 240,
    opacity: 60,
    locked: true,
    position: 'top-right',
    x: null,
    y: null,
    colors: {
      bg: '#99191D26',
      border: '#75A1DA',
      text: '#F6F7FA',
      muted: '#B9C6D8',
      accent: '#5B8DEF',
    },
    fonts: {
      title: { family: 'Microsoft YaHei UI', size: 14, bold: true },
      body: { family: 'Microsoft YaHei UI', size: 14.667, bold: false },
    },
  },
  auditLog: { enabled: true, screenshots: true, retentionDays: 7, maxScreenshotsMB: 500, maxEntries: 5000 },
};

const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const obj = (value) => (isObj(value) ? value : {});
const text = (value, fallback, max = 200) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const num = (value, fallback, min, max) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const int = (value, fallback, min, max) => Math.round(num(value, fallback, min, max));
const color = (value, fallback) =>
  typeof value === 'string' && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value.toUpperCase() : fallback;
const oneOf = (value, options, fallback) =>
  typeof value === 'string' && options.includes(value) ? value : fallback;
/** 屏幕坐标：整数，-20000..20000（多显示器会有负坐标）；null 表示跟随自动布局。 */
const point = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(20000, Math.max(-20000, value))) : null;

/** 浅层递归合并普通对象（数组、标量一律覆盖），用于把局部补丁并进当前外观。 */
export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObj(value) && isObj(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function font(value, fallback) {
  const raw = obj(value);
  return {
    family: text(raw.family, fallback.family, 80),
    size: num(raw.size, fallback.size, 6, 72),
    bold: flag(raw.bold, fallback.bold),
  };
}

function banner(value) {
  const raw = obj(value), base = DEFAULT_APPEARANCE.banner;
  const colors = obj(raw.colors), layout = obj(raw.layout), fonts = obj(raw.fonts);
  return {
    text: text(raw.text, base.text, 120),
    hint: text(raw.hint, base.hint, 120),
    stop: text(raw.stop, base.stop, 40),
    stopped: text(raw.stopped, base.stopped, 40),
    width: int(raw.width, base.width, 0, 1600),
    height: int(raw.height, base.height, 28, 120),
    opacity: int(raw.opacity, base.opacity, 20, 100),
    position: oneOf(raw.position, ['top-left', 'top-center', 'top-right', 'custom'], base.position),
    x: point(raw.x),
    y: point(raw.y),
    colors: {
      bg: color(colors.bg, base.colors.bg),
      text: color(colors.text, base.colors.text),
      hint: color(colors.hint, base.colors.hint),
      dot: color(colors.dot, base.colors.dot),
      stopBg: color(colors.stopBg, base.colors.stopBg),
      stopText: color(colors.stopText, base.colors.stopText),
      border: color(colors.border, base.colors.border),
    },
    fonts: {
      main: font(fonts.main, base.fonts.main),
      hint: font(fonts.hint, base.fonts.hint),
      stop: font(fonts.stop, base.fonts.stop),
    },
    layout: {
      align: oneOf(layout.align, ['left', 'center', 'right'], base.layout.align),
      offsetX: int(layout.offsetX, base.layout.offsetX, -1000, 1000),
      offsetY: int(layout.offsetY, base.layout.offsetY, -200, 400),
      gap: int(layout.gap, base.layout.gap, 0, 60),
      padding: int(layout.padding, base.layout.padding, 0, 80),
    },
  };
}

function audit(value) {
  const raw = obj(value), base = DEFAULT_APPEARANCE.audit;
  const colors = obj(raw.colors), layout = obj(raw.layout), fonts = obj(raw.fonts);
  return {
    enabled: flag(raw.enabled, base.enabled),
    width: int(raw.width, base.width, 220, 1600),
    height: int(raw.height, base.height, 140, 1600),
    opacity: int(raw.opacity, base.opacity, 20, 100),
    locked: flag(raw.locked, base.locked),
    position: oneOf(
      raw.position,
      ['left-of-thought', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'],
      base.position
    ),
    x: point(raw.x),
    y: point(raw.y),
    colors: {
      bg: color(colors.bg, base.colors.bg),
      border: color(colors.border, base.colors.border),
      text: color(colors.text, base.colors.text),
      muted: color(colors.muted, base.colors.muted),
      accent: color(colors.accent, base.colors.accent),
      reason: color(colors.reason, base.colors.reason),
      shot: color(colors.shot, base.colors.shot),
    },
    fonts: {
      title: font(fonts.title, base.fonts.title),
      body: font(fonts.body, base.fonts.body),
    },
    layout: {
      rows: int(layout.rows, base.layout.rows, 3, 40),
      showTime: flag(layout.showTime, base.layout.showTime),
      showReason: flag(layout.showReason, base.layout.showReason),
      showThumb: flag(layout.showThumb, base.layout.showThumb),
      padding: int(layout.padding, base.layout.padding, 0, 60),
      gap: int(layout.gap, base.layout.gap, 0, 40),
    },
  };
}

function thought(value) {
  const raw = obj(value), base = DEFAULT_APPEARANCE.thought;
  const colors = obj(raw.colors), fonts = obj(raw.fonts);
  return {
    width: int(raw.width, base.width, 240, 1600),
    height: int(raw.height, base.height, 160, 1600),
    opacity: int(raw.opacity, base.opacity, 20, 100),
    locked: flag(raw.locked, base.locked),
    position: oneOf(raw.position, ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'], base.position),
    x: point(raw.x),
    y: point(raw.y),
    colors: {
      bg: color(colors.bg, base.colors.bg),
      border: color(colors.border, base.colors.border),
      text: color(colors.text, base.colors.text),
      muted: color(colors.muted, base.colors.muted),
      accent: color(colors.accent, base.colors.accent),
    },
    fonts: {
      title: font(fonts.title, base.fonts.title),
      body: font(fonts.body, base.fonts.body),
    },
  };
}

function auditLog(value) {
  const raw = obj(value), base = DEFAULT_APPEARANCE.auditLog;
  return {
    enabled: flag(raw.enabled, base.enabled),
    screenshots: flag(raw.screenshots, base.screenshots),
    retentionDays: int(raw.retentionDays, base.retentionDays, 1, 365),
    maxScreenshotsMB: int(raw.maxScreenshotsMB, base.maxScreenshotsMB, 20, 20000),
    maxEntries: int(raw.maxEntries, base.maxEntries, 100, 200000),
  };
}

/** 缺键、错类型、越界一律回默认并夹到范围内；返回完整、可直接写盘的对象。 */
export function parseAppearance(value) {
  const raw = obj(value);
  return {
    version: int(raw.version, DEFAULT_APPEARANCE.version, 1, 99),
    banner: banner(raw.banner),
    audit: audit(raw.audit),
    thought: thought(raw.thought),
    auditLog: auditLog(raw.auditLog),
  };
}

/** 把局部补丁并进当前外观再规范化。 */
export function mergeAppearance(current, patch) {
  return parseAppearance(deepMerge(parseAppearance(current), obj(patch)));
}

// ---------------------------------------------------------------------------
// 旧版 activity-settings.json（桌面模式页面的「浮窗设置」历史形状）
// ---------------------------------------------------------------------------

export const LEGACY_POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];

export const OVERLAY_DEFAULTS = {
  overlayEnabled: true,
  position: 'top-right',
  width: 360,
  height: 240,
  opacity: 60,
  locked: true,
};

const clamp = (value, min, max, fallback) => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** 旧版浮窗设置的白名单 + 夹取（POST /set 的 overlay 分支保持原语义）。 */
export function normalizeLegacyOverlay(input) {
  const source = isObj(input) ? input : {};
  return {
    overlayEnabled: source.overlayEnabled !== false,
    position: oneOf(source.position, LEGACY_POSITIONS, OVERLAY_DEFAULTS.position),
    width: clamp(source.width, 240, 1600, OVERLAY_DEFAULTS.width),
    height: clamp(source.height, 160, 1600, OVERLAY_DEFAULTS.height),
    opacity: clamp(source.opacity, 20, 100, OVERLAY_DEFAULTS.opacity),
    locked: source.locked !== false,
  };
}

/** 从 Config 默认值拼出旧版浮窗设置。 */
export function legacyOverlayFromConfig(config) {
  return normalizeLegacyOverlay({
    overlayEnabled: config?.overlayEnabled,
    position: config?.overlayPosition,
    width: config?.overlayWidth,
    height: config?.overlayHeight,
    opacity: config?.overlayOpacity,
    locked: config?.overlayLocked,
  });
}

/** appearance.thought -> 旧版浮窗形状（activity.mjs 和 /read 都还用这个形状）。 */
export function legacyOverlayFromAppearance(appearance, enabled) {
  const t = (appearance && appearance.thought) || DEFAULT_APPEARANCE.thought;
  return {
    overlayEnabled: enabled !== false,
    position: oneOf(t.position, [...LEGACY_POSITIONS, 'custom'], OVERLAY_DEFAULTS.position),
    width: clamp(t.width, 240, 1600, OVERLAY_DEFAULTS.width),
    height: clamp(t.height, 160, 1600, OVERLAY_DEFAULTS.height),
    opacity: clamp(t.opacity, 20, 100, OVERLAY_DEFAULTS.opacity),
    locked: t.locked !== false,
  };
}

/** 旧版浮窗设置写回 appearance.thought（/set 与首次迁移都用它）。 */
export function appearanceFromLegacyOverlay(appearance, overlay) {
  const next = normalizeLegacyOverlay(overlay);
  return mergeAppearance(appearance, {
    thought: {
      width: next.width,
      height: next.height,
      opacity: next.opacity,
      locked: next.locked,
      position: next.position,
    },
  });
}

// ---------------------------------------------------------------------------
// app-policies.json
// ---------------------------------------------------------------------------

export const POLICY_KINDS = ['exe', 'app', 'title'];
export const POLICY_MODES = ['foreground', 'background'];

/** 与服务器 src/policies.ts 的 parsePolicies 一致：先匹配先赢、按 kind:value 去重。 */
export function parsePolicies(value) {
  const raw = isObj(value) ? value : {};
  if (!Array.isArray(raw.apps)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw.apps) {
    if (!isObj(item)) continue;
    if (typeof item.match !== 'string') continue;
    const match = item.match.trim();
    const slash = match.indexOf(':');
    const kind = match.slice(0, slash).toLowerCase();
    const target = match.slice(slash + 1).trim();
    if (slash <= 0 || !target || !POLICY_KINDS.includes(kind)) continue;
    if (item.mode !== 'foreground' && item.mode !== 'background') continue;
    const key = kind + ':' + target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      match: kind + ':' + target,
      label:
        typeof item.label === 'string' && item.label.trim()
          ? item.label.trim().slice(0, 120)
          : target,
      mode: item.mode,
    });
  }
  return result;
}

/** 文件形状（version 固定 1）。 */
export function normalizePolicies(value) {
  return { version: 1, apps: parsePolicies(value) };
}

/**
 * 严格校验 POST /policies 的入参：形状必须对、每条都要能解析。
 * 返回 { ok: true, value } 或 { ok: false, message }。
 */
export function validatePoliciesPayload(body) {
  if (!isObj(body)) return { ok: false, message: '请求体必须是 JSON 对象' };
  if (!Array.isArray(body.apps)) return { ok: false, message: 'apps 必须是数组' };
  if (body.apps.length > 200) return { ok: false, message: '策略过多（最多 200 条）' };
  for (let index = 0; index < body.apps.length; index += 1) {
    const item = body.apps[index];
    if (!isObj(item)) return { ok: false, message: '第 ' + (index + 1) + ' 条策略必须是对象' };
    if (typeof item.match !== 'string') return { ok: false, message: '第 ' + (index + 1) + ' 条策略缺少 match' };
    const match = item.match.trim();
    const slash = match.indexOf(':');
    const kind = match.slice(0, slash).toLowerCase();
    const target = match.slice(slash + 1).trim();
    if (slash <= 0 || !target) return { ok: false, message: '第 ' + (index + 1) + ' 条策略的 match 需要 exe:/app:/title: 前缀' };
    if (!POLICY_KINDS.includes(kind)) return { ok: false, message: '第 ' + (index + 1) + ' 条策略的 match 前缀只能是 exe:/app:/title:' };
    if (!POLICY_MODES.includes(item.mode)) return { ok: false, message: '第 ' + (index + 1) + ' 条策略的 mode 只能是 foreground 或 background' };
    if (item.label !== undefined && item.label !== null && typeof item.label !== 'string') {
      return { ok: false, message: '第 ' + (index + 1) + ' 条策略的 label 必须是字符串' };
    }
  }
  return { ok: true, value: normalizePolicies(body) };
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

/** 免费商用字体白名单（未安装的不列出）。 */
export const FREE_FAMILIES = [
  'Noto Sans SC',
  'Noto Sans',
  'Source Han Sans SC',
  '思源黑体',
  'HarmonyOS Sans SC',
  'OPPO Sans',
  'MiSans',
  'Alibaba PuHuiTi',
  'Smiley Sans',
  '得意黑',
  'Inter',
  'JetBrains Mono',
  'IBM Plex Sans',
  '霞鹜文楷',
  'LXGW WenKai',
];

export const FONT_MAX_BYTES = 8 * 1024 * 1024;
export const FONT_EXTENSIONS = ['.ttf', '.otf'];

const familyKey = (name) => String(name || '').toLowerCase().replace(/[\s\-_]/g, '');

/** 家族名是否落在免费商用白名单里（允许 Light/Medium 之类的后缀变体）。 */
export function isFreeFamily(family) {
  const key = familyKey(family);
  if (!key) return false;
  return FREE_FAMILIES.some((name) => {
    const wanted = familyKey(name);
    return key === wanted || key.startsWith(wanted);
  });
}

/** 清洗上传文件名：去路径、去非法字符、截断名字，保留 .ttf/.otf 扩展名。 */
export function sanitizeFontName(name) {
  const raw = String(name || '').split(/[\\/]/).pop() || '';
  const match = raw.match(/\.(ttf|otf)$/i);
  const ext = match ? '.' + match[1].toLowerCase() : '.ttf';
  const stem = raw
    .replace(/\.(ttf|otf)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return { stem: stem || 'font', ext };
}

/** 上传落盘文件名：清洗后的名字 + 时间戳，避免同名覆盖。 */
export function fontFileName(name, stamp = Date.now()) {
  const { stem, ext } = sanitizeFontName(name);
  return stem + '-' + stamp + ext;
}

/** 只接受真正的 SFNT 字体（ttf/otf 以及字体集合的首个字体）。 */
export function sniffFont(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const signature = buffer.toString('latin1', 0, 4);
  return (
    signature === 'OTTO' ||
    signature === 'true' ||
    signature === 'typ1' ||
    signature === 'ttcf' ||
    buffer.readUInt32BE(0) === 0x00010000
  );
}

// ---------------------------------------------------------------------------
// 文件读写（原子写：同目录 .tmp + rename）
// ---------------------------------------------------------------------------

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/** 读 JSON；文件不存在、读不了或解析失败都返回 undefined（调用方退回默认值）。 */
export function readJsonFile(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 原子写 JSON：先写同目录临时文件再 rename，读者不会看到半截文件。失败会抛错。 */
export function atomicWriteJson(file, value) {
  ensureDir(dirname(file));
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
    return true;
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理失败就算了，别掩盖原始错误 */
    }
    throw error;
  }
}
