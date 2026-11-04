// Letting browsers and terminals in from a plain terminal (core/seats.ts,
// T187), where the switcher's Tricot tab isn't running:
//
// - The terminal where `tricot` runs the board in the foreground registers
//   with it as a Tricot terminal, as `tricot update` does, and asks when a
//   browser wants to act for the person: "A browser wants to act for you
//   (Chrome on macOS, code 4271). Allow? [y/N]", one key, y allowing it, n or
//   Enter denying it (serverTerminal). It answers the very first browser,
//   and, having let that one in, is let in with it until it exits; later ones
//   once it is a seat. It reads keys only while it asks, and Ctrl+C still
//   stops Tricot.
// - `tricot seats`, for a board running in the background or elsewhere:
//   the person's browsers and terminals, and those waiting, each asked y/N
//   (seatsCommand). It answers the first browser as the terminal above does;
//   later ones only once it is let in from a browser already in.
// - `tricot seats reset`, while Tricot is stopped: every browser and
//   terminal let go, and the next browser let in as the first was.
//
// What it holds (a host key, a seat's private key) lives in this process
// alone, as the switcher's do (switcher/answers.ts).
import { existsSync } from 'node:fs';
import { admissionWords, type AdmissionView } from '../core/seats';
import { authHeaders, HOST_KEY_HEADER } from '../server/access';
import { pidAlive, readLock, findRunning } from '../server/lock';
import { Seats, seatsFile } from '../server/seats';
import type { Key, TerminalKeys } from './boardPicker';
import { personOn } from './chooseBoard';
import { holdAnswers, type Answers } from './switcher/answers';
import { ago } from './switcher/tabView';

// ---- one question, one key ------------------------------------------------------------

export type Answered = 'yes' | 'no' | 'left' | 'interrupt';

// Asks, and reads one key while it waits, in raw mode: y is yes, n or Enter
// no, Ctrl+C stops Tricot (raw mode doesn't turn it into a signal); `left`
// when what it asked about went away meanwhile. The key is echoed.
export function askKey(keys: TerminalKeys, question: string, cancelled?: AbortSignal): Promise<Answered> {
  return new Promise((resolve) => {
    keys.write(question);
    let done = false;
    const finish = (answer: Answered, echo: string) => {
      if (done) return;
      done = true;
      stop();
      keys.write(`${echo}\n`);
      resolve(answer);
    };
    const stop = keys.listen((key: Key) => {
      if (key.ctrl && key.name === 'c') return finish('interrupt', '');
      const typed = (key.sequence ?? '').toLowerCase();
      if (typed === 'y') return finish('yes', 'y');
      if (typed === 'n' || key.name === 'return' || key.name === 'enter') return finish('no', 'n');
    });
    if (cancelled?.aborted) finish('left', '(answered elsewhere)');
    cancelled?.addEventListener('abort', () => finish('left', '(answered elsewhere)'), { once: true });
  });
}

// ---- the admissions waiting, as they change -------------------------------------------

export interface AdmissionsFeed {
  reconnect(): void; // at once: this terminal was let in, and reads as one now
  stop(): void;
}

// The admissions this terminal may answer, from the stream a page with no
// board listens to (server/approvalsRoutes.ts GET /api/approvals/stream):
// sent with the host key, and signed once this terminal is a seat.
export function watchAdmissions(options: {
  url: string;
  headers?: Record<string, string>;
  hostKey: () => Promise<string | undefined>;
  sign: (method: string, path: string) => Record<string, string>;
  onChange: (list: AdmissionView[]) => void;
  retryMs?: number;
  fetch?: typeof fetch;
}): AdmissionsFeed {
  const doFetch = options.fetch ?? fetch;
  const path = '/api/approvals/stream';
  let stopped = false;
  let streaming = false;
  let abort: AbortController | undefined;
  let wait: NodeJS.Timeout | undefined;
  const connect = async () => {
    abort = new AbortController();
    streaming = true;
    try {
      const key = await options.hostKey();
      if (stopped) return;
      const res = await doFetch(`${options.url}${path}`, {
        headers: { Accept: 'text/event-stream', ...options.headers, ...(key && { [HOST_KEY_HEADER]: key }), ...options.sign('GET', path) },
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event !== 'admissions' || data === undefined) continue;
          try {
            const list = JSON.parse(data) as unknown;
            if (Array.isArray(list)) options.onChange(list as AdmissionView[]);
          } catch {
            // not one to read
          }
        }
      }
    } catch {
      // Gone for now: it connects again.
    }
    streaming = false;
    if (stopped) return;
    wait = setTimeout(() => void connect(), options.retryMs ?? 1_000);
    wait.unref?.();
  };
  void connect();
  return {
    reconnect() {
      if (stopped) return;
      clearTimeout(wait);
      if (streaming) abort?.abort();
      else void connect();
    },
    stop() {
      stopped = true;
      clearTimeout(wait);
      abort?.abort();
    },
  };
}

