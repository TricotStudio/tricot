// Tricot wakes the agents it starts. A listening agent
// takes a whole model turn each time its wait returns, re-reading its
// conversation, most often for nothing. An agent this terminal started, of a
// kind Tricot can wake (its registry entry's `wakes`), is told instead to end
// its turn when it has nothing to do (core/sessions.ts wakeUrl, which names
// this terminal, server/mcp/session.ts), and this types a line in its
// prompt, then Enter, when something on the board needs it (WAKE_LINE): it
// reads its updates.
//
// This terminal holds each such agent on the board (server/sleepers.ts): it
// sends the board its view of each every few seconds, and at once as one
// falls asleep or is given something to do (POST /api/boards/:id/wakes).
// The view is whether its turn is over (asleep), the board's event from
// which what concerns it is due (`since`), and as of when; the board keeps
// the newer of that and its own record, which a wait that ended the agent's
// turn brings forward. The board answers with each record, and what is due:
// the latest event after `since` that concerns the agent (core/concerns.ts).
// A read doesn't consume it, whoever made it (a Claude Code agent's
// subagents call through its session): a wake that started a turn does, and
// the end of a turn after reading. Another terminal holding the same name on
// the board is refused it: its agent's session, which names its own
// terminal, then waits as any agent's does.
//
// Its turn is over, as far as this terminal knows, once the board says so,
// once its hooks sent the end of its turn (a done step), or once it has been
// quiet for QUIET_TURN_MS with no bell, when neither came (it ended its turn
// another way, or errored). Being given something to do starts a turn: woken,
// sent something by the person in its tab (whatever its prompt held as they
// pressed Enter, a command or a wake line left there included), or drawing
// steadily for DRAWING_TURN_MS while asleep (a turn it began on its own, as
// Claude Code does when a background subagent finishes). The strip says
// asleep while its turn is over.
//
// A wake goes only when every one of these holds (holdOf), and waits until they do:
//  - something is due, newer than what it was last woken for, or a stuck
//    wake's own, retried after a pause, a few times (RETRY_MS);
//  - its turn is over, it isn't waiting on the board, and it has drawn
//    nothing for SETTLE_MS;
//  - no request for permission from it waits on the board;
//  - the person hasn't typed in its tab for TYPING_MS, and its prompt, as its
//    screen shows it, holds nothing but, at most, the wake line itself.
// It types the line (unless it stands there already), then watches for its
// prompt to hold the line and nothing else, for up to ECHO_MS: a dialog that
// took the keys instead (a permission prompt in its terminal) never gets the
// Enter, nor does a line the person typed into. After the Enter, its prompt
// must be empty within CONFIRM_MS, or Enter goes once more; a wake that still
// started no turn is stuck: the strip and the board say so.
import { randomUUID } from 'node:crypto';
import type { WakeTraits } from '../../core/agents/agent';
import { samePerson } from '../../core/format';
import { routes, routeUrl } from '../../core/routes';
import type { Answers } from './answers';
import type { InputModes } from './screen';
import { waitingFor, type BoardLive, type WakeView } from './strip';
import { TabKeyReader } from './tabKeys';

