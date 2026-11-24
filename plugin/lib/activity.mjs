/**
 * 思考/步骤浮窗的写侧（从 dsh-computer-use-win 的 mcp/activity.mjs 精简移植，MIT）。
 *
 * evolution-computer-use 是 stdio MCP 服务器，收不到 DSH 的模型流事件，
 * 所以由宿主插件订阅事件，把活动原子写进 ~/.evolution-computer-use/activity.json；
 * evolution 的 src/desktop/overlay.ts 每秒读该文件，转发给浮窗助手画出来。
 *
 * 浮窗只在 agent 真的操作电脑时出现：回合开始、纯思考、纯写代码都不认领显示，
 * 只有 tools/execute 命中桌面/网页工具才创建 owner（与上游一致）。
 *
 * 精简掉的上游功能：跨会话忙碌锁、AI 摘要、屏幕接管提示。
 * 本文件不用模板字符串：整份内容要能被原样写进磁盘。
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_STEPS = 24, MAX_ACTIONS = 6, OLD_STEP_TEXT = 400, CURRENT_TEXT = 1200, INTENT_TEXT = 300;
export const LINGER_MS = 20000;
// 一次电脑操作中途卡住（等审批、等用户登录）时不能永远霸着浮窗：
// 30 秒没有任何动作和文本，浮窗自己收起来，下一次调用再重新出现。
export const IDLE_MS = 30000;

/** evolution 自己的桌面/浏览器工具：这些动作一定值得上浮窗。 */
// inbox_read / desktop_mode 也算：看信箱和切模式都是在操作这台电脑。
const DESKTOP_TOOL = /^(?:mcp__)?(?:evo-cu-local|evolution-computer-use-win|evolution-computer-use)__(?:desktop|desktop_mode|page_\w+|computer_use|procedure_\w+|inbox_read)$/;

const LABELS = {
  zh: {
    desktop: { open: '操作用户的电脑', shot: '看屏幕', click: '点击', drag: '拖动', type: '输入文字', press: '按键盘', scroll: '滚动', zoom: '放大看', record: '录屏', review: '看录屏', stop: '停下', default: '操作电脑' },
    page: { open: '打开网页', read: '读网页', click: '点击网页', type: '在网页里输入', press: '按键盘', scroll: '滚动网页', shot: '截网页', eval: '在网页里执行', wait: '等网页', default: '操作网页' },
    computer_use: '看能操作什么', procedure_run: '回放学会的操作', procedure_save: '存下学会的操作', procedure_note: '写操作说明',
    procedure_routines: '跑例行操作', list: '看有哪些操作', inbox_read: '看信箱', desktop_mode: '切换电脑操作模式',
    other: '调用工具',
  },
  en: {
    desktop: { open: 'Using the computer', shot: 'Looking at the screen', click: 'Clicking', drag: 'Dragging', type: 'Typing', press: 'Pressing keys', scroll: 'Scrolling', zoom: 'Zooming in', record: 'Recording', review: 'Reviewing the recording', stop: 'Stopping', default: 'Using the computer' },
    page: { open: 'Opening a page', read: 'Reading the page', click: 'Clicking the page', type: 'Typing on the page', press: 'Pressing keys', scroll: 'Scrolling the page', shot: 'Capturing the page', eval: 'Running page script', wait: 'Waiting for the page', default: 'Using the page' },
    computer_use: 'Checking what can be used', procedure_run: 'Replaying a learned procedure', procedure_save: 'Saving a learned procedure', procedure_note: 'Writing procedure notes',
    procedure_routines: 'Running routines', list: 'Listing procedures', inbox_read: 'Checking the inbox', desktop_mode: 'Switching desktop mode',
    other: 'Calling a tool',
  },
};

const words = (locale) => LABELS[String(locale || '').startsWith('en') ? 'en' : 'zh'];
const clean = (text) => String(text === undefined ? '' : text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;
// 截断时避开代理对中间：半个 emoji 会让浮窗那边的 JSON 解析失败。
const headText = (text, limit) => {
  const end = Math.min(text.length, limit);
  return text.slice(0, end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end)) ? end - 1 : end);
};
const lastText = (text, limit) => {
  const start = Math.max(0, text.length - limit);
  return text.slice(start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1)) ? start + 1 : start);
};
const tail = (text, limit) => (text.length > limit ? '…' + lastText(text, limit - 1) : text);