// ---- who answers ---------------------------------------------------------------------

// The person at this terminal, as the board knows them: who last did
// something on the board updated most recently, else this computer's account.
export async function personHere(url: string, dataDir: string): Promise<string> {
  let latest: string | undefined;
  try {
    const res = await fetch(`${url}/api/boards`, { headers: authHeaders(dataDir), signal: AbortSignal.timeout(5_000) });
    const boards = res.ok ? ((await res.json()) as { id: string; updatedAt: string; archived?: boolean }[]) : [];
    latest = boards.filter((b) => !b.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
  } catch {
    latest = undefined;
  }
  return personOn(url, dataDir, latest);
}

// ---- the terminal where Tricot runs --------------------------------------------------

export interface ServerTerminalOptions {
  url: string;
  headers?: Record<string, string>; // its token, beyond this machine
  actor: () => Promise<string>;
  keys: TerminalKeys;
  err(line: string): void;
  interrupt?(): void; // Ctrl+C while it asks: stop Tricot, as Ctrl+C does otherwise
  fetch?: typeof fetch;
  retryMs?: number;
}

export function serverTerminal(options: ServerTerminalOptions): { stop(): Promise<void>; readonly seated: boolean } {
  let feed: AdmissionsFeed | undefined;
  const answers: Answers = holdAnswers({ url: options.url, headers: options.headers, actor: options.actor, label: 'tricot', ...(options.fetch && { fetch: options.fetch }), onSeat: () => feed?.reconnect() });
  const asked = new Set<string>(); // each one is asked once
  let waiting: AdmissionView[] = [];
  let current: { id: string; abort: AbortController } | undefined;
  let stopped = false;

  const next = async (): Promise<void> => {
    if (current || stopped) return;
    const admission = waiting.find((a) => !asked.has(a.id));
    if (!admission) return;
    asked.add(admission.id);
    const abort = new AbortController();
    current = { id: admission.id, abort };
    const answer = await askKey(options.keys, `${admissionWords(admission)}. Allow? [y/N] `, abort.signal);
    current = undefined;
    if (answer === 'interrupt') {
      options.interrupt?.();
      return;
    }
    if (answer === 'yes' || answer === 'no') {
      const outcome = await answers.admit(admission.id, answer === 'yes');
      if (!outcome.ok) options.err(outcome.error);
    }
    void next();
  };

  feed = watchAdmissions({
    url: options.url,
    headers: options.headers,
    hostKey: answers.held,
    sign: (method, path) => answers.sign(method, path),
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.retryMs && { retryMs: options.retryMs }),
    onChange: (list) => {
      waiting = list;
      if (current && !list.some((a) => a.id === current!.id)) current.abort.abort();
      void next();
    },
  });

  return {
    get seated() {
      return answers.seated;
    },
    async stop() {
      stopped = true;
      current?.abort.abort();
      feed?.stop();
      await answers.release();
    },
  };
}

// ---- tricot seats ----------------------------------------------------------------------

export interface SeatsCommandEnv {
  dataDir: string;
  out(line: string): void;
  err(line: string): void;
  keys?: TerminalKeys;
  ask?(question: string, fallback?: boolean): Promise<boolean>;
  fetch?: typeof fetch;
  now?: () => number;
}

// y or n, with one key where there is a terminal to read keys in, else a line.
async function yesNo(env: SeatsCommandEnv, question: string): Promise<boolean | undefined> {
  if (env.keys) {
    const answer = await askKey(env.keys, question);
    return answer === 'yes' ? true : answer === 'interrupt' ? undefined : false;
  }
  if (env.ask) return env.ask(question.trimEnd(), false);
  return undefined;
}

