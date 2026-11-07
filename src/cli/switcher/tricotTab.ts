// The Tricot tab (T192): the first tab of `tricot claude codex`, drawn by
// Tricot itself rather than an agent. It starts on chat (threadsTab.ts): the
// stream of every conversation on the board, threads and comments on cards
// alike (chatView.ts), with the line that answers the latest of them under
// it; /threads opens the threads in a panel beside it, a thread picked there
// showing alone in the stream, and /new comes back to the whole stream, its
// line starting a new thread; the mouse's wheel scrolls the chat (the host
// hands each turn on, T30), and no click above the strip is the tab's.
// /status shows the board, its agents, requests for permission and activity (tabView.ts), live
// from the board's stream. The following shortcuts act in that status view;
// in chat, their letters are message text. TabKeyReader reads both. The
// TRICOT wordmark (wordmark.ts) is at its top, knitted up once from when the
// tab is first drawn and then whole; any key, or leaving the tab, ends the
// knitting (the key is acted on as it always is), never the wordmark:
//
//   ← →          move the highlight along the request's answers: Allow, Allow for
//                this session (where it is offered) and Deny, which it starts on
//   Enter        answer with the one highlighted: Deny, so a stray Enter never allows
//   y            allow the request picked; while this terminal isn't one of
//                the person's seats, ask to be let in (T187) first, as it
//                can't read what the request asks until then
//   s            allow it for the session, where it is offered
//   n            deny it: a reason may be typed first, on one line, for the agent
//   ↑ ↓          pick another, when several wait (the highlight starts on Deny again)
//   o            open the board in the browser
//   t            the chat with the threads' panel open beside it, to read a
//                thread, reply in it, start a new one, set a thread's lens and
//                react to a message (threadsTab.ts); it takes every key while it
//                shows, letters typed on its line included (l sets a lens in the
//                panel, Ctrl+L in a thread, Tab on an empty line chooses a
//                message to react to), and Esc closing the panel comes back to this
//   a            add an agent: any that isn't running, listed one to a row; picking
//                one Tricot can't start says why and how to connect it
//   x            stop one: the agents running, listed one to a row; picked, then
//                asked "Stop it?" with Yes and No (starting on No): ← → move, Enter
//                answers, y and n answer at once, Esc is No, other keys do nothing;
//                it is hung up (SIGHUP) and leaves "Your agents" and the strip at
//                once, those after it moving up a number (T19)
//   ↑ ↓ or k j   in either list, move the highlighted row, wrapping round;
//   Home End     the first or last row; Enter picks the highlighted row, a
//                number 1 to 9 picks at once (the row of that number, or the
//                agent of that number in the stop list), Esc goes back
//   q            quit, as the switch key then q does
//
// A browser or terminal asking to act for the person comes first, when this
// terminal is to answer it (a seat, or any Tricot terminal for the very first
// browser): "A browser wants to act for you (Chrome on macOS, code 4271).
// Allow?" with Yes and No (starting on No): ← → move, Enter answers with the one
// highlighted (so a bare Enter denies), y and n answer at once, Esc leaves it for now.
//
// An answer goes to the board signed by this terminal's seat (answers.ts):
// the first answer wins, from here or the board, and the other side is told
// who answered. The host (host.ts) does what the tab asks of it: starting
// and stopping agents, opening the browser, quitting.
import { samePerson } from '../../core/format';
import type { Approval, ApprovalReply } from '../../core/approvals';
import { APPROVAL_REASON_LIMIT } from '../../core/approvals';
import type { AdmissionView } from '../../core/seats';
import type { Answers } from './answers';
import { agentDoing, type AgentNow, type BoardLive, type Rgb, type Tone } from './strip';
import { TabKeyReader, type TabKey } from './tabKeys';
import { KNIT_MS, wordmarkFits, wordmarkNext, wordmarkRows } from './wordmark';
import { alertOf, choicesOf, paint, renderTab, tabHeader, type ApprovalChoice, type Part, type TabFrame, type TabPrompt } from './tabView';
import { ThreadsTab, type ThreadsAccess } from './threadsTab';
import type { TabCommand } from './tabCommands';

