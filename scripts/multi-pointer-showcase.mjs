#!/usr/bin/env node
/**
 * Reusable multi-pointer 60fps showcase recorder.
 *
 * Design goals
 * ------------
 * - Pure importable functions (deadline scheduling, geometry, state building,
 *   identity validation, ffprobe/framehash/trace parsers, presentation
 *   assessment). Importing this module MUST NOT spawn any process, read the
 *   filesystem or start the overlay helper.
 * - A CLI orchestrator (runShowcase / main) that:
 *     1. reads a REAL identity mapping produced by an exact per-agent creation
 *        diff (never "the most recent 10 slots"),
 *     2. writes the initial overlay state before any helper starts,
 *     3. starts the non-detached input-free overlay helper,
 *     4. drives pointer coordinates on a monotonic-clock, absolute-deadline
 *        schedule (no accumulating sleep drift) at a 60fps target,
 *     5. records the ffmpeg ddagrab capture and verifies that the recorded
 *        frames actually change (not just duplicated frames),
 *     6. always tears every child process down in a finally block.
 * - Container fps metadata is reported but never equated with real on-screen
 *   presentation; cadence, duplicate-frame ratio and the optional helper frame
 *   trace are the actual evidence.
 *
 * This module never injects real mouse/keyboard input and never mutates the
 * plugin state file.
 *
 * Optional helper frame telemetry (best effort, agreed with the render owner):
 *   env DSH_MULTI_POINTER_FRAME_TRACE=<file>
 *   Each presented frame appends one JSON line:
 *     {"seq":<int>,"tMs":<double monotonic ms>,"wallMs":<double unix ms>,"active":<int>}
 *   The demo script reads it after capture to quantify real display intervals.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Default configuration. Nothing here touches the system until runShowcase() is called. */
export const DEFAULTS = Object.freeze({
  ffmpeg: 'D:/ffmpeg/bin/ffmpeg.exe',
  ffprobe: '',
  powershell: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  helper: path.join(REPO_ROOT, 'scripts', 'multi-pointer.ps1'),
  screenWidth: 2560,
  screenHeight: 1440,
  videoWidth: 1920,
  videoHeight: 0,
  fps: 60,
  durationMs: 8000,
  finalHoldMs: 12000,
  expectedAgents: 10,
  helperTimeoutMs: 20000,
  settleMs: 500,
  frameTrace: '',
  dryRun: false,
});

/** Default animation phases (milliseconds). */
export const DEFAULT_PHASES = Object.freeze({
  startHoldMs: 600,
  moveMs: 4500,
  staggerMs: 45,
  rowHoldAtMs: 6500,
});

/** Fallback palette if neither identity nor live plugin state carries a color. */
export const FALLBACK_COLORS = Object.freeze([
  '#FF5252', '#FF9800', '#FFD600', '#8BC34A', '#00E676',
  '#00E5FF', '#448AFF', '#7C4DFF', '#E040FB', '#FF4081',
]);

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Clamp n into [0, 1]. */
export function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** Symmetric cubic ease-in-out. */
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Round to the given number of decimal places. */
export function roundTo(n, places = 3) {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

/** Linear-interpolation quantile over an already sorted ascending array. */
export function quantile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Monotonic millisecond clock (never goes backwards, unlike Date.now()). */
export function monotonicNow() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** Real sleep used by the scheduler. */
export function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Wall-clock ISO timestamp. */
export function nowIso() {
  return new Date().toISOString();
}

/** Count the exact number of frames a duration targets at a given fps. */
export function frameCountFor(durationMs, fps) {
  return Math.round((durationMs * fps) / 1000);
}

// ---------------------------------------------------------------------------
// Absolute-deadline frame scheduler (no accumulating sleep drift)
// ---------------------------------------------------------------------------

/**
 * Build a scheduler that yields one sample per frame. Deadlines are absolute
 * (start + index * frameMs); a slow or overshooting sleep only affects that
 * frame's drift and is corrected on the next frame instead of accumulating.
 *
 * options: { fps, durationMs, frameCount?, now?, sleep? }
 *   now  - injectable monotonic clock (tests)
 *   sleep - injectable sleep function (tests)
 */
export function createDeadlineScheduler(options) {
  const fps = Number(options.fps);
  const durationMs = Number(options.durationMs);
  const frameMs = 1000 / fps;
  const frameCount = options.frameCount ?? frameCountFor(durationMs, fps);
  const now = options.now ?? monotonicNow;
  const sleep = options.sleep ?? realSleep;

  return {
    fps,
    frameMs,
    frameCount,
    durationMs,
    /** Relative (to run start) scheduled time for frame index, in ms. */
    deadlineRelMs(index) {
      return index * frameMs;
    },
    async *run() {
      const startMs = now();
      for (let index = 0; index < frameCount; index += 1) {
        const scheduledRelMs = index * frameMs;
        const target = startMs + scheduledRelMs;
        const remaining = target - now();
        if (remaining > 0) await sleep(remaining);
        const actualRelMs = now() - startMs;
        yield {
          index,
          scheduledRelMs,
          actualRelMs,
          driftMs: actualRelMs - scheduledRelMs,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Identity validation: exact creation-diff mapping only
// ---------------------------------------------------------------------------

/**
 * Validate that identity maps every agent to its own pointer via an EXACT
 * single-pointer creation diff (afterIds - beforeIds === [pointer.id]) and that
 * every mapped pointer is currently live in pluginState with matching
 * id + label. Slot/recency inference is rejected on purpose.
 *
 * Returns { ok, mapping, errors }.
 */
export function validateIdentityMapping(identity, pluginState, options = {}) {
  const expectedAgents = Number(options.expectedAgents ?? 10);
  const errors = [];
  const mapping = [];

  if (!identity || typeof identity !== 'object') {
    return { ok: false, mapping, errors: ['identity object is missing'] };
  }
  const agents = Array.isArray(identity.agents) ? identity.agents : null;
  if (!agents) errors.push('identity.agents must be an array');
  const agentList = agents ?? [];
  if (agentList.length !== expectedAgents) {
    errors.push('identity.agents length ' + agentList.length + ' !== expected ' + expectedAgents);
  }

  const live = Array.isArray(identity.live) ? identity.live : [];
  if (!Array.isArray(identity.live)) errors.push('identity.live must be an array');
  const runningCount = live.filter((item) => item && item.status === 'running').length;
  if (runningCount !== expectedAgents) {
    errors.push('identity.live running count ' + runningCount + ' !== expected ' + expectedAgents);
  }

  const pluginPointers = pluginState && Array.isArray(pluginState.pointers) ? pluginState.pointers : null;
  if (!pluginPointers) errors.push('pluginState.pointers must be an array');

  const seenIds = new Set();
  const seenNames = new Set();

  for (const entry of agentList) {
    const name = entry && entry.agentName;
    if (!name) {
      errors.push('agent entry missing agentName');
      continue;
    }
    if (seenNames.has(name)) errors.push('duplicate agentName ' + name);
    seenNames.add(name);

    const pointer = entry && entry.pointer;
    if (!pointer || !pointer.id) {
      errors.push(name + ': missing pointer.id');
      continue;
    }
    const id = String(pointer.id);
    const pluginLabel = pointer.label;
    if (!pluginLabel) errors.push(name + ': missing pointer.label');

    // Exact creation diff is mandatory: this is what prevents "the 10 most
    // recent pointers" style inference.
    const before = Array.isArray(entry.beforeIds) ? entry.beforeIds : null;
    const after = Array.isArray(entry.afterIds) ? entry.afterIds : null;
    if (!before || !after) {
      errors.push(name + ': missing beforeIds/afterIds (exact creation diff required; slot inference is not allowed)');
    } else {
      const added = after.filter((item) => !before.includes(item));
      const removed = before.filter((item) => !after.includes(item));
      if (added.length !== 1 || String(added[0]) !== id) {
        errors.push(name + ': creation diff added ' + JSON.stringify(added) + ' !== [' + id + ']');
      }
      if (removed.length !== 0) {
        errors.push(name + ': creation diff unexpectedly removed ' + JSON.stringify(removed));
      }
    }

    if (seenIds.has(id)) errors.push('duplicate pointer id ' + id);
    seenIds.add(id);

    if (!pluginPointers) continue;
    const livePointer = pluginPointers.find(
      (item) => item && String(item.id) === id && item.label === pluginLabel,
    );
    if (!livePointer) {
      errors.push(name + ': live plugin pointer id=' + id + ' label=' + JSON.stringify(pluginLabel) + ' not found');
      continue;
    }
    mapping.push({
      agentName: name,
      id,
      label: name,
      pluginLabel,
      color: pointer.color || livePointer.color || '',
    });
  }

  return { ok: errors.length === 0, mapping, errors };
}

/** Check that every mapped pointer is still present live (id + plugin label). */
export function checkLivePointers(pluginState, mapping) {
  const pointers = pluginState && Array.isArray(pluginState.pointers) ? pluginState.pointers : [];
  const missing = mapping.filter(
    (m) => !pointers.some((p) => p && String(p.id) === String(m.id) && p.label === m.pluginLabel),
  );
  return {
    alive: missing.length === 0,
    missing: missing.map((m) => ({ id: m.id, agentName: m.agentName })),
  };
}

// ---------------------------------------------------------------------------
// Geometry, per-phase trajectories and overlay state
// ---------------------------------------------------------------------------

/** Build start-ring / row-target geometry scaled to the requested screen. */
export function buildAgentGeometry(agents, options) {
  const screenWidth = Number(options.screenWidth);
  const screenHeight = Number(options.screenHeight);
  const count = agents.length;
  const center = { x: screenWidth / 2, y: screenHeight / 2 };
  const ringRadiusX = options.ringRadiusX ?? screenWidth * 0.3047;
  const ringRadiusY = options.ringRadiusY ?? screenHeight * 0.3056;
  const marginX = options.marginX ?? screenWidth * 0.1172;
  const targetY = options.targetY ?? screenHeight * 0.5278;
  const span = screenWidth - 2 * marginX;
  const gap = count > 1 ? span / (count - 1) : 0;

  const starts = agents.map((_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, count);
    return {
      x: Math.round(center.x + Math.cos(angle) * ringRadiusX),
      y: Math.round(center.y + Math.sin(angle) * ringRadiusY),
    };
  });
  const targets = agents.map((_, index) => ({
    x: Math.round(marginX + index * gap),
    y: Math.round(targetY),
  }));

  return { center, ringRadiusX, ringRadiusY, marginX, targetY, gap, starts, targets };
}

/** Position + phase for a single pointer at a given elapsed time. */
export function positionAt(geometry, index, elapsedMs, phases = DEFAULT_PHASES) {
  const start = geometry.starts[index];
  const target = geometry.targets[index];
  if (!start || !target) throw new Error('positionAt: unknown pointer index ' + index);

  const local = clamp01((elapsedMs - phases.startHoldMs - index * phases.staggerMs) / phases.moveMs);
  if (elapsedMs < phases.rowHoldAtMs) {
    const eased = easeInOutCubic(local);
    const bow = Math.sin(local * Math.PI) * (index % 2 === 0 ? -34 : 34);
    const phase = local <= 0 ? 'hold-start' : local >= 1 ? 'settle' : 'move';
    return {
      x: Math.round(start.x + (target.x - start.x) * eased),
      y: Math.round(start.y + (target.y - start.y) * eased + bow),
      phase,
    };
  }
  return { x: target.x, y: target.y, phase: 'row' };
}

/** Full overlay state payload (the exact shape scripts/multi-pointer.ps1 reads). */
export function buildState(agents, geometry, elapsedMs, phases = DEFAULT_PHASES) {
  return {
    pointers: agents.map((agent, index) => {
      const position = positionAt(geometry, index, elapsedMs, phases);
      return {
        id: agent.id,
        label: agent.label,
        color: agent.color,
        x: position.x,
        y: position.y,
      };
    }),
  };
}

/** Phase of the whole scene (drives the timeline's phase label). */
export function scenePhaseAt(elapsedMs, phases = DEFAULT_PHASES) {
  if (elapsedMs < phases.startHoldMs) return 'hold-start';
  if (elapsedMs >= phases.rowHoldAtMs) return 'row';
  if (typeof phases.settleAtMs === 'number' && elapsedMs >= phases.settleAtMs) return 'settle';
  return 'move';
}

// ---------------------------------------------------------------------------
// Cadence / interval statistics
// ---------------------------------------------------------------------------

/** Summary statistics over a set of interval values (ms). */
export function intervalStats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    minMs: roundTo(sorted[0]),
    medianMs: roundTo(quantile(sorted, 0.5)),
    p95Ms: roundTo(quantile(sorted, 0.95)),
    meanMs: roundTo(mean),
    maxMs: roundTo(sorted[sorted.length - 1]),
    stddevMs: roundTo(Math.sqrt(variance)),
  };
}

/**
 * Summarise the actual writer cadence from scheduler samples.
 * samples are objects { scheduledRelMs, actualRelMs, driftMs }.
 * A frame counts as "late" when its drift exceeds one frame, and as "dropped"
 * when the observed interval exceeds 1.5 frame durations.
 */
export function summarizeWriteCadence(samples, fps) {
  const frameMs = 1000 / fps;
  const intervals = [];
  for (let i = 1; i < samples.length; i += 1) {
    intervals.push(samples[i].actualRelMs - samples[i - 1].actualRelMs);
  }
  const stats = intervalStats(intervals) ?? {};
  const driftValues = samples.map((s) => s.driftMs);
  const maxDriftMs = driftValues.length ? roundTo(Math.max(...driftValues)) : 0;
  const lateFrames = samples.filter((s) => s.driftMs > frameMs).length;
  const droppedFrames = intervals.filter((v) => v > frameMs * 1.5).length;
  return {
    frames: samples.length,
    frameMs: roundTo(frameMs),
    targetFps: fps,
    effectiveFps: stats.meanMs ? roundTo(1000 / stats.meanMs) : 0,
    intervals: stats,
    maxDriftMs,
    lateFrames,
    droppedFrames,
  };
}

// ---------------------------------------------------------------------------
// ffprobe / framehash / frame-trace parsing (all pure)
// ---------------------------------------------------------------------------

/** Parse a rational frame rate like "60/1" or "60000/1001"; returns 0 if bad. */
export function parseFraction(text) {
  if (text === undefined || text === null || text === '') return 0;
  const str = String(text);
  if (str.includes('/')) {
    const [num, den] = str.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
    return 0;
  }
  const value = Number(str);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Summarise ffprobe JSON (-print_format json -show_streams -show_format).
 * The returned fps/nb_frames are CONTAINER METADATA only and must never be
 * treated as proof of real presentation.
 */
export function summarizeVideoMetadata(probe) {
  const streams = probe && Array.isArray(probe.streams) ? probe.streams : [];
  const format = (probe && probe.format) || {};
  const stream = streams.find((s) => s && s.codec_type === 'video') || streams[0] || {};
  const avgFps = parseFraction(stream.avg_frame_rate);
  const rFps = parseFraction(stream.r_frame_rate);
  const nbFramesRaw = Number(stream.nb_frames);
  const durationSec = Number(stream.duration ?? format.duration);
  return {
    codec: stream.codec_name || '',
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    pixelFormat: stream.pix_fmt || '',
    avgFps: roundTo(avgFps || 0),
    rFps: roundTo(rFps || 0),
    nbFrames: Number.isFinite(nbFramesRaw) ? nbFramesRaw : null,
    durationSec: Number.isFinite(durationSec) ? roundTo(durationSec) : null,
    sizeBytes: Number(format.size) || null,
    note: 'Container fps/nb_frames metadata. Not evidence of real on-screen presentation.',
  };
}

/** Parse ffmpeg framehash muxer stdout into an ordered hash list. */
export function parseFrameHashOutput(text) {
  const hashes = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const hash = parts[parts.length - 1].trim();
    if (/^[0-9a-fA-F]+$/.test(hash)) hashes.push(hash.toLowerCase());
  }
  return hashes;
}

/** Count how many consecutive decoded frames are identical (a duplicate-frames signal). */
export function analyzeFrameHashes(hashes) {
  const total = hashes.length;
  let repeated = 0;
  let run = 0;
  let longestRun = 0;
  for (let i = 0; i < hashes.length; i += 1) {
    if (i > 0 && hashes[i] === hashes[i - 1]) {
      run += 1;
      repeated += 1;
    } else {
      run = 0;
    }
    if (run > longestRun) longestRun = run;
  }
  const uniqueFrames = new Set(hashes).size;
  return {
    frames: total,
    uniqueFrames,
    repeatedFrames: repeated,
    duplicateRatio: total ? roundTo(repeated / total, 4) : 0,
    longestDuplicateRun: longestRun,
    note: 'Decoded-frame hashes. A high duplicateRatio means the recording holds frames instead of moving.',
  };
}

/** Parse helper frame telemetry JSONL into validated entries. */
export function parseFrameTraceJsonl(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.tMs))) {
      entries.push({
        seq: Number.isFinite(Number(parsed.seq)) ? Number(parsed.seq) : entries.length,
        tMs: Number(parsed.tMs),
        wallMs: parsed.wallMs == null || parsed.wallMs === '' ? null : (Number.isFinite(Number(parsed.wallMs)) ? Number(parsed.wallMs) : null),
        active: Number.isFinite(Number(parsed.active)) ? Number(parsed.active) : null,
        stateVersion: parsed.stateVersion == null
          ? null
          : (Number.isFinite(Number(parsed.stateVersion)) ? Number(parsed.stateVersion) : null),
        visuals: normalizeVisuals(parsed.visuals),
      });
    }
  }
  return entries;
}

