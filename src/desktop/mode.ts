/**
 * How the agent uses the user's computer: not at all, one window with posted input, or the whole screen with the real
 * mouse and keyboard. The same three words are the CLI flag, the MCP tool's argument and what the status reports, so
 * every place that talks about the mode says the same thing.
 */
export type DesktopMode = 'off' | 'background' | 'foreground';

export const DESKTOP_MODES = ['off', 'background', 'foreground'] as const;

export function isDesktopMode(value: unknown): value is DesktopMode {
  return value === 'off' || value === 'background' || value === 'foreground';
}