export const WAKE_LINE = 'Something on the board needs you: read your updates.';
export const SETTLE_MS = 1_500; // drew nothing for this long: its turn's last words are out
export const TYPING_MS = 4_000; // a key in its tab this recently: the person is typing there
export const REPORT_MS = 5_000; // how often the board hears which agents this terminal holds (server/sleepers.ts REACHABLE_MS is four of these)
export const QUIET_TURN_MS = 20_000; // quiet this long, with no bell, since it was given something to do: its turn is over, though nothing said so
export const DRAWING_TURN_MS = 3_000; // drawing without a break this long while asleep: it began a turn of its own
export const ECHO_MS = 1_000; // the typed line shows in its prompt within this
export const CONFIRM_MS = 1_500; // after Enter, its prompt is empty within this, or Enter goes once more
export const RETRY_MS = [5_000, 15_000, 45_000]; // a stuck wake tries again after each of these, then gives up on what it was for
const LAST_KEY_MS = 150; // a key from the person this close before the Enter holds it
const POLL_MS = 50;

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// What its prompt holds, from its cursor's row as its screen shows it
// (screen.ts cursorRow): the text before the cursor less the prompt's own
// mark (❯, ›, >) and any border, and what is typed after the cursor, a faint
// suggestion left out; spaces made one. Empty: an empty prompt.
export function promptContent(row: { before: string; after: string }): string {
  const before = row.before.replace(/^[\s│┃|]*(?:[❯›>»▶➜$%#]\s?)?/, '');
  return `${before}${row.after}`.replace(/\s+/g, ' ').trim();
}

// The person's keys in an agent's tab, read as the agent will (tabKeys.ts):
// whether any is a key (a mouse report is none), and whether they send the
// agent something: an Enter on a prompt that held anything, as its screen
// showed it just before (`shown`), or that their keys put there. What they
// typed is kept as near as the keys tell, for a prompt the screen can't show
// whole (a line on more than one row): Ctrl+U and Ctrl+C clear it; Esc and
// ↑ leave it to the screen.
export class Draft {
  private reader = new TabKeyReader();
  private text = '';

  keys(data: Buffer, shown = ''): { typed: boolean; sent: boolean } {
    let typed = false;
    let sent = false;
    for (const key of this.reader.read(data)) {
      if (key.kind === 'other') continue;
      typed = true;
      if (key.kind === 'text' || key.kind === 'paste') this.text += key.text;
      else if (key.kind === 'newline') this.text += '\n';
      else if (key.kind === 'backspace') this.text = [...this.text].slice(0, -1).join('');
      else if (key.kind === 'deleteword') this.text = this.text.replace(/(?:\S+\s*|\s+)$/, '');
      else if (key.kind === 'clear' || key.kind === 'interrupt') this.text = '';
      else if (key.kind === 'enter') {
        if (this.text.trim() || shown) sent = true;
        this.text = '';
        shown = '';
      }
    }
    return { typed, sent };
  }
}

// Why a wake waits, or nothing when it is time.
export type Hold = 'nothing' | 'woken' | 'retry' | 'refused' | 'stopped' | 'waking' | 'approval' | 'draft' | 'typing' | 'busy' | 'listening' | 'drawing';

export interface HoldInput {
  due?: number; // the latest event due, as the board last said
  wokeFor: number; // the event it was last woken for (or gave up on)
  retryInMs?: number; // a stuck wake for `due` tries again in this long (none, or 0: now)
  refused?: boolean; // another terminal holds an agent of its name on the board
  running: boolean; // started, and not closing
  waking?: boolean; // a wake being typed into it now
  asleep: boolean; // its turn is over
  listening?: boolean; // it waits on the board, in a wait that waited after all
  quietMs: number; // since it last drew
  approval: boolean; // a request for permission from it waits
  typedMs: number; // since the person's last key in its tab
  prompt: string; // what its prompt holds (promptContent)
}

export function holdOf(input: HoldInput): Hold | undefined {
  if (input.due === undefined) return 'nothing';
  if (input.due <= input.wokeFor) return 'woken';
  if ((input.retryInMs ?? 0) > 0) return 'retry';
  if (input.refused) return 'refused';
  if (!input.running) return 'stopped';
  if (input.waking) return 'waking';
  if (input.approval) return 'approval';
  if (input.prompt && input.prompt !== WAKE_LINE) return 'draft';
  if (input.typedMs < TYPING_MS) return 'typing';
  if (!input.asleep) return 'busy';
  if (input.listening) return 'listening';
  if (input.quietMs < SETTLE_MS) return 'drawing';
  return undefined;
}

// What the board is told (server/api.ts wakes), and what it answers (server/wakes.ts).
export interface HeldView {
  name: string;
  asleep: boolean;
  since?: number;
  at: number;
  stuck?: boolean;
}
export interface WakeReport {
  holder: string;
  agents: HeldView[];
  gone: string[];
}
export interface WakeReply {
  seq?: number;
  agents?: { name: string; asleep: boolean; since: number; at: number; due?: number; stuck?: boolean }[];
  refused?: string[];
}
export type WakeLink = (report: WakeReport) => Promise<WakeReply | undefined>;

// The board's, as this terminal (answers.ts asTerminal: its key alone): the
// board takes it from a Tricot terminal and nothing else.
export function boardWakes(answers: Pick<Answers, 'asTerminal'>, board: string): WakeLink {
  return async (report) => {
    const sent = await answers.asTerminal(routeUrl(routes.wakes, { boardId: board }), { ...report });
    return sent.ok ? (sent.reply as WakeReply) : undefined;
  };
}

// One agent this terminal wakes, as the host gives it.
export interface WakeTarget {
  name: string; // on the board
  traits: WakeTraits;
  write(data: string): void; // to its pty
  modes(): InputModes; // what it asked of its terminal
  prompt(): { before: string; after: string }; // its cursor's row (screen.ts cursorRow)
  lastOutput(): number | undefined; // when it last drew
  drawingFor(): number; // how long it has drawn without a break, up to now (0: it isn't drawing)
  rangAt(): number | undefined; // when it last rang its bell or sent a notification
  running(): boolean;
}

interface Held {
  target: WakeTarget;
  draft: Draft;
  asleep: boolean; // its turn is over
  since?: number; // the board's event from which what concerns it is due; none until the board says
  at: number; // when it last fell asleep or was given something to do
  stuck: boolean; // the last wake typed into it started no turn
  refused: boolean; // another terminal holds its name on the board
  typedAt: number;
  turnEndedAt?: number; // the end of a turn its hooks sent last
  due?: number;
  wokeFor: number;
  waking: boolean;
  tries: { for: number; count: number; next: number } | undefined; // a stuck wake's retries
}

export interface WakesOptions {
  link?: WakeLink; // none: the board can't be told (no Tricot tab), and nothing is woken
  holder?: string; // which terminal this is, as its agents' MCP addresses name it (core/sessions.ts wakeUrl)
  live: () => BoardLive | undefined;
  now?: () => number;
  changed?: () => void; // the strip has something new to say
  reportMs?: number;
  quietTurnMs?: number;
  confirmMs?: number;
  retryMs?: number[];
}

export class Wakes {
  private held = new Map<string, Held>(); // by name, lower-cased
  private gone = new Map<string, string>(); // let go of since the last report, by name, lower-cased
  private reporting: Promise<void> | undefined;
  private again = false;
  private heard = { seq: -1, chat: -1, presence: '' };
  private seq = 0; // the board's latest event, as last heard
  private timer: NodeJS.Timeout | undefined;
  readonly holder: string;
  private readonly now: () => number;
  private readonly quietTurnMs: number;
  private readonly confirmMs: number;
  private readonly retryMs: number[];
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly options: WakesOptions) {
    this.now = options.now ?? Date.now;
    this.holder = options.holder ?? randomUUID();
    this.quietTurnMs = options.quietTurnMs ?? QUIET_TURN_MS;
    this.confirmMs = options.confirmMs ?? CONFIRM_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
    if (!options.link) return;
    this.timer = setInterval(() => void this.report(), options.reportMs ?? REPORT_MS);
    this.timer.unref?.();
  }

  // It has started, busy with its first message: from now, the board hears it is held.
  add(target: WakeTarget): void {
    if (!this.options.link || this.stopped) return;
    const key = target.name.toLowerCase();
    this.gone.delete(key);
    this.held.set(key, { target, draft: new Draft(), asleep: false, at: this.now(), stuck: false, refused: false, typedAt: 0, wokeFor: -1, waking: false, tries: undefined });
    void this.report();
  }

  // It ended, or was stopped: the board hears it is no longer held.
  remove(name: string): void {
    const key = name.toLowerCase();
    const held = this.held.get(key);
    if (!held) return;
    this.held.delete(key);
    this.gone.set(key, held.target.name);
    void this.report();
  }

  // The person's keys in its tab, before they reach it, so its prompt is
  // read as it stood. Something sent starts its turn, and what was due
  // stays due: nothing says it read it.
  typed(name: string, data: Buffer): void {
    const held = this.held.get(name.toLowerCase());
    if (!held) return;
    const { typed, sent } = held.draft.keys(data, promptContent(held.target.prompt()));
    if (typed) {
      held.typedAt = this.now();
      held.stuck = false;
    }
    if (sent) this.busy(held, held.since);
  }

  // The board's stream changed: the end of a turn its hooks sent, and
  // whether new events came, or an agent's state changed, which the board's
  // record says more of.
  boardChanged(): void {
    const live = this.options.live();
    if (!live) return;
    for (const held of this.held.values()) {
      const latest = live.steps.filter((s) => samePerson(s.agent, held.target.name) && !s.role).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      if (latest?.done) held.turnEndedAt = Date.parse(latest.at);
    }
    const seq = live.activity?.[0]?.seq ?? -1;
    if (seq > this.seq) this.seq = seq;
    const chat = live.chatVer ?? -1;
    const presence = live.presence
      .filter((p) => this.held.has(p.name.toLowerCase()))
      .map((p) => `${p.name}:${p.state}`)
      .join(',');
    if (seq !== this.heard.seq || chat !== this.heard.chat || presence !== this.heard.presence) {
      this.heard = { seq, chat, presence };
      void this.report();
    }
    this.check();
  }

  // Starts and ends the turns no one else said of, then wakes each agent
  // whose wake is due and free to go.
  check(): void {
    if (this.stopped) return;
    const live = this.options.live();
    const now = this.now();
    for (const held of this.held.values()) {
      if (this.turnOver(held, now)) this.sleep(held, now);
      else if (this.turnBegun(held, now)) this.busy(held, held.since);
      if (this.holdFor(held, live, now)) continue;
      void this.wake(held);
    }
  }

  view(name: string): WakeView | undefined {
    const held = this.held.get(name.toLowerCase());
    if (!held) return undefined;
    if (held.refused) return { asleep: false, refused: true };
    if (!held.asleep) return { asleep: false };
    const hold = this.holdFor(held, this.options.live(), this.now());
    return { asleep: true, ...(held.stuck && { stuck: true }), ...((hold === 'typing' || hold === 'draft') && { holding: hold }) };
  }

  // The terminal is quitting: the board hears it holds none of them now.
  // The same promise however often it is asked, for whoever waits on it.
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped = true;
      clearInterval(this.timer);
      for (const [key, held] of this.held) this.gone.set(key, held.target.name);
      this.held.clear();
      while (this.reporting) await this.reporting;
      if (this.gone.size) await this.report(true);
    })();
    return this.stopping;
  }

  // Its turn is over by its hooks' word, or by a quiet that its own drawing,
  // its bell and the board's word on it would have broken.
  private turnOver(held: Held, now: number): boolean {
    if (held.asleep || held.waking) return false;
    if (held.turnEndedAt !== undefined && held.turnEndedAt > held.at) return true;
    const { target } = held;
    const quiet = now - Math.max(held.at, target.lastOutput() ?? 0, target.rangAt() ?? 0);
    const live = this.options.live();
    const listening = live?.presence.some((p) => samePerson(p.name, target.name) && p.state === 'listening');
    return target.running() && !listening && !waitingFor(target.name, live).length && quiet >= this.quietTurnMs;
  }

  // Asleep, it draws without a break, and not as the person types: a turn
  // it began on its own. Its subagents' calls never say so; its own screen does.
  private turnBegun(held: Held, now: number): boolean {
    return held.asleep && !held.waking && now - held.typedAt >= TYPING_MS && held.target.drawingFor() >= DRAWING_TURN_MS;
  }

  private sleep(held: Held, now: number): void {
    Object.assign(held, { asleep: true, at: now });
    void this.report();
    this.options.changed?.();
  }

  // Given something to do: its turn starts. `since`: from where what concerns it is due now.
  private busy(held: Held, since: number | undefined): void {
    Object.assign(held, { asleep: false, at: this.now(), stuck: false, since });
    void this.report();
    this.options.changed?.();
  }

  private holdFor(held: Held, live: BoardLive | undefined, now: number): Hold | undefined {
    const { target } = held;
    const retrying = held.tries && held.tries.for === held.due ? held.tries.next - now : 0;
    return holdOf({
      due: held.due,
      wokeFor: held.wokeFor,
      retryInMs: retrying,
      refused: held.refused,
      running: target.running(),
      waking: held.waking,
      asleep: held.asleep,
      listening: live?.presence.some((p) => samePerson(p.name, target.name) && p.state === 'listening'),
      quietMs: now - (target.lastOutput() ?? 0),
      approval: waitingFor(target.name, live).length > 0,
      typedMs: now - held.typedAt,
      prompt: promptContent(target.prompt()),
    });
  }

  // Waits until `done` holds, or `ms` pass: whether it held.
  private async until(done: () => boolean, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; ; ) {
      if (done()) return true;
      if (Date.now() >= end) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS).unref?.());
    }
  }

  // Types the line (unless its prompt holds it already), waits for its
  // prompt to hold it and nothing else, sends Enter, and waits for its
  // prompt to empty: a turn began. The person's key, or a prompt that shows
  // anything else, stops it before the Enter.
  private async wake(held: Held): Promise<void> {
    const { target } = held;
    const due = held.due!;
    const before = held.wokeFor;
    held.waking = true;
    held.wokeFor = due;
    const typedAt = held.typedAt;
    const typedSince = () => held.typedAt !== typedAt || this.now() - held.typedAt < LAST_KEY_MS;
    const content = () => promptContent(target.prompt());
    const enter = () => target.write(target.modes().keyboard & 8 ? '\x1b[13u' : '\r');
    let stuck = false;
    try {
      if (content() !== WAKE_LINE) {
        target.write(target.modes().bracketedPaste ? `${PASTE_START}${WAKE_LINE}${PASTE_END}` : WAKE_LINE);
        await new Promise<void>((resolve) => setTimeout(resolve, target.traits.enterAfterMs).unref?.());
        await this.until(() => content() === WAKE_LINE || typedSince(), ECHO_MS);
      }
      if (typedSince()) {
        held.wokeFor = before; // the person came first: what they leave in its prompt holds the next try
        return;
      }
      if (content() !== WAKE_LINE || !target.running()) {
        stuck = true; // the keys went somewhere else, or met something there: no Enter for it
        return;
      }
      for (let tries = 0; tries < 2; tries++) {
        if (typedSince()) {
          held.wokeFor = before;
          return;
        }
        enter();
        if (await this.until(() => content() !== WAKE_LINE, this.confirmMs)) {
          if (typedSince() || content() !== '') {
            held.wokeFor = before; // someone else's keys changed it: not this wake's to judge
            return;
          }
          // A turn began: what it was woken for, and what came before, it reads now.
          held.tries = undefined;
          this.busy(held, Math.max(this.seq, due));
          return;
        }
      }
      stuck = true;
    } finally {
      held.waking = false;
      if (stuck) this.stuck(held, due, before);
      this.options.changed?.();
    }
  }

  // A wake that started no turn: said so, and tried again for the same
  // event after each pause in RETRY_MS, then given up on until something newer is due.
  private stuck(held: Held, due: number, before: number): void {
    held.stuck = true;
    const count = held.tries?.for === due ? held.tries.count + 1 : 1;
    const pause = this.retryMs[count - 1];
    if (pause !== undefined) {
      held.tries = { for: due, count, next: this.now() + pause };
      held.wokeFor = before;
      setTimeout(() => this.check(), pause + 10).unref?.();
    } else held.tries = undefined;
    void this.report();
  }

  // One report at a time; one asked for meanwhile goes once it is back.
  private report(last = false): Promise<void> {
    const link = this.options.link;
    if (!link || (this.stopped && !last)) return Promise.resolve();
    if (this.reporting) {
      this.again = true;
      return this.reporting;
    }
    const sent: WakeReport = {
      holder: this.holder,
      agents: [...this.held.values()].map(({ target, asleep, since, at, stuck }) => ({ name: target.name, asleep, at, ...(since !== undefined && { since }), ...(stuck && { stuck }) })),
      gone: [...this.gone.values()],
    };
    this.gone.clear();
    this.reporting = (async () => {
      let reply: WakeReply | undefined;
      try {
        reply = await link(sent);
      } catch {
        reply = undefined;
      }
      if (!reply) {
        // Not heard: those let go of are said again with the next report.
        for (const name of sent.gone) if (!this.held.has(name.toLowerCase())) this.gone.set(name.toLowerCase(), name);
        return;
      }
      if (typeof reply.seq === 'number' && reply.seq > this.seq) this.seq = reply.seq;
      const refused = new Set((reply.refused ?? []).map((name) => name.toLowerCase()));
      for (const [key, held] of this.held) held.refused = refused.has(key);
      for (const record of reply.agents ?? []) {
        const held = this.held.get(record.name.toLowerCase());
        if (!held) continue;
        held.due = record.due;
        // The board's record is newer (its turn ended at a wait), or the
        // same and with the event what's due counts from.
        if (record.at > held.at) Object.assign(held, { asleep: record.asleep, since: record.since, at: record.at });
        else if (record.at === held.at) held.since = record.since;
      }
    })().finally(() => {
      this.reporting = undefined;
      if (this.again) {
        this.again = false;
        void this.report();
      }
      this.check();
      this.options.changed?.();
    });
    return this.reporting;
  }
}