export async function seatsCommand(env: SeatsCommandEnv, arg?: string): Promise<{ exitCode: number }> {
  if (arg === 'reset') return reset(env);
  if (arg !== undefined) {
    env.err(`Unknown: tricot seats ${arg}. Run tricot seats to see and let in your browsers and terminals, or tricot seats reset, with Tricot stopped, to start again.`);
    return { exitCode: 1 };
  }
  const running = await findRunning(env.dataDir);
  if (!running?.url) {
    env.err(`Tricot isn't running on ${env.dataDir}. Start it with tricot: the terminal where it runs asks when a browser wants to act for you.`);
    return { exitCode: 1 };
  }
  const url = running.url;
  const answers = holdAnswers({ url, headers: authHeaders(env.dataDir), actor: () => personHere(url, env.dataDir), label: 'tricot seats', ...(env.fetch && { fetch: env.fetch }) });
  try {
    let waiting = await answers.admissions();
    if (!waiting.ok && waiting.needsSeat) {
      // Not the very first browser any more: only a browser or terminal let in answers.
      env.out("Only a browser or terminal you've let in can let others in, and this terminal isn't one yet.");
      const asked = await answers.askSeat();
      if (!asked.ok) {
        env.err(asked.error);
        return { exitCode: 1 };
      }
      env.out(`Let it in from a browser you've already let in: it shows code ${asked.code}. Waiting for you there…`);
      const end = await answers.seatEnded();
      if (end !== 'admitted') {
        env.err(end === 'denied' ? 'It was denied in the browser, so this terminal lets nothing in.' : 'Nobody allowed it in time, so this terminal lets nothing in.');
        return { exitCode: 1 };
      }
      waiting = await answers.admissions();
    }
    if (!waiting.ok) {
      env.err(waiting.error);
      return { exitCode: 1 };
    }
    const now = env.now?.() ?? Date.now();
    const seats = answers.seated ? await answers.seats() : undefined;
    if (seats?.ok && seats.list.length) {
      env.out('Your browsers and terminals:');
      for (const seat of seats.list) env.out(`  ${seat.label}${seat.you ? ' (this terminal)' : ''}: let in ${ago(seat.admittedAt, now)} ${seat.admittedBy}, ${seat.lastUsedAt ? `last used ${ago(seat.lastUsedAt, now)}` : 'not used yet'}`);
    } else if (!answers.seated) env.out('No browser or terminal acts for you yet: the first browser that asks is let in from here, or from the terminal where Tricot runs.');
    if (!waiting.list.length) {
      env.out(answers.seated ? 'Nothing is waiting to be let in.' : `Nothing is waiting to be let in. Open ${url} in your browser: it shows a code when it asks, and this asks too when you run it again.`);
      return { exitCode: 0 };
    }
    for (const admission of waiting.list) {
      const allow = await yesNo(env, `${admissionWords(admission)}. Allow? [y/N] `);
      if (allow === undefined) {
        env.err('tricot seats asks before letting anything in: run it in a terminal.');
        return { exitCode: 1 };
      }
      const outcome = await answers.admit(admission.id, allow);
      if (!outcome.ok) env.err(outcome.error);
      else env.out(allow ? `${admission.label} acts for you now.` : `Denied: ${admission.label} doesn't act for you.`);
    }
    return { exitCode: 0 };
  } finally {
    await answers.release();
  }
}

// Every browser and terminal let go, the file alone, while Tricot is stopped:
// a running Tricot holds them in memory and would write them back.
async function reset(env: SeatsCommandEnv): Promise<{ exitCode: number }> {
  const lock = readLock(env.dataDir);
  if (lock && pidAlive(lock.pid)) {
    env.err(`Tricot is running on ${env.dataDir} (pid ${lock.pid}). Stop it first with tricot stop, then run tricot seats reset.`);
    return { exitCode: 1 };
  }
  if (!existsSync(seatsFile(env.dataDir))) {
    env.out(`No browser or terminal is let in on ${env.dataDir}: there is nothing to reset.`);
    return { exitCode: 0 };
  }
  const yes = await yesNo(env, "Remove every browser and terminal you've let in? [y/N] ");
  if (yes === undefined) {
    env.err('tricot seats reset asks first: run it in a terminal.');
    return { exitCode: 1 };
  }
  if (!yes) {
    env.out('Nothing was removed.');
    return { exitCode: 0 };
  }
  Seats.reset(env.dataDir);
  env.out('Done: no browser or terminal acts for you now. Until one is let in again, answering agents, approving commits, deciding and the like wait.');
  env.out('The next browser that asks is let in as the first one was, by a keypress in the terminal where Tricot runs or with tricot seats. Start Tricot and let your own browser in first, before anything else asks.');
  return { exitCode: 0 };
}
