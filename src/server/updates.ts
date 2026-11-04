// Is there a newer Tricot? The server asks GitHub for the latest release of
// its repository (package.json's repository): GET
// https://api.github.com/repos/<owner>/<repo>/releases/latest, which leaves
// out drafts and pre-releases. A release counts once it carries its package,
// tricot-<version>.tgz, under the tag v<version>; its notes are the first
// paragraph of the release's text, as plain words. When GitHub can't be
// reached or says no (offline, rate-limited, down), or its latest release
// isn't ready, the server asks the npm registry instead, as it always did
// (GET https://registry.npmjs.org/tricot/latest).
//
// It asks once when it starts and then once a day, and keeps the answer, and
// which of the two gave it, in memory and in <data>/update-check.json, so a
// restart within the day doesn't ask again. Each request is a plain GET with
// no identifiers, no version of its own, nothing about the boards: GitHub's
// asks for its JSON and gives "tricot" as its User-Agent, which GitHub
// requires, and no token. A failed or slow request is dropped quietly after a
// few seconds and tried again in an hour; it never holds up the start.
//
// The check is off with TRICOT_NO_UPDATE_CHECK=1 or --no-update-check, from a
// source checkout or `npm run dev`, and in tests (checkOff). A person can
// still ask now, from the menu under their name (checkNow, POST
// /api/update/check), when only the first two turned it off. Updating itself
// is handoff.ts: from GitHub's answer, an npm install takes the release's own
// file, checked against the checksum GitHub gives for it (releaseFile.ts);
// from npm's, it installs from npm.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_NOTE, type Checked, type CheckedState, type Release, type UpdateFailure, type UpdateHow, type UpdateState } from '../core/update';
import { isNewer, isVersion } from '../core/version';
import { isLoopbackHost } from './access';
import {
  BREW_FORMULA,
  detectLaunch,
  howToUpdate,
  logUpdate,
  npmBeside,
  planHandoff,
  spawnUpdater,
  takeFailure,
  type Command,
  type HandoffPlan,
  type Launch,
  type LaunchKind,
  type ServerPlace,
} from './handoff';
import { pidAlive } from './lock';
import { INTEGRITY, releaseFileName, SHA256, USER_AGENT, type ReleaseFile } from './releaseFile';

export const REGISTRY_URL = 'https://registry.npmjs.org/tricot/latest';
const REGISTRY = 'https://registry.npmjs.org/tricot';
const GITHUB_API = 'https://api.github.com';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1 << 20;
const NOTES_MAX = 280;
const CACHE_FILE = 'update-check.json';

// GitHub's latest release of "owner/repo".
export const releasesUrl = (repo: string) => `${GITHUB_API}/repos/${repo}/releases/latest`;

// Why the automatic check is off, or nothing when it is on. Two variables
// point it elsewhere, to try the notice out, and turn it on even from a
// checkout: TRICOT_UPDATE_URL, where to ask instead of npm (e.g. a data: URL
// with {"version": "9.0.0"}), and TRICOT_RELEASES_URL, where to ask instead of
// GitHub (a stand-in for releases/latest, releasesFromEnv).
export function checkOff(env: NodeJS.ProcessEnv, kind: LaunchKind, flag?: boolean): string | undefined {
  if (flag) return '--no-update-check';
  if (env.TRICOT_NO_UPDATE_CHECK && !/^(0|false|no|off)$/i.test(env.TRICOT_NO_UPDATE_CHECK)) return 'TRICOT_NO_UPDATE_CHECK';
  return neverChecks(env, kind);
}

// Why this Tricot doesn't ask even when a person asks it to (checkNow): in
// tests, and from a source checkout, where updating makes no sense, unless
// one of the two variables points it at a stand-in. Nothing when it may: the
// flag and TRICOT_NO_UPDATE_CHECK turn off the daily check only.
export function neverChecks(env: NodeJS.ProcessEnv, kind: LaunchKind): 'tests' | 'a source checkout' | undefined {
  if (env.TRICOT_UPDATE_URL || releasesFromEnv(env).url) return undefined;
  if (env.NODE_TEST_CONTEXT) return 'tests';
  if (kind === 'source') return 'a source checkout';
  return undefined;
}

