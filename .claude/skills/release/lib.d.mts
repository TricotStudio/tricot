// Types for lib.mjs, for the TypeScript that imports it (test/releaseSkill.test.ts).

export type Bump = 'patch' | 'minor' | 'major';
export type CommitKind = Bump | 'none';

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
  build: string;
}

export interface Commit {
  subject: string;
  body?: string;
}

export interface Classified {
  kind: CommitKind;
  why: string;
}

export interface Suggestion<C extends Commit> {
  kind: Bump;
  reason: string;
  /** Before the public launch: what the commits alone call for. */
  readAs?: { kind: Bump; reason: string };
  commits: (C & Classified)[];
}

export const NOTES_MAX: number;
export const PRE_LAUNCH: boolean;
export const BUMPS: Bump[];

export function parseVersion(text: unknown): Version | undefined;
export function compareVersions(a: string, b: string): number;
export function bumpVersion(current: string, kind: Bump): string;
export function classifyCommit(commit: Commit): Classified;
export function suggestBump<C extends Commit>(commits: C[], current: string, options?: { preLaunch?: boolean }): Suggestion<C>;
export function preLaunchNote(current: string): string;
export function preLaunchWarning(current: string, version: string, options?: { preLaunch?: boolean }): string | undefined;
export function resolveTarget(current: string, wanted: string | undefined, suggested: Bump): { version: string; error?: undefined } | { error: string; version?: undefined };
export function checkNotes(text: unknown): { flat: string; errors: string[]; warnings: string[] };
export function withReleaseNotes(json: string, notes: string): string;
export function wrap(text: string, width?: number): string;
export function releaseCommitMessage(version: string, notes?: string, trailer?: string): string;
export function pushCommand(version: string): string;
export function githubRepo(repository: unknown): string | undefined;