/** Parse the writer timeline JSONL into {elapsedMs, wallMs, phase, pointers} rows. */
export function parseTimelineJsonl(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.elapsedMs))) {
      rows.push({
        elapsedMs: Number(parsed.elapsedMs),
        wallMs: parsed.wallMs == null || parsed.wallMs === '' ? null : (Number.isFinite(Number(parsed.wallMs)) ? Number(parsed.wallMs) : null),
        phase: typeof parsed.phase === 'string' ? parsed.phase : '',
        pointers: normalizeVisuals(parsed.pointers || parsed.visuals),
      });
    }
  }
  return rows.sort((a, b) => a.elapsedMs - b.elapsedMs);
}

/** Normalise an optional visuals array into [{id,x,y}] with numeric coords. */
export function normalizeVisuals(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ id: item.id == null ? '' : String(item.id), x: roundTo(x), y: roundTo(y) });
  }
  return out;
}

/** Stable fingerprint of a visuals snapshot, used to detect pointer movement. */
export function visualsFingerprint(visuals) {
  if (!Array.isArray(visuals) || visuals.length === 0) return '';
  return visuals
    .map((v) => String(v.id) + ':' + v.x + ',' + v.y)
    .sort()
    .join('|');
}

/** Max per-pointer displacement (px) between two visuals snapshots. */
export function visualsMaxDisplacement(a, b) {
  const ma = new Map((a || []).map((v) => [String(v.id), v]));
  const mb = new Map((b || []).map((v) => [String(v.id), v]));
  let maxD = 0;
  const ids = new Set([...ma.keys(), ...mb.keys()]);
  for (const id of ids) {
    const pa = ma.get(id);
    const pb = mb.get(id);
    if (!pa || !pb) return Number.POSITIVE_INFINITY;
    maxD = Math.max(maxD, Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
  }
  return maxD;
}

/** Mean absolute per-axis position difference across pointer ids shared by two
 * visuals snapshots. Returns null when they share no ids. */
function pointerMeanAbsDiff(a, b) {
  const ma = new Map((a || []).map((v) => [String(v.id), v]));
  const mb = new Map((b || []).map((v) => [String(v.id), v]));
  let sum = 0;
  let n = 0;
  for (const id of ma.keys()) {
    const pa = ma.get(id);
    const pb = mb.get(id);
    if (!pa || !pb) continue;
    sum += Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

/**
 * Split helper presentation intervals into STATIC holds (no pointer movement),
 * MOTION intervals (pointers actually moved), and STALLED-MOTION intervals
 * (the writer timeline says pointers should move but the helper presented an
 * unchanged pose — a real presentation freeze, not an excusable hold).
 *
 * When options.timeline is supplied (the writer's planned coordinate timeline
 * with elapsedMs + pointers), it is used to decide what SHOULD be moving: a
 * frozen stretch inside an expected-motion window is counted as stalledMotion
 * and blocks an "ok" verdict. Only expected holds (timeline poses not moving)
 * may be excluded. Without a timeline, expected-motion coverage is unknown, so
 * "ok" cannot be granted.
 *
 * A long interval (dt > gapFactor * nominal) counts as motion ONLY when its
 * displacement is consistent with continuous motion at the reference speed
 * (>= speedTolerance * referenceSpeed * dt). Otherwise it is a static hold or
 * (if the timeline expected motion) a stalled-motion interval. This keeps a
 * genuine mid-motion gap (large proportional displacement) while dropping a
 * multi-second hold that merely ends with a small settling nudge, and it never
 * filters a long motion gap to fabricate 60fps.
 */
export function analyzeMotionCadence(entries, options = {}) {
  const expectedFps = Number(options.fps || 60);
  const nominalMs = 1000 / expectedFps;
  const gapFactor = Number(options.gapFactor || 3);
  const speedTolerance = Number(options.speedTolerance || 0.5);
  const expectedMotionMinPx = Number(options.expectedMotionMinPx || 3);
  const expectedCoverage = Number(options.expectedCoverage || 0.1);
  const minPassFps = Number(options.minPassFps || 54);
  const timelineRows = Array.isArray(options.timeline)
    ? options.timeline
        .filter((r) => r && Number.isFinite(Number(r.elapsedMs)))
        .map((r) => ({
          elapsedMs: Number(r.elapsedMs),
          wallMs: r.wallMs == null || r.wallMs === '' ? null : (Number.isFinite(Number(r.wallMs)) ? Number(r.wallMs) : null),
          phase: typeof r.phase === 'string' ? r.phase : '',
          pointers: normalizeVisuals(r.pointers || r.visuals),
        }))
        .sort((a, b) => a.elapsedMs - b.elapsedMs)
    : [];
  const timelineUsed = timelineRows.length >= 2;

  const list = Array.isArray(entries)
    ? entries.filter((e) => e && Number.isFinite(Number(e.tMs))).slice().sort((a, b) => a.tMs - b.tMs)
    : [];
  const withVisuals = list.filter((e) => Array.isArray(e.visuals) && e.visuals.length > 0);
  if (withVisuals.length < 2) {
    return {
      available: false,
      reason: withVisuals.length === 0
        ? 'no visuals in trace; cannot separate motion from static holds'
        : 'fewer than two frames carry visuals',
      expectedFps,
      nominalMs: roundTo(nominalMs),
      timelineUsed,
      clockOffsetMs: 0,
    };
  }

  // Prefer a shared wall clock when both the writer timeline and helper trace
  // carry epoch milliseconds. The writer records Date.now() on every timeline
  // sample (and driveStartWallMs in the summary); the helper records its own
  // DateTimeOffset.UtcNow wallMs per presented frame. Those are the same host
  // clock, so we can map each trace frame to the timeline by wall time and do
  // NOT infer the offset from the opening hold pose. The writer's elapsedMs is
  // still the authoritative motion schedule; wall time only anchors it.
  const wallRows = timelineRows.filter((r) => Number.isFinite(r.wallMs));
  const wallTimelineUsed = timelineUsed && wallRows.length === timelineRows.length && wallRows.length >= 2;
  const traceWallUsed = wallTimelineUsed && withVisuals.every((e) => Number.isFinite(e.wallMs));
  const alignmentMode = traceWallUsed ? 'wall' : 'elapsed';
  let driveStartWallMs = null;
  let wallOriginSpreadMs = null;
  if (wallTimelineUsed) {
    // wallMs - elapsedMs is the same drive-start epoch for every sample; a
    // large spread would mean the wall clock jumped or was sampled badly.
    const origins = wallRows.map((r) => r.wallMs - r.elapsedMs).sort((a, b) => a - b);
    const mid = origins.length % 2 === 1
      ? origins[(origins.length - 1) / 2]
      : (origins[origins.length / 2 - 1] + origins[origins.length / 2]) / 2;
    driveStartWallMs = mid;
    const deviations = origins.map((v) => Math.abs(v - mid));
    wallOriginSpreadMs = deviations.reduce((m, v) => Math.max(m, v), 0);
  }

  // Fallback for legacy recordings without wall timestamps: estimate the
  // offset between helper present times (tMs) and writer elapsedMs. This is
  // inherently ambiguous while the opening hold is static and is marked as an
  // uncertain alignment below; it must never be used to excuse a real freeze.
  const nearestTimelineRow = (elapsedMs) => {
    if (!timelineUsed) return null;
    const first = timelineRows[0];
    const last = timelineRows[timelineRows.length - 1];
    if (elapsedMs <= first.elapsedMs) return first;
    if (elapsedMs >= last.elapsedMs) return last;
    let lo = 0;
    let hi = timelineRows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timelineRows[mid].elapsedMs < elapsedMs) lo = mid + 1;
      else hi = mid - 1;
    }
    const a = timelineRows[Math.max(0, hi)];
    const b = timelineRows[Math.min(timelineRows.length - 1, lo)];
    return elapsedMs - a.elapsedMs <= b.elapsedMs - elapsedMs ? a : b;
  };
  let clockOffsetMs = 0;
  if (traceWallUsed) {
    // Diagnostic only: estimate the helper tMs value at writer drive start.
    // Motion matching below uses wall time directly, never this offset.
    const offsets = withVisuals
      .filter((e) => Number.isFinite(e.wallMs))
      .map((e) => e.tMs - (e.wallMs - driveStartWallMs))
      .sort((a, b) => a - b);
    clockOffsetMs = offsets.length ? quantile(offsets, 0.5) : 0;
  } else if (timelineUsed) {
    // Poses that actually changed since the previous presentation carry timing
    // information; a frozen stretch presents the same pose for any offset.
    const changedPoses = [];
    let prevFp = null;
    for (const e of withVisuals) {
      const fp = visualsFingerprint(e.visuals);
      if (prevFp !== null && fp !== prevFp) changedPoses.push(e);
      prevFp = fp;
    }

    // Primary anchor: the helper's first presented pose is recorded at the
    // start of recording, so match it to the EARLIEST timeline row with the same
    // pose. This captures the clock offset without removing any real initial
    // stall (anchoring on first *movement* would wrongly shift a slow-start
    // stall out of the expected-motion window).
    const first = withVisuals[0];
    let anchor = null;
    let anchorDiff = Infinity;
    // Fast, deterministic path: if the first presented pose matches the first
    // writer row, the clocks already share a zero. This avoids scanning the
    // whole opening hold (many identical rows) and keeps the estimated offset
    // exactly first.tMs - timelineRows[0].elapsedMs.
    const firstRow = timelineRows.find((row) => row.pointers.length > 0);
    if (firstRow) {
      const firstRowDiff = pointerMeanAbsDiff(first.visuals, firstRow.pointers);
      if (firstRowDiff != null && Number.isFinite(firstRowDiff) && firstRowDiff <= 1e-6) {
        anchor = firstRow;
        anchorDiff = firstRowDiff;
      }
    }
    if (!anchor) {
      for (const row of timelineRows) {
        if (!row.pointers.length) continue;
        const d = pointerMeanAbsDiff(first.visuals, row.pointers);
        if (d == null || !Number.isFinite(d)) continue;
        if (d < anchorDiff - 1e-9) {
          anchorDiff = d;
          anchor = row;
        }
      }
    }
    if (anchor && anchorDiff <= 4) {
      const off = first.tMs - anchor.elapsedMs;
      if (Number.isFinite(off) && Math.abs(off) <= 60000) clockOffsetMs = Math.round(off * 1000) / 1000;
    } else {
      // Fallback: correlate changed poses across the run by mean pose error.
      const pool = changedPoses.length >= 5 ? changedPoses : withVisuals;
      const step = Math.max(1, Math.floor(pool.length / 60));
      const samples = [];
      for (let i = 0; i < pool.length; i += step) samples.push(pool[i]);
      const candSet = new Set();
      for (const e of withVisuals.slice(0, Math.min(5, withVisuals.length))) {
        for (const row of timelineRows) candSet.add(Math.round((e.tMs - row.elapsedMs) * 1000) / 1000);
      }
      candSet.add(Math.round((withVisuals[0].tMs - timelineRows[0].elapsedMs) * 1000) / 1000);
      let best = null;
      for (const off of candSet) {
        let sum = 0;
        let used = 0;
        for (const e of samples) {
          const row = nearestTimelineRow(e.tMs - off);
          if (!row || !row.pointers.length) continue;
          const d = pointerMeanAbsDiff(e.visuals, row.pointers);
          if (d == null || !Number.isFinite(d)) continue;
          sum += d;
          used += 1;
        }
        if (!used) continue;
        const avg = sum / used;
        if (!best || avg < best.avg - 1e-9) best = { avg, off };
      }
      clockOffsetMs = best ? best.off : withVisuals[0].tMs - timelineRows[0].elapsedMs;
    }
  }
  const mapElapsed = (tMs) => tMs - clockOffsetMs;
  const entryElapsed = (entry) => (traceWallUsed ? entry.wallMs - driveStartWallMs : entry.tMs - clockOffsetMs);
  const expectedAt = (elapsedMs) => nearestTimelineRow(elapsedMs);
  const expectedDisp = (ea, eb) => {
    if (!timelineUsed) return null;
    const a = expectedAt(ea);
    const b = expectedAt(eb);
    if (!a || !b || !a.pointers.length || !b.pointers.length) return null;
    const d = visualsMaxDisplacement(a.pointers, b.pointers);
    return Number.isFinite(d) ? d : null;
  };

  const recs = [];
  for (let i = 1; i < withVisuals.length; i += 1) {
    const prev = withVisuals[i - 1];
    const cur = withVisuals[i];
    // With shared wall timestamps the wall delta is the real elapsed time. The
    // helper's tMs is kept for reporting but not used for cadence arithmetic.
    const dt = traceWallUsed && Number.isFinite(prev.wallMs) && Number.isFinite(cur.wallMs)
      ? cur.wallMs - prev.wallMs
      : cur.tMs - prev.tMs;
    const dMax = visualsMaxDisplacement(prev.visuals, cur.visuals);
    const changed = Number.isFinite(dMax) ? dMax > 0 : true;
    recs.push({
      prevIdx: i - 1,
      curIdx: i,
      prevTMs: prev.tMs,
      tMs: cur.tMs,
      prevWallMs: prev.wallMs,
      wallMs: cur.wallMs,
      dtMs: dt,
      dtClock: traceWallUsed ? 'wall' : 'helper-tMs',
      displacementPx: Number.isFinite(dMax) ? dMax : null,
      changed,
      motion: false,
      stalled: false,
      kind: 'static',
      preDrive: false,
      postTimeline: false,
      expectedDisplacementPx: null,
      expectedPhase: null,
      prevElapsedMs: null,
      elapsedMs: null,
    });
  }
  const speeds = recs
    .filter((r) => r.changed && r.dtMs > 0 && r.dtMs <= nominalMs * 2 && Number.isFinite(r.displacementPx) && r.displacementPx > 0)
    .map((r) => r.displacementPx / r.dtMs)
    .sort((a, b) => a - b);
  const referenceSpeed = speeds.length ? quantile(speeds, 0.5) : 0;

  for (const r of recs) {
    const ea = entryElapsed(withVisuals[r.prevIdx]);
    const eb = entryElapsed(withVisuals[r.curIdx]);
    r.prevElapsedMs = ea;
    r.elapsedMs = eb;
    const rowA = timelineUsed ? expectedAt(ea) : null;
    const rowB = timelineUsed ? expectedAt(eb) : null;
    const exp = timelineUsed ? expectedDisp(ea, eb) : null;
    r.expectedDisplacementPx = exp;
    r.expectedPhase = rowA && rowB
      ? (rowA.phase === rowB.phase ? rowA.phase : rowA.phase + '->' + rowB.phase)
      : (rowA ? rowA.phase : rowB ? rowB.phase : null);
    // Wall-aligned trace frames before the writer drive starts are startup
    // hold, not expected motion. Exclude them instead of turning the lead-in
    // into a fabricated motion stall. Frames after the writer's last sample
    // are the final hold for the same reason.
    if (traceWallUsed && eb < timelineRows[0].elapsedMs - nominalMs) {
      r.kind = 'static';
      r.motion = false;
      r.stalled = false;
      r.preDrive = true;
      r.expectedPhase = 'pre-drive';
      r.expectedDisplacementPx = null;
      continue;
    }
    if (traceWallUsed && ea > timelineRows[timelineRows.length - 1].elapsedMs + nominalMs) {
      r.kind = 'static';
      r.motion = false;
      r.stalled = false;
      r.postTimeline = true;
      r.expectedPhase = 'post-timeline';
      r.expectedDisplacementPx = null;
      continue;
    }
    const act = Number.isFinite(r.displacementPx) ? r.displacementPx : 0;
    // A freeze inside any interval whose NEAREST writer rows are in a motion
    // phase is a stalled presentation even when the nearest sampled coords are
    // identical (the take-01 move phase was labelled move for its whole span).
    // Expected coords are still used for displacement coverage; the phase is an
    // additional signal, never an excuse to skip a freeze.
    const expectedPhaseMoving = Boolean(
      timelineUsed && ((rowA && rowA.phase === 'move') || (rowB && rowB.phase === 'move')),
    );
    const expectedMoving = expectedPhaseMoving || (exp != null && exp >= expectedMotionMinPx);
    const insufficient = expectedMoving && act < Math.max(0.5, exp * expectedCoverage);
    if (insufficient) {
      r.kind = 'stalled';
      r.stalled = true;
      r.motion = false;
      continue;
    }
    if (!r.changed) {
      r.kind = 'static';
      r.motion = false;
    } else if (!(r.dtMs > nominalMs * gapFactor)) {
      r.kind = 'motion';
      r.motion = true;
    } else if (referenceSpeed > 0 && Number.isFinite(r.displacementPx) && r.displacementPx >= referenceSpeed * r.dtMs * speedTolerance) {
      r.kind = 'motion';
      r.motion = true;
    } else if (expectedMoving) {
      r.kind = 'stalled';
      r.stalled = true;
      r.motion = false;
    } else {
      r.kind = 'static';
      r.motion = false;
    }
  }

  const motionIntervals = recs.filter((r) => r.motion).map((r) => r.dtMs);
  const staticIntervals = recs.filter((r) => r.kind === 'static').map((r) => r.dtMs);
  const stalledIntervals = recs.filter((r) => r.stalled).map((r) => r.dtMs);
  const preDriveIntervals = recs.filter((r) => r.preDrive).map((r) => r.dtMs);
  const postTimelineIntervals = recs.filter((r) => r.postTimeline).map((r) => r.dtMs);
  const sum = (a) => a.reduce((m, v) => m + v, 0);
  const motionStats = intervalStats(motionIntervals);
  const segments = [];
  let cur = null;
  for (const r of recs) {
    if (r.motion) {
      if (!cur) {
        cur = {
          startTMs: r.prevTMs,
          endTMs: r.tMs,
          intervals: 0,
          dtSumMs: 0,
          maxDisplacementPx: 0,
          movedIds: new Set(),
          fingerprints: new Set([visualsFingerprint(withVisuals[r.prevIdx].visuals)]),
        };
      }
      cur.intervals += 1;
      cur.dtSumMs += r.dtMs;
      cur.endTMs = r.tMs;
      if (Number.isFinite(r.displacementPx)) cur.maxDisplacementPx = Math.max(cur.maxDisplacementPx, r.displacementPx);
      const prevV = new Map((withVisuals[r.prevIdx].visuals || []).map((v) => [String(v.id), v]));
      for (const v of withVisuals[r.curIdx].visuals || []) {
        const pv = prevV.get(String(v.id));
        if (!pv || pv.x !== v.x || pv.y !== v.y) cur.movedIds.add(String(v.id));
      }
      cur.fingerprints.add(visualsFingerprint(withVisuals[r.curIdx].visuals));
    } else if (cur) {
      segments.push(cur);
      cur = null;
    }
  }
  if (cur) segments.push(cur);
  const segmentReports = segments.map((sg) => {
    const durationMs = sg.endTMs - sg.startTMs;
    return {
      startTMs: roundTo(sg.startTMs),
      endTMs: roundTo(sg.endTMs),
      durationMs: roundTo(durationMs),
      intervals: sg.intervals,
      effectiveFps: durationMs > 0 ? roundTo((sg.intervals * 1000) / durationMs) : 0,
      distinctVisualFrames: sg.fingerprints.size,
      movedPointerIds: [...sg.movedIds].sort(),
      maxDisplacementPx: roundTo(sg.maxDisplacementPx),
    };
  });
  const longMotionGaps = recs
    .filter((r) => r.motion && r.dtMs > nominalMs * gapFactor)
    .map((r) => ({
      fromTMs: roundTo(r.prevTMs),
      dtMs: roundTo(r.dtMs),
      displacementPx: Number.isFinite(r.displacementPx) ? roundTo(r.displacementPx) : null,
    }));

  const stateVersionAt = (idx) => {
    const entry = withVisuals[idx];
    return entry && Number.isFinite(entry.stateVersion) ? entry.stateVersion : null;
  };
  const runSeqContinuous = (x) => {
    for (let i = x.firstIdx + 1; i <= x.lastIdx; i += 1) {
      const prevSeq = Number(withVisuals[i - 1] && withVisuals[i - 1].seq);
      const curSeq = Number(withVisuals[i] && withVisuals[i].seq);
      if (!Number.isFinite(prevSeq) || !Number.isFinite(curSeq) || curSeq - prevSeq !== 1) return false;
    }
    return true;
  };
  const runsOf = (pred) => {
    const runs = [];
    let run = null;
    for (const r of recs) {
      if (pred(r)) {
        if (!run) {
          run = {
            startTMs: r.prevTMs,
            endTMs: r.tMs,
            intervals: 0,
            dtSumMs: 0,
            maxExpectedPx: 0,
            firstIdx: r.prevIdx,
            lastIdx: r.curIdx,
          };
        }
        run.intervals += 1;
        run.dtSumMs += r.dtMs;
        run.endTMs = r.tMs;
        run.lastIdx = r.curIdx;
        if (Number.isFinite(r.expectedDisplacementPx)) run.maxExpectedPx = Math.max(run.maxExpectedPx, r.expectedDisplacementPx);
      } else if (run) {
        runs.push(run);
        run = null;
      }
    }
    if (run) runs.push(run);
    return runs;
  };
  const reportRun = (x) => {
    const stateVersionStart = stateVersionAt(x.firstIdx);
    const stateVersionEnd = stateVersionAt(x.lastIdx);
    const stateVersionAdvanced = stateVersionStart != null && stateVersionEnd != null
      ? stateVersionEnd - stateVersionStart
      : null;
    let diagnosis = 'state-version-unavailable';
    if (stateVersionAdvanced != null) {
      if (stateVersionAdvanced > 0) diagnosis = 'state-version-advanced-with-identical-pose';
      else if (stateVersionAdvanced === 0) diagnosis = 'state-version-flat-no-new-state';
      else diagnosis = 'state-version-regressed';
    }
    return {
      startTMs: roundTo(x.startTMs),
      endTMs: roundTo(x.endTMs),
      durationMs: roundTo(x.endTMs - x.startTMs),
      intervals: x.intervals,
      expectedDisplacementPx: roundTo(x.maxExpectedPx),
      seqContinuous: runSeqContinuous(x),
      stateVersionStart,
      stateVersionEnd,
      stateVersionAdvanced,
      diagnosis,
    };
  };
  const staticStallReports = runsOf((r) => r.kind === 'static')
    .filter((x) => x.dtSumMs > nominalMs * gapFactor)
    .map(reportRun);
  const stalledMotionRuns = runsOf((r) => r.stalled).map(reportRun);
  const sustainedMotionStalls = runsOf((r) => r.stalled)
    .filter((x) => x.dtSumMs > nominalMs * gapFactor)
    .map(reportRun);

  const motionMs = motionIntervals.reduce((a, b) => a + b, 0);
  const excludedStaticMs = staticIntervals.reduce((a, b) => a + b, 0);
  const stalledMotionMs = stalledIntervals.reduce((a, b) => a + b, 0);
  const allFingerprints = new Set(withVisuals.map((e) => visualsFingerprint(e.visuals)));
  const seqEntries = list.filter((e) => Number.isFinite(Number(e.seq)));
  const seqGaps = [];
  let missingSeq = 0;
  let nonMonotonicSeq = 0;
  for (let i = 1; i < seqEntries.length; i += 1) {
    const delta = Number(seqEntries[i].seq) - Number(seqEntries[i - 1].seq);
    if (delta === 1) continue;
    if (delta > 1) {
      missingSeq += delta - 1;
      seqGaps.push({ fromSeq: Number(seqEntries[i - 1].seq), toSeq: Number(seqEntries[i].seq), delta });
    } else {
      nonMonotonicSeq += 1;
    }
  }
  const stateVersions = list
    .map((e) => e.stateVersion)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const traceDiagnostics = {
    seqEntries: seqEntries.length,
    firstSeq: seqEntries.length ? Number(seqEntries[0].seq) : null,
    lastSeq: seqEntries.length ? Number(seqEntries[seqEntries.length - 1].seq) : null,
    missingSeq,
    nonMonotonicSeq,
    gaps: seqGaps,
    seqContinuous: seqEntries.length >= 2 && missingSeq === 0 && nonMonotonicSeq === 0,
    stateVersionEntries: stateVersions.length,
    stateVersionDistinct: new Set(stateVersions).size,
    stateVersionMin: stateVersions.length ? stateVersions[0] : null,
    stateVersionMax: stateVersions.length ? stateVersions[stateVersions.length - 1] : null,
    stateVersionAdvanced: stateVersions.length >= 2
      ? stateVersions[stateVersions.length - 1] - stateVersions[0]
      : null,
    stateVersionFlat: stateVersions.length >= 2
      ? new Set(stateVersions).size === 1
      : (stateVersions.length === 1 ? true : null),
  };
  const motionEffectiveFps = motionStats && motionStats.meanMs ? roundTo(1000 / motionStats.meanMs) : 0;
  const fpsPass = motionEffectiveFps >= minPassFps;
  const ok = Boolean(timelineUsed && fpsPass && sustainedMotionStalls.length === 0 && longMotionGaps.length === 0);
  const expectedMotionAware = timelineUsed;
  const clockAlignment = {
    mode: alignmentMode,
    certain: alignmentMode === 'wall',
    traceWallUsed,
    timelineWallRows: wallRows.length,
    timelineRows: timelineRows.length,
    driveStartWallMs: driveStartWallMs == null ? null : roundTo(driveStartWallMs),
    wallOriginSpreadMs: wallOriginSpreadMs == null ? null : roundTo(wallOriginSpreadMs),
    helperTMsAtDriveStart: roundTo(clockOffsetMs),
    note: alignmentMode === 'wall'
      ? 'Shared host wall clock: timeline wallMs and helper trace wallMs are matched directly; opening hold is pre-drive startup, not inferred motion.'
      : 'UNCERTAIN alignment: legacy timeline has no wallMs (or trace lacks it); clock offset is inferred from pose matching and the opening hold can be ambiguous.',
  };

  return {
    available: true,
    expectedFps,
    nominalMs: roundTo(nominalMs),
    minPassFps,
    referenceSpeedPxPerMs: roundTo(referenceSpeed),
    frames: withVisuals.length,
    intervals: recs.length,
    timelineUsed,
    expectedMotionAware,
    alignmentMode,
    clockAlignment,
    clockOffsetMs: roundTo(clockOffsetMs),
    preDriveIntervals: preDriveIntervals.length,
    preDriveMs: roundTo(sum(preDriveIntervals)),
    postTimelineIntervals: postTimelineIntervals.length,
    postTimelineMs: roundTo(sum(postTimelineIntervals)),
    intervalClock: traceWallUsed ? 'wall' : 'helper-tMs',
    motionIntervals: motionIntervals.length,
    staticIntervals: staticIntervals.length,
    stalledMotionIntervals: stalledIntervals.length,
    motionMs: roundTo(motionMs),
    excludedStaticMs: roundTo(excludedStaticMs),
    stalledMotionMs: roundTo(stalledMotionMs),
    motionEffectiveFps,
    motionMedianMs: motionStats ? motionStats.medianMs : null,
    motionP95Ms: motionStats ? motionStats.p95Ms : null,
    motionMaxMs: motionStats ? motionStats.maxMs : null,
    motionIntervalsStats: motionStats,
    staticIntervalsStats: intervalStats(staticIntervals),
    longMotionGaps,
    staticStalls: staticStallReports,
    stalledMotionRuns,
    sustainedMotionStalls,
    distinctVisualFrames: allFingerprints.size,
    traceDiagnostics,
    segments: segmentReports,
    criteria: {
      targetFps: expectedFps,
      targetFrameMs: roundTo(nominalMs),
      minPassFps,
      measuredMotionMedianMs: motionStats ? motionStats.medianMs : null,
      measuredMotionEffectiveFps: motionEffectiveFps,
      fpsPass,
      expectedMotionAware,
      sustainedMotionStalls: sustainedMotionStalls.length,
      longMotionGaps: longMotionGaps.length,
      ok,
      note: 'ok requires a timeline-verified motion effective fps >= ' + minPassFps + ' (about 90% of the 60fps target) AND zero sustained motion stalls (frozen stretches inside expected motion) AND zero long motion gaps. A 60fps target is a presentation request, not a display scan-out measurement; any frozen stretch while the timeline says pointers should move is counted as stalledMotion and blocks ok. ' + (timelineUsed ? '' : 'No timeline was supplied, so expected-motion coverage is unknown and ok cannot be granted.'),
    },
    limitations: [
      'tMs are UpdateLayeredWindow present times from the helper: submit-side evidence that the helper presented frames, NOT proof the display scanned them out. Confirm real on-screen motion from screen capture/video pixels.',
      'Expected-motion windows come from the writer timeline, not from the screen: a pose the helper never presented looks identical to a held pose, so a freeze inside expected motion is counted as stalledMotion rather than excused as a static hold.',
      'Only a timeline-verified motion fps >= ' + minPassFps + ' with no sustained motion stalls can pass; the 60fps target is a presentation goal, not a measured display scan-out rate.',
      'A decoded-video duplicateRatio near 0 or a changing desktop background does NOT prove pointer motion; only the helper visuals against the timeline does.',
      ...(alignmentMode === 'wall' ? [] : ['Legacy timeline has no shared wall clock (or the helper trace lacks wallMs): alignment is inferred from pose matching and the true start of motion can be misplaced. Record wallMs on every timeline sample for a certain alignment.']),
    ],
  };
}

/** Summarise helper presentation intervals and motion-only cadence. */
export function summarizeFrameTrace(entries, expectedFps, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.tMs - b.tMs);
  const intervals = [];
  for (let i = 1; i < sorted.length; i += 1) intervals.push(sorted[i].tMs - sorted[i - 1].tMs);
  const stats = intervalStats(intervals) ?? {};
  const nominalFrameMs = 1000 / Number(expectedFps || 60);
  const longGaps = intervals.filter((v) => v > nominalFrameMs * 2).length;
  const activeValues = sorted.map((e) => e.active).filter((v) => Number.isFinite(v));
  return {
    entries: sorted.length,
    firstTMs: roundTo(sorted[0].tMs),
    lastTMs: roundTo(sorted[sorted.length - 1].tMs),
    spanMs: roundTo(sorted[sorted.length - 1].tMs - sorted[0].tMs),
    nominalFrameMs: roundTo(nominalFrameMs),
    effectiveFps: stats.meanMs ? roundTo(1000 / stats.meanMs) : 0,
    intervals: stats,
    longGaps,
    medianActive: activeValues.length ? quantile([...activeValues].sort((a, b) => a - b), 0.5) : null,
    motion: analyzeMotionCadence(sorted, { fps: expectedFps || 60, timeline: options.timeline }),
    note: 'Overall presentation intervals (DSH_MULTI_POINTER_FRAME_TRACE). effectiveFps here INCLUDES static holds and must NOT be quoted as the motion frame rate; use motion.* for motion-only cadence. These are UpdateLayeredWindow submit times, not display scan-out; verify real motion on screen/video.',
  };
}