// TRICOT_RELEASES_URL, which only the environment Tricot is started in sets:
// nothing a page, a board or an agent sends reaches it. It must be an https
// address, or http on this computer (a stand-in GitHub for tests), or a data:
// URL; anything else is refused, and GitHub asked.
export function releasesFromEnv(env: NodeJS.ProcessEnv): { url?: string; refused?: string } {
  const value = env.TRICOT_RELEASES_URL;
  if (!value) return {};
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { refused: `TRICOT_RELEASES_URL isn't an address, so Tricot asks GitHub.` };
  }
  const here = url.protocol === 'http:' && isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.protocol === 'https:' || url.protocol === 'data:' || here) return { url: value };
  return { refused: `TRICOT_RELEASES_URL must be an https address, or http on this computer, so Tricot asks GitHub.` };
}

// ---- what a check found -----------------------------------------------------------

export type Source = 'github' | 'npm';

// The release a check found, which of the two said so and, from GitHub, the
// release's file (tricot-<version>.tgz) with the checksum GitHub gives for it.
export interface Found {
  release: Release;
  source: Source;
  file?: { url: string; sha256?: string };
}

// The release a version manifest from npm describes: its version, its short
// notes when the package carries them ("releaseNotes" in its package.json),
// and its release page: GitHub's for a GitHub repository, else npm's.
export function releaseFrom(manifest: unknown): Release | undefined {
  if (!manifest || typeof manifest !== 'object') return undefined;
  const m = manifest as Record<string, unknown>;
  if (!isVersion(m.version)) return undefined;
  const notes = typeof m.releaseNotes === 'string' ? shortNotes(m.releaseNotes) : undefined;
  const repo = githubRepo(m.repository);
  const link = repo ? `https://github.com/${repo}/releases/tag/v${m.version}` : `https://www.npmjs.com/package/tricot/v/${m.version}`;
  return { version: m.version, ...(notes && { notes }), link };
}

function shortNotes(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (flat.length <= NOTES_MAX) return flat;
  const cut = flat.slice(0, NOTES_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), NOTES_MAX / 2)).replace(/[\s,;:.]+$/, '')}…`;
}

// "owner/repo" from package.json's repository, when it is on GitHub.
export function githubRepo(repository: unknown): string | undefined {
  const url = typeof repository === 'string' ? repository : (repository as { url?: unknown } | null)?.url;
  if (typeof url !== 'string') return undefined;
  const match = /^(?:github:|(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

// The repository's page, from package.json's repository, for the Source link
// at the foot of Home: anyone using a running Tricot, over a network too, can
// find the code it runs. GitHub's page for a GitHub repository, else its
// address when that is https; none otherwise.
export function sourceLink(repository: unknown): string | undefined {
  const repo = githubRepo(repository);
  if (repo) return `https://github.com/${repo}`;
  const url = typeof repository === 'string' ? repository : (repository as { url?: unknown } | null)?.url;
  if (typeof url !== 'string') return undefined;
  const page = url.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https:\/\/[^\s/?#@]+\/[^\s]*$/.test(page) ? page : undefined;
}

// ---- GitHub's answer -------------------------------------------------------------

