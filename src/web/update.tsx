import { useEffect, useState, useSyncExternalStore } from 'react';
import { BACKUP_NOTE, type Release, type UpdateFailure, type UpdateHow, type UpdateState } from '../core/update';
import { api, type RequestError } from './api';
import { Icon, Popover } from './components';
import { Stitch } from './stitch';
import './update.css';

// "Tricot 0.2.0 is out": a quiet notice on Home (UpdateNotice) and in a
// board's top bar (UpdateChip), from what the server last heard from GitHub
// (GET /api/update, server/updates.ts). Update asks the server to update
// itself (POST /api/update): it installs the new version, hands its address
// over to it and restarts, while the page says "Updating to 0.2.0…" and asks
// every second until the new version answers, then reloads into it. Where the
// server can't update itself, the button copies the command to run instead.
// Skipping a version is this browser's, until a newer one is out.

const SKIPPED_KEY = 'tricot:update-skipped'; // localStorage: the version set aside
const FAILURE_SEEN_KEY = 'tricot:update-failure-seen'; // localStorage: when the failure read was
const UPDATING_KEY = 'tricot:updating'; // sessionStorage: the update this tab is waiting for
const UPDATED_KEY = 'tricot:updated'; // sessionStorage: the version this tab just reloaded into

const CHECK_EVERY_MS = 10 * 60_000; // the server checks GitHub once a day; this only asks the server
const WAIT_EVERY_MS = 1000;
const GIVE_UP_MS = 8 * 60_000; // npm may be slow to install it

interface Waiting {
  release: Release;
  from: string;
  since: number;
  slow?: boolean; // it's taking longer than it should
}

interface Snapshot {
  state: UpdateState | null; // null until the server says, or when it doesn't
  loadedAs?: string; // the version this page came from
  waiting?: Waiting;
  error?: string; // a refused update, in the server's words
  skipped?: string;
  failureSeen?: string;
  justUpdated?: Release;
}