const NOTE_MS = 6_000;

export interface TabAgent extends AgentNow {
  number: number; // what picks it, from 1
}

// What an agent Tricot knows looks like to the tab's "add".
export interface AddChoice {
  id: string; // claude, codex, opencode, gemini, pi, omp
  name: string; // Claude Code
  note?: string; // why it can't be started now, in a few words ("not installed", "connect it first")
  problem?: string; // and in full, said when it is picked
}

// What the tab asks of the host.
export interface TabHost {
  agents(): TabAgent[];
  live(): BoardLive | undefined;
  now(): number;
  changed(): void; // draw it again
  open(): void; // the board, in the browser
  quit(): void;
  choices(): AddChoice[]; // every agent but those running, some with a note on why not now
  add(id: string): string | undefined | Promise<string | undefined>; // starts it in a tab of its own (soon, when it waits on the board); a problem, if it can't
  stop(number: number): void; // hangs it up
}

export interface TricotTabOptions {
  url: string; // Tricot's address
  title?: string; // the board's, until the stream says otherwise
  answers?: Answers; // none: answering from here isn't possible (no board)
  threads?: ThreadsAccess; // none: the board's threads can't be read from here (no board)
  // The wordmark at the top: knitted up as the tab first shows, or whole at once (TRICOT_NO_ANIMATION=1);
  // none: the one-line header alone.
  wordmark?: 'knit' | 'whole';
}

// The number a key picks a row of a list with, 1 to 9: 0 for any other key.
const digitOf = (key: TabKey): number => (key.kind === 'text' && /^[1-9]$/.test(key.text) ? Number(key.text) : 0);

// The requests waiting from these agents, on this board or on none yet, oldest first.
export function waitingFrom(names: string[], live: BoardLive | undefined): Approval[] {
  if (!live) return [];
  return live.approvals.filter((a) => names.some((name) => samePerson(a.agent, name)) && (!a.on || a.on.board === live.board));
}

export class TricotTab {
  private readonly reader = new TabKeyReader();
  private readonly threads: ThreadsTab;
  private prompt: TabPrompt = { kind: 'keys' };
  private addChoices: AddChoice[] = [];
  private stopping: number | undefined; // the agent asked about
  private selectedId: string | undefined;
  private leaning: { id: string; on: ApprovalChoice } | undefined; // the answer highlighted for the request picked
  private admissionLeaning: { id: string; allow: boolean } | undefined; // and for the one asking to act for the person
  private denying: { id: string; reason: string } | undefined;
  private sending: { id: string; behavior: 'allow' | 'deny' } | undefined;
  private answeredHere = new Set<string>(); // gone from here at once, as the stream catches up
  private note: { text: string; tone: Tone; until: number } | undefined;
  private quitting = false;
  private admissionsLater = new Set<string>(); // left for now with Esc
  private admitting: string | undefined; // an answer to one is on its way
  private asking = false; // asking for this terminal to be let in
  private knitting: { since?: number } | undefined; // the wordmark's knitting: since when, once drawn; gone once it has played or been ended

  constructor(
    private readonly host: TabHost,
    private readonly options: TricotTabOptions,
  ) {
    if (options.wordmark === 'knit') this.knitting = {};
    this.threads = new ThreadsTab({
      access: options.threads,
      live: () => host.live(),
      now: () => host.now(),
      changed: () => host.changed(),
      agents: () => host.agents().map((a) => a.name),
      askSeat: () => void this.askSeat(),
      seatWords: () => (this.asking ? `Waiting for you to let this terminal in${options.answers?.seatCode ? `: code ${options.answers.seatCode}` : ''}.` : undefined),
      navigate: (command) => this.navigate(command),
    });
    if (options.threads) this.threads.start();
  }

