/**
 * 多鼠标 runtime（进程级单例）：每个 root 任务的开关 + 真实 ActionEvent 消费 + Companion 状态桥。
 *
 * 纯 ESM，不 import 任何宿主包，方便单测。事实源见
 * docs/design/cyble-multi-mouse-implementation-plan.md：
 *   - ModeSnapshot  : { enabled, task, epoch }，enabled=false 默认；enabled 或 task 变化 epoch++
 *   - ActionEvent   : 由执行链（ComputerUse.onAction）逐 phase 产出，所有层透传同一 requestId
 *   - Companion     : 主思考窗左侧堆叠，每个子 Agent 一行，只留最近一条，root 不进入
 *
 * 本模块只做四件事：
 *   1) 保存每个 root 的任务开关（默认关），并原子写 multi-mouse-mode.json 供其它进程只读轮询；
 *   2) 消费已标准化的 ActionEvent，维护“每个 root / 每个子 Agent 的最近一条动作”；
 *   3) 把当前活跃 root 的 Companion 快照原子写 companion-live.json，供 C# CompanionFrame 按路径读取；
 *   4) 提供同步订阅（mode / companion / action），监听器抛错被隔离，绝不影响输入链。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SCHEMA = 1;
// 数据层不淘汰活着的子 Agent（A10 至少十人同时完整可见）；上限只用于回收已结束的旧行，
// 超过上限且仍有 done 行时优先淘汰最久未动的 done 行，活人一行都不静默删除。
const MAX_ROWS = 32;
const MAX_TASK = 60;
const MAX_LABEL = 60;
const MAX_REASON = 200;
const MAX_REQUESTS = 256;      // 每个 root 记住的 requestId 绑定（超出丢最早）

const KINDS = new Set(['move', 'click', 'drag', 'wheel', 'scroll', 'type', 'key', 'wait', 'other']);
const DONE_PHASES = new Set(['succeeded', 'cancelled', 'failed', 'uncertain', 'done', 'end', 'cancel', 'settle-done']);

function dataDirOf(options) {
  return (options && options.dataDir) || process.env.EVOCU_DATA_DIR || join(homedir(), '.evolution-computer-use');
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function point(value) {
  if (!value || typeof value !== 'object') return null;
  const x = num(value.x);
  const y = num(value.y);
  return x === null || y === null ? null : { x, y };
}

/**
 * 把执行链的 ActionEvent 归一化成展示层需要的形状（纯函数）。缺身份返回 null。
 * 兼容 action 为字符串或 { kind, label, button } 两种；phase 不假设枚举。
 */
export function normalizeActionEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  // 只接受执行链真实产出的 ActionEvent；工具参数/脚本拼出来的伪事件一律拒绝。
  if (clean(evt.kind, 32) !== 'desktop-action') return null;
  const actor = evt.actor && typeof evt.actor === 'object' ? evt.actor : {};
  // 身份必须来自可信网关：legacy 或字段不全的事件拒绝，避免旧生命期/伪身份覆盖新状态。
  if (clean(actor.trust, 16) !== 'trusted') return null;
  const rootId = clean(actor.rootAgentId != null ? actor.rootAgentId : (evt.rootAgentId != null ? evt.rootAgentId : evt.rootId), 120);
  const agentId = clean(actor.agentId != null ? actor.agentId : evt.agentId, 120);
  const depth = Number.isInteger(actor.depth) ? actor.depth : (Number.isInteger(evt.depth) ? evt.depth : NaN);
  const lifetime = num(actor.lifetime) != null ? num(actor.lifetime) : num(evt.lifetime);
  const requestId = clean(evt.requestId, 120);
  const seq = Number.isInteger(evt.seq) ? evt.seq : NaN;
  if (!rootId || !agentId) return null;
  if (!Number.isInteger(depth) || depth < 0) return null;
  if (!Number.isInteger(lifetime) || lifetime <= 0) return null;
  if (!requestId || !Number.isInteger(seq) || seq < 0) return null;
  // space 只信执行链声明的物理屏像素；非 physical 却带坐标 → 拒绝，绝不把窗口坐标改标成物理坐标。
  const space = clean(evt.space, 16);
  const hasCoords = point(evt.from) !== null || point(evt.to) !== null
    || (Array.isArray(evt.path) && evt.path.length > 0);
  if (space !== 'physical' && hasCoords) return null;

  const action = evt.action;
  let kind = 'other';
  let label = '';
  let button = '';
  if (typeof action === 'string') {
    if (KINDS.has(action)) kind = action;
    label = clean(action, MAX_LABEL);
  } else if (action && typeof action === 'object') {
    const k = clean(action.kind, 24);
    if (KINDS.has(k)) kind = k;
    label = clean(action.label, MAX_LABEL);
    button = clean(action.button, 12);
  }

  return {
    rootId: rootId,
    agentId: agentId,
    depth: depth,
    lifetime: lifetime,
    requestId: requestId,
    seq: seq,
    leaseId: clean(evt.leaseId, 120),
    phase: clean(evt.phase, 24) || 'unknown',
    kind: kind,
    label: label,
    button: button,
    space: space,
    epoch: Number.isInteger(evt.epoch) && evt.epoch > 0 ? evt.epoch : null,
    from: point(evt.from),
    to: point(evt.to),
    path: Array.isArray(evt.path) ? evt.path.map(point).filter(Boolean).slice(0, 96) : [],
    sampleMs: num(evt.sampleMs),
    motionMs: num(evt.motionMs),
    durationMs: num(evt.durationMs),
    double: action && typeof action === 'object' && action.double === true,
    app: clean(evt.app, MAX_LABEL),
    trust: clean(actor.trust, 16),
    windowRect: evt.windowRect && typeof evt.windowRect === 'object' ? {
      x: num(evt.windowRect.x), y: num(evt.windowRect.y),
      width: num(evt.windowRect.width), height: num(evt.windowRect.height),
    } : null,
    ok: typeof evt.ok === 'boolean' ? evt.ok : undefined,
    reason: clean(evt.reason, MAX_REASON) || '',
    at: num(evt.at) != null ? num(evt.at) : Date.now(),
  };
}