/**
 * Assess whether the evidence supports a real ~60fps presentation. Pure so it
 * can be unit-tested and reviewed.
 */
export function assessPresentation({ fps, writer, trace, frames }) {
  const frameMs = 1000 / fps;
  const reasons = [];
  const limitations = [];
  let level = 'unknown';

  const motion = trace && trace.motion;
  if (motion && motion.available) {
    const c = motion.criteria || {};
    const effFps = c.measuredMotionEffectiveFps != null ? c.measuredMotionEffectiveFps : motion.motionEffectiveFps;
    const minPass = c.minPassFps || 54;
    const sustained = motion.sustainedMotionStalls ? motion.sustainedMotionStalls.length : (c.sustainedMotionStalls || 0);
    const gaps = motion.longMotionGaps ? motion.longMotionGaps.length : 0;
    const aware = c.expectedMotionAware !== undefined ? c.expectedMotionAware : Boolean(motion.timelineUsed);
    const clockCertain = !(motion.clockAlignment && motion.clockAlignment.certain === false);
    const pass = c.ok === true && typeof effFps === 'number' && effFps >= minPass && sustained === 0 && gaps === 0 && clockCertain;
    if (pass) {
      level = 'ok';
      reasons.push('motion effectiveFps=' + effFps + ' >= pass floor ' + minPass + 'fps with no sustained motion stalls or long gaps (timeline-verified)');
    } else {
      level = 'warn';
      if (typeof effFps !== 'number' || effFps < minPass) reasons.push('motion effectiveFps=' + effFps + ' below pass floor ' + minPass + 'fps (~90% of the ' + fps + 'fps target)');
      if (sustained > 0) reasons.push(sustained + ' sustained motion stall(s) (' + (motion.stalledMotionMs != null ? motion.stalledMotionMs : 0) + 'ms frozen while the timeline expected motion)');
      if (gaps > 0) reasons.push(gaps + ' long motion gap(s) > 2 frames (real drops while moving, kept not filtered)');
      if (!aware) reasons.push('no writer timeline supplied: expected-motion coverage unknown, cannot pass');
      if (!clockCertain) reasons.push('clock alignment uncertain: legacy timeline has no shared wall clock, so the true start of motion cannot be certified');
    }
    reasons.push('motion samples=' + motion.motionIntervals + ', stalled ' + (motion.stalledMotionIntervals || 0) + ', excluded static ' + motion.excludedStaticMs + 'ms, distinct visuals=' + motion.distinctVisualFrames);
    limitations.push('UpdateLayeredWindow success is submit-side evidence only; it is not a display scan-out frame. Confirm real on-screen motion from screen capture/video.');
    limitations.push('Freezes inside the timeline expected-motion window are counted as stalledMotion, not excused as static holds; a 60fps target is a presentation request, not a measured display scan-out rate.');
    if (!clockCertain) limitations.push('Clock alignment is uncertain (no shared wall clock); motion timing is a fallback estimate and cannot be certified as ~60fps.');
  } else if (trace && trace.intervals) {
    const okFps = trace.effectiveFps >= fps * 0.9;
    const okGap = trace.longGaps === 0;
    const okMax = trace.intervals.maxMs <= frameMs * 3;
    if (okFps && okGap && okMax) {
      level = 'ok';
      reasons.push('overall trace effectiveFps=' + trace.effectiveFps + ' (includes static holds)');
    } else {
      level = 'warn';
      if (!okFps) reasons.push('overall trace effectiveFps=' + trace.effectiveFps + ' below target ' + fps + ' (includes static holds; motion fps unverified)');
      if (!okGap) reasons.push('overall trace has ' + trace.longGaps + ' gap(s) > 2 frames');
      if (!okMax) reasons.push('overall trace max interval ' + trace.intervals.maxMs + 'ms > 3 frames');
    }
    limitations.push('No visuals in trace: overall effectiveFps includes static holds and is not the motion frame rate.');
  } else {
    reasons.push('no helper frame trace available; display cadence unverified');
  }

  if (frames && frames.frames > 0) {
    if (frames.duplicateRatio >= 0.5) {
      if (level === 'ok') level = 'warn';
      reasons.push('duplicateRatio=' + frames.duplicateRatio + ' indicates mostly held decoded frames');
    } else {
      reasons.push('decoded duplicateRatio=' + frames.duplicateRatio + ' (unique frames; a changing background can also cause this, so it does NOT prove pointer motion)');
    }
  }

  if (writer && writer.intervals) {
    reasons.push('writer effectiveFps=' + writer.effectiveFps + ', droppedFrames=' + writer.droppedFrames);
    if (writer.droppedFrames > writer.frames * 0.25 && level === 'ok') level = 'warn';
  }

  return { level, reasons, limitations };
}