const stored = {
  get(store: Storage | undefined, key: string): string | undefined {
    try {
      return store?.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(store: Storage | undefined, key: string, value: string | undefined): void {
    try {
      if (value === undefined) store?.removeItem(key);
      else store?.setItem(key, value);
    } catch {
      // Not kept: it comes back on the next visit, which is all it costs.
    }
  },
};
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage);
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

function readJson<T>(text: string | undefined): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

let snapshot: Snapshot = {
  state: null,
  skipped: stored.get(local(), SKIPPED_KEY),
  failureSeen: stored.get(local(), FAILURE_SEEN_KEY),
  justUpdated: readJson<Release>(stored.get(session(), UPDATED_KEY)),
  waiting: readJson<Waiting>(stored.get(session(), UPDATING_KEY)),
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function set(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function load(): void {
  api.update().then(
    (state) => {
      set({ state, loadedAs: snapshot.loadedAs ?? state.current });
      // Another tab, or `tricot update`, started it: wait for it here too.
      if (state.updating && !snapshot.waiting) {
        set({ waiting: { release: state.available ?? { version: state.updating }, from: state.current, since: Date.now() } });
      }
      // This tab reloaded while waiting: go on waiting.
      if (snapshot.waiting) void waitForNewVersion();
    },
    () => {}, // a server without updates (npm run dev), or away for a moment
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    load();
    timer = setInterval(load, CHECK_EVERY_MS);
    window.addEventListener('focus', load);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      window.removeEventListener('focus', load);
    }
  };
}

export function useUpdate(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

// ---- updating -----------------------------------------------------------------

let waitingNow = false;

export async function startUpdate(release: Release): Promise<void> {
  const from = snapshot.state?.current ?? '';
  set({ error: undefined });
  try {
    const state = await api.startUpdate(release.version);
    const waiting = { release, from, since: Date.now() };
    stored.set(session(), UPDATING_KEY, JSON.stringify(waiting));
    set({ state, waiting });
    void waitForNewVersion();
  } catch (e) {
    set({ error: (e as RequestError).message });
    load(); // it may say how to update instead
  }
}

async function fetchState(): Promise<UpdateState | undefined> {
  try {
    const response = await fetch('/api/update', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    return response.ok ? ((await response.json()) as UpdateState) : undefined;
  } catch {
    return undefined; // between the two: the old one has stopped, the new one isn't up yet
  }
}

// Asks every second until the new version answers, then reloads into it: its
// page is the new version's too. An update that stopped short says why.
async function waitForNewVersion(): Promise<void> {
  if (waitingNow) return;
  waitingNow = true;
  try {
    for (;;) {
      const waiting = snapshot.waiting;
      if (!waiting) return;
      if (Date.now() - waiting.since > GIVE_UP_MS) {
        set({ waiting: { ...waiting, slow: true } });
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_EVERY_MS));
      const state = await fetchState();
      if (!state) continue;
      if (state.current === waiting.release.version) {
        stored.set(session(), UPDATING_KEY, undefined);
        stored.set(session(), UPDATED_KEY, JSON.stringify(waiting.release));
        location.reload();
        return;
      }
      if (state.failed?.version === waiting.release.version) {
        stored.set(session(), UPDATING_KEY, undefined);
        set({ state, waiting: undefined });
        return;
      }
      set({ state });
    }
  } finally {
    waitingNow = false;
  }
}

export function skipVersion(version: string): void {
  stored.set(local(), SKIPPED_KEY, version);
  set({ skipped: version });
}

function seenFailure(failure: UpdateFailure): void {
  stored.set(local(), FAILURE_SEEN_KEY, failure.at);
  set({ failureSeen: failure.at });
}

function seenUpdate(): void {
  stored.set(session(), UPDATED_KEY, undefined);
  set({ justUpdated: undefined });
}

// ---- what shows ---------------------------------------------------------------

export type Shown =
  | { kind: 'updating'; version: string; slow: boolean; how?: UpdateHow }
  | { kind: 'failed'; failure: UpdateFailure; current: string }
  | { kind: 'updated'; release: Release }
  | { kind: 'moved'; version: string } // the server is on another version than this page: updated elsewhere
  | { kind: 'available'; release: Release; current: string; how?: UpdateHow; error?: string };

// What the notice shows now, if anything: an update under way first, then
// one that didn't finish, one just done, and last a release not skipped.
export function shownOf(s: Snapshot): Shown | null {
  const { state } = s;
  if (s.waiting) return { kind: 'updating', version: s.waiting.release.version, slow: Boolean(s.waiting.slow), how: state?.how };
  if (!state) return null;
  if (state.updating) return { kind: 'updating', version: state.updating, slow: false, how: state.how };
  if (state.failed && state.failed.at !== s.failureSeen) return { kind: 'failed', failure: state.failed, current: state.current };
  if (s.justUpdated && s.justUpdated.version === state.current) return { kind: 'updated', release: s.justUpdated };
  if (s.loadedAs && state.current !== s.loadedAs) return { kind: 'moved', version: state.current };
  if (state.available && state.available.version !== s.skipped) return { kind: 'available', release: state.available, current: state.current, how: state.how, error: s.error };
  return null;
}

// ---- the notice ---------------------------------------------------------------

const VIA = { npm: 'npm is installing it', brew: 'Homebrew is upgrading it', npx: 'npx is fetching it' } as const;

function UpdateBody({ shown }: { shown: Shown }) {
  switch (shown.kind) {
    case 'updating':
      return (
        <>
          <div className="update-text">
            <p className="update-title">
              <strong>Updating to Tricot {shown.version}…</strong>
            </p>
            <p className="update-fine">
              {shown.slow
                ? "It's taking longer than it should. What happened is in update.log, in Tricot's data folder."
                : `${shown.how?.self ? `${VIA[shown.how.via]}, then ` : ''}Tricot restarts on the same address. This page reconnects by itself.`}
            </p>
          </div>
          <span className="update-busy" aria-hidden>
            <Stitch state="working" />
          </span>
        </>
      );
    case 'failed':
      return (
        <>
          <div className="update-text">
            <p className="update-title">
              <strong>The update to Tricot {shown.failure.version} didn't finish.</strong> You're on {shown.current}.
            </p>
            <p className="update-fine">{shown.failure.message}</p>
            <p className="update-fine">
              What happened is in <code>{shown.failure.log}</code>.
            </p>
          </div>
          <div className="update-actions">
            <button className="btn btn-small" onClick={() => seenFailure(shown.failure)}>
              OK
            </button>
          </div>
        </>
      );
    case 'updated':
      return (
        <>
          <div className="update-text">
            <p className="update-title">
              <strong>You're on Tricot {shown.release.version} now.</strong>
            </p>
            {shown.release.notes && <p className="update-notes">{shown.release.notes}</p>}
            <WhatsNew release={shown.release} />
          </div>
          <div className="update-actions">
            <button className="btn btn-small" onClick={seenUpdate}>
              OK
            </button>
          </div>
        </>
      );
    case 'moved':
      return (
        <>
          <div className="update-text">
            <p className="update-title">
              <strong>Tricot is now {shown.version}.</strong> Reload to use it.
            </p>
          </div>
          <div className="update-actions">
            <button className="btn btn-primary btn-small" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </>
      );
    case 'available':
      return <Available shown={shown} />;
  }
}

function WhatsNew({ release }: { release: Release }) {
  if (!release.link) return null;
  return (
    <a className="update-link" href={release.link} target="_blank" rel="noreferrer">
      What's new in {release.version}
      <Icon name="external" />
    </a>
  );
}

function Available({ shown }: { shown: Extract<Shown, { kind: 'available' }> }) {
  const { release, current, how, error } = shown;
  const [busy, setBusy] = useState(false);
  const manual = how && !how.self ? how : undefined;
  const update = () => {
    setBusy(true);
    void startUpdate(release).finally(() => setBusy(false));
  };
  return (
    <>
      <div className="update-text">
        <p className="update-title">
          <strong>Tricot {release.version} is out.</strong> You have {current}.
        </p>
        {release.notes && <p className="update-notes">{release.notes}</p>}
        <WhatsNew release={release} />
        {manual ? (
          <>
            <p className="update-fine">{manual.why}</p>
            <code className="update-command">{manual.command}</code>
            {manual.restart && (
              <>
                <p className="update-fine">Then restart Tricot on it:</p>
                <code className="update-command">{manual.restart}</code>
              </>
            )}
            <p className="update-fine">{BACKUP_NOTE}</p>
          </>
        ) : (
          <p className="update-fine">Update installs it, and Tricot restarts on the same address; this page reconnects by itself. {BACKUP_NOTE}</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="update-actions">
        {manual ? (
          <CopyCommand text={manual.command} />
        ) : (
          <button className="btn btn-primary btn-small" disabled={busy} onClick={update}>
            Update
          </button>
        )}
        <button className="btn btn-quiet btn-small" onClick={() => skipVersion(release.version)} title="Hides it until a newer version is out">
          Skip this version
        </button>
      </div>
    </>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const reset = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(reset);
  }, [copied]);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {}, // clipboard blocked: the command stays there to select
    );
  return (
    <button className="btn btn-primary btn-small" onClick={() => void copy()}>
      {copied ? 'Copied' : 'Copy the update command'}
    </button>
  );
}

// Home's: a quiet line above everything, while there is something to say.
export function UpdateNotice() {
  const shown = shownOf(useUpdate());
  if (!shown) return null;
  return (
    <section className={`update-notice is-${shown.kind}`} aria-label="Tricot update" aria-live="polite">
      <Icon name={shown.kind === 'updated' ? 'check' : 'arrow-up'} className="update-icon" />
      <UpdateBody shown={shown} />
    </section>
  );
}

function chipLabel(shown: Shown): string {
  switch (shown.kind) {
    case 'updating':
      return `Updating to ${shown.version}…`;
    case 'failed':
      return "Update didn't finish";
    case 'updated':
      return `Updated to ${shown.release.version}`;
    case 'moved':
      return `Tricot ${shown.version}: reload`;
    case 'available':
      return `Tricot ${shown.release.version} is out`;
  }
}

// A board's: a small label in its top bar, which opens the same notice.
export function UpdateChip() {
  const shown = shownOf(useUpdate());
  if (!shown) return null;
  const label = chipLabel(shown);
  return (
    <Popover className="update-chip">
      <summary className={`update-chip-button is-${shown.kind}`} title={label}>
        {shown.kind === 'updating' ? <Stitch state="working" /> : <Icon name={shown.kind === 'updated' ? 'check' : 'arrow-up'} />}
        <span>{label}</span>
      </summary>
      <div className={`popover-body update-popover is-${shown.kind}`} aria-live="polite">
        <UpdateBody shown={shown} />
      </div>
    </Popover>
  );
}
