// Types for tricot-usage.mjs, for the TypeScript that imports it (the tests).
// What it sends is UsageInput in src/core/usage.ts, as POST
// /api/agents/:name/usage reads it.

export interface HookUsage {
  source: 'claude-statusline' | 'codex-rollout';
  plan?: string;
  windows?: { id: string; usedPercent: number; resetsAt: number; minutes?: number }[];
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };
  costUsd?: number;
  context?: { usedPercent: number; window: number };
}

export const CONFIG_FILE: string;
export const TAIL_BYTES: number;

export function fromStatusLine(input: unknown): HookUsage | undefined;
export function readTail(file: unknown, bytes?: number): { text: string; cut: boolean } | undefined;
export function fromRollout(tail: { text: string; cut: boolean } | undefined, now?: number): HookUsage | undefined;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<unknown>;
export function postUsage(url: string, name: string, usage: HookUsage | undefined, options?: { timeout?: number; send?: Fetch; token?: string }): Promise<void>;

export function previousLine(file?: string | URL): unknown;
export function runPrevious(command: string, input: string, options?: { stdout?: 'inherit' | 'pipe' | 'ignore' | number; env?: NodeJS.ProcessEnv }): Promise<number>;