// The notes the notice shows, from a release's text: its first paragraph,
// before the install lines the release workflow adds after it, as plain
// words (no Markdown), cut at 280 characters; "Tricot <version>." when it
// has nothing before them. The workflow's first paragraph is package.json's
// releaseNotes, which npm's answer gave.
export function notesFromBody(body: unknown, version: string): string {
  const fallback = `Tricot ${version}.`;
  if (typeof body !== 'string') return fallback;
  for (const paragraph of body.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    if (!paragraph.trim()) continue;
    if (/^\s*(```|~~~)/.test(paragraph)) break; // a command: the install lines
    // A heading or a rule on its own: what's under it.
    if (paragraph.split('\n').every((line) => /^ {0,3}(#{1,6}(\s|$)|([-*_])(\s*\3){2,}\s*$)/.test(line) || !line.trim())) continue;
    const [lead] = plainText(paragraph).split(/(?:^|(?<=[.!?:]\s+))Install (?:it )?with npm\b/i);
    return shortNotes(lead) ?? fallback;
  }
  return fallback;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '') // headings
    .replace(/^ {0,3}>[ \t]?/gm, '') // quotes
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '') // list items
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // pictures: their words
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: their words
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '') // HTML
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, '$2') // code
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold
    .replace(/(?<![\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1') // italics
    .replace(/(?<!\w)_(?=\S)([^_]*?\S)_(?!\w)/g, '$1')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
}

// Where a release's file may be downloaded from: GitHub's address for it,
// https://github.com/<owner>/<repo>/releases/download/v<version>/tricot-<version>.tgz,
// or the same path on the stand-in TRICOT_RELEASES_URL names (`releases`).
function fileUrlOk(url: unknown, version: string, releases?: string): url is string {
  if (typeof url !== 'string') return false;
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return false;
  }
  const v = version.replace(/[.+]/g, '\\$&');
  if (at.search || at.hash || at.username || at.password) return false;
  if (!new RegExp(`^/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/releases/download/v${v}/tricot-${v}\\.tgz$`).test(at.pathname)) return false;
  if (at.protocol === 'https:' && at.host === 'github.com') return true;
  if (!releases || releases.startsWith(`${GITHUB_API}/`)) return false;
  try {
    const stand = new URL(releases);
    return /^https?:$/.test(stand.protocol) && at.origin === stand.origin;
  } catch {
    return false;
  }
}

// What GitHub's answer for one release says, or why it is set aside: a draft
// or (unless `prerelease`) a pre-release, a tag that isn't v<version>, or no
// tricot-<version>.tgz uploaded to it yet.
export function releaseFromGitHub(answer: unknown, options: { releases?: string; prerelease?: boolean } = {}): Found {
  if (!answer || typeof answer !== 'object') throw new Error("GitHub's answer isn't a release");
  const r = answer as Record<string, unknown>;
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  if (!tag.startsWith('v') || !isVersion(tag.slice(1))) throw new Error(`GitHub's latest release is tagged "${tag.slice(0, 40)}", not v and a version`);
  const version = tag.slice(1);
  if (r.draft === true) throw new Error(`GitHub's release ${tag} is a draft`);
  if (r.prerelease === true && !options.prerelease) throw new Error(`GitHub's release ${tag} is a pre-release`);
  const name = releaseFileName(version);
  const asset = (Array.isArray(r.assets) ? r.assets : []).find((a): a is Record<string, unknown> => !!a && typeof a === 'object' && (a as { name?: unknown }).name === name);
  if (!asset || (asset.state !== undefined && asset.state !== 'uploaded')) throw new Error(`GitHub's release ${tag} has no ${name} yet`);
  if (!fileUrlOk(asset.browser_download_url, version, options.releases)) throw new Error(`GitHub's release ${tag} has ${name} somewhere Tricot doesn't download from`);
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-fA-F]{64})$/.exec(asset.digest)?.[1]?.toLowerCase() : undefined;
  const link = typeof r.html_url === 'string' && /^https:\/\/github\.com\/[^\s]+$/.test(r.html_url) ? r.html_url : undefined;
  return {
    release: { version, notes: notesFromBody(r.body, version), ...(link && { link }) },
    source: 'github',
    file: { url: asset.browser_download_url, ...(digest && { sha256: digest }) },
  };
}

async function getJson(url: string, fetchFn: typeof fetch, timeoutMs: number, headers: Record<string, string>, who: string): Promise<unknown> {
  const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${who} answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error(`${who}'s answer is too large`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${who}'s answer isn't JSON`);
  }
}

// One release on GitHub (releases/latest, or releases/tags/v<version>).
export async function fetchGitHubRelease(url: string, fetchFn: typeof fetch = fetch, timeoutMs = TIMEOUT_MS, options: { releases?: string; prerelease?: boolean } = {}): Promise<Found> {
  const answer = await getJson(url, fetchFn, timeoutMs, { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT }, 'GitHub');
  return releaseFromGitHub(answer, { releases: options.releases ?? url, prerelease: options.prerelease });
}

// npm's latest tricot.
export async function fetchRelease(url = REGISTRY_URL, fetchFn: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<Release> {
  const release = releaseFrom(await getJson(url, fetchFn, timeoutMs, { accept: 'application/json' }, 'the registry'));
  if (!release) throw new Error("the registry's answer has no version");
  return release;
}

// Where a check asks: GitHub's releases/latest for this Tricot's repository
// (none for a package that isn't on GitHub), then npm's latest.
export interface Where {
  releases?: string;
  registry?: string;
}

// Neither GitHub nor npm answered: why, for each it asked (GitHub's is
// missing when it wasn't asked), and both in one message.
export class NoAnswer extends Error {
  constructor(
    readonly npm: unknown,
    readonly github?: unknown,
  ) {
    super(github === undefined ? said(npm) : `${said(github)}; and from npm: ${said(npm)}`);
  }
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The latest release: GitHub's, else npm's when GitHub can't say. Throws
// NoAnswer when neither can, saying why for each.
export async function fetchLatest(where: Where, fetchFn: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<Found> {
  let github: unknown;
  if (where.releases) {
    try {
      return await fetchGitHubRelease(where.releases, fetchFn, timeoutMs);
    } catch (error) {
      github = error ?? 'no answer';
    }
  }
  try {
    return { release: await fetchRelease(where.registry ?? REGISTRY_URL, fetchFn, timeoutMs), source: 'npm' };
  } catch (error) {
    throw new NoAnswer(error, github);
  }
}

// Who a check asks, in words, for what the person is told when it fails.
export const askedWhom = (where: Where) => (where.releases ? 'GitHub or the npm registry' : 'the npm registry');

// Why a check found nothing, in plain words for the person who asked it, to
// follow "Couldn't check: ": that each can't be reached (no network, a
// refused connection) or didn't answer in time, or else what it said
// ("GitHub answered 403").
export function whyNoAnswer(error: unknown): string {
  if (!(error instanceof NoAnswer)) return said(error);
  const npm = unreachable(error.npm);
  if (error.github === undefined) return npm ? `the npm registry ${npm}` : said(error.npm);
  const github = unreachable(error.github);
  if (github && github === npm) return `GitHub and the npm registry ${github}`;
  return `${github ? `GitHub ${github}` : said(error.github)}, and ${npm ? `the npm registry ${npm}` : said(error.npm)}`;
}

// A request that got no answer at all, in words: fetch's own failure (no
// network, a name that doesn't resolve, a refused connection), or the timeout.
function unreachable(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return "didn't answer in time";
  if (error instanceof TypeError) return "can't be reached";
  return undefined;
}

// npm's checksum for one version of tricot (dist.integrity, sha512).
export async function npmIntegrity(version: string, fetchFn: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<string | undefined> {
  if (!isVersion(version)) return undefined;
  const manifest = (await getJson(`${REGISTRY}/${version}`, fetchFn, timeoutMs, { accept: 'application/json' }, 'the registry')) as { version?: unknown; dist?: { integrity?: unknown } } | null;
  const integrity = manifest?.version === version ? manifest.dist?.integrity : undefined;
  return typeof integrity === 'string' && INTEGRITY.test(integrity) ? integrity : undefined;
}

// The file an npm install downloads for a release GitHub named, with the
// checksum to hold it to: GitHub's, or for a file GitHub gives none for,
// npm's for the same version. None for a release from npm, which npm installs
// itself. Throws when there is nothing to check the file against.
export async function releaseFileFor(found: Found, fetchFn: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<ReleaseFile | undefined> {
  if (found.source !== 'github' || !found.file) return undefined;
  const { version } = found.release;
  if (found.file.sha256) return { version, url: found.file.url, sha256: found.file.sha256 };
  const name = releaseFileName(version);
  let integrity: string | undefined;
  try {
    integrity = await npmIntegrity(version, fetchFn, timeoutMs);
  } catch (error) {
    throw new Error(`GitHub gives no checksum for ${name}, and the npm registry, which could vouch for it instead, couldn't be reached (${error instanceof Error ? error.message : error}), so Tricot won't install a file it can't check`);
  }
  if (!integrity) throw new Error(`GitHub gives no checksum for ${name}, and npm has no tricot ${version} to check it against, so Tricot won't install a file it can't check`);
  return { version, url: found.file.url, integrity };
}

// The running version's own release file, from its release on GitHub, to put
// it back if the new one doesn't start; none when GitHub can't say (then npm
// puts it back, as before).
export async function releaseFileOf(version: string, releases: string | undefined, fetchFn: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<ReleaseFile | undefined> {
  if (!releases || !isVersion(version) || !/\/releases\/latest$/.test(releases)) return undefined;
  try {
    const found = await fetchGitHubRelease(releases.replace(/\/releases\/latest$/, `/releases/tags/v${version}`), fetchFn, timeoutMs, { releases, prerelease: true });
    const sha256 = found.file?.sha256;
    return found.release.version === version && sha256 ? { version, url: found.file!.url, sha256 } : undefined;
  } catch {
    return undefined;
  }
}

// ---- the check -----------------------------------------------------------------

// Calls `run` after `ms`, without keeping the process alive; returns how to cancel.
export type Timer = (run: () => void, ms: number) => () => void;

const realTimer: Timer = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface CheckerOptions {
  current: string;
  dataDir: string;
  releases?: string; // GitHub's releases/latest for this Tricot; none: npm only
  url?: string; // npm's latest
  fetch?: typeof fetch;
  now?: () => number;
  timer?: Timer;
  timeoutMs?: number;
}

// Presses of "Check for updates" this close to the last answer share it.
export const SHARE_ANSWER_MS = 5000;

export class UpdateChecker {
  private found: Found | undefined;
  private checkedAt: number | undefined;
  private cancel: (() => void) | undefined;
  private asking: Promise<Found> | undefined;
  private answered: { at: number; found: Found } | { at: number; error: unknown } | undefined; // the last request's end
  private daily = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly timer: Timer;

  constructor(private readonly options: CheckerOptions) {
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? realTimer;
  }

  // The folder's last answer if it is less than a day old, else ask now; then once a day.
  start(): void {
    this.daily = true;
    const cached = readCache(this.options.dataDir, this.options.releases);
    const now = this.now();
    if (cached && cached.checkedAt <= now && now - cached.checkedAt < CHECK_EVERY_MS) {
      this.found = cached.found;
      this.checkedAt = cached.checkedAt;
      this.schedule(cached.checkedAt + CHECK_EVERY_MS - now);
    } else {
      this.schedule(0);
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
  }

  // Asks now, GitHub then npm; one request at a time.
  check(): Promise<Found> {
    this.asking ??= (async () => {
      try {
        const found = await fetchLatest({ releases: this.options.releases, registry: this.options.url }, this.options.fetch ?? fetch, this.options.timeoutMs ?? TIMEOUT_MS);
        this.found = found;
        this.checkedAt = this.now();
        this.answered = { at: this.checkedAt, found };
        writeCache(this.options.dataDir, this.checkedAt, found);
        return found;
      } catch (error) {
        this.answered = { at: this.now(), error };
        throw error;
      } finally {
        this.asking = undefined;
      }
    })();
    return this.asking;
  }

  // Asked by a person: the same check, now. Presses close together share one
  // request: one under way, or one that ended in the last few seconds,
  // answers for them, whoever asked it. A new answer counts as the day's:
  // the daily check, when it's on, asks next a day later.
  async checkNow(): Promise<Found> {
    if (this.asking) return this.asking;
    const last = this.answered;
    const age = last ? this.now() - last.at : Infinity;
    if (last && age >= 0 && age < SHARE_ANSWER_MS) {
      if ('error' in last) throw last.error;
      return last.found;
    }
    const found = await this.check();
    if (this.daily) this.schedule(CHECK_EVERY_MS);
    return found;
  }

  // The latest release, when it is newer than the one running, and where it was found.
  latest(): Found | undefined {
    return this.found && isNewer(this.found.release.version, this.options.current) ? this.found : undefined;
  }

  // The same, as a page is shown it.
  available(): Release | undefined {
    return this.latest()?.release;
  }

  lastChecked(): number | undefined {
    return this.checkedAt;
  }

  private schedule(ms: number): void {
    this.cancel?.();
    if (this.stopped) return;
    this.cancel = this.timer(() => void this.tick(), Math.max(0, ms));
  }

  private async tick(): Promise<void> {
    try {
      await this.check();
      this.schedule(CHECK_EVERY_MS);
    } catch {
      this.schedule(RETRY_MS); // offline, or both are down: quietly, later
    }
  }
}

// The last answer, read back as carefully as it was first read: a release
// GitHub named keeps its file only when that is still a place Tricot
// downloads from. A cache from before GitHub was asked came from npm.
function readCache(dataDir: string, releases?: string): { checkedAt: number; found: Found } | undefined {
  try {
    const kept = JSON.parse(readFileSync(path.join(dataDir, CACHE_FILE), 'utf8')) as { checkedAt?: unknown; source?: unknown; release?: Partial<Release>; file?: { url?: unknown; sha256?: unknown } };
    const checkedAt = typeof kept.checkedAt === 'string' ? Date.parse(kept.checkedAt) : NaN;
    const { version, notes, link } = kept.release ?? {};
    if (!Number.isFinite(checkedAt) || !isVersion(version)) return undefined;
    const release = { version, ...(typeof notes === 'string' && { notes: notes.slice(0, NOTES_MAX + 1) }), ...(typeof link === 'string' && /^https:\/\//.test(link) && { link }) };
    if (kept.source === undefined || kept.source === 'npm') return { checkedAt, found: { release, source: 'npm' } };
    if (kept.source !== 'github' || !fileUrlOk(kept.file?.url, version, releases)) return undefined;
    const sha256 = typeof kept.file?.sha256 === 'string' && SHA256.test(kept.file.sha256) ? kept.file.sha256 : undefined;
    return { checkedAt, found: { release, source: 'github', file: { url: kept.file.url, ...(sha256 && { sha256 }) } } };
  } catch {
    return undefined;
  }
}

function writeCache(dataDir: string, checkedAt: number, found: Found): void {
  try {
    const kept = { checkedAt: new Date(checkedAt).toISOString(), source: found.source, release: found.release, ...(found.file && { file: found.file }) };
    writeFileSync(path.join(dataDir, CACHE_FILE), `${JSON.stringify(kept)}\n`, { mode: 0o600 });
  } catch {
    // Kept in memory only: the next start asks again.
  }
}

// ---- updating ------------------------------------------------------------------

export interface UpdatesOptions {
  // The package folder, which says how Tricot was installed (handoff.ts);
  // none, or `launch`, when it is known already.
  root?: string;
  launch?: Launch;
  // This version's own command (node and its script): with start's options it
  // starts this version again. `updater` runs the updater, `self _handoff` unless given.
  self?: Command;
  updater?: Command;
  flags?: string[]; // start's options the next version keeps
  check: boolean; // the automatic check
  manual?: boolean; // a person may check now (checkNow): not in tests or from a source checkout (neverChecks); none: they may not
  releases?: string; // GitHub's releases/latest for this Tricot (releasesUrl, or TRICOT_RELEASES_URL); none: npm only
  url?: string; // npm's latest (TRICOT_UPDATE_URL)
  fetch?: typeof fetch;
  timer?: Timer;
  npm?: Command; // npm, without a shell; tests stand in for it
  npx?: (version: string) => Command; // what runs `npx -y tricot@<version>`; tests stand in for it
  platform?: NodeJS.Platform;
}

export type HandOffResult = { ok: true } | { ok: false; status: number; error: string; how?: UpdateHow };

export type CheckNowResult = { ok: true; state: CheckedState } | { ok: false; status: number; error: string; how?: UpdateHow };

const UPDATER_GONE = 'The updater stopped before it finished.';
const NO_CHECK_IN_TESTS = "This Tricot runs for tests, so it doesn't check for updates.";

// The check, the state a page is shown, and the handover, for one server.
export class Updates {
  private readonly checker: UpdateChecker;
  private launch: Launch | undefined;
  private detecting: Promise<Launch> | undefined;
  private updating: { version: string; pid: number } | undefined;
  private handing: { version: string; result: Promise<HandOffResult> } | undefined;
  private failed: UpdateFailure | undefined;
  private readonly npm: Command;

  constructor(
    private readonly options: UpdatesOptions & { current: string; place: ServerPlace },
    failed?: UpdateFailure,
  ) {
    this.checker = new UpdateChecker({ current: options.current, dataDir: options.place.dataDir, releases: options.releases, url: options.url, fetch: options.fetch, timer: options.timer });
    this.launch = options.launch ?? (options.root ? undefined : { kind: 'source' });
    this.failed = failed;
    this.npm = options.npm ?? npmBeside();
  }

  // After the server listens: never in the way of starting.
  start(): void {
    if (this.options.check) this.checker.start();
    void this.detect().catch(() => {});
  }

  stop(): void {
    this.checker.stop();
  }

  private detect(): Promise<Launch> {
    if (this.launch) return Promise.resolve(this.launch);
    this.detecting ??= detectLaunch(this.options.root!, { npm: this.npm, platform: this.options.platform }).then(
      (launch) => (this.launch = launch),
      () => (this.launch = { kind: 'unknown' }),
    );
    return this.detecting;
  }

  // How this Tricot updates; the command to run names the release's file on
  // GitHub when that's where the release was found.
  private howFor(launch: Launch): UpdateHow {
    const found = this.checker.latest();
    return howToUpdate(launch, this.options.place, { platform: this.options.platform, ...(found?.source === 'github' && found.file && { file: found.file.url }) });
  }

  state(): UpdateState {
    this.noticeEnd();
    const checkedAt = this.checker.lastChecked();
    const how = this.launch && this.howFor(this.launch);
    const available = this.checker.available();
    return {
      current: this.options.current,
      check: this.options.check,
      ...(available && { available }),
      ...(checkedAt !== undefined && { checkedAt: new Date(checkedAt).toISOString() }),
      ...(how && { how }),
      ...(this.updating && { updating: this.updating.version }),
      ...(this.failed && { failed: this.failed }),
    };
  }

  // A check the person asked for, now, even with the daily check off
  // (UpdateChecker.checkNow), and what it found, beside the state a page is
  // shown. Not in tests, nor from a source checkout, where it says how that
  // Tricot is updated instead.
  async checkNow(): Promise<CheckNowResult> {
    const launch = await this.detect();
    if (!this.options.manual) {
      const how = this.howFor(launch);
      const error = launch.kind === 'source' && !how.self ? `${how.why.replace(/\.$/, '')}, so it doesn't check for updates: update it with ${how.command}.` : NO_CHECK_IN_TESTS;
      return { ok: false, status: 409, error, how };
    }
    let checked: Checked;
    try {
      const found = await this.checker.checkNow();
      checked = isNewer(found.release.version, this.options.current) ? { newer: found.release } : { latest: true };
    } catch (error) {
      checked = { error: whyNoAnswer(error) };
    }
    return { ok: true, state: { ...this.state(), checked } };
  }

  // An update that stopped short leaves this server running: the updater
  // says why in the data folder, or is simply gone.
  private noticeEnd(): void {
    if (!this.updating) return;
    const failure = takeFailure(this.options.place.dataDir);
    if (failure) {
      this.failed = failure;
      this.updating = undefined;
    } else if (!pidAlive(this.updating.pid)) {
      this.failed = { version: this.updating.version, at: new Date().toISOString(), message: UPDATER_GONE, log: path.join(this.options.place.dataDir, 'update.log') };
      this.updating = undefined;
    }
  }

  // Hands over to `version`, the one the person was shown. Only the latest
  // release is ever installed: a version GitHub or npm doesn't name as latest
  // is refused, whatever asked for it. One at a time: the page and `tricot
  // update` asking together start one updater.
  async handOff(version: string): Promise<HandOffResult> {
    if (this.handing) {
      return this.handing.version === version ? this.handing.result : { ok: false, status: 409, error: `Tricot is already updating to ${this.handing.version}.` };
    }
    const result = this.tryHandOff(version);
    this.handing = { version, result };
    try {
      return await result;
    } finally {
      this.handing = undefined;
    }
  }

  private async tryHandOff(version: string): Promise<HandOffResult> {
    const { current, place } = this.options;
    this.noticeEnd();
    if (this.updating) {
      return this.updating.version === version ? { ok: true } : { ok: false, status: 409, error: `Tricot is already updating to ${this.updating.version}.` };
    }
    if (!isVersion(version)) return { ok: false, status: 400, error: `"${version}" is not a version number.` };
    if (!isNewer(version, current)) return { ok: false, status: 409, error: `Tricot ${current} is running, which is already ${version} or newer.` };
    const launch = await this.detect();
    const how = this.howFor(launch);
    if (!how.self) return { ok: false, status: 409, error: how.why, how };
    // Asked again, so the release's file and its checksum are what they are
    // now; what was found earlier still holds if neither can be reached.
    try {
      await this.checker.check();
    } catch (error) {
      if (this.checker.latest()?.release.version !== version) {
        return { ok: false, status: 502, error: `Tricot couldn't reach ${askedWhom(this.where())} to confirm ${version}: ${error instanceof Error ? error.message : error}.` };
      }
    }
    const latest = this.checker.latest();
    if (latest?.release.version !== version) {
      return { ok: false, status: 409, error: latest ? `The latest Tricot is ${latest.release.version}, not ${version}.` : `${version} isn't the latest Tricot.` };
    }
    const updater = this.options.updater ?? (this.options.self && { command: this.options.self.command, args: [...this.options.self.args, '_handoff'] });
    if (!updater || !this.options.self) return { ok: false, status: 409, error: "This Tricot wasn't started by the tricot command, so it can't restart itself." };

    // An npm install of a release GitHub named takes the release's file, and
    // puts this version back from its own if it must.
    let file: ReleaseFile | undefined;
    let backFile: ReleaseFile | undefined;
    if (how.via === 'npm' && latest.source === 'github') {
      const fetchFn = this.options.fetch ?? fetch;
      try {
        file = await releaseFileFor(latest, fetchFn);
      } catch (error) {
        return { ok: false, status: 502, error: `Tricot won't update to ${version}: ${error instanceof Error ? error.message : error}.` };
      }
      backFile = await releaseFileOf(current, this.options.releases, fetchFn);
    }

    const plan = this.plan(version, how.via, file, backFile);
    let pid: number;
    try {
      pid = await spawnUpdater(updater, plan);
    } catch (error) {
      return { ok: false, status: 500, error: `The updater couldn't be started: ${error instanceof Error ? error.message : error}.` };
    }
    this.updating = { version, pid };
    this.failed = undefined;
    const first = { npm: file ? `npm installs ${releaseFileName(version)} from its GitHub release once its checksum is checked, then ` : `npm install -g tricot@${version}, then `, brew: `brew upgrade ${BREW_FORMULA}, then `, npx: '' }[how.via];
    console.log(`Updating to Tricot ${version}: ${first}this Tricot stops and the new one starts in the background on the same address. Its output goes to ${path.join(place.dataDir, 'server.log')}.`);
    console.log(BACKUP_NOTE);
    return { ok: true };
  }

  private where(): Where {
    return { releases: this.options.releases, registry: this.options.url };
  }

  private plan(version: string, via: 'npm' | 'brew' | 'npx', file?: ReleaseFile, backFile?: ReleaseFile): HandoffPlan {
    const { current, place } = this.options;
    const from = file ? `npm, with ${releaseFileName(version)} from GitHub` : via;
    logUpdate(place.dataDir, `Asked to update ${current} to ${version} (${from}).`);
    return planHandoff({ via, version, current, place, launch: this.launch!, self: this.options.self!, npm: this.npm, npx: this.options.npx, file, backFile });
  }
}
