/**
 * 设置页的本机接口：桌面模式、三窗外观、字体上传、窗口捕捉与按应用策略。
 *
 * 路径都在 /api/dsh-evolution-desktop-mode 下，由 lib/index.js 用 exact 路由注册；
 * exact 只按 pathname 匹配，所以 DELETE /fonts?file=... 也能命中 /fonts。
 * 所有写盘都走 settings.js 的原子写，任何错误都回 { ok:false, message }，不往外抛。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FONT_EXTENSIONS,
  FONT_MAX_BYTES,
  appearanceFromLegacyOverlay,
  atomicWriteJson,
  ensureDir,
  fontFileName,
  isFreeFamily,
  legacyOverlayFromAppearance,
  legacyOverlayFromConfig,
  mergeAppearance,
  normalizeLegacyOverlay,
  normalizePolicies,
  parseAppearance,
  parsePolicies,
  readJsonFile,
  sanitizeFontName,
  sniffFont,
  validatePoliciesPayload,
} from './settings.js';

const MODES = ['off', 'background', 'foreground'];
// 网关传输：GUI 只允许在这两个值之间切换（native-probe 只是验收证据用的传输，界面不提供）。
const TRANSPORTS = ['mcp', 'native'];
// 严格目标：只改 profile 里 id 为 evolution-computer-use、且 name 指向本包网关入口的那一行。
const TRANSPORT_ENTRY_ID = 'evolution-computer-use';
const TRANSPORT_ENTRY_NAMES = ['evolution-computer-use-win', 'evolution-computer-use-win/lib/index.js'];
const SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const WINDOWS_SCRIPT = join(SCRIPT_DIR, 'window-picker.ps1');
const FONTS_SCRIPT = join(SCRIPT_DIR, 'fonts.ps1');
const WINDOW_CACHE_MS = 3000;
const WINDOW_LIMIT = 60;
const SMALL_BODY = 64 * 1024;
const FONT_BODY = 12 * 1024 * 1024;
const INSTALLED_FONT_CACHE_MS = 5 * 60 * 1000;

/** 数据目录：默认 ~/.evolution-computer-use；EVOCU_DATA_DIR 留给测试注入临时目录。 */
export function defaultDataDir() {
  return process.env.EVOCU_DATA_DIR || join(homedir(), '.evolution-computer-use');
}

/** 统一响应：JSON + 不缓存（设置页每次都要看最新值）。 */
export function writeJson(res, status, payload) {
  try {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  } catch (error) {
    console.error('[evolution-desktop-mode] 写响应失败：', error);
  }
}

const messageOf = (error) => String((error && error.message) || error || '未知错误').slice(0, 400);

/** 读请求体（带上限，字体上传要能过 8MB）；返回 { ok, value } 或 { ok:false, message, status }。 */
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        if (typeof req.resume === 'function') req.resume();
        finish({ ok: false, status: 413, message: '请求体过大' });
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      try {
        finish({ ok: true, value: text ? JSON.parse(text) : {} });
      } catch {
        finish({ ok: false, status: 400, message: '请求体不是合法 JSON' });
      }
    });
    req.on('error', () => finish({ ok: false, status: 400, message: '读取请求体失败' }));
  });
}

/** 跑 PowerShell 脚本；stdout 交给调用方解析，失败带 stderr 片段。 */
function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, message: '当前系统不是 Windows' });
      return;
    }
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'].concat(args),
        { timeout: timeoutMs || 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message || error).trim();
            resolve({ ok: false, message: detail.slice(0, 400) || 'PowerShell 执行失败' });
            return;
          }
          resolve({ ok: true, text: String(stdout || '') });
        }
      );
    } catch (error) {
      resolve({ ok: false, message: messageOf(error) });
    }
  });
}

function parseScriptJson(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 原子写二进制（字体文件）：同目录 .tmp + rename。 */
function atomicWriteFile(file, buffer) {
  ensureDir(dirname(file));
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    writeFileSync(tmp, buffer);
    renameSync(tmp, file);
    return true;
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清不掉就忽略，别掩盖原始错误 */
    }
    throw error;
  }
}

