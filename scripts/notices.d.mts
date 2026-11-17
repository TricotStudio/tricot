// Types for notices.mjs, for the TypeScript that imports it (vite.config.ts and the tests).

export type Build = 'web' | 'canvas' | 'cli';

export interface Inlined {
  name: string;
  version: string | null;
  in: string;
}

export interface BundleRecord {
  build: Build;
  packages: string[];
  helpers: string[];
  inlined: Inlined[];
  vendored: string[];
}

export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  fromFile?: boolean;
  copied?: boolean; // its licence from scripts/licences: its package publishes none
  source?: string;
  texts: { name: string; text: string }[];
  builds: Set<Build>;
  inside: Set<string>;
}

export const ROOT: string;
export const NOTICES_FILE: string;
export const LISTS_DIR: string;
export const LICENCES_DIR: string;
export const BUILDS: Record<Build, string>;
export const FULL_PAGE_ENTRY: string;
export const COMPATIBLE: Set<string>;
export const FLAGGED: Record<string, string>;
export const INCOMPATIBLE: Map<string, string>; // a licence's id, and why it can't ship
export const HELPER: RegExp;

export function licenceFiles(dir: string): string[];
export function packageDirOf(file: string): string | undefined;
export function inlinedIn(file: string): Inlined[];
export function recordBundle(build: Build, files: Iterable<string>, listsDir?: string): BundleRecord;
export function licenceOf(pkg: Record<string, unknown>, texts?: { name: string; text: string }[]): string;
export function licenceAllowed(expression: string, allowed?: { has(id: string): boolean }): boolean;
export function licenceRefusal(expression: string, refused?: Map<string, string>): string | undefined;
export function licenceRefused(expression: string, refused?: Map<string, string>): boolean;
export function hasFullPage(root?: string): boolean;
export function buildsOf(root?: string): Build[];
export function collectNotices(listsDir?: string, copiesDir?: string, builds?: Build[]): { entries: NoticeEntry[]; problems: string[]; flagged: string[] };
export function noticesMarkdown(entries: NoticeEntry[], builds?: Build[]): string;
export function writeNotices(options?: { listsDir?: string; out?: string; log?: Pick<Console, 'warn'>; builds?: Build[] }): { file: string; count: number; flagged: number };