const shortName = (name) => String(name === undefined ? '' : name).replace(/^(?:mcp__)?(?:evo-cu-local|evolution-computer-use)__/, '');

/** 工具调用的人话标签：只由工具名和参数形状决定，绝不带上输入的文字、网址、坐标。 */
export function actionLabel(name, args, locale) {
  const dict = words(locale);
  const tool = shortName(name);
  if (tool === 'desktop') return dict.desktop[(args && args.action) || 'default'] || dict.desktop.default;
  if (tool.indexOf('page_') === 0) return dict.page[tool.slice(5)] || dict.page.default;
  if (dict[tool]) return dict[tool];
  return DESKTOP_TOOL.test(name) ? dict.other : '';
}

const ensuredDirs = new Set();
/** 先写临时文件再改名替换：读侧永远只会看到完整 JSON，或上一份完整 JSON。 */
export function atomicJson(file, value) {
  if (!file) return;
  const dir = dirname(file);
  if (!ensuredDirs.has(dir)) { mkdirSync(dir, { recursive: true }); ensuredDirs.add(dir); }
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(value), 'utf8');
    renameSync(temp, file);
  } catch (error) {
    ensuredDirs.delete(dir);
    try { unlinkSync(temp); } catch { /* 已经没了 */ }
    throw error;
  }
}

const newProgress = (startedAt) => ({
  status: 'waiting', step: 0, action: '', reasoning: '', reply: '', intent: '', steps: [],
  startedAt: startedAt || Date.now(), endedAt: 0,
});

// 每个模型步骤一条：这一步做了哪些动作、DSH 显示了什么文本。
function stepEntry(progress, step) {
  let entry = progress.steps.length ? progress.steps[progress.steps.length - 1] : undefined;
  if (entry && entry.step === step) return entry;
  for (const old of progress.steps) { old.reasoning = tail(old.reasoning, OLD_STEP_TEXT); old.reply = tail(old.reply, OLD_STEP_TEXT); }
  entry = { step: step, actions: [], reasoning: '', reply: '' };
  progress.steps.push(entry);
  if (progress.steps.length > MAX_STEPS) progress.steps.splice(0, progress.steps.length - MAX_STEPS);
  return entry;
}

function addAction(progress, label) {
  const entry = stepEntry(progress, progress.step || 1);
  const action = { label: label, state: 'running' };
  entry.actions.push(action);
  if (entry.actions.length > MAX_ACTIONS) entry.actions.splice(0, entry.actions.length - MAX_ACTIONS);
  progress.action = label;
  return action;
}

/**
 * 订阅 DSH 事件，把活动写进 activity.json。
 * @param {any} ctx 宿主插件上下文
 * @param {string} file activity.json 路径
 * @param {{ getSettings?(): object, getLocale?(): string }} options 设置项与界面语言
 */