/**
 * 建一套接口。
 * options.config：插件 Config 的值（文件缺失时的兜底默认）；
 * options.dataDir：覆盖数据目录（测试用）；
 * options.onOverlayChanged：浮窗设置写完后的回调（activity.mjs 需要 publish）；
 * options.getConfigEditor：返回宿主的 configEditor 服务（每次请求时读取，缺省或返回空则只有 /transport 不可用，
 *   其余接口照常工作：configEditor 绝不是设置页的硬依赖）。
 */
export function createSettingsApi(options) {
  const opts = options || {};
  const config = opts.config || {};
  const dataDir = opts.dataDir || defaultDataDir();
  const appearanceFile = process.env.EVOCU_APPEARANCE_FILE || join(dataDir, 'appearance.json');
  const modeFile = join(dataDir, 'desktop-mode.json');
  const settingsFile = join(dataDir, 'activity-settings.json');
  const policiesFile = join(dataDir, 'app-policies.json');
  const fontsDir = join(dataDir, 'fonts');
  const activityFile = join(dataDir, 'activity.json');

  let notify = typeof opts.onOverlayChanged === 'function' ? opts.onOverlayChanged : () => {};
  // 多鼠标任务模式（plugin/lib/multi-mouse-runtime.mjs 的进程单例）：设置页“本任务”开关。
  const getMultiMouse = typeof opts.getMultiMouse === 'function' ? opts.getMultiMouse : () => null;
  // 宿主 configEditor：只在处理 /transport 请求时调用这个 getter，服务不在时那一条路由自己回 503。
  let getConfigEditor = typeof opts.getConfigEditor === 'function' ? opts.getConfigEditor : () => undefined;

  // root 只来自当前可信活动（活动采集在 tools/execute 里 observeRoot 登记），
  // 拿不到活任务就显示“需先选择活任务”，绝不偷偷开启所有 root。
  function multiMouseView() {
    const rt = getMultiMouse();
    if (!rt) return { available: false, roots: [], rootId: null, needsSelection: true, mode: null };
    let roots = [];
    try { roots = (typeof rt.listRoots === 'function' ? rt.listRoots() : []) || []; } catch { roots = []; }
    let activeRootId = null;
    try { activeRootId = typeof rt.activeRootId === 'function' ? rt.activeRootId() : null; } catch { activeRootId = null; }
    // 只有唯一 root 时才自动选中；多 root 必须显式选择，绝不由后台“最近活动”抢选当前任务。
    const rootId = activeRootId || (roots.length === 1 ? roots[0].rootId : null) || null;
    let mode = null;
    if (rootId && typeof rt.getMode === 'function') {
      try { mode = rt.getMode(rootId); } catch { mode = null; }
    }
    const known = rootId ? roots.some((r) => r && r.rootId === rootId) : false;
    return { available: true, roots, rootId, needsSelection: !rootId, known, mode };
  }

  function readAppearance() {
    return parseAppearance(readJsonFile(appearanceFile));
  }

  function readFileMode() {
    const raw = readJsonFile(modeFile);
    const mode = raw && raw.desktopMode;
    return MODES.includes(mode) ? mode : undefined;
  }

  function currentMode() {
    const file = readFileMode();
    if (file !== undefined) return file;
    return MODES.includes(config.desktopMode) ? config.desktopMode : 'background';
  }

  function readLegacySettings() {
    return readJsonFile(settingsFile);
  }

  function currentOverlay() {
    const raw = readLegacySettings();
    // 兼容旧行为：没有旧设置文件时，浮窗开关沿用 Config 的 overlayEnabled 默认值。
    const enabled =
      raw === undefined || raw === null ? config.overlayEnabled !== false : raw.overlayEnabled !== false;
    return legacyOverlayFromAppearance(readAppearance(), enabled);
  }

  function getPolicies() {
    return normalizePolicies(readJsonFile(policiesFile));
  }

  /** 写 appearance.json，并同步旧的 activity-settings.json（浮窗助手兼容旧版读取）。 */
  function writeAppearance(next) {
    const clean = parseAppearance(next);
    atomicWriteJson(appearanceFile, clean);
    try {
      const enabled = currentOverlay().overlayEnabled;
      atomicWriteJson(settingsFile, legacyOverlayFromAppearance(clean, enabled));
    } catch (error) {
      console.error('[evolution-desktop-mode] 同步 activity-settings.json 失败：', error);
    }
    return clean;
  }

  function writeOverlayLegacy(overlay) {
    const legacy = normalizeLegacyOverlay(overlay);
    const next = appearanceFromLegacyOverlay(readAppearance(), legacy);
    atomicWriteJson(appearanceFile, next);
    atomicWriteJson(settingsFile, legacy);
    return { overlay: legacyOverlayFromAppearance(next, legacy.overlayEnabled), appearance: next };
  }

  function writeMode(mode) {
    atomicWriteJson(modeFile, { desktopMode: mode });
  }

  /** 首次运行：补文件。已有文件绝不覆盖用户的选择。 */
  function init() {
    ensureDir(dataDir);
    const legacy = readLegacySettings();
    if (!existsSync(appearanceFile)) {
      // 没有旧设置时沿用 Config 的浮窗默认值，保持 /read 在全新安装上的旧行为。
      const seed = legacy === undefined ? legacyOverlayFromConfig(config) : normalizeLegacyOverlay(legacy);
      atomicWriteJson(appearanceFile, appearanceFromLegacyOverlay(parseAppearance(undefined), seed));
    }
    if (legacy === undefined) {
      atomicWriteJson(settingsFile, currentOverlay());
    }
  }

  // --- 字体 ---------------------------------------------------------------

  function installedFamilies() {
    return runPowerShell([FONTS_SCRIPT, '-Mode', 'installed'], 20000).then((result) => {
      if (!result.ok) return { ok: false, message: result.message, families: [] };
      const parsed = parseScriptJson(result.text);
      const families = Array.isArray(parsed && parsed.families) ? parsed.families.filter((name) => typeof name === 'string' && name.trim()) : [];
      return { ok: true, families };
    });
  }

  function uploadedFiles() {
    try {
      if (!existsSync(fontsDir)) return [];
      return readdirSync(fontsDir)
        .filter((name) => FONT_EXTENSIONS.includes(extname(name).toLowerCase()))
        .map((name) => ({ file: name, path: join(fontsDir, name) }))
        .sort((a, b) => a.file.localeCompare(b.file));
    } catch (error) {
      console.error('[evolution-desktop-mode] 读字体目录失败：', error);
      return [];
    }
  }

  function fallbackFamily(file) {
    const stem = basename(file, extname(file)).replace(/-\d{9,}$/, '').replace(/[-_]+/g, ' ').trim();
    return stem || basename(file);
  }

  /** 上传字体的家族名：PowerShell PrivateFontCollection 解析，失败退回文件名。 */
  function readFontFamily(file) {
    return runPowerShell([FONTS_SCRIPT, '-Mode', 'family', '-File', file], 15000).then((result) => {
      if (!result.ok) return fallbackFamily(file);
      const parsed = parseScriptJson(result.text);
      const family = parsed && typeof parsed.family === 'string' ? parsed.family.trim() : '';
      return family || fallbackFamily(file);
    });
  }

  /** uploaded：[{ file, family }]，一次 PowerShell 读全部，读不到就用文件名。 */
  async function uploadedFamilies() {
    const files = uploadedFiles();
    if (!files.length) return [];
    const result = await runPowerShell([FONTS_SCRIPT, '-Mode', 'list', '-Files'].concat(files.map((item) => item.path)), 30000);
    const seen = new Map();
    if (result.ok) {
      const parsed = parseScriptJson(result.text);
      const entries = parsed && Array.isArray(parsed.fonts) ? parsed.fonts : [];
      for (const entry of entries) {
        if (!entry || typeof entry.file !== 'string') continue;
        seen.set(basename(entry.file), typeof entry.family === 'string' ? entry.family : '');
      }
    }
    return files.map((item) => ({ file: item.file, family: seen.get(item.file) || fallbackFamily(item.file) }));
  }

  // --- 窗口捕捉 -----------------------------------------------------------

  let windowCache = { at: 0, windows: [] };

  function cleanWindow(item) {
    if (!item || typeof item !== 'object') return undefined;
    const hwnd = Number(item.hwnd);
    if (!Number.isFinite(hwnd) || hwnd <= 0) return undefined;
    const toInt = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0);
    return {
      hwnd,
      pid: toInt(item.pid),
      exe: typeof item.exe === 'string' ? item.exe : '',
      title: typeof item.title === 'string' ? item.title : '',
      minimized: item.minimized === true,
      width: toInt(item.width),
      height: toInt(item.height),
      thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : '',
    };
  }

  async function listWindows(force) {
    const now = Date.now();
    if (!force && windowCache.windows.length && now - windowCache.at < WINDOW_CACHE_MS) {
      return { ok: true, windows: windowCache.windows };
    }
    const result = await runPowerShell([WINDOWS_SCRIPT, '-Thumbs', '-Limit', String(WINDOW_LIMIT)], 25000);
    if (!result.ok) return { ok: false, message: '枚举窗口失败：' + result.message };
    const parsed = parseScriptJson(result.text);
    if (!parsed || !Array.isArray(parsed.windows)) return { ok: false, message: '窗口脚本输出不是预期的 JSON' };
    const windows = parsed.windows.map(cleanWindow).filter(Boolean).slice(0, WINDOW_LIMIT);
    windowCache = { at: now, windows };
    return { ok: true, windows };
  }

  // --- 路由 ---------------------------------------------------------------

  function readRoute(req, res) {
    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    writeJson(res, 200, { ok: true, value: { desktopMode: currentMode(), overlay: currentOverlay(), multiMouse: multiMouseView() } });
  }

  // 多鼠标任务模式：GET 看当前“本任务”，POST { enabled?, task?, rootId? } 合并更新。
  async function multiMouseRoute(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      writeJson(res, 200, { ok: true, value: multiMouseView() });
      return;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const rt = getMultiMouse();
    if (!rt) {
      writeJson(res, 503, { ok: false, message: '多鼠标 runtime 不可用' });
      return;
    }
    const body = await readBody(req, SMALL_BODY);
    if (!body.ok) {
      writeJson(res, body.status || 400, { ok: false, message: body.message });
      return;
    }
    const payload = body.value || {};
    const patch = payload.multiMouse && typeof payload.multiMouse === 'object' ? payload.multiMouse : payload;
    const requestedRoot = (typeof patch.rootId === 'string' && patch.rootId)
      || (typeof payload.rootId === 'string' && payload.rootId)
      || '';
    const next = {};
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.task === 'string') next.task = patch.task;
    // 只给了 rootId：视为显式选择“本任务”，不改开关。
    if (Object.keys(next).length === 0) {
      if (requestedRoot && typeof rt.selectRoot === 'function') {
        const picked = rt.selectRoot(requestedRoot);
        if (!picked) {
          writeJson(res, 409, { ok: false, message: '未知任务 root' });
          return;
        }
        writeJson(res, 200, { ok: true, value: multiMouseView() });
        return;
      }
      writeJson(res, 400, { ok: false, message: 'enabled、task 或 rootId 至少给一个' });
      return;
    }
    if (requestedRoot && !multiMouseView().roots.some((r) => r && r.rootId === requestedRoot)) {
      writeJson(res, 409, { ok: false, message: '未知任务 root' });
      return;
    }
    const rootId = requestedRoot || multiMouseView().rootId;
    if (!rootId) {
      writeJson(res, 409, { ok: false, message: '需先选择活任务' });
      return;
    }
    try {
      rt.publishMode(rootId, next);
    } catch (error) {
      console.error('[evolution-desktop-mode] 写多鼠标模式失败：', error);
      writeJson(res, 500, { ok: false, message: '写入多鼠标模式失败' });
      return;
    }
    writeJson(res, 200, { ok: true, value: multiMouseView() });
  }

  // --- 网关传输（MCP / native）---------------------------------------------
  // 正规写入路径是宿主的 configEditor.edit(entry, change)：它自己带 profile 文件锁、fresh current/inherited、
  // override 拒绝、writeFileAtomic 失败回滚，并在成功后 reconcile（等价于把这一行重挂载）。
  // 这里只做三件事：认准那一行、校验 next/expected、写完复核；不碰其它行、不自己写 profile 文件。

  function editorNow() {
    if (typeof getConfigEditor !== 'function') return { reason: '宿主没有提供 configEditor 服务' };
    let editor;
    try {
      editor = getConfigEditor();
    } catch (error) {
      return { reason: '读取 configEditor 失败：' + messageOf(error) };
    }
    if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
      return { reason: '宿主没有提供 configEditor 服务（这个 DSH 版本不支持在界面里改网关传输）' };
    }
    return { editor };
  }

  /** 找到网关那一行；找不到、不唯一或指向别的插件都算失败（绝不就近改一行）。 */
  function gatewayEntry(editor) {
    let rows;
    try {
      rows = editor.entries();
    } catch (error) {
      return { reason: '读取可编辑配置失败：' + messageOf(error) };
    }
    const list = Array.isArray(rows) ? rows : [];
    const matches = list.filter((row) => row && row.options && row.options.id === TRANSPORT_ENTRY_ID);
    if (matches.length === 0) {
      return { reason: '当前 profile 里没有可编辑的 ' + TRANSPORT_ENTRY_ID + ' 行（可能被更高优先级的配置覆盖）' };
    }
    if (matches.length > 1) {
      // 不猜第一条：同名条目出现多条时无法确定哪一行是网关。
      return { reason: TRANSPORT_ENTRY_ID + ' 有 ' + matches.length + ' 条同名条目，无法确定改哪一行，拒绝修改' };
    }
    const entry = matches[0];
    const name = String((entry.options && entry.options.name) || '');
    if (!TRANSPORT_ENTRY_NAMES.includes(name)) {
      return { reason: 'id 为 ' + TRANSPORT_ENTRY_ID + ' 的行指向 ' + (name || '（空）') + '，不是本插件的网关，拒绝修改' };
    }
    return { entry };
  }

  /**
   * 读这一行当前的传输。没写 toolTransport 才是历史默认 MCP（与 lib/index.js 的默认分支一致）；
   * 写了但界面不提供（native-probe，或任何不认识的字符串）就原样报出来，不能假装成 mcp。
   */
  function transportOf(entry) {
    const raw = entry && entry.options && entry.options.config ? entry.options.config.toolTransport : undefined;
    if (typeof raw === 'string' && raw.trim() !== '') return { current: raw.trim(), explicit: true };
    return { current: 'mcp', explicit: false };
  }

  /** change() 回调里读到的 fresh current 用的是同一套判断，避免两处规则漂移。 */
  function transportOfConfig(config) {
    const raw = config && typeof config === 'object' ? config.toolTransport : undefined;
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    return 'mcp';
  }

  function transportView() {
    const view = {
      entryId: TRANSPORT_ENTRY_ID,
      options: TRANSPORTS.slice(),
      available: false,
      current: null,
      explicit: false,
      expected: null,
    };
    const { editor, reason } = editorNow();
    if (!editor) return Object.assign(view, { reason });
    const { entry, reason: missing } = gatewayEntry(editor);
    if (!entry) return Object.assign(view, { reason: missing });
    const { current, explicit } = transportOf(entry);
    return Object.assign(view, { available: true, current, explicit, expected: current });
  }

  // GET 看当前值（含 expected 令牌）；POST { next, expected } 改，expected 必须等于刚读到的值。
  async function transportRoute(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      writeJson(res, 200, { ok: true, value: transportView() });
      return;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const { editor, reason } = editorNow();
    if (!editor) {
      // 服务缺失只让这一条路由不可用，不影响设置页其它接口。
      writeJson(res, 503, { ok: false, message: reason });
      return;
    }
    const body = await readBody(req, SMALL_BODY);
    if (!body.ok) {
      writeJson(res, body.status || 400, { ok: false, message: body.message });
      return;
    }
    const payload = body.value || {};
    const next = typeof payload.next === 'string' ? payload.next : '';
    if (!TRANSPORTS.includes(next)) {
      writeJson(res, 400, { ok: false, message: 'next 只能是 ' + TRANSPORTS.join(' 或 ') });
      return;
    }
    const before = transportView();
    if (!before.available) {
      writeJson(res, 409, { ok: false, message: before.reason, value: before });
      return;
    }
    if (typeof payload.expected !== 'string' || payload.expected !== before.current) {
      writeJson(res, 409, {
        ok: false,
        conflict: true,
        message: '网关传输已经被别处改成 ' + before.current + '，请刷新后再改',
        value: before,
      });
      return;
    }
    const fresh = gatewayEntry(editor);
    if (!fresh.entry) {
      writeJson(res, 409, { ok: false, message: fresh.reason, value: transportView() });
      return;
    }
    if (transportOf(fresh.entry).current !== before.current) {
      writeJson(res, 409, { ok: false, conflict: true, message: '网关传输刚刚变了，请刷新后再改', value: transportView() });
      return;
    }
    try {
      // config 是整体替换：必须保留其它字段（desktopMode、multiMouse、dataDir…），否则会被悄悄清掉。
      await editor.edit(fresh.entry, (current) => {
        const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
        // 宿主在文件锁内给的 fresh current 才是权威值：这里再查一次 expected，过期就直接抛，一个字节都不写。
        const now = transportOfConfig(base);
        if (now !== before.current) {
          const stale = new Error('网关传输在保存时变成了 ' + now + '，请刷新后再改');
          stale.stale = true;
          throw stale;
        }
        return Object.assign({}, base, { toolTransport: next });
      });
    } catch (error) {
      const message = messageOf(error);
      const stale = Boolean(error && error.stale);
      if (stale) {
        writeJson(res, 409, { ok: false, conflict: true, message, value: transportView() });
        return;
      }
      const overridden = /overridden/i.test(message);
      console.error('[evolution-desktop-mode] 修改网关传输失败：', error);
      writeJson(res, overridden ? 409 : 500, {
        ok: false,
        message: overridden ? '网关这一行被更高优先级的配置覆盖，改不动：' + message : '修改网关传输失败：' + message,
        value: transportView(),
      });
      return;
    }
    // 宿主只会重挂载这一行；复核读回来的值，避免「写了但没生效」被当成成功。
    const after = transportView();
    if (!after.available || after.current !== next) {
      writeJson(res, 500, {
        ok: false,
        message: '配置写完了但网关没有改成 ' + next + '（可能被更高优先级的配置覆盖）',
        value: after,
      });
      return;
    }
    writeJson(res, 200, { ok: true, value: after });
  }

  async function setRoute(req, res) {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const body = await readBody(req, SMALL_BODY);
    if (!body.ok) {
      writeJson(res, body.status || 400, { ok: false, message: body.message });
      return;
    }
    const payload = body.value;
    const mode = payload && payload.desktopMode;
    if (payload && payload.overlay !== undefined && (typeof payload.overlay !== 'object' || payload.overlay === null)) {
      writeJson(res, 400, { ok: false, message: 'overlay 必须是个对象' });
      return;
    }
    if (payload && payload.overlay !== undefined) {
      let next;
      try {
        next = writeOverlayLegacy(Object.assign({}, currentOverlay(), payload.overlay));
      } catch (error) {
        console.error('[evolution-desktop-mode] 写浮窗设置失败：', error);
        writeJson(res, 500, { ok: false, message: '写入浮窗设置失败' });
        return;
      }
      try {
        notify();
      } catch {
        /* 浮窗刷新失败不影响保存结果 */
      }
      if (mode === undefined) {
        writeJson(res, 200, { ok: true, value: { overlay: next.overlay } });
        return;
      }
    }
    if (mode === undefined) {
      writeJson(res, 200, { ok: true, value: { overlay: currentOverlay() } });
      return;
    }
    if (!MODES.includes(mode)) {
      writeJson(res, 400, { ok: false, message: 'mode 只能是 off、background、foreground' });
      return;
    }
    try {
      writeMode(mode);
    } catch (error) {
      console.error('[evolution-desktop-mode] 写模式文件失败：', error);
      writeJson(res, 500, { ok: false, message: '写入模式文件失败' });
      return;
    }
    writeJson(res, 200, { ok: true, value: { desktopMode: mode, overlay: currentOverlay() } });
  }

  async function appearanceRoute(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      writeJson(res, 200, { ok: true, value: readAppearance() });
      return;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const body = await readBody(req, SMALL_BODY);
    if (!body.ok) {
      writeJson(res, body.status || 400, { ok: false, message: body.message });
      return;
    }
    if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
      writeJson(res, 400, { ok: false, message: '请求体必须是 JSON 对象' });
      return;
    }
    let next;
    try {
      next = writeAppearance(mergeAppearance(readAppearance(), body.value));
    } catch (error) {
      console.error('[evolution-desktop-mode] 写 appearance.json 失败：', error);
      writeJson(res, 500, { ok: false, message: '写入外观设置失败：' + messageOf(error) });
      return;
    }
    try {
      notify();
    } catch {
      /* 同 /set：浮窗刷新失败不影响保存结果 */
    }
    writeJson(res, 200, { ok: true, value: next });
  }

  async function fontsRoute(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'DELETE') {
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const file = url.searchParams.get('file') || '';
      deleteFont(res, file);
      return;
    }
    if (method === 'GET') {
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
      const force = url.searchParams.get('refresh') === '1';
      if (force || !installedCache.families.length || Date.now() - installedCache.at > INSTALLED_FONT_CACHE_MS) {
        const installed = await installedFamilies();
        if (!installed.ok) {
          writeJson(res, 500, { ok: false, message: '读取系统字体失败：' + installed.message });
          return;
        }
        const unique = Array.from(new Set(installed.families.map((name) => name.trim()))).sort((a, b) => a.localeCompare(b));
        installedCache = { at: Date.now(), families: unique };
      }
      writeJson(res, 200, {
        ok: true,
        value: {
          installed: installedCache.families.map((family) => ({ family, free: isFreeFamily(family) })),
          uploaded: await uploadedFamilies(),
        },
      });
      return;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    await uploadFont(req, res);
  }

  function deleteFont(res, rawName) {
    const name = basename(String(rawName || '').replace(/\\/g, '/'));
    if (!name || name === '.' || name === '..' || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) {
      writeJson(res, 400, { ok: false, message: '缺少要删除的字体文件名' });
      return;
    }
    if (!FONT_EXTENSIONS.includes(extname(name).toLowerCase())) {
      writeJson(res, 400, { ok: false, message: '只允许删除字体文件（.ttf/.otf）' });
      return;
    }
    const file = join(fontsDir, name);
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        writeJson(res, 404, { ok: false, message: '字体文件不存在' });
        return;
      }
      unlinkSync(file);
      writeJson(res, 200, { ok: true, value: { deleted: name } });
    } catch (error) {
      writeJson(res, 500, { ok: false, message: '删除字体失败：' + messageOf(error) });
    }
  }

  async function fontsDeleteRoute(req, res) {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const body = await readBody(req, SMALL_BODY);
    if (!body.ok) {
      writeJson(res, body.status || 400, { ok: false, message: body.message });
      return;
    }
    deleteFont(res, body.value && body.value.file);
  }

  async function uploadFont(req, res) {
    const body = await readBody(req, FONT_BODY);
    if (!body.ok) {
      writeJson(res, body.status || 400, { ok: false, message: body.message });
      return;
    }
    const payload = body.value || {};
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      writeJson(res, 400, { ok: false, message: '缺少字体文件名' });
      return;
    }
    // 先按原始扩展名把关：sanitizeFontName 会把陌生扩展名兜底成 .ttf，不能拿它做白名单判断。
    if (!FONT_EXTENSIONS.includes(extname(name).toLowerCase())) {
      writeJson(res, 400, { ok: false, message: '只支持 .ttf / .otf 字体' });
      return;
    }
    const sanitized = sanitizeFontName(name);
    if (typeof payload.dataBase64 !== 'string' || !payload.dataBase64.trim()) {
      writeJson(res, 400, { ok: false, message: '缺少字体文件内容' });
      return;
    }
    const comma = payload.dataBase64.indexOf(',');
    const base64 = (comma >= 0 ? payload.dataBase64.slice(comma + 1) : payload.dataBase64).replace(/\s+/g, '');
    if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
      writeJson(res, 400, { ok: false, message: '字体内容不是合法的 base64' });
      return;
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
      writeJson(res, 400, { ok: false, message: '字体内容为空' });
      return;
    }
    if (buffer.length > FONT_MAX_BYTES) {
      writeJson(res, 413, { ok: false, message: '字体文件不能超过 8MB' });
      return;
    }
    if (!sniffFont(buffer)) {
      writeJson(res, 400, { ok: false, message: '文件不是有效的 TTF/OTF 字体' });
      return;
    }
    const file = fontFileName(name);
    try {
      atomicWriteFile(join(fontsDir, file), buffer);
    } catch (error) {
      writeJson(res, 500, { ok: false, message: '保存字体失败：' + messageOf(error) });
      return;
    }
    const family = await readFontFamily(join(fontsDir, file));
    writeJson(res, 200, { ok: true, value: { file, family } });
  }

  async function appsRoute(req, res) {
    if ((req.method || 'GET').toUpperCase() !== 'GET') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
    const force = url.searchParams.get('refresh') === '1';
    const windows = await listWindows(force);
    if (!windows.ok) {
      writeJson(res, 500, { ok: false, message: windows.message });
      return;
    }
    writeJson(res, 200, { ok: true, value: { windows: windows.windows, policies: getPolicies() } });
  }

  async function policiesRoute(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      writeJson(res, 200, { ok: true, value: getPolicies() });
      return;
    }
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, message: 'method not allowed' });
      return;
    }
    const body = await readBody(req, SMALL_BODY);
    if (!body.ok) {
      writeJson(res, body.status || 400, { ok: false, message: body.message });
      return;
    }
    const checked = validatePoliciesPayload(body.value);
    if (!checked.ok) {
      writeJson(res, 400, { ok: false, message: checked.message });
      return;
    }
    try {
      atomicWriteJson(policiesFile, checked.value);
    } catch (error) {
      writeJson(res, 500, { ok: false, message: '保存按应用策略失败：' + messageOf(error) });
      return;
    }
    writeJson(res, 200, { ok: true, value: checked.value });
  }

  const guarded = (handler) =>
    function guardedHandler(req, res) {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error) => {
          console.error('[evolution-desktop-mode] 接口出错：', error);
          if (!res.headersSent) writeJson(res, 500, { ok: false, message: messageOf(error) });
          else if (typeof res.end === 'function') res.end();
        });
    };

  return {
    dataDir,
    activityFile,
    appearanceFile,
    modeFile,
    settingsFile,
    policiesFile,
    fontsDir,
    init,
    currentMode,
    currentOverlay,
    multiMouseView,
    transportView,
    setConfigEditor(fn) {
      getConfigEditor = typeof fn === 'function' ? fn : () => undefined;
    },
    getAppearance: readAppearance,
    getPolicies,
    setNotify(fn) {
      notify = typeof fn === 'function' ? fn : () => {};
    },
    routes: [
      { path: '/read', handler: guarded(readRoute) },
      { path: '/set', handler: guarded(setRoute) },
      { path: '/multi-mouse', handler: guarded(multiMouseRoute) },
      { path: '/transport', handler: guarded(transportRoute) },
      { path: '/appearance', handler: guarded(appearanceRoute) },
      { path: '/fonts', handler: guarded(fontsRoute) },
      { path: '/fonts/delete', handler: guarded(fontsDeleteRoute) },
      { path: '/apps', handler: guarded(appsRoute) },
      { path: '/policies', handler: guarded(policiesRoute) },
    ],
  };
}

let installedCache = { at: 0, families: [] };