  private navigate(command: TabCommand): void {
    if (command === 'status') this.threads.hide();
    else if (command === 'threads') this.threads.list();
    else this.threads.start(true); // /new: the stream, its line starting a new thread
  }

  // The requests the tab shows, oldest first.
  waiting(): Approval[] {
    const names = this.host.agents().map((a) => a.name);
    return waitingFrom(names, this.host.live()).filter((a) => !this.answeredHere.has(a.id));
  }

  get typing(): boolean {
    return this.denying !== undefined || this.threads.typing;
  }

  // The browser or terminal asking to act for the person that this terminal answers now.
  admission(): AdmissionView | undefined {
    return (this.host.live()?.admissions ?? []).find((a) => !this.admissionsLater.has(a.id));
  }

  // The answer highlighted for a request: Deny until the arrows move it.
  private choiceFor(approval: Approval): ApprovalChoice {
    const on = this.leaning?.id === approval.id ? this.leaning.on : 'deny';
    return choicesOf(approval).includes(on) ? on : 'deny';
  }

  // Whether Yes is highlighted for an admission: No until the arrows move it.
  private allowingFor(admission: AdmissionView): boolean {
    return this.admissionLeaning?.id === admission.id && this.admissionLeaning.allow;
  }

  closing(): void {
    this.quitting = true;
    this.endKnitting();
  }

  // Ends the knitting, for good, the wordmark whole from then on: a key, leaving the tab, quitting.
  endKnitting(): void {
    this.knitting = undefined;
  }

  // The wordmark's rows, where the window has room for it (none: the one-line header). It knits
  // from the first time the tab is drawn; a window too small for it then ends the knitting too,
  // so it is whole when the window grows.
  private wordmark(cols: number, rows: number): Part[][] | undefined {
    if (!this.options.wordmark) return undefined;
    if (!wordmarkFits(cols, rows)) {
      this.endKnitting();
      return undefined;
    }
    const knitting = this.knitting;
    if (!knitting) return wordmarkRows();
    const now = this.host.now();
    knitting.since ??= now;
    if (now - knitting.since >= KNIT_MS) this.endKnitting();
    return wordmarkRows(now - knitting.since);
  }

  // How long until the wordmark needs drawing again, in ms: none once it is knitted.
  nextFrame(): number | undefined {
    if (this.knitting?.since === undefined) return undefined;
    return wordmarkNext(this.host.now() - this.knitting.since);
  }

  // ---- what it shows ---------------------------------------------------------------

  // Whether the time alone changes what the tab shows, for the host's tick to
  // draw it again: in chat, only once a time it says would change
  // (threadsTab.ts due); in the status view, each time.
  due(now: number): boolean {
    return !this.threads.showing || this.quitting || this.threads.due(now);
  }