export function installActivity(ctx, file, options) {
  const settings0 = options || {};
  const getSettings = settings0.getSettings || (() => ({}));
  const getLocale = settings0.getLocale || (() => 'zh');

  let owner;      // { id, session, turn, pending, otherPending, lastActive, desktop, progress }
  let lingering;  // { owner, until } —— 回合结束后继续显示一会儿
  let closed = false;
  let lastWarn = 0;
  let needsPublish = true;

  // 回合里第一次电脑操作之前流出的文本（多半是模型正在决定要不要用电脑）。
  // 只留在内存，每个会话一条；这一回合真的用了电脑才灌进浮窗，否则永远不显示。
  const early = new Map();

  // 一次操作中途卡住（等审批、等用户登录）时不能永远霸着浮窗。
  // 只按「上一次真的操作电脑（桌面/网页工具）」计时：之后即使还在写代码、跑命令，
  // 连续 IDLE_MS 没有电脑操作也把浮窗收起来。
  const expireIdle = () => {
    if (owner && owner.pending === 0 && Date.now() - (owner.lastDesktop || owner.lastActive) >= IDLE_MS) owner = undefined;
  };

  const publish = () => {
    try {
      needsPublish = true;
      expireIdle();
      if (lingering && (owner || Date.now() >= lingering.until)) lingering = undefined;
      const settings = getSettings() || {};
      const shown = owner || (lingering && lingering.owner);
      const body = {
        active: !!owner,
        sessionId: owner ? owner.id : (lingering && lingering.owner ? lingering.owner.id : null),
        turn: owner ? owner.turn : (lingering && lingering.owner ? lingering.owner.turn : null),
        locale: getLocale(),
        overlayEnabled: settings.overlayEnabled !== false,
        position: settings.position || 'top-right',
        width: settings.width || 360,
        height: settings.height || 240,
        opacity: settings.opacity === undefined ? 60 : settings.opacity,
        locked: settings.locked !== false,
        // 接管提示用：这一回合是否真的动过鼠标键盘（纯网页操控为 false）。
        indicator: !!(owner && owner.desktop),
        // 读侧心跳：写侧一秒一刷，超过这个时刻还没更新说明宿主插件已退出。
        expiresAt: owner ? Date.now() + 5000 : 0,
        updatedAt: Date.now(),
      };
      // 关掉浮窗时不写文本：文本留在内存里，中途打开还能看到整个回合。
      if (shown && settings.overlayEnabled !== false) body.progress = shown.progress;
      if (!owner && lingering) body.lingerUntil = lingering.until;
      atomicJson(file, body);
      needsPublish = false;
    } catch (error) {
      needsPublish = true;
      // 显示用的写入绝不能把已完成的工具调用变成失败结果。
      if (!closed && Date.now() - lastWarn > 10000) {
        lastWarn = Date.now();
        console.error('[evolution-desktop-mode] 写浮窗活动失败：', error);
      }
    }
  };
  publish();

  /** 桌面工具第一次进来时才建浮窗，并把这一回合早到的文本接上。 */
  const startOwner = (session, turn) => {
    const seed = early.get(session.id);
    early.delete(session.id);
    const progress = newProgress(seed && seed.turn === turn ? seed.startedAt : Date.now());
    if (seed && seed.turn === turn && seed.step) {
      progress.step = seed.step;
      const entry = stepEntry(progress, seed.step);
      entry.reasoning = progress.reasoning = seed.reasoning;
      entry.reply = progress.reply = seed.reply;
      if (seed.reasoning) { progress.intent = headText(seed.reasoning, INTENT_TEXT); progress.intentStep = seed.step; }
    }
    return progress;
  };

  /**
   * 一步开始。浮窗已经出现（这一回合真的操作过电脑）就推进到下一步；
   * 还没出现就只在内存里留一份种子，等这一回合真的用到电脑时再接上。
   */
  function stepStarted(sessionId, turn, step) {
    if (!sessionId || turn === undefined || turn === null) return;
    if (owner && owner.id === sessionId && owner.turn === turn) {
      const progress = owner.progress;
      if (step === undefined || (step === progress.step && progress.steps.length && progress.steps[progress.steps.length - 1].step === step)) return;
      progress.step = step;
      stepEntry(progress, step);
      progress.reasoning = '';
      progress.reply = '';
      if (progress.status !== 'acting') progress.status = 'thinking';
      needsPublish = true;
      return;
    }
    const seed = early.get(sessionId);
    if (seed && seed.turn === turn && seed.step === step) return;
    early.set(sessionId, {
      turn: turn,
      step: step === undefined ? 0 : step,
      reasoning: '',
      reply: '',
      startedAt: seed && seed.turn === turn ? seed.startedAt : Date.now(),
    });
    while (early.size > 8) early.delete(early.keys().next().value);
  }

  /** 被放弃的那次尝试要重来：丢掉上一次留下的文本（浮窗没出现时丢种子）。 */
  function clearStepText(sessionId, turn, step) {
    if (owner && owner.id === sessionId && owner.turn === turn) {
      for (const item of owner.progress.steps) {
        if (item.step === step) { item.reasoning = ''; item.reply = ''; }
      }
      if (owner.progress.step === step) { owner.progress.reasoning = ''; owner.progress.reply = ''; }
      needsPublish = true;
    } else {
      const seed = early.get(sessionId);
      if (seed && seed.turn === turn && seed.step === step) { seed.reasoning = ''; seed.reply = ''; }
    }
  }

  const acceptText = (sessionId, turn, step, chunk) => {
    if (!chunk || typeof chunk.text !== 'string' || !chunk.text) return;
    if (turn === undefined || turn === null) return;
    // 浮窗还没出现：文本只进内存种子，绝不因此写文件、绝不显示。
    if (!owner || owner.id !== sessionId || owner.turn !== turn) {
      const seed = early.get(sessionId);
      if (!seed || seed.turn !== turn || (step !== undefined && seed.step !== step)) return;
      if (chunk.type === 'reasoning-delta') seed.reasoning = lastText(clean(seed.reasoning + chunk.text), CURRENT_TEXT);
      else if (chunk.type === 'text-delta') seed.reply = lastText(clean(seed.reply + chunk.text), CURRENT_TEXT);
      return;
    }
    const progress = owner.progress;
    owner.lastActive = Date.now();
    const at = stepEntry(progress, Number.isSafeInteger(step) ? step : progress.step || 1);
    progress.step = at.step;
    if (chunk.type === 'reasoning-delta') {
      progress.reasoning = clean(progress.reasoning + chunk.text);
      at.reasoning = clean(at.reasoning + chunk.text);
      // 第一步的思考另外存一份开头当「意图」：浮窗在长思考里也能看出这次要干什么。
      if (progress.steps.length === 1) progress.intent = headText(at.reasoning, INTENT_TEXT);
      if (progress.status === 'waiting' || progress.status === 'acting') progress.status = 'thinking';
    } else if (chunk.type === 'text-delta') {
      progress.reply = clean(progress.reply + chunk.text);
      at.reply = clean(at.reply + chunk.text);
      progress.status = 'replying';
    } else return;
    if (progress.reasoning.length > CURRENT_TEXT) progress.reasoning = tail(progress.reasoning, CURRENT_TEXT);
    if (progress.reply.length > CURRENT_TEXT) progress.reply = tail(progress.reply, CURRENT_TEXT);
    needsPublish = true;
  };

  ctx.on('session/event', (session, event) => {
    const data = (event && event.data) || {};
    const turn = data.turn;
    if (event && event.type === 'turn/end') {
      early.delete(session.id);
      if (owner && owner.id === session.id && owner.turn === turn) {
        const kind = (data.reason && data.reason.kind) || '';
        const progress = owner.progress;
        progress.status = kind === 'aborted' ? 'stopped' : kind === 'error' ? 'failed' : 'done';
        progress.endedAt = Date.now();
        progress.action = '';
        lingering = LINGER_MS > 0 ? { owner: owner, until: Date.now() + LINGER_MS } : undefined;
        owner = undefined;
      }
      publish();
      return;
    }
    const step = Number.isSafeInteger(data.step) ? data.step : undefined;
    // 回合开始不再认领浮窗：只有真的调用桌面/网页工具才出现（见 tools/execute）。
    if (event && event.type === 'step/start') stepStarted(session.id, turn, step);
    // 兼容旧宿主：思考文本曾经是按 assistant/chunk 事件流出来的。
    const chunk = event && event.type === 'assistant/chunk' ? data.chunk : undefined;
    if (chunk) acceptText(session.id, turn, step, chunk);
  }, { global: true });

  // DSH 把模型输出按帧流出来：start 帧给出这一回合哪一步，chunk 帧带文本，
  // 被放弃的那次尝试会从头重来，所以旧的文本要清掉。
  const attempts = new Map();
  const retried = new Set();
  ctx.on('agent/assistant-stream', (payload) => {
    const frame = payload && payload.frame;
    const sessionId = payload && payload.agent && payload.agent.session && payload.agent.session.id;
    if (!sessionId || !frame) return;
    if (frame.type === 'start') {
      if (!Number.isSafeInteger(frame.turn)) return;
      const step = Number.isSafeInteger(frame.step) ? frame.step : undefined;
      const key = JSON.stringify([sessionId, frame.turn, step]);
      attempts.set(frame.attemptId, { sessionId: sessionId, turn: frame.turn, step: step, key: key });
      while (attempts.size > 32) attempts.delete(attempts.keys().next().value);
      // 重来的那一步：丢掉上一次尝试留下的文本。
      if (retried.delete(key)) clearStepText(sessionId, frame.turn, step);
      stepStarted(sessionId, frame.turn, step);
      return;
    }
    const attempt = attempts.get(frame.attemptId);
    if (!attempt) return;
    if (frame.type === 'end') {
      attempts.delete(frame.attemptId);
      if (frame.outcome && frame.outcome.kind === 'abandoned') {
        retried.add(attempt.key);
        while (retried.size > 32) retried.delete(retried.values().next().value);
      }
      return;
    }
    if (frame.type === 'chunk') acceptText(sessionId, attempt.turn, attempt.step, frame.chunk);
  }, { global: true });

  ctx.on('tools/execute', async (exec, next) => {
    const name = (exec && exec.name) || '';
    const isDesktop = DESKTOP_TOOL.test(name);
    // DSH 的 tools/execute 里，会话在 exec.agent.session，回合号在 exec.agent.phase.turn。
    const session = exec && exec.agent && exec.agent.session;
    const phase = exec && exec.agent && exec.agent.phase;
    const turn = phase && phase.kind === 'running' ? phase.turn : undefined;
    let args = {};
    try { args = typeof exec.arguments === 'string' ? JSON.parse(exec.arguments) : (exec.arguments || {}); } catch { args = {}; }
    const label = actionLabel(name, args, getLocale()) || name.replace(/^mcp__[^_]+__/, '') || name;

    // 普通工具：只有浮窗已经因为电脑操作而显示时，才顺手加一行「在做什么」；
    // 别的会话、别的回合、浮窗没出现的，一律不认领、不写文件。
    if (!isDesktop) {
      if (!owner || owner.id !== session?.id || owner.turn !== turn || !label) return next();
      const current = owner;
      const action = addAction(current.progress, label);
      current.otherPending = (current.otherPending || 0) + 1;
      current.progress.status = 'acting';
      needsPublish = true;
      try {
        const result = await next();
        action.state = result && result.isError ? 'error' : 'done';
        return result;
      } catch (error) {
        action.state = 'error';
        throw error;
      } finally {
        current.otherPending = Math.max(0, (current.otherPending || 1) - 1);
        // 普通工具不续命：浮窗只跟着电脑操作走（见 expireIdle）。
        if (owner === current && current.pending === 0 && current.otherPending === 0 && current.progress.action === label) {
          current.progress.status = 'waiting';
          current.progress.action = '';
        }
        publish();
      }
    }

    // 桌面/网页工具：浮窗只在这里出现。
    if (!session || turn === undefined || turn === null) return next();
    // 别的会话正占着浮窗：这一次不抢显示，工具照常执行。
    if (owner && owner.id !== session.id) return next();
    expireIdle();
    if (!owner || owner.turn !== turn) {
      owner = {
        id: session.id, session: session, turn: turn,
        pending: 0, otherPending: 0, lastActive: Date.now(), lastDesktop: Date.now(), desktop: false,
        progress: startOwner(session, turn),
      };
      lingering = undefined;
    }
    const current = owner;
    // 只有真的动用户鼠标键盘才算（纯网页操控在后台浏览器里，不算）。
    if (!/__page_\w+$/.test(name)) current.desktop = true;
    const action = addAction(current.progress, label || shortName(name));
    current.pending++;
    current.progress.status = 'acting';
    current.progress.tool = shortName(name);
    publish();
    try {
      const result = await next();
      action.state = result && result.isError ? 'error' : 'done';
      current.progress.lastAction = { tool: shortName(name), status: action.state, at: Date.now() };
      return result;
    } catch (error) {
      action.state = 'error';
      current.progress.lastAction = { tool: shortName(name), status: 'error', at: Date.now() };
      throw error;
    } finally {
      current.pending--;
      current.lastActive = Date.now();
      current.lastDesktop = Date.now();
      if (owner === current && current.pending === 0 && !current.otherPending) {
        current.progress.status = 'waiting';
        current.progress.tool = '';
        current.progress.action = '';
      }
      if (owner === current) publish();
    }
  }, { global: true });

  // 一秒一刷：文本是攒在内存里的，靠这个节拍写出去；linger 到点也靠这一次收掉。
  const timer = setInterval(() => {
    if ((owner || needsPublish || (lingering && Date.now() >= lingering.until)) && !closed) {
      try { publish(); } catch (error) { console.error('[evolution-desktop-mode] 浮窗定时写入失败：', error); }
    }
  }, 1000);

  ctx.on('dispose', () => {
    closed = true;
    clearInterval(timer);
    owner = undefined;
    lingering = undefined;
    early.clear();
    try { publish(); } catch { /* 卸载时的写入失败不用管 */ }
  });
  return { publish, refresh: publish };
}
