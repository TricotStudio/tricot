// Plan usage beside live steps, for the agents whose harness says it on this
// machine (core/usage.ts):
//
// - Claude Code says it only to its status line. Turning Claude's live steps
//   on (user scope) also sets `statusLine` in its settings to Tricot's,
//   hooks/tricot-usage.mjs, which passes the numbers on and runs the person's
//   own status line as before. What they had (their statusLine value, or none)
//   is kept exactly in tricot-usage.json beside the script, and turning live
//   steps off puts it back exactly: the same value in the same place, or no
//   statusLine at all. When the person sets another status line themselves
//   (/statusline), Tricot's is no longer there: that is theirs to do, and
//   Tricot only says so (usage 'replaced'). Turning steps off then leaves
//   their status line as it is; turning them on again wraps the new one.
// - Codex writes it into its own session file: its steps hook reads the end
//   of that file at each turn's end when its command says --usage, with
//   tricot-usage.mjs beside it.

import { existsSync, readFileSync } from 'node:fs';

export const USAGE_SCRIPT = 'tricot-usage.mjs';
export const USAGE_CONFIG = 'tricot-usage.json';

// How an agent passes its plan usage on, if it does.
export type UsageRoute = 'statusLine' | 'flag';

// on: set up. off: not set up (or from before Tricot had it). replaced: the
// person set a status line of their own since, so Claude's usage stops.
export type UsageState = 'on' | 'off' | 'replaced';

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Tricot's own status line: one whose command runs tricot-usage.mjs.
export const isUsageLine = (line: unknown): boolean => isObject(line) && typeof line.command === 'string' && line.command.includes(USAGE_SCRIPT);

// What Tricot keeps of the person's status line, to run it and put it back:
// whether the settings had one, and its value, exactly.
export interface UsageConfig {
  had: boolean;
  previous?: unknown;
}

export function readUsageConfig(file: string): UsageConfig | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(parsed) || typeof parsed.had !== 'boolean') return undefined;
    return parsed.had ? { had: true, previous: parsed.previous } : { had: false };
  } catch {
    return undefined;
  }
}

// What to keep, from the settings as they are: the person's status line, or,
// when Tricot's is there already, what was kept when it was put there.
export function usageConfigFor(settings: Record<string, unknown>, kept: UsageConfig | undefined): UsageConfig {
  if (isUsageLine(settings.statusLine)) return kept ?? { had: false };
  return Object.hasOwn(settings, 'statusLine') ? { had: true, previous: settings.statusLine } : { had: false };
}

// Tricot's status line: its command, with the person's own other settings for
// it (padding, refreshInterval, hideVimModeIndicator), so it looks the same.
export function usageLine(config: UsageConfig, command: string): Record<string, unknown> {
  const { type: _type, command: _command, ...rest } = config.had && isObject(config.previous) ? config.previous : {};
  return { type: 'command', command, ...rest };
}

// The settings with Tricot's status line, in the place the person's had.
export const withUsageLine = <T extends Record<string, unknown>>(settings: T, line: Record<string, unknown>): T => ({ ...settings, statusLine: line });

// The settings as they were before Tricot's status line: the person's back
// in its place, or none. Settings whose status line isn't Tricot's stay as
// they are.
export function withoutUsageLine<T extends Record<string, unknown>>(settings: T, kept: UsageConfig | undefined): T {
  if (!isUsageLine(settings.statusLine)) return settings;
  if (kept?.had) return { ...settings, statusLine: kept.previous };
  const { statusLine: _ours, ...rest } = settings;
  return rest as T;
}

// The person's status line command, to name it in a sentence.
export const lineCommand = (config: UsageConfig | undefined): string | undefined =>
  config?.had && isObject(config.previous) && typeof config.previous.command === 'string' ? config.previous.command : undefined;
