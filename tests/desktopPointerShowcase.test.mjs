import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PHASES,
  FALLBACK_COLORS,
  analyzeFrameHashes,
  analyzeMotionCadence,
  assessPresentation,
  buildAgentGeometry,
  buildState,
  checkLivePointers,
  createDeadlineScheduler,
  deriveFfprobe,
  frameCountFor,
  helperStillLive,
  helpText,
  intervalStats,
  normalizeVisuals,
  parseArgs,
  parseFraction,
  parseFrameHashOutput,
  parseFrameTraceJsonl,
  parseHelperReady,
  parseTimelineJsonl,
  positionAt,
  resolveConfig,
  resolveVideoSize,
  scenePhaseAt,
  stopChild,
  summarizeFrameTrace,
  summarizeVideoMetadata,
  summarizeWriteCadence,
  validateIdentityMapping,
  visualsFingerprint,
  visualsMaxDisplacement,
} from '../scripts/multi-pointer-showcase.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(name, id, label, color, beforeIds, afterIds) {
  return { agentName: name, pointer: { id, label, color }, beforeIds, afterIds };
}

function makeValidIdentity() {
  const agents = [
    makeAgent('prism-01', 'p1', 'Agent 1 - aaa111', '#111111', [], ['p1']),
    makeAgent('prism-02', 'p2', 'Agent 2 - bbb222', '#222222', ['p1'], ['p1', 'p2']),
    makeAgent('prism-03', 'p3', 'Agent 3 - ccc333', '#333333', ['p1', 'p2'], ['p1', 'p2', 'p3']),
  ];
  const live = agents.map((a) => ({ name: a.agentName, status: 'running' }));
  return { method: 'exact creation diff', agents, live };
}

