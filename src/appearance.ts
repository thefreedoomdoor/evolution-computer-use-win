/**
 * The three surfaces the user can restyle — the operation banner, the audit
 * window and the thought window — read one file, `appearance.json`.
 *
 * The DSH plugin (dsh-evolution-desktop-mode) is the writer; the MCP server,
 * win32.ps1 and windows-takeover.cs are the readers. A missing file, a missing
 * key or a wrong type never breaks an operation: each falls back to the
 * default value below. The contract is docs/design/appearance.md.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type BannerPosition = 'top-left' | 'top-center' | 'top-right' | 'custom';
export type AuditPosition = 'left-of-thought' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'custom';
export type ThoughtPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'custom';

export interface FontSpec { family: string; size: number; bold: boolean }

export interface BannerColors {
  bg: string; text: string; hint: string; dot: string; stopBg: string; stopText: string; border: string;
}
export interface BannerFonts { main: FontSpec; hint: FontSpec; stop: FontSpec }
export interface BannerLayout { align: 'left' | 'center' | 'right'; offsetX: number; offsetY: number; gap: number; padding: number }
export interface BannerAppearance {
  text: string; hint: string; stop: string; stopped: string;
  width: number; height: number; opacity: number; position: BannerPosition;
  x: number | null; y: number | null;
  colors: BannerColors; fonts: BannerFonts; layout: BannerLayout;
}

export interface AuditColors { bg: string; border: string; text: string; muted: string; accent: string; reason: string; shot: string }
export interface AuditFonts { title: FontSpec; body: FontSpec }
export interface AuditLayout { rows: number; showTime: boolean; showReason: boolean; showThumb: boolean; padding: number; gap: number }
export interface AuditAppearance {
  enabled: boolean; width: number; height: number; opacity: number; locked: boolean;
  position: AuditPosition; x: number | null; y: number | null;
  colors: AuditColors; fonts: AuditFonts; layout: AuditLayout;
}

export interface ThoughtColors { bg: string; border: string; text: string; muted: string; accent: string }
export interface ThoughtFonts { title: FontSpec; body: FontSpec }
export interface ThoughtAppearance {
  width: number; height: number; opacity: number; locked: boolean;
  position: ThoughtPosition; x: number | null; y: number | null;
  colors: ThoughtColors; fonts: ThoughtFonts;
}

export interface AuditLogAppearance {
  enabled: boolean; screenshots: boolean; retentionDays: number; maxScreenshotsMB: number; maxEntries: number;
}

export interface Appearance {
  version: number;
  banner: BannerAppearance;
  audit: AuditAppearance;
  thought: ThoughtAppearance;
  auditLog: AuditLogAppearance;
}

export const DEFAULT_APPEARANCE: Appearance = {
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
      bg: '#EC181A20', text: '#F5F7FA', hint: '#969CA8', dot: '#408CFF',
      stopBg: '#22FFFFFF', stopText: '#F0F2F6', border: '#00000000',
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
      bg: '#EB0B0D12', border: '#2A3140', text: '#E6EAF2', muted: '#8A93A3',
      accent: '#4ADE80', reason: '#C7B26B', shot: '#5B8DEF',
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
    colors: { bg: '#99191D26', border: '#75A1DA', text: '#F6F7FA', muted: '#B9C6D8', accent: '#5B8DEF' },
    fonts: {
      title: { family: 'Microsoft YaHei UI', size: 14, bold: true },
      body: { family: 'Microsoft YaHei UI', size: 14.667, bold: false },
    },
  },
  auditLog: { enabled: true, screenshots: true, retentionDays: 7, maxScreenshotsMB: 500, maxEntries: 5000 },
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const obj = (value: unknown): Obj => (isObj(value) ? value : {});
const text = (value: unknown, fallback: string, max = 200): string =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const num = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const int = (value: unknown, fallback: number, min: number, max: number): number =>
  Math.round(num(value, fallback, min, max));
const color = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value.toUpperCase() : fallback;
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : fallback;
/** A screen coordinate: an integer, -20000..20000 (multi-monitor screens go negative). */
const point = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(20000, Math.max(-20000, value))) : null;

function font(value: unknown, fallback: FontSpec): FontSpec {
  const raw = obj(value);
  return {
    family: text(raw.family, fallback.family, 80),
    size: num(raw.size, fallback.size, 6, 72),
    bold: flag(raw.bold, fallback.bold),
  };
}