/** 稳定的指针/Companion 标签，规则与 pointer worker 一致：'Agent 2 - abcdef' / 'Agent 3'。 */
export function agentLabel(agentId, ordinal) {
  const n = Number.isInteger(ordinal) && ordinal > 0 ? ordinal : 1;
  const id = clean(agentId, 120);
  if (id.length >= 6 && /^[0-9a-f]/i.test(id)) return 'Agent ' + n + ' - ' + id.slice(0, 6);
  return 'Agent ' + n;
}

function emptyRoot(rootId) {
  return {
    rootId: rootId,
    enabled: false,
    task: '',
    epoch: 1,
    label: '',
    lastActivityAt: 0,
    updatedAt: 0,
    thinking: { visible: false, sessionId: rootId, status: 'idle', action: '', reasoning: '' },
    rows: new Map(),          // `${agentId}::${lifetime}` -> row（同 Agent 新生命期独立一行/独立 ordinal）
    life: new Map(),          // agentId -> { lifetime, ordinal }：每一段生命期各有一个 permanent ordinal
    requests: new Map(),      // requestId -> { epoch, lastSeq, agentId, lifetime, at }：请求起点绑定 epoch
    actors: new Map(),        // `${agentId}::${lifetime}` -> 可信 actor-live（供晚订阅的 probe 回放）
    disposed: new Map(),      // agentId -> 已释放的最大 lifetime（该生命期及更早的迟到事件一律拒绝）
    rootLife: 0,              // 已观测到的最高 root lifetime：进程内 lifetime 严格递增，跨 epoch 不清零
    nextOrdinal: 1,
  };
}

