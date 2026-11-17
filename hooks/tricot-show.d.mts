// Types for tricot-show.mjs, for the TypeScript that imports it
// (tricot-steps-extension.ts, and the tests).

import type { ChildProcess, ExecFileOptions } from 'node:child_process';

export const SHOW_CONTEXT: string;
export const SHOW_CONTEXT_DOWN: string;
export const SHOW_CONTEXT_DOWN_NO_SHOW: string;

// How long all of the check that Tricot is running may take, in milliseconds.
export const WITHIN_MS: number;

export function showAsked(text: unknown): boolean;

export function showContext(text: unknown): string | undefined;

export type BoardState = 'up' | 'down' | 'unknown';

// What the board is asked with (a fetch), and what it is connected to with first (net.connect).
export type BoardFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<unknown>;
export interface BoardSocket {
  once(event: 'connect', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  destroy(): unknown;
}
export type BoardConnect = (options: { host: string; port: number }) => BoardSocket;
export type ShowRun = (file: string, args: string[], options: ExecFileOptions, done: (error: Error | null, stdout: string) => void) => ChildProcess | undefined;

export interface BoardOptions {
  token?: string;
  fetch?: BoardFetch;
  connect?: BoardConnect;
  ms?: number;
}

export interface ShowCommandOptions {
  env?: Record<string, string | undefined>;
  run?: ShowRun;
  ms?: number;
}

export function boardState(url: string, options?: BoardOptions): Promise<BoardState>;

export function hasShowCommand(options?: ShowCommandOptions): Promise<boolean>;

export interface ShowContextOptions extends Omit<BoardOptions, 'ms'>, Omit<ShowCommandOptions, 'ms'> {
  url?: string;
}

export function showContextFor(text: unknown, options?: ShowContextOptions): Promise<string | undefined>;
