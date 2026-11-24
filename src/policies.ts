/**
 * Per-program overrides of the global desktop mode (foreground / background).
 * The DSH plugin writes app-policies.json; the server reads it before an
 * operation on a program and switches mode only for that operation. The
 * contract is docs/design/appearance.md.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PolicyMode = 'foreground' | 'background';

export interface AppPolicy {
  /** `exe:<name.exe>`, `app:<name the agent opened>` or `title:<window title>`. */
  match: string;
  label: string;
  mode: PolicyMode;
}

export interface PolicyTarget { exe?: string; app?: string; title?: string }

export const POLICIES_FILE = join(homedir(), '.evolution-computer-use', 'app-policies.json');

export function parsePolicies(value: unknown): AppPolicy[] {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as { apps?: unknown };
  if (!Array.isArray(raw.apps)) return [];
  const seen = new Set<string>();
  const result: AppPolicy[] = [];
  for (const item of raw.apps) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as { match?: unknown; label?: unknown; mode?: unknown };
    if (typeof entry.match !== 'string') continue;
    const match = entry.match.trim();
    const slash = match.indexOf(':');
    const kind = match.slice(0, slash).toLowerCase();
    const value = match.slice(slash + 1).trim();
    if (slash <= 0 || !value || !['exe', 'app', 'title'].includes(kind)) continue;
    if (entry.mode !== 'foreground' && entry.mode !== 'background') continue;
    const key = kind + ':' + value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      match: kind + ':' + value,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 120) : value,
      mode: entry.mode,
    });
  }
  return result;
}

let cache: { stamp: number; value: AppPolicy[] } | undefined;

export function readAppPolicies(): AppPolicy[] {
  let stamp = 0;
  try { stamp = statSync(POLICIES_FILE).mtimeMs; } catch { /* absent: no overrides */ }
  if (cache && cache.stamp === stamp) return cache.value;
  let value: AppPolicy[] = [];
  if (stamp !== 0) {
    try { value = parsePolicies(JSON.parse(readFileSync(POLICIES_FILE, 'utf8').replace(/^﻿/, ''))); }
    catch { value = []; }
  }
  cache = { stamp, value };
  return value;
}

/** First matching policy for what the agent is about to touch. */
export function matchAppPolicy(policies: AppPolicy[], target: PolicyTarget): AppPolicy | undefined {
  const exe = target.exe?.trim().toLowerCase();
  const app = target.app?.trim().toLowerCase();
  const title = target.title?.trim().toLowerCase();
  for (const policy of policies) {
    const slash = policy.match.indexOf(':');
    const kind = policy.match.slice(0, slash);
    const wanted = policy.match.slice(slash + 1).toLowerCase();
    if (kind === 'exe' && exe && (exe === wanted || exe + '.exe' === wanted)) return policy;
    if (kind === 'app' && app && app === wanted) return policy;
    if (kind === 'title' && title && title === wanted) return policy;
  }
  return undefined;
}

export function forgetPolicies(): void {
  cache = undefined;
}
