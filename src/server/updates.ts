// Is there a newer Tricot? The server asks the npm registry for the latest
// `tricot`, once when it starts and then once a day, and keeps the answer in
// memory and in <data>/update-check.json, so a restart within the day doesn't
// ask again. The request is a plain GET of the package's latest version: no
// identifiers, no version of its own, nothing about the boards. A failed or
// slow request (offline) is dropped quietly after a few seconds and tried
// again in an hour; it never holds up the start.
//
// The check is off with TRICOT_NO_UPDATE_CHECK=1 or --no-update-check, from a
// source checkout or `npm run dev`, and in tests (checkOff). Updating itself
// is handoff.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_NOTE, type Release, type UpdateFailure, type UpdateHow, type UpdateState } from '../core/update';
import { isNewer, isVersion } from '../core/version';
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

export const REGISTRY_URL = 'https://registry.npmjs.org/tricot/latest';
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1 << 20;
const NOTES_MAX = 280;
const CACHE_FILE = 'update-check.json';

// Why the automatic check is off, or nothing when it is on. TRICOT_UPDATE_URL
// (where to ask instead of npm, e.g. a data: URL with {"version": "9.0.0"})
// is for trying the notice out, and turns it on even from a checkout.
export function checkOff(env: NodeJS.ProcessEnv, kind: LaunchKind, flag?: boolean): string | undefined {
  if (flag) return '--no-update-check';
  if (env.TRICOT_NO_UPDATE_CHECK && !/^(0|false|no|off)$/i.test(env.TRICOT_NO_UPDATE_CHECK)) return 'TRICOT_NO_UPDATE_CHECK';
  if (env.TRICOT_UPDATE_URL) return undefined;
  if (env.NODE_TEST_CONTEXT) return 'tests';
  if (kind === 'source') return 'a source checkout';
  return undefined;
}

// ---- the registry's answer ------------------------------------------------------