  // `tintFrom`: the terminal's background, where it draws 24-bit colour, for the chat's tints (chatView.ts chatTints).
  render(cols: number, rows: number, light = false, tintFrom?: Rgb): TabFrame {
    if (this.threads.showing && !this.quitting) {
      const live = this.host.live();
      const header = this.options.wordmark && rows >= 6 ? [...tabHeader({ title: live?.title ?? this.options.title, url: this.options.url, connected: live !== undefined, wordmark: this.wordmark(cols, rows) }, cols, rows - 4), []] : [];
      const notice = this.elsewhere();
      const prefix: Part[][] = [...header, ...(notice && this.threads.typing && rows >= 5 ? [[[` ${notice}`, alertOf(light)]] as Part[]] : [])];
      const frame = this.threads.render(cols, rows - prefix.length, light, prefix.length > header.length ? undefined : notice, tintFrom);
      const drawn = prefix.map((parts) => paint(parts, cols));
      return { rows: [...drawn.map((row) => row.line), ...frame.rows], plain: [...drawn.map((row) => row.plain), ...frame.plain], ...(frame.cursor && { cursor: { x: frame.cursor.x, y: frame.cursor.y + prefix.length } }) };
    }
    const now = this.host.now();
    const live = this.host.live();
    const waiting = this.settle();
    const selected = Math.max(0, waiting.findIndex((a) => a.id === this.selectedId));
    const showing = waiting[selected];
    const wordmark = this.wordmark(cols, rows);
    return renderTab(
      {
        title: live?.title ?? this.options.title,
        url: this.options.url,
        connected: live !== undefined,
        agents: this.host.agents().map((agent) => ({ number: agent.number, name: agent.name, doing: agentDoing(agent, live, now) })),
        approvals: waiting,
        selected,
        ...(showing && { choice: this.choiceFor(showing) }),
        ...(showing && this.sending?.id === showing.id && { sending: this.sending.behavior }),
        ...(showing && this.denying?.id === showing.id && { reason: this.denying.reason }),
        activity: live?.activity ?? [],
        ...(this.admission() && { admission: { ...this.admission()!, allow: this.allowingFor(this.admission()!), ...(this.admitting && { sending: true }) } }),
        ...(this.options.answers && { seat: { seated: this.options.answers.seated, ...(this.options.answers.seatCode && { code: this.options.answers.seatCode }), ...(this.asking && { asking: true }) } }),
        prompt: this.prompt,
        ...(this.note && this.note.until > now && { note: { text: this.note.text, tone: this.note.tone } }),
        quitting: this.quitting,
        ...(wordmark && { wordmark }),
        now,
      },
      cols,
      rows,
      light,
    );
  }

  // What waits on the person in the tab's own view, for the threads to say on their last row.
  private elsewhere(): string | undefined {
    const count = this.waiting().length + (this.admission() ? 1 : 0);
    return count ? `${count} waiting for your OK: /status` : undefined;
  }

  // The requests now, with the one picked still picked; a reason being typed
  // for one answered meanwhile (on the board) is let go, and says so.
  private settle(): Approval[] {
    const waiting = this.waiting();
    if (this.denying && !waiting.some((a) => a.id === this.denying!.id)) {
      this.denying = undefined;
      this.say('It was answered meanwhile, on the board or in its own terminal.', 'normal');
    }
    if (!waiting.some((a) => a.id === this.selectedId)) this.selectedId = waiting[0]?.id;
    return waiting;
  }

  private say(text: string, tone: Tone = 'normal'): void {
    this.note = { text, tone, until: this.host.now() + NOTE_MS };
    this.host.changed();
  }

  // ---- what is typed --------------------------------------------------------------------

  // A turn of the mouse's wheel (the host hands on every one, T30): it
  // scrolls the chat `lines`, up when positive; the status view has nothing to scroll.
  wheel(lines: number): void {
    if (this.quitting || !this.threads.showing) return;
    this.threads.wheel(lines);
    this.host.changed();
  }

  key(data: Buffer): void {
    this.endKnitting();
    for (const key of this.reader.read(data)) {
      // Keys typed fast come in one read: each is a key of its own, as what it does may change what the next does.
      if (key.kind === 'text') for (const ch of key.text) this.one({ kind: 'text', text: ch });
      else this.one(key);
    }
    this.host.changed();
  }