export function createMultiMouseRuntime(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const warn = typeof options.onWarn === 'function' ? options.onWarn : (message) => console.warn('[multi-mouse-runtime]', message);
  const dir = dataDirOf(options);
  const modeFile = options.modeFile || join(dir, 'multi-mouse-mode.json');
  const companionFile = options.companionFile || join(dir, 'companion-live.json');
  // 指针状态文件的规范路径：由 probe 的 writer 写、由它启动的 C# helper 读；runtime 本身从不写这个文件。
  // 用进程号命名，避免多个 DSH 进程共用同一 home 目录时互相覆盖；probe 必须用 runtime.pointerStatePath()。
  const pointerStateFile = options.pointerStateFile || join(dir, 'pointer-state-' + process.pid + '.json');

  const roots = new Map();
  const listeners = { mode: new Set(), companion: new Set(), action: new Set(), reset: new Set(), 'actor-live': new Set(), 'actor-disposed': new Set() };
  let closed = false;
  // 真实光标锚点由 pointer-architect 的 C# renderer 在 spawn/release 时用 GetCursorPos 采；
  // runtime 不持有同步采样器、不承诺 sampleCursor 缓存（driver.sampleCursor 是 async，旧缓存不可用）。
  // 指针写入器由 pointer-writer 在启动时挂载；runtime 不 import 它的实现，进程内回调即可。
  let pointerWriter = null;
  // 当前选中的任务 root：只由显式选择（设置页/工具显式开启）或“唯一 root”时自动选定，
  // 绝不由后台其它 root 的活动事件抢占。
  let selectedRootId = null;
  // 当前选中项是否只是“唯一 root”的自动选择；一旦出现多个 root，自动选择即失效，
  // 必须由用户/工具重新显式选择，避免设置页把不确定的 root 当成本任务。
  let autoSelected = false;
  let ambiguousRoots = false;

  const rootOf = (rootId) => {
    const id = clean(rootId, 120);
    if (!id) return null;
    let root = roots.get(id);
    if (!root) {
      root = emptyRoot(id);
      roots.set(id, root);
      if (roots.size > 1) {
        ambiguousRoots = true;
        if (autoSelected) { selectedRootId = null; autoSelected = false; }
      }
    }
    return root;
  };

  const emit = (type, payload) => {
    const set = listeners[type];
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try { fn(payload); } catch (error) { warn('listener ' + type + ' failed: ' + (error && error.message ? error.message : error)); }
    }
  };

  const atomicWrite = (file, body) => {
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, JSON.stringify(body), 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      warn('write ' + file + ' failed: ' + (error && error.message ? error.message : error));
    }
  };

  const modeSnapshot = (root) => ({ rootId: root.rootId, enabled: root.enabled, task: root.task, epoch: root.epoch });

  const persistMode = () => {
    const out = { schema: SCHEMA, selectedRootId: selectedRootId, autoSelected: autoSelected, updatedAt: now(), roots: {} };
    for (const root of roots.values()) {
      out.roots[root.rootId] = { enabled: root.enabled, task: root.task, epoch: root.epoch, label: root.label };
    }
    atomicWrite(modeFile, out);
  };

  // 只认显式选中的 root；没有选中就返回 null——多 root 时不得由“最近活动”自动抢选当前任务。
  const activeRoot = () => {
    if (!selectedRootId) return null;
    const root = roots.get(selectedRootId);
    if (!root || !root.enabled) return null;
    return root;
  };

  const rowSnapshot = (row) => ({
    ordinal: row.ordinal,
    agentId: row.agentId,
    rootId: row.rootId,
    depth: row.depth,
    lifetime: row.lifetime,
    label: row.label,
    state: row.state,
    last: row.last ? Object.assign({}, row.last) : null,
    updatedAt: row.updatedAt,
  });

  const companionBody = () => {
    const root = activeRoot();
    const updatedAt = now();
    if (!root) {
      return {
        schema: SCHEMA, epoch: 0, rootId: null, enabled: false, task: '', updatedAt: updatedAt,
        banner: { text: '', hint: '', stop: '' },
        thinking: { visible: false, sessionId: null, status: 'idle', action: '', reasoning: '' },
        rows: [],
      };
    }
    // 全量输出存活子 Agent（C# 按工作区自适应行高）；数据层已保证活人不被淘汰，
    // 这里绝不再截断，否则第 9/10 人的审计框会在写盘前就丢掉。
    const rows = Array.from(root.rows.values())
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(rowSnapshot);
    const task = root.task || '';
    return {
      schema: SCHEMA,
      epoch: root.epoch,
      rootId: root.rootId,
      enabled: root.enabled,
      task: task,
      updatedAt: updatedAt,
      banner: {
        text: task ? 'DSH正在完成' + task : 'DSH正在完成当前任务',
        hint: '连按两下 Esc 停下',
        stop: '停下',
      },
      thinking: Object.assign({}, root.thinking),
      rows: rows,
    };
  };

  const persistCompanion = () => { atomicWrite(companionFile, companionBody()); };

  // 同一 Agent 的每段生命期（lifetime）各拿一个 ordinal；重建后不复用旧编号，也不继承旧行。
  const assignOrdinal = (root, agentId, lifetime) => {
    const existing = root.life.get(agentId);
    if (existing && existing.lifetime === lifetime) return existing.ordinal;
    const ordinal = root.nextOrdinal++;
    root.life.set(agentId, { lifetime, ordinal });
    return ordinal;
  };

  const evict = (root) => {
    if (root.rows.size <= MAX_ROWS) return;
    // 只回收 done 行：活着的 Agent（acting/idle）无论多少都必须完整保留。
    const done = [];
    for (const row of root.rows.values()) if (row.state === 'done') done.push(row);
    done.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const row of done) {
      if (root.rows.size <= MAX_ROWS) break;
      root.rows.delete(row.key); // ordinal 留在 life，避免重排
    }
  };

  // 当前 root 生命期水位：网关的 lifetime 序列在进程内严格递增（src/native-tools.ts 的共享序列），
  // 所以“比已知最高值更小的 lifetime”必然是上一段 root 生命期。水位只由两处可信公告抬高，
  // 且都要求 actor 就是 root 自己（root 的动作、root 的 agent/created 公告）：深度 0 但身份不同的
  // 动作不算，免得把真 root 的销毁误判成旧生命期而放过它。上次销毁也记一笔，重复的旧 disposal 便幂等。
  // publishMode 切换 epoch 会清空 life/actors/disposed，这里的 rootLife 故意不清：否则切任务之后
  // 旧生命期的迟到 disposal 又会把新框抹掉。进程重启后水位从 0 开始（不落盘），此时 root 尚未开启、
  // thinking 也已重置，迟到 disposal 最多清掉一个空的 idle 框，不会丢真实文本。
  const noteRootLife = (root, lifetime) => {
    if (Number.isInteger(lifetime) && lifetime > root.rootLife) root.rootLife = lifetime;
  };

  const runtime = {
    /** 当前 root 的任务开关快照；未见过该 root 时返回默认关闭、epoch 1。 */
    getMode(rootId) {
      const root = roots.get(clean(rootId, 120));
      return root ? modeSnapshot(root) : { rootId: clean(rootId, 120), enabled: false, task: '', epoch: 1 };
    },

    /** 显式 dispose 后为 true；getMultiMouseRuntime 不会再返回这个实例。 */
    isClosed() { return closed; },

    /**
     * 主对话思考数据源：Activity 把当前选中且 enabled root 的真实流式文本写进 Companion.thinking。
     * 只更新 root 自己的 thinking，绝不接收子 Agent 文本；未开启/未知 root 返回 null。
     */
    publishRootThinking(rootId, patch) {
      if (closed) return null;
      const root = roots.get(clean(rootId, 120));
      if (!root || !root.enabled) return null;
      const p = patch && typeof patch === 'object' ? patch : {};
      const next = Object.assign({}, root.thinking, {
        visible: true,
        sessionId: root.rootId,
        status: clean(p.status, 24) || root.thinking.status || 'thinking',
        action: clean(p.action, MAX_LABEL) || root.thinking.action || '',
        reasoning: clean(p.reasoning, 1200),
      });
      if (typeof p.reply === 'string') next.reply = clean(p.reply, 1200);
      if (Number.isSafeInteger(p.step)) next.step = p.step;
      if (typeof p.intent === 'string') next.intent = clean(p.intent, 300);
      next.updatedAt = now();
      root.thinking = next;
      root.updatedAt = now();
      persistCompanion();
      emit('companion', Object.assign({ rootId: root.rootId }, companionBody()));
      return Object.assign({}, next);
    },

    /** 合并式更新某个 root 的开关。enabled 发生变化 → epoch++，并清空旧 Companion 行。 */
    publishMode(rootId, patch) {
      if (closed) return null;
      const root = rootOf(rootId);
      if (!root) return null;
      const beforeEnabled = root.enabled;
      const beforeTask = root.task;
      const patchObj = patch && typeof patch === 'object' ? patch : {};
      if (typeof patchObj.enabled === 'boolean') root.enabled = patchObj.enabled;
      if (typeof patchObj.task === 'string') root.task = clean(patchObj.task, MAX_TASK);
      // 任务切换（enabled 不变、task 变了）也要 epoch++ 并清行，防止上一任务的迟到事件污染新任务。
      if (root.enabled !== beforeEnabled || root.task !== beforeTask) {
        root.epoch += 1;
        root.rows.clear();
        root.life.clear();
        root.actors.clear();
        root.disposed.clear();
        // 保留 requests 绑定：任务切换后旧 requestId 仍应命中旧 epoch 并被丢弃，
        // 若清空会被旧事件的后续 phase 重新绑定成“当前 epoch”而漏进来。
        root.nextOrdinal = 1;
        root.thinking = { visible: root.enabled, sessionId: root.rootId, status: 'idle', action: '', reasoning: '' };
        // 通知指针层整批释放该 root 的旧指针（epoch 变了，旧指针不得残留）。
        emit('reset', {
          rootId: root.rootId,
          epoch: root.epoch,
          enabled: root.enabled,
          reason: root.enabled !== beforeEnabled ? (root.enabled ? 'enabled' : 'disabled') : 'task',
          at: now(),
        });
      }
      // 显式开启某个 root 即视为选中它（模型明确对它开任务，不是后台抢选）。
      if (patchObj.enabled === true) { selectedRootId = root.rootId; autoSelected = false; }
      root.updatedAt = now();
      if (!root.lastActivityAt && root.enabled) root.lastActivityAt = root.updatedAt;
      const snapshot = modeSnapshot(root);
      persistMode();
      persistCompanion();
      emit('mode', snapshot);
      emit('companion', Object.assign({ rootId: root.rootId }, companionBody()));
      return snapshot;
    },

    /** 登记一个活跃 root（供设置页选择“本任务”；不改开关）。 */
    observeRoot(info) {
      if (closed) return null;
      const root = rootOf(info && info.rootId);
      if (!root) return null;
      const at = num(info && info.at) != null ? num(info && info.at) : now();
      root.lastActivityAt = Math.max(root.lastActivityAt || 0, at);
      if (info && typeof info.label === 'string' && info.label) root.label = clean(info.label, MAX_LABEL);
      // 只有在从未出现过多个 root、且当前唯一 root 时自动选中（无歧义）；
      // 多 root 必须由用户/工具显式选择。
      if (selectedRootId == null && !ambiguousRoots && roots.size === 1) { selectedRootId = root.rootId; autoSelected = true; }
      root.updatedAt = now();
      persistMode();
      return modeSnapshot(root);
    },

    /** 消费一条真实 ActionEvent。root 未开启时只登记活跃度、不产生指针/Companion 行。 */
    publishAction(rawEvent) {
      if (closed) return null;
      const evt = normalizeActionEvent(rawEvent);
      if (!evt) return null;
      // 身份与深度自相矛盾：depth 0 表示“root 自己”，但 agentId 不是 rootId。
      // 不能假设生产者永远一致（native 侧 depthOf 缺失/非法会回退 0），所以在写任何状态
      // （root 创建、活跃度、请求绑定、生命期水位、主思考、子行）之前直接拒绝。
      if (evt.depth === 0 && evt.agentId !== evt.rootId) return null;
      const root = rootOf(evt.rootId);
      if (!root) return null;
      const rawEpoch = Number.isInteger(rawEvent.epoch) && rawEvent.epoch > 0 ? rawEvent.epoch : null;
      let binding = root.requests.get(evt.requestId);
      if (!binding) {
        // 请求在首个 phase 绑定当时的任务 epoch；之后每个 phase 必须带同一 epoch。
        // 不可只校验“可选 rawEvent.epoch”，否则不带 epoch 的旧任务事件会漏进来。
        binding = { epoch: rawEpoch != null ? rawEpoch : root.epoch, lastSeq: -1, agentId: evt.agentId, lifetime: evt.lifetime, at: now() };
        root.requests.set(evt.requestId, binding);
        if (root.requests.size > MAX_REQUESTS) {
          const oldest = root.requests.keys().next().value;
          if (oldest !== undefined) root.requests.delete(oldest);
        }
      } else if (rawEpoch != null && rawEpoch !== binding.epoch) {
        return null; // 同一 requestId 的 epoch 不可变
      } else if (binding.agentId !== evt.agentId || binding.lifetime !== evt.lifetime) {
        return null; // requestId 不得跨 Agent / 生命期复用
      }
      // 绑定的 epoch 已不是当前任务（任务切换/关闭再开）→ 旧事件丢弃，即使事件没带 epoch。
      if (binding.epoch !== root.epoch) return null;
      if (evt.seq <= binding.lastSeq) return null; // 重复或回退的 seq
      // 转发给指针/Companion 的事件带上请求绑定的实际 epoch（未带 epoch 时也能识别任务切换）。
      evt.epoch = binding.epoch;
      binding.lastSeq = evt.seq;
      binding.at = now();
      root.lastActivityAt = now();
      const isRoot = evt.agentId === root.rootId || evt.depth === 0;
      const rootLife = isRoot ? root.life.get(root.rootId) : null;
      const knownLife = isRoot ? null : root.life.get(evt.agentId);
      // 旧生命期事件在 emit 之前丢弃：指针/Companion 订阅者不应看到幽灵动作。
      // root 自己的判定用水位而不是 root.life：root.life 只在 root 的动作到达时才更新，水位还包括
      // agent/created 公告和上一次销毁，所以 root L1 -> L2 之后迟到的 L1 动作不会重新点亮主思考框。
      if (isRoot && evt.agentId === root.rootId) {
        if (evt.lifetime < root.rootLife) return null;
        const retired = root.disposed.get(root.rootId);
        if (retired != null && evt.lifetime <= retired) return null; // 已释放生命期的迟到动作不得复活
      } else if (isRoot) {
        // 深度 0 但身份不是 root 自己：这是调用方身份不一致的异常路径，沿用原判定，不拿 root 的水位去卡它。
        if (rootLife && evt.lifetime < rootLife.lifetime) return null;
      } else {
        if (knownLife && evt.lifetime < knownLife.lifetime) return null;
        const released = root.disposed.get(evt.agentId);
        if (released != null && evt.lifetime <= released) return null; // 已释放生命期的迟到事件不得复活
      }
      const isNewLife = !isRoot && (!knownLife || evt.lifetime > knownLife.lifetime);
      // 未开启只登记活跃度（observeRoot/lastActivityAt），不向指针/Companion 订阅者发动作。
      // 但 root 生命期水位照记：关闭期间换过生命期，随后迟到的旧 disposal 也不能抹掉重新开启后的框。
      // 只认 root 自己的身份：depth 0 但 agentId 不同的动作不抬高水位，避免把真 root 的销毁误判成旧生命期。
      if (isRoot && evt.agentId === root.rootId) noteRootLife(root, evt.lifetime);
      if (!root.enabled) return evt;
      emit('action', evt);

      if (isRoot) {
        if (!rootLife || evt.lifetime > rootLife.lifetime) root.life.set(root.rootId, { lifetime: evt.lifetime, ordinal: 0 });
        root.thinking = {
          visible: true,
          sessionId: evt.agentId,
          status: DONE_PHASES.has(evt.phase) ? 'idle' : 'acting',
          action: evt.label || evt.kind,
          reasoning: root.thinking.reasoning || '',
        };
      } else {
        const ordinal = assignOrdinal(root, evt.agentId, evt.lifetime);
        if (isNewLife) {
          // 同一 agentId 重建：丢掉旧生命期的行，但新生命期拿全新 ordinal。
          for (const key of Array.from(root.rows.keys())) {
            if (key.indexOf(evt.agentId + '::') === 0) root.rows.delete(key);
          }
        }
        const rowKey = evt.agentId + '::' + evt.lifetime;
        const prev = root.rows.get(rowKey);
        root.rows.set(rowKey, {
          key: rowKey,
          agentId: evt.agentId,
          rootId: root.rootId,
          depth: evt.depth,
          lifetime: evt.lifetime,
          ordinal: ordinal,
          label: agentLabel(evt.agentId, ordinal),
          state: DONE_PHASES.has(evt.phase) ? 'idle' : 'acting',
          last: {
            seq: evt.seq,
            phase: evt.phase,
            kind: evt.kind,
            label: evt.label || evt.kind,
            app: evt.app || (prev && prev.last ? prev.last.app : ''),
            // 只认本笔事件自己可信的 physical 点；没有就写 null，绝不让上一笔的坐标
            // 冒充新事件的 seq/phase。用 == null 判断，0 与负坐标照常保留。
            x: evt.to == null ? null : evt.to.x,
            y: evt.to == null ? null : evt.to.y,
            ok: typeof evt.ok === 'boolean' ? evt.ok : null, // 未知结果不冒充成功
            reason: evt.reason || null,
            at: evt.at,
          },
          updatedAt: now(),
        });
        evict(root);
      }
      root.updatedAt = now();
      persistCompanion();
      emit('companion', Object.assign({ rootId: root.rootId }, companionBody()));
      return evt;
    },

    /** 生命周期：子 Agent 完成/回收 → 标 done（保留行与 ordinal，直到 epoch 变化）。 */
    markAgent(rootId, agentId, state) {
      if (closed) return null;
      const root = roots.get(clean(rootId, 120));
      if (!root) return null;
      const id = clean(agentId, 120);
      // 同一 agentId 可能有多段生命期；只标记最新（lifetime 最大）的那一行。
      const rows = Array.from(root.rows.values()).filter((r) => r.agentId === id);
      const row = rows.sort((a, b) => b.lifetime - a.lifetime)[0];
      if (!row) return null;
      row.state = clean(state, 12) || 'done';
      row.updatedAt = now();
      persistCompanion();
      emit('companion', Object.assign({ rootId: root.rootId }, companionBody()));
      return rowSnapshot(row);
    },

    /** 供设置页/工具列出现过的 root。 */
    listRoots() {
      return Array.from(roots.values()).map((root) => Object.assign(modeSnapshot(root), {
        label: root.label,
        lastActivityAt: root.lastActivityAt,
        rows: root.rows.size,
        selected: root.rootId === selectedRootId,
      })).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    },

    /** 当前显式选中的 root（可能尚未开启，供设置页显示开关状态）；无则 null。 */
    activeRootId() {
      if (!selectedRootId) return null;
      return roots.has(selectedRootId) ? selectedRootId : null;
    },

    /** 显式选择“本任务”的 root（设置页/工具调用）；未知 root 返回 null。 */
    selectRoot(rootId) {
      if (closed) return null;
      const id = clean(rootId, 120);
      const root = roots.get(id);
      if (!root) return null;
      selectedRootId = id;
      autoSelected = false;
      root.updatedAt = now();
      persistMode();
      persistCompanion();
      emit('mode', modeSnapshot(root));
      emit('companion', Object.assign({ rootId: root.rootId }, companionBody()));
      return modeSnapshot(root);
    },

    /** probe 的 C# helper 与 writer 共用的指针状态文件；runtime 只给出路径，永远不写它。 */
    pointerStatePath() {
      return pointerStateFile;
    },

    /** 网关在 agent/created 时告知一个活 actor；只登记 root/活跃度，不产生 Companion 行（动作到达才建行）。 */
    publishActorLive(actor) {
      if (closed) return false;
      if (!actor || typeof actor !== 'object') return false;
      if (clean(actor.trust, 16) !== 'trusted') return false;
      const rootId = clean(actor.rootAgentId != null ? actor.rootAgentId : actor.rootId, 120);
      const agentId = clean(actor.agentId, 120);
      const lifetime = num(actor.lifetime);
      if (!rootId || !agentId || !Number.isInteger(lifetime) || lifetime <= 0) return false;
      const root = rootOf(rootId);
      if (!root) return false;
      root.lastActivityAt = Math.max(root.lastActivityAt || 0, now());
      if (selectedRootId == null && !ambiguousRoots && roots.size === 1) { selectedRootId = root.rootId; autoSelected = true; }
      persistMode();
      // probe 只用可信 lifecycle 建 label/身份，不再从裸 agent/created 自算 lifetime/depth。
      // 同一 actor 可能重复公告（overlay 晚加载/agent 启动）；这里按 agentId+lifetime 去重，
      // 并保留最近集合：晚订阅的 probe 会在 subscribe('actor-live') 时收到回放。
      const event = {
        rootId: rootId, agentId: agentId, rootAgentId: rootId, depth: num(actor.depth) || 0,
        lifetime: lifetime, trust: 'trusted', at: now(),
        actor: { trust: 'trusted', agentId: agentId, rootAgentId: rootId, depth: num(actor.depth) || 0, lifetime: lifetime },
      };
      if (agentId === root.rootId) noteRootLife(root, lifetime);
      const key = agentId + '::' + lifetime;
      if (root.actors.has(key)) return true;
      root.actors.set(key, event);
      emit('actor-live', event);
      return true;
    },

    /** pointer-writer 启动时挂载自己的 dispose(actor)，runtime 不 import 其实现。返回解绑函数。 */
    attachPointerWriter(writer) {
      if (closed) return () => {};
      const next = writer && typeof writer.dispose === 'function' ? writer : null;
      pointerWriter = next;
      return () => { if (pointerWriter === next) pointerWriter = null; };
    },

    /** 网关在 agent/disposed 时调用：释放该 actor 的指针与 Companion 行；未知 root 返回 false。
     *  不接收/不编造光标坐标：release 的淡出锚点由 renderer 在该 seq 用 GetCursorPos 实采。 */
    publishActorDisposed(actor) {
      if (closed) return false;
      if (!actor || typeof actor !== 'object') return false;
      if (clean(actor.trust, 16) !== 'trusted') return false;
      const rootId = clean(actor.rootAgentId != null ? actor.rootAgentId : actor.rootId, 120);
      const agentId = clean(actor.agentId, 120);
      const lifetime = num(actor.lifetime);
      if (!rootId || !agentId || !Number.isInteger(lifetime) || lifetime <= 0) return false;
      const root = roots.get(rootId);
      if (!root) return false;
      let changed = false;
      // 先判“这段生命期是不是当前 root”，再写 disposed：本次销毁自己不算已知的更新生命期。
      const staleRootLife = agentId === rootId && lifetime < root.rootLife;
      const released = root.disposed.get(agentId);
      if (released == null || lifetime > released) root.disposed.set(agentId, lifetime);
      root.actors.delete(agentId + '::' + lifetime);
      for (const [key, row] of Array.from(root.rows.entries())) {
        if (row.agentId === agentId && row.lifetime === lifetime) { root.rows.delete(key); changed = true; }
      }
      // 保留 life 里的 ordinal 记录：同一 agentId 的旧生命期迟到事件仍应被拒绝，新生命期另取新号。
      // 只有“当前 root 生命期”的销毁才隐藏主思考框：root L1 -> L2 -> L2 已在写思考时，迟到的 L1
      // disposal 若照样隐藏，会把新框和正文一起抹掉，还会向 Companion 推一条误导性的空状态。
      // 旧生命期仍照常释放指针、照常发 actor-disposed（事件本身是真实的），只是不动新框。
      // 取舍：新根已公告但还没写自己的思考时，框里留的是上一段生命期的文本（status 也不改），
      // 由新根第一条动作/思考或它自己的 disposal 收尾；要按“这段文本由哪个生命期写的”精确收尾，
      // 需要给 thinking 记一个 owner lifetime，属于另一处内部状态，不在本次最小修复范围内。
      if (agentId === rootId) {
        noteRootLife(root, lifetime);
        if (!staleRootLife && root.thinking.visible) { root.thinking = Object.assign({}, root.thinking, { visible: false, status: 'idle' }); changed = true; }
      }
      if (changed) {
        root.updatedAt = now();
        persistCompanion();
        emit('companion', Object.assign({ rootId: root.rootId }, companionBody()));
      }
      emit('actor-disposed', { rootId: root.rootId, agentId: agentId, lifetime: lifetime, depth: num(actor.depth) || 0, at: now() });
      if (pointerWriter) {
        try { pointerWriter.dispose(actor); } catch (error) { warn('pointer writer dispose failed: ' + (error && error.message ? error.message : error)); }
      }
      return true;
    },

    subscribe(type, fn) {
      if (closed) return () => {};
      const set = listeners[type];
      if (!set || typeof fn !== 'function') return () => {};
      set.add(fn);
      // 晚订阅的 probe 也能拿到在当前进程内已公告的活 actor（gateway 可能先于 probe 启动）。
      if (type === 'actor-live') {
        for (const root of roots.values()) {
          for (const event of root.actors.values()) {
            try { fn(event); } catch (error) { warn('listener actor-live replay failed: ' + (error && error.message ? error.message : error)); }
          }
        }
      }
      return () => set.delete(fn);
    },

    /** 强制把当前状态落盘（测试与 dispose 前使用）。 */
    flush() { if (closed) return; persistMode(); persistCompanion(); },

    /**
     * 显式释放（进程整体结束/测试）。这是终态操作：先把每个 root 置为关闭并落盘，
     * 对订阅者发 reset/mode/companion，让指针层清屏，然后才清监听器。
     * 设置插件不得调用它；旧 gateway/probe 的引用会失效，新的 getMultiMouseRuntime 返回全新实例。
     */
    dispose() {
      if (closed) return;
      closed = true;
      const resets = [];
      for (const root of roots.values()) {
        root.enabled = false;
        root.epoch += 1;
        root.thinking = { visible: false, sessionId: root.rootId, status: 'idle', action: '', reasoning: '' };
        root.rows.clear();
        root.life.clear();
        root.actors.clear();
        root.requests.clear();
        root.disposed.clear();
        root.nextOrdinal = 1;
        root.updatedAt = now();
        resets.push({ rootId: root.rootId, epoch: root.epoch, enabled: false, task: root.task, reason: 'dispose', at: now() });
      }
      // 必须先落盘再清 roots：mode 文件里所有任务都为 off，companion 为空，不给重启留常驻状态。
      persistMode();
      persistCompanion();
      for (const info of resets) {
        emit('reset', info);
        emit('mode', { rootId: info.rootId, enabled: false, task: info.task, epoch: info.epoch });
      }
      emit('companion', companionBody());
      for (const set of Object.values(listeners)) set.clear();
      roots.clear();
      pointerWriter = null;
    },

    // 便于测试/调试，不对外承诺稳定。
    _files: { modeFile: modeFile, companionFile: companionFile, dir: dir },
    _companionBody: companionBody,
  };

  // 启动时恢复上次落盘的 root 开关与选中项（别的进程/上一会话可能已写），
  // 否则整插件重启会把已开启的任务和选中态清空。
  try {
    const saved = JSON.parse(readFileSync(modeFile, 'utf8'));
    if (saved && saved.roots && typeof saved.roots === 'object') {
      for (const [id, value] of Object.entries(saved.roots)) {
        const root = rootOf(id);
        if (!root || !value || typeof value !== 'object') continue;
        if (typeof value.task === 'string') root.task = clean(value.task, MAX_TASK);
        if (Number.isInteger(value.epoch) && value.epoch > 0) root.epoch = value.epoch;
        if (typeof value.label === 'string') root.label = clean(value.label, MAX_LABEL);
        // 不恢复 enabled：A15 要求默认关闭。旧会话留下的 enabled=true 不得让重启后的电脑自动常驻多鼠标，
        // 只有当前活 root 明确启用（模型 multi_mouse 或设置页勾选）后才重新出现。
        root.enabled = false;
        root.thinking = { visible: false, sessionId: root.rootId, status: 'idle', action: '', reasoning: '' };
      }
    }
    if (saved && typeof saved.selectedRootId === 'string' && roots.has(saved.selectedRootId)) {
      selectedRootId = saved.selectedRootId;
      autoSelected = saved.autoSelected === true && !ambiguousRoots;
      if (!autoSelected && saved.autoSelected === true) selectedRootId = null;
    }
  } catch { /* 没有旧文件或解析失败：从空状态开始 */ }

  if (!closed) { persistMode(); persistCompanion(); }
  return runtime;
}

let singleton = null;

/** 进程级单例：gateway 与 activity 必须共用同一实例（串行 epoch / 单文件写入）。
 *  显式 dispose 后旧实例是终态，不能让后续消费者拿到无声死实例；此处重建，
 *  但设置插件卸载不应走到这里（它只释放自己的订阅，绝不 dispose 共享 runtime）。 */
export function getMultiMouseRuntime(options = {}) {
  if (!singleton || (typeof singleton.isClosed === 'function' && singleton.isClosed())) {
    singleton = createMultiMouseRuntime(options);
  }
  return singleton;
}

/** 仅测试用：丢弃并释放单例（显式 dispose 会落盘 off + 发 reset）。 */
export function resetMultiMouseRuntime() {
  const old = singleton;
  singleton = null;
  if (old && typeof old.dispose === 'function') {
    try { old.dispose(); } catch { /* 测试清理不阻断 */ }
  }
}