// The release a version manifest describes: its version, its short notes when
// the package carries them ("releaseNotes" in its package.json), and its
// release page: GitHub's for a GitHub repository, else npm's.
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
// find the code it runs (the AGPL's section 13). GitHub's page for a GitHub
// repository, else its address when that is https; none otherwise.
export function sourceLink(repository: unknown): string | undefined {
  const repo = githubRepo(repository);
  if (repo) return `https://github.com/${repo}`;
  const url = typeof repository === 'string' ? repository : (repository as { url?: unknown } | null)?.url;
  if (typeof url !== 'string') return undefined;
  const page = url.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https:\/\/[^\s/?#@]+\/[^\s]*$/.test(page) ? page : undefined;
}

export async function fetchRelease(url = REGISTRY_URL, fetchFn: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<Release> {
  const response = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`the registry answered ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("the registry's answer is too large");
  const release = releaseFrom(JSON.parse(text));
  if (!release) throw new Error("the registry's answer has no version");
  return release;
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
  url?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timer?: Timer;
  timeoutMs?: number;
}

export class UpdateChecker {
  private release: Release | undefined;
  private checkedAt: number | undefined;
  private cancel: (() => void) | undefined;
  private asking: Promise<Release> | undefined;
  private stopped = false;
  private readonly now: () => number;
  private readonly timer: Timer;

  constructor(private readonly options: CheckerOptions) {
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? realTimer;
  }

  // The folder's last answer if it is less than a day old, else ask now; then once a day.
  start(): void {
    const cached = readCache(this.options.dataDir);
    const now = this.now();
    if (cached && cached.checkedAt <= now && now - cached.checkedAt < CHECK_EVERY_MS) {
      this.release = cached.release;
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

  // Asks the registry now; one request at a time.
  check(): Promise<Release> {
    this.asking ??= (async () => {
      try {
        const release = await fetchRelease(this.options.url ?? REGISTRY_URL, this.options.fetch ?? fetch, this.options.timeoutMs ?? TIMEOUT_MS);
        this.release = release;
        this.checkedAt = this.now();
        writeCache(this.options.dataDir, { checkedAt: this.checkedAt, release });
        return release;
      } finally {
        this.asking = undefined;
      }
    })();
    return this.asking;
  }

  // The latest release, when it is newer than the one running.
  available(): Release | undefined {
    return this.release && isNewer(this.release.version, this.options.current) ? this.release : undefined;
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
      this.schedule(RETRY_MS); // offline, or the registry is down: quietly, later
    }
  }
}

function readCache(dataDir: string): { checkedAt: number; release: Release } | undefined {
  try {
    const kept = JSON.parse(readFileSync(path.join(dataDir, CACHE_FILE), 'utf8')) as { checkedAt?: unknown; release?: Partial<Release> };
    const checkedAt = typeof kept.checkedAt === 'string' ? Date.parse(kept.checkedAt) : NaN;
    const { version, notes, link } = kept.release ?? {};
    if (!Number.isFinite(checkedAt) || !isVersion(version)) return undefined;
    return {
      checkedAt,
      release: { version, ...(typeof notes === 'string' && { notes }), ...(typeof link === 'string' && /^https:\/\//.test(link) && { link }) },
    };
  } catch {
    return undefined;
  }
}

function writeCache(dataDir: string, cache: { checkedAt: number; release: Release }): void {
  try {
    writeFileSync(path.join(dataDir, CACHE_FILE), `${JSON.stringify({ checkedAt: new Date(cache.checkedAt).toISOString(), release: cache.release })}\n`, { mode: 0o600 });
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
  url?: string;
  fetch?: typeof fetch;
  timer?: Timer;
  npm?: Command; // npm, without a shell; tests stand in for it
  npx?: (version: string) => Command; // what runs `npx -y tricot@<version>`; tests stand in for it
  platform?: NodeJS.Platform;
}

export type HandOffResult = { ok: true } | { ok: false; status: number; error: string; how?: UpdateHow };

const UPDATER_GONE = 'The updater stopped before it finished.';

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
    this.checker = new UpdateChecker({ current: options.current, dataDir: options.place.dataDir, url: options.url, fetch: options.fetch, timer: options.timer });
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

  private how(): UpdateHow | undefined {
    return this.launch && howToUpdate(this.launch, this.options.place, { platform: this.options.platform });
  }

  state(): UpdateState {
    this.noticeEnd();
    const checkedAt = this.checker.lastChecked();
    const how = this.how();
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
  // release is ever installed: a version the registry doesn't name as latest
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
    const how = howToUpdate(await this.detect(), place, { platform: this.options.platform });
    if (!how.self) return { ok: false, status: 409, error: how.why, how };
    if (this.checker.available()?.version !== version) {
      try {
        await this.checker.check();
      } catch (error) {
        return { ok: false, status: 502, error: `Tricot couldn't reach the npm registry to confirm ${version}: ${error instanceof Error ? error.message : error}.` };
      }
    }
    const latest = this.checker.available();
    if (latest?.version !== version) {
      return { ok: false, status: 409, error: latest ? `The latest Tricot is ${latest.version}, not ${version}.` : `${version} isn't the latest Tricot.` };
    }
    const updater = this.options.updater ?? (this.options.self && { command: this.options.self.command, args: [...this.options.self.args, '_handoff'] });
    if (!updater || !this.options.self) return { ok: false, status: 409, error: "This Tricot wasn't started by the tricot command, so it can't restart itself." };

    const plan = this.plan(version, how.via);
    let pid: number;
    try {
      pid = await spawnUpdater(updater, plan);
    } catch (error) {
      return { ok: false, status: 500, error: `The updater couldn't be started: ${error instanceof Error ? error.message : error}.` };
    }
    this.updating = { version, pid };
    this.failed = undefined;
    const first = { npm: `npm install -g tricot@${version}, then `, brew: `brew upgrade ${BREW_FORMULA}, then `, npx: '' }[how.via];
    console.log(`Updating to Tricot ${version}: ${first}this Tricot stops and the new one starts in the background on the same address. Its output goes to ${path.join(place.dataDir, 'server.log')}.`);
    console.log(BACKUP_NOTE);
    return { ok: true };
  }

  private plan(version: string, via: 'npm' | 'brew' | 'npx'): HandoffPlan {
    const { current, place } = this.options;
    logUpdate(place.dataDir, `Asked to update ${current} to ${version} (${via}).`);
    return planHandoff({ via, version, current, place, launch: this.launch!, self: this.options.self!, npm: this.npm, npx: this.options.npx });
  }
}