// ---------------------------------------------------------------------------
// CLI parsing / config resolution
// ---------------------------------------------------------------------------

/** Parse argv (without node/script) into a raw config. Pure. */
export function parseArgs(argv) {
  const raw = {};
  const unknown = [];
  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    let token = args[i];
    if (!token.startsWith('--')) {
      unknown.push(token);
      continue;
    }
    let inlineValue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    const key = token.slice(2);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      return args[i];
    };
    switch (key) {
      case 'identity': raw.identityPath = takeValue(); break;
      case 'plugin-state': raw.pluginStatePath = takeValue(); break;
      case 'out': raw.out = takeValue(); break;
      case 'ffmpeg': raw.ffmpeg = takeValue(); break;
      case 'ffprobe': raw.ffprobe = takeValue(); break;
      case 'powershell': raw.powershell = takeValue(); break;
      case 'helper': raw.helper = takeValue(); break;
      case 'screen-width': raw.screenWidth = Number(takeValue()); break;
      case 'screen-height': raw.screenHeight = Number(takeValue()); break;
      case 'video-width': raw.videoWidth = Number(takeValue()); break;
      case 'video-height': raw.videoHeight = Number(takeValue()); break;
      case 'fps': raw.fps = Number(takeValue()); break;
      case 'duration-ms': raw.durationMs = Number(takeValue()); break;
      case 'final-hold-ms': raw.finalHoldMs = Number(takeValue()); break;
      case 'expected-agents': raw.expectedAgents = Number(takeValue()); break;
      case 'helper-timeout-ms': raw.helperTimeoutMs = Number(takeValue()); break;
      case 'settle-ms': raw.settleMs = Number(takeValue()); break;
      case 'frame-trace': raw.frameTrace = takeValue(); break;
      case 'dry-run': raw.dryRun = true; break;
      case 'help': raw.help = true; break;
      default: unknown.push('--' + key); break;
    }
  }
  raw.unknown = unknown;
  return raw;
}