function pluginFor(identity, extraPointers = []) {
  return {
    pointers: [
      ...identity.agents.map((a) => ({ id: a.pointer.id, label: a.pointer.label, color: a.pointer.color, x: 0, y: 0 })),
      ...extraPointers,
    ],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// CLI parsing / config
// ---------------------------------------------------------------------------

test('parseArgs reads required flags and defaults', () => {
  const raw = parseArgs(['--identity', 'id.json', '--plugin-state', 'state.json', '--out', 'out-dir']);
  assert.equal(raw.identityPath, 'id.json');
  assert.equal(raw.pluginStatePath, 'state.json');
  assert.equal(raw.out, 'out-dir');
  assert.deepEqual(raw.unknown, []);
  assert.equal(raw.fps, undefined);
});

test('parseArgs supports inline equals and numeric flags', () => {
  const raw = parseArgs(['--identity=a.json', '--fps=60', '--duration-ms', '8000', '--dry-run', '--weird']);
  assert.equal(raw.identityPath, 'a.json');
  assert.equal(raw.fps, 60);
  assert.equal(raw.durationMs, 8000);
  assert.equal(raw.dryRun, true);
  assert.ok(raw.unknown.includes('--weird'));
});

test('resolveConfig requires identity, plugin-state and out for a real run', () => {
  assert.throws(() => resolveConfig({}), /--identity is required/);
  assert.throws(() => resolveConfig({ identityPath: 'a' }), /--plugin-state is required/);
  assert.throws(() => resolveConfig({ identityPath: 'a', pluginStatePath: 'b' }), /--out is required/);
});

test('resolveConfig fills defaults and derives ffprobe + even video size', () => {
  const config = resolveConfig({ identityPath: 'a.json', pluginStatePath: 'b.json', out: 'out' });
  assert.equal(config.fps, 60);
  assert.equal(config.durationMs, 8000);
  assert.equal(config.finalHoldMs, 12000);
  assert.equal(config.expectedAgents, 10);
  assert.equal(config.videoWidth, 1920);
  assert.equal(config.videoHeight, 1080);
  assert.match(config.ffprobe, /ffprobe\.exe$/i);
  assert.equal(config.frameTrace, path.join(config.out, 'frame-trace.jsonl'));
});

test('resolveConfig allows dry-run without out', () => {
  const config = resolveConfig({ identityPath: 'a.json', pluginStatePath: 'b.json', dryRun: true });
  assert.equal(config.dryRun, true);
  assert.ok(config.out.length > 0);
});

test('frameCountFor targets 480 frames for 8s at 60fps', () => {
  assert.equal(frameCountFor(8000, 60), 480);
  assert.equal(frameCountFor(12000, 60), 720);
  assert.equal(frameCountFor(8000, 30), 240);
});

test('resolveVideoSize preserves aspect and keeps dimensions even', () => {
  assert.deepEqual(resolveVideoSize({ screenWidth: 2560, screenHeight: 1440, videoWidth: 1920, videoHeight: 0 }), { width: 1920, height: 1080 });
  assert.deepEqual(resolveVideoSize({ screenWidth: 2560, screenHeight: 1440, videoWidth: 1921, videoHeight: 0 }), { width: 1920, height: 1080 });
  assert.deepEqual(resolveVideoSize({ screenWidth: 2560, screenHeight: 1440, videoWidth: 1920, videoHeight: 1081 }), { width: 1920, height: 1080 });
});

test('deriveFfprobe maps ffmpeg.exe to ffprobe.exe in the same directory', () => {
  assert.equal(deriveFfprobe('D:/ffmpeg/bin/ffmpeg.exe').replace(/\\/g, '/'), 'D:/ffmpeg/bin/ffprobe.exe');
  assert.equal(deriveFfprobe(''), 'ffprobe');
});

test('helpText documents the required flags', () => {
  const text = helpText();
  assert.match(text, /--identity/);
  assert.match(text, /--plugin-state/);
  assert.match(text, /--out/);
  assert.match(text, /--fps/);
});

// ---------------------------------------------------------------------------
// Deadline scheduler (no accumulating drift)
// ---------------------------------------------------------------------------

test('deadline scheduler emits exact absolute deadlines', async () => {
  // Fake exact clock so this stays instant (no real 8s sleep).
  let clock = 0;
  const now = () => clock;
  const sleep = (ms) => { clock += ms; return Promise.resolve(); };
  const scheduler = createDeadlineScheduler({ fps: 60, durationMs: 8000, now, sleep });
  assert.equal(scheduler.frameCount, 480);
  const frameMs = scheduler.frameMs;
  const seen = [];
  for await (const sample of scheduler.run()) seen.push(sample);
  assert.equal(seen.length, 480);
  for (let i = 0; i < seen.length; i += 1) {
    assert.ok(Math.abs(seen[i].scheduledRelMs - i * frameMs) < 1e-9);
  }
});

test('overshooting sleep does not accumulate drift across frames', async () => {
  // Fake monotonic clock: every sleep overshoots by a constant 2ms.
  let clock = 0;
  const now = () => clock;
  const sleep = (ms) => {
    clock += ms + 2;
    return Promise.resolve();
  };
  const scheduler = createDeadlineScheduler({ fps: 60, durationMs: 1000, now, sleep });
  const samples = [];
  for await (const sample of scheduler.run()) samples.push(sample);
  const frameMs = 1000 / 60;
  // Drift stays bounded near the constant overshoot instead of growing with index.
  const maxDrift = Math.max(...samples.map((s) => s.driftMs));
  assert.ok(maxDrift < 5, 'max drift bounded, got ' + maxDrift);
  const lastDrift = samples[samples.length - 1].driftMs;
  assert.ok(lastDrift < 5, 'late-frame drift did not accumulate, got ' + lastDrift);
  // Deadlines remain exact multiples regardless of sleeps.
  for (let i = 0; i < samples.length; i += 1) {
    assert.ok(Math.abs(samples[i].scheduledRelMs - i * frameMs) < 1e-9);
  }
});

test('a single huge stall is corrected on the next frame (bounded drift)', async () => {
  let clock = 0;
  let call = 0;
  const now = () => clock;
  const sleep = (ms) => {
    call += 1;
    // The third sleep stalls for 40ms extra.
    clock += ms + (call === 3 ? 40 : 0);
    return Promise.resolve();
  };
  const scheduler = createDeadlineScheduler({ fps: 60, durationMs: 500, now, sleep });
  const samples = [];
  for await (const sample of scheduler.run()) samples.push(sample);
  // After the stall frame, the following frame must catch back up rather than
  // shifting every later deadline.
  const stallIndex = samples.findIndex((s) => s.driftMs > 20);
  assert.ok(stallIndex >= 0, 'expected a stalled frame');
  // The single 40ms stall is bounded, not compounded, and the cadence recovers
  // by the end of the run instead of every later frame carrying the delay.
  const maxDrift = Math.max(...samples.map((s) => s.driftMs));
  assert.ok(maxDrift <= 45, 'max drift bounded by the one stall, got ' + maxDrift);
  const finalDrift = samples[samples.length - 1].driftMs;
  assert.ok(finalDrift < 5, 'cadence recovered by the end, drift=' + finalDrift);
});

// ---------------------------------------------------------------------------
// Identity validation
// ---------------------------------------------------------------------------

test('valid exact-diff identity maps every agent to its own live pointer', () => {
  const identity = makeValidIdentity();
  const result = validateIdentityMapping(identity, pluginFor(identity), { expectedAgents: 3 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.mapping.length, 3);
  assert.deepEqual(result.mapping.map((m) => m.id), ['p1', 'p2', 'p3']);
  assert.equal(result.mapping[0].pluginLabel, 'Agent 1 - aaa111');
});

test('missing creation diff is rejected (slot inference not allowed)', () => {
  const identity = makeValidIdentity();
  delete identity.agents[1].beforeIds;
  delete identity.agents[1].afterIds;
  const result = validateIdentityMapping(identity, pluginFor(identity), { expectedAgents: 3 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /exact creation diff required/.test(e)), JSON.stringify(result.errors));
});

test('a diff that adds more than one pointer is rejected', () => {
  const identity = makeValidIdentity();
  identity.agents[2].afterIds = ['p1', 'p2', 'p3', 'p4'];
  const result = validateIdentityMapping(identity, pluginFor(identity), { expectedAgents: 3 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /creation diff added/.test(e)));
});

test('a diff that removes a pointer is rejected', () => {
  const identity = makeValidIdentity();
  identity.agents[2].beforeIds = ['p1', 'p2', 'pX'];
  const result = validateIdentityMapping(identity, pluginFor(identity), { expectedAgents: 3 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unexpectedly removed/.test(e)));
});

test('pointer id that is not the diffed id is rejected', () => {
  const identity = makeValidIdentity();
  identity.agents[1].pointer.id = 'p9';
  const result = validateIdentityMapping(identity, pluginFor(identity), { expectedAgents: 3 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /creation diff added/.test(e)) || result.errors.some((e) => /not found/.test(e)));
});

test('a mapping to a non-live plugin pointer is rejected', () => {
  const identity = makeValidIdentity();
  const plugin = pluginFor(identity);
  plugin.pointers = plugin.pointers.filter((p) => p.id !== 'p2');
  const result = validateIdentityMapping(identity, plugin, { expectedAgents: 3 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /live plugin pointer/.test(e)));
});

test('wrong number of running live agents is rejected', () => {
  const identity = makeValidIdentity();
  identity.live[0].status = 'inactive';
  const result = validateIdentityMapping(identity, pluginFor(identity), { expectedAgents: 3 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /running count/.test(e)));
});

test('duplicate pointer ids are rejected', () => {
  const identity = makeValidIdentity();
  const plugin = pluginFor(identity);
  plugin.pointers.push({ id: 'p1', label: 'Agent 1 - aaa111', color: '#fff', x: 0, y: 0 });
  const result = validateIdentityMapping(identity, plugin, { expectedAgents: 3 });
  // Duplicate *identity* ids come from editing an agent to reuse p1.
  identity.agents[1].pointer.id = 'p1';
  identity.agents[1].afterIds = ['p1'];
  const dup = validateIdentityMapping(identity, plugin, { expectedAgents: 3 });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => /duplicate pointer id/.test(e)), JSON.stringify(dup.errors));
});

test('checkLivePointers reports missing identities', () => {
  const identity = makeValidIdentity();
  const mapping = identity.agents.map((a) => ({ id: a.pointer.id, agentName: a.agentName, pluginLabel: a.pointer.label }));
  const ok = checkLivePointers(pluginFor(identity), mapping);
  assert.equal(ok.alive, true);
  const plugin = pluginFor(identity);
  plugin.pointers.pop();
  const missing = checkLivePointers(plugin, mapping);
  assert.equal(missing.alive, false);
  assert.equal(missing.missing[0].id, 'p3');
});

// ---------------------------------------------------------------------------
// Geometry / state
// ---------------------------------------------------------------------------

test('geometry builds a start ring and an aligned row for ten agents', () => {
  const agents = Array.from({ length: 10 }, (_, i) => ({ agentName: 'a' + i, id: 'p' + i, label: 'a' + i, color: FALLBACK_COLORS[i] }));
  const geometry = buildAgentGeometry(agents, { screenWidth: 2560, screenHeight: 1440 });
  assert.equal(geometry.starts.length, 10);
  assert.equal(geometry.targets.length, 10);
  for (let i = 1; i < geometry.targets.length; i += 1) {
    assert.ok(geometry.targets[i].x > geometry.targets[i - 1].x, 'row x increases');
    assert.equal(geometry.targets[i].y, geometry.targets[0].y, 'row shares y');
  }
});

test('positions start on the ring, then settle exactly on the row targets', () => {
  const agents = Array.from({ length: 10 }, (_, i) => ({ agentName: 'a' + i, id: 'p' + i, label: 'a' + i, color: FALLBACK_COLORS[i] }));
  const geometry = buildAgentGeometry(agents, { screenWidth: 2560, screenHeight: 1440 });
  for (let i = 0; i < agents.length; i += 1) {
    const atStart = positionAt(geometry, i, 0, DEFAULT_PHASES);
    assert.equal(atStart.phase, 'hold-start');
    assert.equal(atStart.x, geometry.starts[i].x);
    assert.equal(atStart.y, geometry.starts[i].y);
    const atRow = positionAt(geometry, i, DEFAULT_PHASES.rowHoldAtMs + 1000, DEFAULT_PHASES);
    assert.equal(atRow.phase, 'row');
    assert.deepEqual({ x: atRow.x, y: atRow.y }, geometry.targets[i]);
  }
});

test('buildState emits integer coords and full pointer identity', () => {
  const agents = [
    { agentName: 'a0', id: 'p1', label: 'a0', color: '#111111' },
    { agentName: 'a1', id: 'p2', label: 'a1', color: '#222222' },
  ];
  const geometry = buildAgentGeometry(agents, { screenWidth: 2560, screenHeight: 1440 });
  const state = buildState(agents, geometry, 2000, DEFAULT_PHASES);
  assert.equal(state.pointers.length, 2);
  for (const pointer of state.pointers) {
    assert.ok(Number.isInteger(pointer.x));
    assert.ok(Number.isInteger(pointer.y));
    assert.ok(typeof pointer.id === 'string');
    assert.ok(typeof pointer.color === 'string');
  }
});

test('scenePhaseAt reports the hold, move and row phases', () => {
  assert.equal(scenePhaseAt(0), 'hold-start');
  assert.equal(scenePhaseAt(DEFAULT_PHASES.rowHoldAtMs - 10), 'move');
  assert.equal(scenePhaseAt(DEFAULT_PHASES.rowHoldAtMs), 'row');
});

// ---------------------------------------------------------------------------
// Cadence statistics
// ---------------------------------------------------------------------------

test('intervalStats and summarizeWriteCadence quantify frame cadence', () => {
  assert.equal(intervalStats([]), null);
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    samples.push({ scheduledRelMs: i * (1000 / 60), actualRelMs: i * (1000 / 60), driftMs: 0 });
  }
  const cadence = summarizeWriteCadence(samples, 60);
  assert.equal(cadence.frames, 10);
  assert.ok(Math.abs(cadence.effectiveFps - 60) < 0.5);
  assert.equal(cadence.droppedFrames, 0);
  assert.equal(cadence.lateFrames, 0);
});