  private one(key: TabKey): void {
    if (this.quitting) return;
    if (this.threads.showing) return this.threads.key(key);
    if (this.denying) return this.reasonKey(key);
    if (this.prompt.kind === 'keys' && this.options.threads) {
      if (key.kind === 'text' && key.text === '/') return this.threads.commands(true);
      if (key.kind === 'escape') return this.threads.chat();
    }
    switch (this.prompt.kind) {
      case 'add':
        return this.addKey(this.prompt, key);
      case 'stop':
        return this.stopKey(this.prompt, key);
      case 'confirm-stop':
        return this.confirmKey(this.prompt, key);
    }
    const asking = this.admission();
    if (asking && this.admissionKey(asking, key)) return;
    const waiting = this.settle();
    const picked = waiting.find((a) => a.id === this.selectedId);
    if (key.kind === 'up' || key.kind === 'down') {
      if (waiting.length < 2) return;
      const at = waiting.findIndex((a) => a.id === this.selectedId);
      const next = (at + (key.kind === 'up' ? -1 : 1) + waiting.length) % waiting.length;
      this.selectedId = waiting[next].id;
      this.leaning = undefined;
      return;
    }
    if (picked && !picked.sealed && !this.sending && (key.kind === 'left' || key.kind === 'right' || key.kind === 'enter')) {
      this.note = undefined;
      const offered = choicesOf(picked);
      const at = offered.indexOf(this.choiceFor(picked));
      if (key.kind === 'enter') return this.decide(picked, offered[at]);
      this.leaning = { id: picked.id, on: offered[(at + (key.kind === 'left' ? -1 : 1) + offered.length) % offered.length] };
      return;
    }
    if (key.kind === 'interrupt') return this.say('Ctrl+C does nothing here: q quits, and closes every agent.');
    if (key.kind !== 'text') return;
    this.note = undefined; // what the last key did gives way to what this one does
    for (const ch of key.text) {
      switch (ch) {
        case 'y':
        case 's':
          if (!picked) return this.say('Nothing is waiting for your OK.');
          if (picked.sealed) {
            if (ch === 's') return this.say('Let this terminal answer for you first: y asks.');
            void this.askSeat();
            return;
          }
          return this.decide(picked, ch === 's' ? 'session' : 'allow');
        case 'n':
          if (!picked) return this.say('Nothing is waiting for your OK.');
          if (picked.sealed) return this.say('Let this terminal answer for you first: y asks.');
          return this.decide(picked, 'deny');
        case 'o':
          this.host.open();
          return this.say('Opened the board in your browser.');
        case 't':
          this.threads.list();
          return;
        case 'a':
          this.addChoices = this.host.choices();
          this.prompt = { kind: 'add', choices: this.addChoices.map((c) => ({ name: c.name, ...(c.note && { note: c.note }) })), at: Math.max(0, this.addChoices.findIndex((c) => !c.problem)) };
          return;
        case 'x':
          this.prompt = { kind: 'stop', choices: this.running().map((a) => ({ number: a.number, name: a.name })), at: 0 };
          return;
        case 'q':
          this.host.quit();
          return;
      }
    }
  }

  // Answers the request with one of its choices: a denial opens the line for its reason first.
  private decide(picked: Approval, choice: ApprovalChoice): void {
    if (choice === 'deny') {
      if (!this.sending) this.denying = { id: picked.id, reason: '' };
      return;
    }
    if (choice === 'session' && !picked.forSession?.length) return this.say('"Allow for this session" isn\'t offered for this one: y allows it once.');
    void this.answer(picked, { behavior: 'allow', ...(choice === 'session' && { session: true }) });
  }

  private running(): TabAgent[] {
    return this.host.agents().filter((a) => a.state !== 'ended' && !a.closing);
  }

  private reasonKey(key: TabKey): void {
    const denying = this.denying!;
    switch (key.kind) {
      case 'text':
      case 'paste': {
        const text = key.text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
        denying.reason = [...(denying.reason + text)].slice(0, APPROVAL_REASON_LIMIT).join('');
        return;
      }
      case 'backspace':
        denying.reason = [...denying.reason].slice(0, -1).join('');
        return;
      case 'clear':
        denying.reason = '';
        return;
      case 'escape':
      case 'interrupt':
        this.denying = undefined;
        return;
      case 'enter': {
        const approval = this.settle().find((a) => a.id === denying.id);
        this.denying = undefined;
        if (approval) void this.answer(approval, { behavior: 'deny', ...(denying.reason.trim() && { reason: denying.reason.trim() }) });
        return;
      }
    }
  }