/** Derive ffprobe path from an ffmpeg path (same directory, ffprobe.exe). */
export function deriveFfprobe(ffmpegPath) {
  if (!ffmpegPath) return 'ffprobe';
  const dir = path.dirname(ffmpegPath);
  const base = path.basename(ffmpegPath).toLowerCase();
  if (base === 'ffmpeg.exe' || base === 'ffmpeg') return path.join(dir, 'ffprobe.exe');
  return 'ffprobe';
}

/** Resolve even video dimensions, preserving the screen aspect if no height is given. */
export function resolveVideoSize({ screenWidth, screenHeight, videoWidth, videoHeight }) {
  let width = Math.max(2, Math.round(Number(videoWidth) || screenWidth));
  let height;
  if (Number(videoHeight) > 0) height = Math.round(Number(videoHeight));
  else height = Math.round((width * Number(screenHeight)) / Number(screenWidth));
  if (width % 2 !== 0) width -= 1;
  if (height % 2 !== 0) height -= 1;
  return { width: Math.max(2, width), height: Math.max(2, height) };
}

/** Merge defaults, validate and normalise a raw config. Throws on invalid input. */
export function resolveConfig(raw = {}) {
  const config = { ...DEFAULTS, ...raw };
  config.dryRun = Boolean(config.dryRun);
  const errors = [];

  if (!config.identityPath) errors.push('--identity is required');
  if (!config.pluginStatePath) errors.push('--plugin-state is required');
  if (!config.out && !config.dryRun) errors.push('--out is required');

  for (const key of ['screenWidth', 'screenHeight', 'videoWidth', 'fps', 'durationMs', 'finalHoldMs', 'expectedAgents', 'helperTimeoutMs', 'settleMs']) {
    const value = Number(config[key]);
    if (!Number.isFinite(value) || value <= 0) errors.push(key + ' must be a positive number');
  }
  if (Number(config.videoHeight) < 0 || !Number.isFinite(Number(config.videoHeight))) {
    errors.push('videoHeight must be >= 0');
  }

  if (errors.length) {
    const error = new Error('invalid config: ' + errors.join('; '));
    error.errors = errors;
    throw error;
  }

  config.screenWidth = Number(config.screenWidth);
  config.screenHeight = Number(config.screenHeight);
  config.fps = Number(config.fps);
  config.durationMs = Number(config.durationMs);
  config.finalHoldMs = Number(config.finalHoldMs);
  config.expectedAgents = Number(config.expectedAgents);
  config.helperTimeoutMs = Number(config.helperTimeoutMs);
  config.settleMs = Number(config.settleMs);

  const size = resolveVideoSize(config);
  config.videoWidth = size.width;
  config.videoHeight = size.height;

  config.ffmpeg = String(config.ffmpeg || DEFAULTS.ffmpeg);
  config.ffprobe = config.ffprobe ? String(config.ffprobe) : deriveFfprobe(config.ffmpeg);
  config.powershell = String(config.powershell || DEFAULTS.powershell);
  config.helper = String(config.helper || DEFAULTS.helper);

  if (config.identityPath) config.identityPath = path.resolve(config.identityPath);
  if (config.pluginStatePath) config.pluginStatePath = path.resolve(config.pluginStatePath);

  if (config.out) config.out = path.resolve(config.out);
  else config.out = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-pointer-dry-'));

  if (config.frameTrace) config.frameTrace = path.resolve(config.frameTrace);
  else config.frameTrace = path.join(config.out, 'frame-trace.jsonl');

  return config;
}