test('summarizeWriteCadence flags a dropped frame when an interval doubles', () => {
  const frameMs = 1000 / 60;
  const samples = [];
  let t = 0;
  for (let i = 0; i < 6; i += 1) {
    t += i === 3 ? frameMs * 2 : frameMs;
    samples.push({ scheduledRelMs: i * frameMs, actualRelMs: t, driftMs: 0 });
  }
  const cadence = summarizeWriteCadence(samples, 60);
  assert.ok(cadence.droppedFrames >= 1);
});

// ---------------------------------------------------------------------------
// ffprobe / framehash / frame trace parsing
// ---------------------------------------------------------------------------

test('parseFraction handles rational and numeric rates', () => {
  assert.equal(parseFraction('60/1'), 60);
  assert.equal(parseFraction('60000/1001').toFixed(3), '59.940');
  assert.equal(parseFraction('30'), 30);
  assert.equal(parseFraction(''), 0);
});

test('summarizeVideoMetadata reads container fps and frame count', () => {
  const probe = {
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '60/1', r_frame_rate: '60/1', nb_frames: '480', duration: '8.0', pix_fmt: 'yuv420p' }],
    format: { duration: '8.0', size: '123456' },
  };
  const meta = summarizeVideoMetadata(probe);
  assert.equal(meta.avgFps, 60);
  assert.equal(meta.nbFrames, 480);
  assert.equal(meta.width, 1920);
  assert.match(meta.note, /Not evidence/);
});

test('parseFrameHashOutput ignores comments and keeps per-frame hashes', () => {
  const text = [
    '#version 1.0',
    '#format: framehash',
    '#stream#, dts, pts, duration, size, hash',
    '0, 0, 0, 1, 100, aabb01',
    '0, 1, 1, 1, 100, aabb01',
    '0, 2, 2, 1, 100, ccdd02',
    '0, 3, 3, 1, 100, ccdd02',
  ].join('\n');
  const hashes = parseFrameHashOutput(text);
  assert.deepEqual(hashes, ['aabb01', 'aabb01', 'ccdd02', 'ccdd02']);
  const analysis = analyzeFrameHashes(hashes);
  assert.equal(analysis.frames, 4);
  assert.equal(analysis.uniqueFrames, 2);
  assert.equal(analysis.repeatedFrames, 2);
  assert.equal(analysis.duplicateRatio, 0.5);
});