function banner(value: unknown): BannerAppearance {
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
    position: oneOf(raw.position, ['top-left', 'top-center', 'top-right', 'custom'] as const, base.position),
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
      align: oneOf(layout.align, ['left', 'center', 'right'] as const, base.layout.align),
      offsetX: int(layout.offsetX, base.layout.offsetX, -1000, 1000),
      offsetY: int(layout.offsetY, base.layout.offsetY, -200, 400),
      gap: int(layout.gap, base.layout.gap, 0, 60),
      padding: int(layout.padding, base.layout.padding, 0, 80),
    },
  };
}

function audit(value: unknown): AuditAppearance {
  const raw = obj(value), base = DEFAULT_APPEARANCE.audit;
  const colors = obj(raw.colors), layout = obj(raw.layout), fonts = obj(raw.fonts);
  return {
    enabled: flag(raw.enabled, base.enabled),
    width: int(raw.width, base.width, 220, 1600),
    height: int(raw.height, base.height, 140, 1600),
    opacity: int(raw.opacity, base.opacity, 20, 100),
    locked: flag(raw.locked, base.locked),
    position: oneOf(raw.position, ['left-of-thought', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'] as const, base.position),
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

function thought(value: unknown): ThoughtAppearance {
  const raw = obj(value), base = DEFAULT_APPEARANCE.thought;
  const colors = obj(raw.colors), fonts = obj(raw.fonts);
  return {
    width: int(raw.width, base.width, 240, 1600),
    height: int(raw.height, base.height, 160, 1600),
    opacity: int(raw.opacity, base.opacity, 20, 100),
    locked: flag(raw.locked, base.locked),
    position: oneOf(raw.position, ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'] as const, base.position),
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

function auditLog(value: unknown): AuditLogAppearance {
  const raw = obj(value), base = DEFAULT_APPEARANCE.auditLog;
  return {
    enabled: flag(raw.enabled, base.enabled),
    screenshots: flag(raw.screenshots, base.screenshots),
    retentionDays: int(raw.retentionDays, base.retentionDays, 1, 365),
    maxScreenshotsMB: int(raw.maxScreenshotsMB, base.maxScreenshotsMB, 20, 20000),
    maxEntries: int(raw.maxEntries, base.maxEntries, 100, 200000),
  };
}

/** Six digits and letters make a number; used by tests and the plugin. */
export function parseAppearance(value: unknown): Appearance {
  const raw = obj(value);
  return {
    version: int(raw.version, DEFAULT_APPEARANCE.version, 1, 99),
    banner: banner(raw.banner),
    audit: audit(raw.audit),
    thought: thought(raw.thought),
    auditLog: auditLog(raw.auditLog),
  };
}

export function appearanceFile(): string {
  const override = process.env.EVOCU_APPEARANCE_FILE?.trim();
  return override || join(homedir(), '.evolution-computer-use', 'appearance.json');
}

/** The data directory the shared files live in (fixed; --data does not move it). */
export function sharedDataDir(): string {
  return join(homedir(), '.evolution-computer-use');
}

export function auditDir(): string {
  const override = process.env.EVOCU_AUDIT_DIR?.trim();
  return override || join(sharedDataDir(), 'audit');
}

export function fontsDir(): string {
  return join(sharedDataDir(), 'fonts');
}

let cache: { path: string; stamp: number; value: Appearance } | undefined;

/**
 * The current appearance. Re-parsed when the file's mtime changes; a broken or
 * absent file yields the defaults instead of failing an operation.
 */
export function readAppearance(): Appearance {
  const path = appearanceFile();
  let stamp = 0;
  try { stamp = statSync(path).mtimeMs; } catch { /* absent: use defaults */ }
  if (cache && cache.path === path && cache.stamp === stamp) return cache.value;
  let value = DEFAULT_APPEARANCE;
  if (stamp !== 0) {
    try { value = parseAppearance(JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))); }
    catch { value = DEFAULT_APPEARANCE; }
  }
  cache = { path, stamp, value };
  return value;
}

/** The banner's words with `{app}` filled in; trailing space from an empty name goes away. */
export function bannerText(app?: string): string {
  const filled = readAppearance().banner.text.replaceAll('{app}', app?.trim() ?? '');
  return filled.trim() || 'DSH正在操作';
}

/** For tests: forget what was read so a rewritten file is picked up even with the same mtime. */
export function forgetAppearance(): void {
  cache = undefined;
}