  // What a key does in a list: moves the highlight (↑ ↓ or k j, wrapping; Home
  // and End), gives the row Enter picks, or says to leave the list (Esc,
  // Ctrl+C). Any other key does nothing, so a slip leaves the list as it was.
  private listKey(list: { choices: unknown[]; at: number }, key: TabKey): number | 'cancel' | undefined {
    const count = list.choices.length;
    if (!count) return 'cancel'; // nothing to pick: any key goes back
    const text = key.kind === 'text' ? key.text : '';
    if (key.kind === 'up' || text === 'k') list.at = (list.at - 1 + count) % count;
    else if (key.kind === 'down' || text === 'j') list.at = (list.at + 1) % count;
    else if (key.kind === 'home') list.at = 0;
    else if (key.kind === 'end') list.at = count - 1;
    else if (key.kind === 'enter') return list.at;
    else if (key.kind === 'escape' || key.kind === 'interrupt') return 'cancel';
    return undefined;
  }

  private addKey(prompt: Extract<TabPrompt, { kind: 'add' }>, key: TabKey): void {
    const digit = digitOf(key);
    const row = digit && prompt.choices.length ? digit - 1 : this.listKey(prompt, key);
    if (row === 'cancel') this.prompt = { kind: 'keys' };
    const choice = typeof row === 'number' ? this.addChoices[row] : undefined;
    if (!choice) return;
    this.prompt = { kind: 'keys' };
    if (choice.problem) return this.say(choice.problem, 'alert');
    const problem = this.host.add(choice.id);
    if (typeof problem === 'object') void problem.then((later) => later && this.say(later, 'alert'));
    else if (problem) this.say(problem, 'alert');
  }

  private stopKey(prompt: Extract<TabPrompt, { kind: 'stop' }>, key: TabKey): void {
    const digit = digitOf(key);
    const row = digit && prompt.choices.length ? prompt.choices.findIndex((c) => c.number === digit) : this.listKey(prompt, key);
    if (row === 'cancel') this.prompt = { kind: 'keys' };
    const picked = typeof row === 'number' ? prompt.choices[row] : undefined;
    if (!picked) return;
    this.prompt = { kind: 'keys' };
    const agent = this.running().find((a) => a.number === picked.number);
    if (!agent) return;
    this.stopping = agent.number;
    this.prompt = { kind: 'confirm-stop', name: agent.name, yes: false };
  }

  // ← → move between Yes and No, Enter answers with the one highlighted, y and n
  // answer at once, Esc is No; any other key does nothing, so a slip leaves the question as it was.
  private confirmKey(prompt: Extract<TabPrompt, { kind: 'confirm-stop' }>, key: TabKey): void {
    const text = key.kind === 'text' ? key.text.toLowerCase() : '';
    if (key.kind === 'left' || key.kind === 'right') {
      prompt.yes = !prompt.yes;
      return;
    }
    const yes = text === 'y' || (key.kind === 'enter' && prompt.yes);
    const no = text === 'n' || (key.kind === 'enter' && !prompt.yes) || key.kind === 'escape' || key.kind === 'interrupt';
    if (!yes && !no) return;
    this.prompt = { kind: 'keys' };
    const agent = this.running().find((a) => a.number === this.stopping);
    this.stopping = undefined;
    if (!agent) return;
    if (yes) {
      this.host.stop(agent.number);
      this.say(`Stopped ${agent.name}.`);
    } else this.say(`${agent.name} keeps running.`);
  }

  // ---- letting in ----------------------------------------------------------------------