test('a continuously changing video has near-zero duplicate ratio', () => {
  const hashes = ['a', 'b', 'c', 'd', 'e'];
  const analysis = analyzeFrameHashes(hashes);
  assert.equal(analysis.repeatedFrames, 0);
  assert.equal(analysis.duplicateRatio, 0);
});

test('parseFrameTraceJsonl keeps valid entries and ignores junk', () => {
  const text = [
    'not json',
    '{"seq":0,"tMs":0,"wallMs":1000,"active":10}',
    '{"seq":1,"tMs":16.667,"wallMs":1016.667,"active":10,"visuals":[{"id":"p1","x":1,"y":2}]}',
    '{"seq":2,"bad":true}',
  ].join('\n');
  const entries = parseFrameTraceJsonl(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].seq, 1);
  assert.equal(entries[1].active, 10);
});

test('summarizeFrameTrace reports ~60fps effective and zero long gaps', () => {
  const entries = [];
  const frameMs = 1000 / 60;
  for (let i = 0; i < 480; i += 1) entries.push({ seq: i, tMs: i * frameMs, wallMs: i, active: 10 });
  const summary = summarizeFrameTrace(entries, 60);
  assert.ok(summary);
  assert.ok(Math.abs(summary.effectiveFps - 60) < 0.5);
  assert.equal(summary.longGaps, 0);
  assert.equal(summary.entries, 480);
});

test('summarizeFrameTrace counts a long gap', () => {
  const entries = [
    { seq: 0, tMs: 0, wallMs: 0, active: 10 },
    { seq: 1, tMs: 16.7, wallMs: 0, active: 10 },
    { seq: 2, tMs: 100, wallMs: 0, active: 10 },
  ];
  const summary = summarizeFrameTrace(entries, 60);
  assert.equal(summary.longGaps, 1);
});

// ---------------------------------------------------------------------------
// Presentation assessment
// ---------------------------------------------------------------------------

test('assessPresentation passes a good trace and low duplicate ratio', () => {
  const trace = { effectiveFps: 59.5, longGaps: 0, intervals: { maxMs: 20 } };
  const frames = { frames: 480, duplicateRatio: 0.02 };
  const writer = { intervals: {}, effectiveFps: 60, droppedFrames: 0, frames: 480 };
  const verdict = assessPresentation({ fps: 60, writer, trace, frames });
  assert.equal(verdict.level, 'ok', JSON.stringify(verdict.reasons));
});

test('assessPresentation warns when frames are mostly duplicates', () => {
  const frames = { frames: 480, duplicateRatio: 0.9 };
  const verdict = assessPresentation({ fps: 60, writer: null, trace: null, frames });
  assert.notEqual(verdict.level, 'ok');
  assert.ok(verdict.reasons.some((r) => /duplicateRatio/.test(r)));
});

test('assessPresentation reports unknown without trace and low duplicates', () => {
  const frames = { frames: 480, duplicateRatio: 0.01 };
  const verdict = assessPresentation({ fps: 60, writer: null, trace: null, frames });
  assert.equal(verdict.level, 'unknown');
});

// ---------------------------------------------------------------------------
// Child process teardown (fake child, nothing is spawned)
// ---------------------------------------------------------------------------

test('stopChild kills a live fake child and resolves', async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  const result = await stopChild(child, { timeoutMs: 2000, taskkill: false });
  assert.equal(result.stopped, true);
  assert.equal(child.exitCode, 0);
});

test('stopChild returns immediately for an already-exited child', async () => {
  const child = new EventEmitter();
  child.pid = 1;
  child.exitCode = 0;
  let killed = false;
  child.kill = () => { killed = true; };
  const result = await stopChild(child, { timeoutMs: 1000 });
  assert.equal(result.stopped, true);
  assert.equal(killed, false);
});

// ---------------------------------------------------------------------------
// Import purity
// ---------------------------------------------------------------------------

test('module exposes the orchestrator without starting anything on import', () => {
  // If importing had side effects (spawning the helper), this test file itself
  // would hang or fail to reach these assertions.
  assert.equal(typeof resolveConfig, 'function');
  assert.equal(typeof createDeadlineScheduler, 'function');
  assert.equal(typeof validateIdentityMapping, 'function');
});

// ---------------------------------------------------------------------------
// Visuals timeline + motion-only cadence (task-23)
// ---------------------------------------------------------------------------

function vis(id, x, y) {
  return [{ id, x, y }];
}

// Frame at time t with a single pointer at (x,y) and the given visuals array.
function frame(seq, tMs, visuals, active = 1) {
  return { seq, tMs, wallMs: 1000000 + tMs, active, visuals };
}

test('normalizeVisuals drops junk items and rounds coordinates', () => {
  const out = normalizeVisuals([
    { id: 'p1', x: 1.234567, y: '2' },
    { id: 'p2', x: 'NaN', y: 3 },
    null,
    { x: 5, y: 6 },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'p1', x: 1.235, y: 2 });
  assert.deepEqual(out[1], { id: '', x: 5, y: 6 });
  assert.deepEqual(normalizeVisuals(null), []);
  assert.deepEqual(normalizeVisuals('nope'), []);
});

test('visualsFingerprint is order-independent and changes with coordinates', () => {
  const a = [{ id: 'p1', x: 1, y: 2 }, { id: 'p2', x: 3, y: 4 }];
  const b = [{ id: 'p2', x: 3, y: 4 }, { id: 'p1', x: 1, y: 2 }];
  const c = [{ id: 'p1', x: 1, y: 2 }, { id: 'p2', x: 3, y: 5 }];
  assert.equal(visualsFingerprint(a), visualsFingerprint(b));
  assert.notEqual(visualsFingerprint(a), visualsFingerprint(c));
  assert.equal(visualsFingerprint([]), '');
});

test('visualsMaxDisplacement reports max axis delta and Infinity on id change', () => {
  assert.equal(visualsMaxDisplacement(vis('p1', 0, 0), vis('p1', 3, 4)), 4);
  assert.equal(visualsMaxDisplacement(vis('p1', 0, 0), vis('p1', 10, 2)), 10);
  assert.equal(visualsMaxDisplacement(vis('p1', 0, 0), vis('p2', 1, 1)), Number.POSITIVE_INFINITY);
  assert.equal(visualsMaxDisplacement(vis('p1', 5, 5), vis('p1', 5, 5)), 0);
});