/** Resolve all output paths under the out directory. */
export function outputPaths(outDir) {
  const join = (name) => path.join(outDir, name);
  return {
    outDir,
    runConfig: join('run-config.json'),
    validation: join('validation.json'),
    agents: join('agents.json'),
    pluginSnapshot: join('plugin-state-snapshot.json'),
    demoState: join('demo-state.json'),
    timeline: join('timeline.jsonl'),
    summary: join('summary.json'),
    video: join('video.mp4'),
    finalPng: join('final.png'),
    videoMetadata: join('video-metadata.json'),
    frameAnalysis: join('frame-analysis.json'),
    frameTrace: join('frame-trace.jsonl'),
    frameTraceSummary: join('frame-trace-summary.json'),
    helperLog: join('helper.log'),
    pids: join('pids.json'),
  };
}

/** Usage text. */
export function helpText() {
  return [
    'multi-pointer-showcase.mjs — reusable 60fps multi-pointer demo recorder',
    '',
    'Usage:',
    '  node scripts/multi-pointer-showcase.mjs --identity <file> --plugin-state <file> --out <dir> [options]',
    '',
    'Required:',
    '  --identity <file>       real identity mapping json (agents[].beforeIds/afterIds exact diff + live[])',
    '  --plugin-state <file>   live plugin state json ({ pointers: [{id,label,color,x,y}] })',
    '  --out <dir>             output directory (created if needed)',
    '',
    'Options:',
    '  --ffmpeg <path>         default ' + DEFAULTS.ffmpeg,
    '  --ffprobe <path>        default derived from --ffmpeg (ffprobe.exe)',
    '  --powershell <path>     default ' + DEFAULTS.powershell,
    '  --helper <path>         default scripts/multi-pointer.ps1',
    '  --screen-width <n>      default ' + DEFAULTS.screenWidth,
    '  --screen-height <n>     default ' + DEFAULTS.screenHeight,
    '  --video-width <n>       default ' + DEFAULTS.videoWidth,
    '  --video-height <n>      default 0 (even, screen aspect preserved)',
    '  --fps <n>               default ' + DEFAULTS.fps,
    '  --duration-ms <n>       capture length, default ' + DEFAULTS.durationMs + ' (' + frameCountFor(DEFAULTS.durationMs, DEFAULTS.fps) + ' frames @60)',
    '  --final-hold-ms <n>     keep overlay visible after capture, default ' + DEFAULTS.finalHoldMs,
    '  --expected-agents <n>   default ' + DEFAULTS.expectedAgents,
    '  --helper-timeout-ms <n> default ' + DEFAULTS.helperTimeoutMs,
    '  --settle-ms <n>         wait after first frame before capture, default ' + DEFAULTS.settleMs,
    '  --frame-trace <path>    helper telemetry file (default <out>/frame-trace.jsonl)',
    '  --dry-run               validate identity/plugin/geometry only; no helper or capture',
    '  --help                  show this help',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Orchestration helpers (no side effects until called)
// ---------------------------------------------------------------------------

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  const text = JSON.stringify(value);
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function waitReal(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Recognise the overlay helper's ready log in either the current or legacy format.
 * Current helper logs:
 *   refresh items=N visuals=N allowCapture=True
 *   first present visuals=N
 * Legacy helper logs:
 *   presented N visuals
 * The current format is ready only after both the target refresh and the first
 * present line report exactly the expected number of visuals with capture allowed.
 */
export function parseHelperReady(logText, expectedAgents) {
  const text = String(logText || '');
  const expected = Number(expectedAgents);
  const refresh = [];
  const refreshRe = /\brefresh items=(-?\d+) visuals=(\d+) allowCapture=(True|False)\b/gi;
  let m;
  while ((m = refreshRe.exec(text)) !== null) {
    refresh.push({ items: Number(m[1]), visuals: Number(m[2]), allowCapture: /^true$/i.test(m[3]) });
  }
  const firstPresent = [];
  const firstRe = /\bfirst present visuals=(\d+)\b/gi;
  while ((m = firstRe.exec(text)) !== null) firstPresent.push(Number(m[1]));
  const legacy = [];
  const legacyRe = /\bpresented (\d+) visuals\b/gi;
  while ((m = legacyRe.exec(text)) !== null) legacy.push(Number(m[1]));

  const lastRefresh = refresh.length ? refresh[refresh.length - 1] : null;
  const captureAllowed = lastRefresh ? lastRefresh.allowCapture : null;
  const refreshOk = Boolean(lastRefresh) && lastRefresh.visuals === expected
    && lastRefresh.items === expected && lastRefresh.allowCapture === true;
  const firstPresentOk = firstPresent.includes(expected);
  const legacyOk = legacy.includes(expected);
  const newFormatSeen = Boolean(lastRefresh) || firstPresent.length > 0;
  let ready = false;
  let format = 'waiting';
  let reason = 'no helper ready log yet';
  if (refreshOk && firstPresentOk) {
    ready = true;
    format = 'current';
    reason = 'refresh and first-present lines confirm ' + expected + ' visuals with capture allowed';
  } else if (!newFormatSeen && legacyOk) {
    ready = true;
    format = 'legacy';
    reason = 'legacy presented line confirms ' + expected + ' visuals';
  } else if (newFormatSeen) {
    if (!lastRefresh) reason = 'waiting for refresh items/visuals/allowCapture line';
    else if (lastRefresh.items !== expected) reason = 'refresh items=' + lastRefresh.items + ' not ' + expected;
    else if (lastRefresh.visuals !== expected) reason = 'refresh visuals=' + lastRefresh.visuals + ' not ' + expected;
    else if (!lastRefresh.allowCapture) reason = 'helper reports allowCapture=False';
    else if (!firstPresentOk) reason = 'waiting for first present visuals=' + expected;
  } else if (legacy.length) {
    reason = 'legacy presented count ' + legacy[legacy.length - 1] + ' not ' + expected;
  }
  return {
    ready,
    format,
    expectedAgents: Number.isFinite(expected) ? expected : null,
    refreshItems: lastRefresh ? lastRefresh.items : null,
    refreshVisuals: lastRefresh ? lastRefresh.visuals : null,
    allowCapture: captureAllowed,
    firstPresentVisuals: firstPresent.length ? firstPresent[firstPresent.length - 1] : null,
    legacyPresentedVisuals: legacy.length ? legacy[legacy.length - 1] : null,
    reason,
  };
}

/** True while a spawned helper child is still running (not exited and not killed). */
export function helperStillLive(child) {
  if (!child || typeof child !== 'object') return false;
  if (child.killed === true) return false;
  return child.exitCode === null || child.exitCode === undefined;
}
/** Wait for an async predicate to become truthy, polling on the real clock. */
export async function waitFor(predicate, timeoutMs, label, intervalMs = 50) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let value;
    try {
      value = await predicate();
    } catch {
      value = false;
    }
    if (value) return value;
    await waitReal(intervalMs);
  }
  throw new Error('timeout waiting for ' + label);
}

/** Spawn a process with piped stdout/stderr and resolve once it exits. */
export function captureCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: false });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), error: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, options.timeoutMs ?? 60000);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error: String(error) });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Stop a child process and wait for it to exit, escalating to taskkill if it
 * refuses within the timeout. Safe to call on an already-exited child.
 */