  // ← → move between Yes and No, Enter answers with the one highlighted (No
  // to begin with), y and n answer at once, Esc leaves it for now (it still
  // shows on the board); the tab's other keys do what they always do.
  private admissionKey(admission: AdmissionView, key: TabKey): boolean {
    if (this.admitting) return true;
    if (key.kind === 'escape') {
      this.admissionsLater.add(admission.id);
      this.say('Left for now: it waits on the board until it lapses.');
      return true;
    }
    if (key.kind === 'left' || key.kind === 'right') {
      this.admissionLeaning = { id: admission.id, allow: !this.allowingFor(admission) };
      return true;
    }
    const letter = key.kind === 'text' ? key.text.toLowerCase() : '';
    if (key.kind !== 'enter' && letter !== 'y' && letter !== 'n') return false;
    void this.admit(admission, key.kind === 'enter' ? this.allowingFor(admission) : letter === 'y');
    return true;
  }

  private async admit(admission: AdmissionView, allow: boolean): Promise<void> {
    if (!this.options.answers) return this.say('Answering from here needs the board, which this terminal is not connected to.', 'alert');
    this.admitting = admission.id;
    this.host.changed();
    const outcome = await this.options.answers.admit(admission.id, allow);
    this.admitting = undefined;
    this.admissionsLater.add(admission.id); // gone from here at once, as the stream catches up
    setTimeout(() => this.admissionsLater.delete(admission.id), 300_000).unref?.();
    const what = admission.kind === 'terminal' ? 'That terminal' : admission.label;
    if (outcome.ok) this.say(allow ? `${what} acts for you now.` : `Denied: ${what} doesn't act for you.`, allow ? 'normal' : 'alert');
    else this.say(outcome.error, 'alert');
  }

  // Asks for this terminal to be let in, so it can read and answer what agents ask.
  private async askSeat(): Promise<void> {
    const answers = this.options.answers;
    if (!answers) return this.say('Answering from here needs the board, which this terminal is not connected to: answer on the board.', 'alert');
    if (this.asking) return;
    this.asking = true;
    this.host.changed();
    const asked = await answers.askSeat();
    if (!asked.ok) {
      this.asking = false;
      return this.say(asked.error, 'alert');
    }
    this.host.changed();
    const end = await answers.seatEnded();
    this.asking = false;
    if (end === 'admitted') this.say('This terminal answers for you now, until it closes.');
    else if (end === 'denied') this.say('That was denied in the browser: this terminal still can\'t answer.', 'alert');
    else if (end === 'expired') this.say('Nobody allowed it in time: y asks again.', 'alert');
    else this.host.changed();
  }

  // ---- answering ----------------------------------------------------------------------

  private async answer(approval: Approval, reply: ApprovalReply): Promise<void> {
    if (this.sending) return;
    if (!this.options.answers) return this.say('Answering from here needs the board, which this terminal is not connected to: answer on the board.', 'alert');
    this.sending = { id: approval.id, behavior: reply.behavior };
    this.host.changed();
    const outcome = await this.options.answers.answer(approval.id, reply);
    this.sending = undefined;
    const who = approval.agent;
    if (!outcome.ok && outcome.needsSeat) {
      this.say(outcome.error, 'alert');
      void this.askSeat();
      return;
    }
    if (outcome.ok) {
      this.answeredHere.add(approval.id);
      const done =
        reply.behavior === 'deny'
          ? `Denied: ${who} ${reply.reason ? 'reads your reason' : 'is told you said no'}.`
          : reply.session
            ? `Allowed for this session: ${who} goes ahead.`
            : `Allowed: ${who} goes ahead.`;
      this.say(done);
    } else {
      if (outcome.gone) this.answeredHere.add(approval.id);
      this.say(outcome.gone ? outcome.error : `Your answer to ${who} didn't go through: ${outcome.error}`, outcome.gone ? 'normal' : 'alert');
    }
    // Forgotten after a while: an id is never shown twice, and the set stays small.
    setTimeout(() => this.answeredHere.delete(approval.id), 120_000).unref?.();
  }
}