test('parseFrameTraceJsonl preserves validated visuals id/x/y', () => {
  const text = [
    '{"seq":0,"tMs":0,"wallMs":1,"active":2,"visuals":[{"id":"p1","x":10,"y":20},{"id":"p2","x":30.5,"y":40}]}',
    '{"seq":1,"tMs":16.7,"wallMs":18,"active":2,"visuals":[]}',
    'not json',
  ].join('\n');
  const entries = parseFrameTraceJsonl(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].visuals, [
    { id: 'p1', x: 10, y: 20 },
    { id: 'p2', x: 30.5, y: 40 },
  ]);
  assert.deepEqual(entries[1].visuals, []);
});

test('analyzeMotionCadence requires visuals and reports why when missing', () => {
  const entries = [frame(0, 0, []), frame(1, 16.7, [])];
  const motion = analyzeMotionCadence(entries, { fps: 60 });
  assert.equal(motion.available, false);
  assert.match(motion.reason, /visuals/);
});

test('analyzeMotionCadence measures motion fps and excludes a 2.3s static hold with a settling nudge', () => {
  const entries = [];
  let seq = 0;
  let t = 0;
  let x = 0;
  // 30 real motion frames at 60fps (10px per ~16.67ms => 0.6 px/ms reference speed)
  for (let i = 0; i < 30; i += 1) {
    entries.push(frame(seq++, t, vis('p1', x, 100)));
    t += 1000 / 60;
    x += 10;
  }
  // One huge static hold interval (2.3s). The pointer is essentially still but
  // ends 97px away (a tiny settling nudge): must be excluded as static.
  t += 2300;
  entries.push(frame(seq++, t, vis('p1', x + 97, 100)));
  // A further short genuine motion step.
  t += 1000 / 60;
  entries.push(frame(seq++, t, vis('p1', x + 107, 100)));

  const motion = analyzeMotionCadence(entries, { fps: 60 });
  assert.equal(motion.available, true);
  assert.ok(motion.motionMedianMs <= 1000 / 60 + 1, 'motion median near one frame');
  assert.ok(motion.motionEffectiveFps > 55, 'motion fps near 60');
  assert.ok(motion.excludedStaticMs >= 2200, 'the 2.3s hold is excluded from motion');
  assert.equal(motion.longMotionGaps.length, 0, 'a static hold is not a long motion gap');
  assert.ok(motion.staticStalls.length >= 1, 'the static hold is reported as a stall');
  assert.ok(motion.staticStalls.some((x) => x.durationMs >= 2200), 'stall duration is reported');
  assert.ok(motion.motionIntervals >= 30);
});

test('analyzeMotionCadence KEEPS a genuine long gap inside continuous motion', () => {
  const entries = [];
  let seq = 0;
  let t = 0;
  let x = 0;
  for (let i = 0; i < 12; i += 1) {
    entries.push(frame(seq++, t, vis('p1', x, 200)));
    t += 1000 / 60;
    x += 10; // 0.6 px/ms
  }
  // A real 100ms stall mid-motion: displacement matches continuous motion
  // (0.6 px/ms * 100ms = 60px), so it must be counted as a real long motion gap.
  t += 100;
  x += 60;
  entries.push(frame(seq++, t, vis('p1', x, 200)));

  const motion = analyzeMotionCadence(entries, { fps: 60 });
  assert.equal(motion.available, true);
  assert.equal(motion.longMotionGaps.length, 1, 'real long motion gap is reported, not filtered');
  assert.ok(motion.longMotionGaps[0].dtMs >= 100, 'reported gap is the real interval, >= 100ms');
  assert.ok(motion.motionMaxMs >= 100);
  assert.equal(motion.staticIntervals, 0);
});

test('analyzeMotionCadence splits continuous motion into segments across static breaks', () => {
  const entries = [];
  let seq = 0;
  let t = 0;
  let x = 0;
  const push = (dx) => {
    x += dx;
    entries.push(frame(seq++, t, vis('p1', x, 10)));
  };
  push(0); // initial pose
  for (let i = 0; i < 5; i += 1) { t += 1000 / 60; push(10); }
  for (let i = 0; i < 3; i += 1) { t += 1000 / 60; entries.push(frame(seq++, t, vis('p1', x, 10))); } // static hold
  for (let i = 0; i < 5; i += 1) { t += 1000 / 60; push(10); }

  const motion = analyzeMotionCadence(entries, { fps: 60 });
  assert.equal(motion.available, true);
  assert.equal(motion.segments.length, 2, 'two motion bursts separated by a static break');
  assert.ok(motion.segments[0].distinctVisualFrames >= 2);
  assert.ok(motion.segments[0].movedPointerIds.includes('p1'));
  assert.ok(motion.segments[0].maxDisplacementPx >= 10);
  assert.ok(motion.distinctVisualFrames >= 11, 'distinct poses across both bursts are counted');
});

test('summarizeFrameTrace keeps overall fps (static included) AND reports motion fps', () => {
  const entries = [];
  let seq = 0;
  let t = 0;
  let x = 0;
  for (let i = 0; i < 30; i += 1) {
    entries.push(frame(seq++, t, vis('p1', x, 0)));
    t += 1000 / 60;
    x += 10;
  }
  // A single multi-second static hold drags the OVERALL mean interval way down
  // (this is exactly the take-01 2.3s gap that made overall 19.4fps misleading).
  t += 3000;
  entries.push(frame(seq++, t, vis('p1', x, 0)));
  const summary = summarizeFrameTrace(entries, 60);
  assert.ok(summary);
  assert.ok(summary.effectiveFps < 30, 'overall fps is dragged down by the static hold');
  assert.ok(summary.motion.available);
  assert.ok(summary.motion.motionEffectiveFps > 55, 'motion-only fps stays near 60');
  assert.ok(summary.motion.excludedStaticMs > 1500);
  assert.match(summary.note, /must NOT be quoted as the motion frame rate/);
});