export async function stopChild(child, options = {}) {
  if (!child || typeof child !== 'object') return { stopped: true };
  const alreadyExited = child.exitCode !== null && child.exitCode !== undefined;
  if (alreadyExited) return { stopped: true, forced: false };

  const exited = new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(true); } };
    child.once('exit', done);
    child.once('error', done);
  });

  try { child.kill(); } catch { /* ignore */ }

  const timeoutMs = options.timeoutMs ?? 5000;
  let timedOut = false;
  await Promise.race([
    exited,
    waitReal(timeoutMs).then(() => { timedOut = true; }),
  ]);

  let forced = false;
  if (timedOut && child.pid) {
    forced = true;
    if (options.taskkill !== false) {
      await new Promise((resolve) => {
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.once('exit', resolve);
          killer.once('error', resolve);
        } catch {
          resolve();
        }
      });
    }
    await Promise.race([exited, waitReal(2000)]);
  }
  return { stopped: true, forced };
}

/**
 * Run a command writing stdout to a FILE descriptor instead of a Node pipe.
 * This avoids child_process pipe stdio, which is blocked under some Windows
 * sandboxes. Returns { code, signal, stderr }.
 */
export function captureToFile(command, args, stdoutFile, options = {}) {
  return new Promise((resolve) => {
    let outFd;
    try {
      outFd = fs.openSync(stdoutFile, 'w');
    } catch (error) {
      resolve({ code: -1, stderr: String(error) });
      return;
    }
    const errFile = stdoutFile + '.err';
    let errFd = 'ignore';
    try { errFd = fs.openSync(errFile, 'w'); } catch { errFd = 'ignore'; }

    const finish = (code, signal, extraStderr) => {
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      if (typeof errFd === 'number') { try { fs.closeSync(errFd); } catch { /* ignore */ } }
      let stderr = extraStderr || '';
      if (!stderr) { try { stderr = fs.readFileSync(errFile, 'utf8'); } catch { /* ignore */ } }
      resolve({ code, signal, stderr, stdoutFile, errFile });
    };

    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', outFd, errFd], windowsHide: true, detached: false });
    } catch (error) {
      finish(-1, null, String(error));
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, options.timeoutMs ?? 120000);
    child.once('error', (error) => { clearTimeout(timer); finish(-1, null, String(error)); });
    child.once('exit', (code, signal) => { clearTimeout(timer); finish(code, signal); });
  });
}