test('assessPresentation gates on timeline-verified effective fps and stalls', () => {
  const goodMotion = {
    available: true,
    motionMedianMs: 16.7,
    motionEffectiveFps: 60,
    motionIntervals: 400,
    stalledMotionIntervals: 0,
    stalledMotionMs: 0,
    excludedStaticMs: 200,
    distinctVisualFrames: 420,
    timelineUsed: true,
    longMotionGaps: [],
    sustainedMotionStalls: [],
    criteria: { ok: true, measuredMotionEffectiveFps: 60, fpsPass: true, minPassFps: 54, expectedMotionAware: true, sustainedMotionStalls: 0, longMotionGaps: 0 },
  };
  const okVerdict = assessPresentation({ fps: 60, writer: null, trace: { motion: goodMotion }, frames: { frames: 480, duplicateRatio: 0 } });
  assert.equal(okVerdict.level, 'ok');
  assert.ok(okVerdict.limitations.some((r) => /submit-side evidence/.test(r)));
  assert.ok(okVerdict.limitations.some((r) => /stalledMotion/.test(r)));

  const slowMotion = {
    ...goodMotion,
    motionMedianMs: 30.7,
    motionEffectiveFps: 32.7,
    longMotionGaps: [{ dtMs: 60, displacementPx: 300, fromTMs: 100 }],
    criteria: { ok: false, measuredMotionEffectiveFps: 32.7, fpsPass: false, minPassFps: 54, expectedMotionAware: true, sustainedMotionStalls: 0, longMotionGaps: 1 },
  };
  const warnVerdict = assessPresentation({ fps: 60, writer: null, trace: { motion: slowMotion }, frames: { frames: 480, duplicateRatio: 0 } });
  assert.equal(warnVerdict.level, 'warn');
  assert.ok(warnVerdict.reasons.some((r) => /below pass floor/.test(r)));
  assert.ok(warnVerdict.reasons.some((r) => /long motion gap/.test(r)));
});


// ---- timeline-aware motion acceptance (task-23 revision) ----

function poseAt(elapsedMs) {
  if (elapsedMs < 600) return { x: 0, y: 0 };
  if (elapsedMs < 6000) return { x: (elapsedMs - 600) * 0.2, y: 0 };
  return { x: 1080, y: 0 };
}

function buildMotionTimeline() {
  const rows = [];
  for (let e = 0; e <= 8000; e += 1000 / 60) {
    const pos = poseAt(e);
    rows.push({ elapsedMs: Math.round(e * 1000) / 1000, phase: e < 600 ? 'hold-start' : e < 6000 ? 'move' : 'row', pointers: [{ id: 'p1', x: Math.round(pos.x * 1000) / 1000, y: pos.y }] });
  }
  return rows;
}

function buildMotionTrace({ presentMs, freeze }) {
  const frozenPose = poseAt(freeze ? freeze.from : 0);
  const entries = [];
  let seq = 0;
  for (let e = 0; e <= 8000; e += presentMs) {
    const inFreeze = freeze && e >= freeze.from && e < freeze.to;
    const pos = inFreeze ? frozenPose : poseAt(e);
    entries.push({ seq: seq++, tMs: Math.round(e * 1000) / 1000, wallMs: 1000000 + e, active: true, visuals: [{ id: 'p1', x: Math.round(pos.x * 1000) / 1000, y: pos.y }] });
  }
  return entries;
}

test('3s freeze inside the expected motion window counts as stalledMotion and blocks ok', () => {
  const timeline = buildMotionTimeline();
  const entries = buildMotionTrace({ presentMs: 1000 / 60, freeze: { from: 2664, to: 5664 } });
  const motion = analyzeMotionCadence(entries, { fps: 60, timeline });
  assert.equal(motion.timelineUsed, true);
  assert.equal(motion.expectedMotionAware, true);
  assert.equal(motion.clockOffsetMs, 0, 'fixture starts at the same zero, so the anchored offset must be exactly 0');
  assert.ok(motion.sustainedMotionStalls.length >= 1, 'expected at least one sustained motion stall');
  const stall = motion.sustainedMotionStalls[0];
  assert.ok(stall.durationMs >= 2900 && stall.durationMs <= 3100, 'stall duration ~3000ms, got ' + stall.durationMs);
  assert.ok(motion.stalledMotionMs >= 2900 && motion.stalledMotionMs <= 3100, 'stalledMotionMs ~3000, got ' + motion.stalledMotionMs);
  assert.ok(motion.motionEffectiveFps > 54, 'presents at ~60fps outside the freeze, got ' + motion.motionEffectiveFps);
  assert.equal(motion.criteria.fpsPass, true);
  assert.equal(motion.criteria.sustainedMotionStalls, motion.sustainedMotionStalls.length);
  assert.equal(motion.criteria.ok, false, 'a sustained mid-motion freeze must not pass even at 60fps cadence');
  const verdict = assessPresentation({ fps: 60, writer: null, trace: { motion }, frames: { frames: 480, duplicateRatio: 0 } });
  assert.equal(verdict.level, 'warn');
  assert.ok(verdict.reasons.some((r) => /sustained motion stall/.test(r)));
});

test('motion effective fps below the 54fps floor fails even with no stalls', () => {
  const timeline = buildMotionTimeline();
  const entries = buildMotionTrace({ presentMs: 20, freeze: null });
  const motion = analyzeMotionCadence(entries, { fps: 60, timeline });
  assert.equal(motion.timelineUsed, true);
  assert.ok(motion.motionEffectiveFps < 54 && motion.motionEffectiveFps > 45, 'expected ~50fps, got ' + motion.motionEffectiveFps);
  assert.equal(motion.sustainedMotionStalls.length, 0);
  assert.equal(motion.criteria.fpsPass, false);
  assert.equal(motion.criteria.ok, false);
  const verdict = assessPresentation({ fps: 60, writer: null, trace: { motion }, frames: { frames: 480, duplicateRatio: 0 } });
  assert.equal(verdict.level, 'warn');
  assert.ok(verdict.reasons.some((r) => /below pass floor/.test(r)));
});

test('an expected hold is excluded and does not count as a stall', () => {
  const timeline = buildMotionTimeline();
  const entries = buildMotionTrace({ presentMs: 1000 / 60, freeze: null });
  const motion = analyzeMotionCadence(entries, { fps: 60, timeline });
  assert.equal(motion.timelineUsed, true);
  assert.equal(motion.sustainedMotionStalls.length, 0);
  assert.ok(motion.excludedStaticMs >= 2000, 'final hold should be excluded, got ' + motion.excludedStaticMs);
  assert.equal(motion.criteria.fpsPass, true);
  assert.equal(motion.criteria.ok, true, '60fps presents with only expected holds should pass');
});

test('parseTimelineJsonl reconstructs elapsed/phase/pointers from real take rows', () => {
  const text = [
    JSON.stringify({ frame: 1, elapsedMs: 16.7, scheduledMs: 16.7, driftMs: 0, phase: 'move', pointers: [{ id: 'p1', x: 10, y: 20 }] }),
    JSON.stringify({ frame: 0, elapsedMs: 0, scheduledMs: 0, driftMs: 0, phase: 'hold-start', pointers: [{ id: 'p1', x: 0, y: 0 }] }),
  ].join('\n');
  const rows = parseTimelineJsonl(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].elapsedMs, 0);
  assert.equal(rows[1].phase, 'move');
  assert.deepEqual(rows[1].pointers, [{ id: 'p1', x: 10, y: 20 }]);
});

test('scenePhaseAt labels the post-tween settle gap only when settleAtMs is supplied', () => {
  const settleAtMs = DEFAULT_PHASES.startHoldMs + DEFAULT_PHASES.moveMs + 9 * DEFAULT_PHASES.staggerMs;
  const phases = { ...DEFAULT_PHASES, settleAtMs };
  assert.equal(scenePhaseAt(settleAtMs - 1, phases), 'move');
  assert.equal(scenePhaseAt(settleAtMs + 1, phases), 'settle');
  assert.equal(scenePhaseAt(DEFAULT_PHASES.rowHoldAtMs, phases), 'row');
  assert.equal(scenePhaseAt(DEFAULT_PHASES.rowHoldAtMs - 10), 'move');
});

test('parseHelperReady accepts current refresh + first-present logs and requires capture', () => {
  const good = [
    '2026-11-26 15:00:00 refresh items=10 visuals=10 allowCapture=True',
    '2026-11-26 15:00:01 first present visuals=10',
  ].join('\n');
  const ready = parseHelperReady(good, 10);
  assert.equal(ready.ready, true);
  assert.equal(ready.format, 'current');
  assert.equal(ready.refreshItems, 10);
  assert.equal(ready.allowCapture, true);
  assert.equal(ready.firstPresentVisuals, 10);

  const denied = parseHelperReady('refresh items=10 visuals=10 allowCapture=False\nfirst present visuals=10', 10);
  assert.equal(denied.ready, false);
  assert.match(denied.reason, /allowCapture=False/);
  const wrong = parseHelperReady('refresh items=9 visuals=9 allowCapture=True\nfirst present visuals=9', 10);
  assert.equal(wrong.ready, false);
  assert.match(wrong.reason, /not 10/);
  const waiting = parseHelperReady('refresh items=10 visuals=10 allowCapture=True', 10);
  assert.equal(waiting.ready, false);
  assert.match(waiting.reason, /first present/);
  const legacy = parseHelperReady('overlay ready: presented 10 visuals', 10);
  assert.equal(legacy.ready, true);
  assert.equal(legacy.format, 'legacy');
});

test('helperStillLive tracks an exited or killed helper', () => {
  const live = { exitCode: null, killed: false };
  assert.equal(helperStillLive(live), true);
  assert.equal(helperStillLive({ exitCode: 0, killed: false }), false);
  assert.equal(helperStillLive({ exitCode: null, killed: true }), false);
  assert.equal(helperStillLive(null), false);
});

test('a freeze during a move-labelled timeline is stalled even when sampled coords match', () => {
  const timeline = [];
  for (let i = 0; i <= 480; i += 1) {
    const e = i * 1000 / 60;
    timeline.push({ elapsedMs: Math.round(e * 1000) / 1000, phase: e < 600 ? 'hold-start' : e < 6000 ? 'move' : 'row', pointers: [{ id: 'p1', x: 0, y: 0 }] });
  }
  const entries = [];
  for (let i = 0; i <= 480; i += 1) {
    const e = i * 1000 / 60;
    entries.push({ seq: i, tMs: Math.round(e * 1000) / 1000, wallMs: 1000 + e, active: true, stateVersion: 7, visuals: [{ id: 'p1', x: 0, y: 0 }] });
  }
  const motion = analyzeMotionCadence(entries, { fps: 60, timeline });
  assert.equal(motion.expectedMotionAware, true);
  assert.ok(motion.sustainedMotionStalls.length >= 1, 'move phase with identical coords is still a freeze');
  assert.equal(motion.criteria.ok, false);
  assert.equal(motion.traceDiagnostics.seqContinuous, true);
  assert.equal(motion.traceDiagnostics.stateVersionFlat, true);
  assert.equal(motion.sustainedMotionStalls[0].seqContinuous, true);
  assert.equal(motion.sustainedMotionStalls[0].stateVersionStart, 7);
  assert.equal(motion.sustainedMotionStalls[0].stateVersionAdvanced, 0);
  assert.equal(motion.sustainedMotionStalls[0].diagnosis, 'state-version-flat-no-new-state');
});

test('parseFrameTraceJsonl reads optional stateVersion without rejecting entries', () => {
  const entries = parseFrameTraceJsonl([
    JSON.stringify({ seq: 0, tMs: 0, wallMs: 1, active: true, stateVersion: 12, visuals: [{ id: 'p1', x: 0, y: 0 }] }),
    JSON.stringify({ seq: 1, tMs: 16.7, wallMs: 2, active: true, visuals: [{ id: 'p1', x: 1, y: 0 }] }),
  ].join('\n'));
  assert.equal(entries[0].stateVersion, 12);
  assert.equal(entries[1].stateVersion, null);
  assert.equal(entries.length, 2);
});

// ---- shared wall-clock alignment (task-28) ----