async function runFfprobe(ffprobePath, videoPath, outDir) {
  const jsonFile = path.join(outDir, 'ffprobe-raw.json');
  const result = await captureToFile(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', videoPath],
    jsonFile,
    { timeoutMs: 30000 },
  );
  if (result.code !== 0) throw new Error('ffprobe failed: ' + result.stderr.trim());
  try {
    return JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (error) {
    throw new Error('ffprobe returned invalid json: ' + String(error));
  }
}

async function runFrameHash(ffmpegPath, videoPath, outDir) {
  const hashFile = path.join(outDir, 'frame-hashes.txt');
  const result = await captureToFile(
    ffmpegPath,
    ['-v', 'error', '-i', videoPath, '-an', '-f', 'framehash', '-hash', 'md5', hashFile],
    path.join(outDir, 'framehash-stdout.txt'),
    { timeoutMs: 120000 },
  );
  if (result.code !== 0) throw new Error('ffmpeg framehash failed: ' + result.stderr.trim());
  return parseFrameHashOutput(fs.readFileSync(hashFile, 'utf8'));
}

/**
 * The full recorder. Only call this from the CLI or deliberately; it spawns the
 * overlay helper and ffmpeg. All children are torn down in a finally block.
 */
export async function runShowcase(rawConfig, log = console.log) {
  const config = resolveConfig(rawConfig);
  const phases = { ...DEFAULT_PHASES, ...(rawConfig.phases || {}) };
  const paths = outputPaths(config.out);
  fs.mkdirSync(config.out, { recursive: true });

  const identity = readJsonSafe(config.identityPath);
  const plugin = readJsonSafe(config.pluginStatePath);
  const validation = validateIdentityMapping(identity, plugin, { expectedAgents: config.expectedAgents });

  const runConfigRecord = {
    startedAt: nowIso(),
    cli: { identity: config.identityPath, pluginState: config.pluginStatePath, out: config.out },
    resolved: { ...config },
    phases,
    expectedFrames: frameCountFor(config.durationMs, config.fps),
  };
  writeJson(paths.runConfig, runConfigRecord);
  writeJson(paths.validation, validation);

  if (!validation.ok) {
    throw new Error('identity validation failed: ' + validation.errors.join('; '));
  }

  const agents = validation.mapping.map((entry, index) => ({
    ...entry,
    color: entry.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length],
  }));
  const geometry = buildAgentGeometry(agents, config);
  // The last pointer finishes its tween at startHold + (n-1)*stagger + moveMs.
  // Label the gap until the row hold as an expected 'settle' hold so the
  // timeline does not present a designed standstill as if pointers were moving.
  phases.settleAtMs = phases.startHoldMs + phases.moveMs + Math.max(0, agents.length - 1) * phases.staggerMs;

  if (config.dryRun) {
    log('DRY_RUN_OK ' + JSON.stringify({
      agents: agents.map((a) => ({ agentName: a.agentName, id: a.id })),
      screen: { width: config.screenWidth, height: config.screenHeight },
      video: { width: config.videoWidth, height: config.videoHeight, fps: config.fps, frames: frameCountFor(config.durationMs, config.fps) },
      paths,
    }));
    return { dryRun: true, validation, agents, geometry, config, paths };
  }

  writeJson(paths.pluginSnapshot, plugin);
  writeJson(paths.agents, {
    generatedAt: nowIso(),
    source: identity && (identity.method || identity.source) || 'exact creation diff',
    identityFile: config.identityPath,
    agents,
  });

  const startedAt = nowIso();
  const startedMs = monotonicNow();
  const samples = [];
  const timelineBuf = [];
  const timelineRowsForAnalysis = [];
  let helper = null;
  let video = null;
  let videoExitPromise = null;
  let frameTraceSummary = null;
  let videoMetadata = null;
  let frameAnalysis = null;

  const flushTimeline = () => {
    if (timelineBuf.length) {
      fs.appendFileSync(paths.timeline, timelineBuf.join('\n') + '\n');
      timelineBuf.length = 0;
    }
  };

  try {
    // 1) Initial overlay state first, before any helper starts.
    writeJson(paths.demoState, buildState(agents, geometry, 0, phases));
    fs.writeFileSync(paths.timeline, '');
    try { fs.unlinkSync(paths.helperLog); } catch { /* ignore */ }
    // Fresh trace file so we only read this run (helper may also truncate).
    try { fs.writeFileSync(config.frameTrace, ''); } catch { /* ignore */ }

    // 2) Start the non-detached, input-free overlay helper.
    const helperEnv = { ...process.env, DSH_MULTI_POINTER_CAPTURE: '1' };
    if (config.frameTrace) helperEnv.DSH_MULTI_POINTER_FRAME_TRACE = config.frameTrace;
    helper = spawn(
      config.powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', config.helper, '-StatePath', paths.demoState, '-LogPath', paths.helperLog],
      { env: helperEnv, stdio: 'ignore', windowsHide: true, detached: false },
    );
    helper.on('error', (error) => log('HELPER_ERROR ' + error.message));
    writeJson(paths.pids, { helperPid: helper.pid, startedAt: nowIso(), capture: true });

    const readyInfo = await waitFor(() => {
      try {
        const logText = fs.readFileSync(paths.helperLog, 'utf8');
        const info = parseHelperReady(logText, agents.length);
        return info.ready ? info : false;
      } catch {
        return false;
      }
    }, config.helperTimeoutMs, 'overlay ready log for ' + agents.length + ' visuals');
    log('HELPER_READY ' + JSON.stringify(readyInfo));
    if (!helperStillLive(helper)) {
      throw new Error('overlay helper exited before capture started; readiness=' + JSON.stringify(readyInfo));
    }

    // The helper must still be alive after the settle delay and immediately
    // before capture begins; a helper that died after its ready line would
    // otherwise record an empty desktop.
    writeJson(paths.demoState, buildState(agents, geometry, 0, phases));
    await waitReal(config.settleMs);
    if (!helperStillLive(helper)) {
      throw new Error('overlay helper exited during settle before capture started; readiness=' + JSON.stringify(readyInfo));
    }

    // 3) Start capture (ddagrab at fps, output at fps).
    const scaleFilter = config.videoHeight > 0
      ? 'hwdownload,format=bgra,scale=' + config.videoWidth + ':' + config.videoHeight + ':flags=lanczos'
      : 'hwdownload,format=bgra,scale=' + config.videoWidth + ':-2:flags=lanczos';
    video = spawn(
      config.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'ddagrab=0:framerate=' + config.fps,
        '-vf', scaleFilter,
        '-t', String(config.durationMs / 1000),
        '-r', String(config.fps),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-y', paths.video,
      ],
      { stdio: 'ignore', windowsHide: true, detached: false },
    );
    videoExitPromise = new Promise((resolve) => {
      video.once('exit', (code, signal) => resolve({ code, signal }));
      video.once('error', (error) => resolve({ code: -1, error: String(error) }));
    });

    // 4) Drive coordinates on a monotonic absolute-deadline schedule.
    const scheduler = createDeadlineScheduler({ fps: config.fps, durationMs: config.durationMs });
    let lastSerialized = '';
    let lastFlushIndex = 0;
    let lastAliveCheckMs = -Infinity;

    const driveStartedMs = monotonicNow();
    const driveStartedWallMs = Date.now();
    for await (const frame of scheduler.run()) {
      const elapsed = frame.actualRelMs;
      const state = buildState(agents, geometry, elapsed, phases);
      const serialized = JSON.stringify(state);
      if (serialized !== lastSerialized) {
        writeJson(paths.demoState, state);
        lastSerialized = serialized;
      }
      samples.push(frame);
      const timelineRow = {
        frame: frame.index,
        elapsedMs: roundTo(elapsed),
        wallMs: Date.now(),
        scheduledMs: roundTo(frame.scheduledRelMs),
        driftMs: roundTo(frame.driftMs),
        phase: scenePhaseAt(elapsed, phases),
        pointers: state.pointers.map((p) => ({ id: p.id, x: p.x, y: p.y })),
      };
      timelineRowsForAnalysis.push({ elapsedMs: timelineRow.elapsedMs, wallMs: timelineRow.wallMs, phase: timelineRow.phase, pointers: timelineRow.pointers });
      timelineBuf.push(JSON.stringify(timelineRow));
      if (frame.index - lastFlushIndex >= 60) {
        flushTimeline();
        lastFlushIndex = frame.index;
      }
      if (elapsed - lastAliveCheckMs >= 250) {
        const current = readJsonSafe(config.pluginStatePath);
        const live = checkLivePointers(current, agents);
        if (!live.alive) throw new Error('real Agent identity no longer live: ' + JSON.stringify(live.missing));
        lastAliveCheckMs = elapsed;
      }
    }

    // Final row pose + final timeline entry.
    const finalElapsed = phases.rowHoldAtMs + phases.moveMs + 1000;
    const finalState = buildState(agents, geometry, finalElapsed, phases);
    writeJson(paths.demoState, finalState);
    const finalMonoMs = monotonicNow();
    const finalRow = {
      frame: samples.length,
      elapsedMs: roundTo(finalMonoMs - driveStartedMs),
      wallMs: Date.now(),
      scheduledMs: roundTo(samples.length ? samples[samples.length - 1].scheduledRelMs + 1000 / config.fps : 0),
      driftMs: roundTo(finalMonoMs - driveStartedMs - (samples.length ? samples[samples.length - 1].scheduledRelMs + 1000 / config.fps : 0)),
      phase: 'row-final',
      pointers: finalState.pointers.map((p) => ({ id: p.id, x: p.x, y: p.y })),
    };
    timelineRowsForAnalysis.push({ elapsedMs: finalRow.elapsedMs, wallMs: finalRow.wallMs, phase: finalRow.phase, pointers: finalRow.pointers });
    timelineBuf.push(JSON.stringify(finalRow));
    flushTimeline();

    const videoResult = await videoExitPromise;
    if (!videoResult || videoResult.code !== 0) {
      throw new Error('ffmpeg video failed: ' + JSON.stringify(videoResult));
    }

    // 5) Post-capture verification.
    videoMetadata = summarizeVideoMetadata(await runFfprobe(config.ffprobe, paths.video, config.out));
    writeJson(paths.videoMetadata, videoMetadata);

    const hashes = await runFrameHash(config.ffmpeg, paths.video, config.out);
    frameAnalysis = analyzeFrameHashes(hashes);
    writeJson(paths.frameAnalysis, frameAnalysis);

    try {
      if (fs.existsSync(config.frameTrace)) {
        const text = fs.readFileSync(config.frameTrace, 'utf8');
        frameTraceSummary = summarizeFrameTrace(parseFrameTraceJsonl(text), config.fps, { timeline: timelineRowsForAnalysis });
        if (frameTraceSummary) writeJson(paths.frameTraceSummary, frameTraceSummary);
      }
    } catch (error) {
      log('FRAME_TRACE_ERROR ' + String(error));
    }

    // Final screenshot (helper still visible).
    const finalShot = await captureCommand(
      config.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'ddagrab=0', '-vf', 'hwdownload,format=bgra', '-frames:v', '1', '-y', paths.finalPng],
      { timeoutMs: 30000 },
    );
    if (finalShot.code !== 0) log('FINAL_SHOT_WARN ' + finalShot.stderr.trim());

    const writer = summarizeWriteCadence(samples, config.fps);
    const presentation = {
      claim: '60fps target; container fps and decoded-frame uniqueness are not proof of real pointer motion; motion cadence comes from the helper visuals timeline',
      containerMetadata: {
        fps: videoMetadata.avgFps || videoMetadata.rFps,
        nbFrames: videoMetadata.nbFrames,
        durationSec: videoMetadata.durationSec,
      },
      writerCadence: writer,
      displayTrace: frameTraceSummary,
      motionCadence: frameTraceSummary ? frameTraceSummary.motion : null,
      duplicateFrameAnalysis: frameAnalysis,
      verdict: assessPresentation({ fps: config.fps, writer, trace: frameTraceSummary, frames: frameAnalysis }),
    };

    const summary = {
      startedAt,
      endedAt: nowIso(),
      clockEvidence: {
        driveStartedWallMs,
        driveStartedMonoMs: roundTo(driveStartedMs),
        timelineClock: 'node Date.now() epoch ms on every timeline sample',
        helperClock: 'helper wallMs epoch ms in frame-trace.jsonl',
        sharedHostClock: true,
        timelineSamples: timelineRowsForAnalysis.length,
        timelineRowsWithWallMs: timelineRowsForAnalysis.filter((r) => Number.isFinite(r.wallMs)).length,
        alignment: frameTraceSummary && frameTraceSummary.motion ? frameTraceSummary.motion.clockAlignment : null,
        note: 'Drive start is recorded after helper ready + settle. Helper trace frames before this wall instant are startup hold and are excluded by wall alignment, never inferred as motion.',
      },
      runConfig: runConfigRecord,
      screen: { width: config.screenWidth, height: config.screenHeight },
      video: { width: config.videoWidth, height: config.videoHeight, fps: config.fps, durationMs: config.durationMs, expectedFrames: frameCountFor(config.durationMs, config.fps) },
      helperPid: helper.pid,
      capture: { helperAllowCapture: true, method: 'ffmpeg ddagrab (Desktop Duplication) ' + config.fps + 'fps -> x264 ' + config.fps + 'fps' },
      source: 'real subagent identities mapped by exact creation diff; one input-free overlay plays their coordinates',
      identity: { method: identity && (identity.method || identity.source) || 'exact creation diff', validation: { ok: validation.ok, errors: validation.errors } },
      agents: agents.map((agent, index) => ({
        agentName: agent.agentName,
        id: agent.id,
        pluginLabel: agent.pluginLabel,
        color: agent.color,
        start: geometry.starts[index],
        end: geometry.targets[index],
      })),
      phases,
      writerCadence: writer,
      videoMetadata,
      duplicateFrameAnalysis: frameAnalysis,
      displayTrace: frameTraceSummary,
      motionCadence: frameTraceSummary ? frameTraceSummary.motion : null,
      presentation,
      evidence: {
        video: paths.video,
        finalScreenshot: paths.finalPng,
        timeline: paths.timeline,
        agents: paths.agents,
        pluginSnapshot: paths.pluginSnapshot,
        helperLog: paths.helperLog,
        videoMetadata: paths.videoMetadata,
        frameAnalysis: paths.frameAnalysis,
        frameTrace: fs.existsSync(config.frameTrace) ? config.frameTrace : null,
        frameTraceSummary: frameTraceSummary ? paths.frameTraceSummary : null,
        validation: paths.validation,
      },
      note: 'No real mouse/keyboard input was injected; only the transparent layered overlay window changed. The overlay stays visible for finalHoldMs after capture, then the helper is stopped. Motion cadence is derived from helper visuals (independent of the writer timeline); helper UpdateLayeredWindow success is submit-side evidence only and is not a display scan-out frame, so real on-screen motion must still be confirmed from the recorded video / screen capture.',
    };
    writeJson(paths.summary, summary);
    log('SHOWCASE_READY ' + JSON.stringify({
      video: paths.video,
      finalPng: paths.finalPng,
      summary: paths.summary,
      agents: agents.map((a) => a.agentName),
      helperPid: helper.pid,
      frameTrace: Boolean(frameTraceSummary),
      verdict: presentation.verdict.level,
    }));

    // 6) Keep the overlay visible for the final hold, then tear down.
    await waitReal(config.finalHoldMs);
    return { summary, paths };
  } finally {
    const stops = [];
    if (video) stops.push(stopChild(video, { timeoutMs: 5000, taskkill: true }));
    if (helper) stops.push(stopChild(helper, { timeoutMs: 8000, taskkill: true }));
    await Promise.all(stops);
    flushTimeline();
  }
}

/** CLI entry point. */
export async function main(argv, log = console.log) {
  const raw = parseArgs(argv);
  if (raw.help) {
    log(helpText());
    return 0;
  }
  if (Array.isArray(raw.unknown) && raw.unknown.length) {
    log('WARN unknown arguments: ' + raw.unknown.join(', '));
  }
  await runShowcase(raw, log);
  return 0;
}

function invokedDirectly() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  }).catch((error) => {
    console.error('SHOWCASE_ERROR ' + (error && error.stack ? error.stack : String(error)));
    process.exitCode = 1;
  });
}