function buildWallTimeline(wallOrigin = 2000000) {
  const rows = [];
  for (let e = 0; e <= 8000; e += 1000 / 60) {
    const pos = poseAt(e);
    rows.push({
      elapsedMs: Math.round(e * 1000) / 1000,
      wallMs: wallOrigin + e,
      phase: e < 600 ? 'hold-start' : e < 6000 ? 'move' : 'row',
      pointers: [{ id: 'p1', x: Math.round(pos.x * 1000) / 1000, y: pos.y }],
    });
  }
  return rows;
}

// Trace frames are offset by preDriveMs before the writer's drive start. wallMs is
// the shared host clock; tMs is deliberately skewed (tSkew) so the test proves the
// analyser uses the shared wall clock, not the first-pose / tMs anchor.
function buildWallTrace({ presentMs = 1000 / 60, freeze = null, preDriveMs = 600, wallOrigin = 2000000, tSkew = 9000 } = {}) {
  const entries = [];
  let seq = 0;
  const frozenPose = freeze ? poseAt(freeze.from) : null;
  for (let e = -preDriveMs; e <= 8000 + 1e-9; e += presentMs) {
    const inFreeze = freeze && e >= freeze.from && e < freeze.to;
    const pos = inFreeze ? frozenPose : poseAt(e < 0 ? 0 : e);
    entries.push({
      seq: seq++,
      tMs: e + tSkew,
      wallMs: wallOrigin + e,
      active: true,
      visuals: [{ id: 'p1', x: Math.round(pos.x * 1000) / 1000, y: pos.y }],
    });
  }
  return entries;
}

test('parseTimelineJsonl preserves an optional per-row wallMs and reports null when absent', () => {
  const rows = parseTimelineJsonl([
    JSON.stringify({ frame: 0, elapsedMs: 0.5, wallMs: 2000000.5, phase: 'hold-start', pointers: [{ id: 'p1', x: 0, y: 0 }] }),
    JSON.stringify({ frame: 1, elapsedMs: 17.2, phase: 'move', pointers: [{ id: 'p1', x: 2, y: 0 }] }),
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].wallMs, 2000000.5);
  assert.equal(rows[1].wallMs, null);
});

test('shared wall clock ignores a pre-drive hold and a skewed helper tMs', () => {
  const timeline = buildWallTimeline(2000000);
  const entries = buildWallTrace({ preDriveMs: 600, wallOrigin: 2000000, tSkew: 9000 });
  const motion = analyzeMotionCadence(entries, { fps: 60, timeline });
  assert.equal(motion.alignmentMode, 'wall');
  assert.equal(motion.clockAlignment.certain, true);
  assert.equal(motion.clockAlignment.mode, 'wall');
  assert.match(motion.clockAlignment.note, /Shared host wall clock/);
  assert.ok(Math.abs(motion.clockAlignment.driveStartWallMs - 2000000) <= 0.01, 'drive start wall is recovered exactly');
  assert.ok(motion.clockOffsetMs > 8000, 'helper tMs offset is only diagnostic under wall alignment');
  assert.equal(motion.intervalClock, 'wall');
  assert.ok(motion.preDriveIntervals >= 30, 'pre-drive startup hold is classified separately');
  assert.ok(motion.preDriveMs >= 560 && motion.preDriveMs <= 600, 'pre-drive hold is ~600ms (to one frame boundary), not folded into motion');
  assert.ok(motion.motionEffectiveFps > 54, 'real motion cadence is measured at ~60fps');
  assert.equal(motion.sustainedMotionStalls.length, 0);
  assert.equal(motion.criteria.ok, true);
});

test('a sustained freeze inside wall-clock motion still blocks acceptance', () => {
  const timeline = buildWallTimeline(2000000);
  const entries = buildWallTrace({ preDriveMs: 600, wallOrigin: 2000000, tSkew: 9000, freeze: { from: 2664, to: 5664 } });
  const motion = analyzeMotionCadence(entries, { fps: 60, timeline });
  assert.equal(motion.alignmentMode, 'wall');
  assert.equal(motion.criteria.fpsPass, true, 'presents at 60fps outside the freeze');
  assert.ok(motion.motionEffectiveFps > 54);
  assert.ok(motion.sustainedMotionStalls.length >= 1, 'the wall-clock freeze is a sustained motion stall');
  const longStall = motion.sustainedMotionStalls.find((s) => s.durationMs >= 2500);
  assert.ok(longStall, 'the ~3s freeze is reported');
  assert.ok(motion.stalledMotionMs >= 2500);
  assert.equal(motion.criteria.ok, false, 'freeze blocks even though fps outside it is 60');
  const verdict = assessPresentation({ fps: 60, writer: { effectiveFps: 60, frameCount: 480 }, trace: { motion, entries: entries.length, available: true }, frames: { duplicateRatio: 0 } });
  assert.equal(verdict.level, 'warn');
  assert.ok(verdict.reasons.some((r) => /sustained motion stall/.test(r)));
});

test('legacy timeline without wallMs keeps the fallback but marks alignment uncertain', () => {
  // Parse JSONL so wallMs is null (not merely undefined) — the real legacy path.
  const timeline = parseTimelineJsonl(buildMotionTimeline().map((r) => JSON.stringify(r)).join('\n'));
  assert.ok(timeline.every((r) => r.wallMs === null));
  const entries = buildMotionTrace({ presentMs: 1000 / 60 });
  const motion = analyzeMotionCadence(entries, { fps: 60, timeline });
  assert.equal(motion.alignmentMode, 'elapsed');
  assert.equal(motion.clockAlignment.certain, false);
  assert.match(motion.clockAlignment.note, /UNCERTAIN/);
  assert.ok(motion.limitations.some((l) => /wall/i.test(l)));
});


test('runShowcase summary binds driveStartedWallMs (not driveStartWallMs)', () => {
  const source = fs.readFileSync(new URL('../scripts/multi-pointer-showcase.mjs', import.meta.url), 'utf8');
  assert.match(source, /const driveStartedWallMs = Date\.now\(\);/);
  assert.match(source, /clockEvidence:\s*\{\s*driveStartedWallMs,/);
  assert.doesNotMatch(source, /clockEvidence:\s*\{\s*driveStartWallMs,/);
});
