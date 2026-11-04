// The Tricot tab (T192): the first tab of `tricot claude codex`, drawn by
// Tricot itself rather than an agent. It shows the board, each agent and
// what it is doing, the requests for permission waiting from its agents, and
// the board's latest activity (tabView.ts draws it), live from the board's
// stream (live.ts), and takes its own keys (tabKeys.ts reads them):
//
//   y            allow the request picked; while this terminal isn't one of
//                the person's seats, ask to be let in (T187) first, as it
//                can't read what the request asks until then
//   s            allow it for the session, where it is offered
//   n            deny it: a reason may be typed first, on one line, for the agent
//   ↑ ↓          pick another, when several wait
//   o            open the board in the browser
//   a            add an agent: one Tricot can start that isn't running
//   x            stop one: picked, then y; it is hung up (SIGHUP)
//   q            quit, as the switch key then q does
//
// A browser or terminal asking to act for the person comes first, when this
// terminal is to answer it (a seat, or any Tricot terminal for the very first
// browser): "A browser wants to act for you (Chrome on macOS, code 4271).
// Allow? [y/N]", y allowing it, n or Enter denying it, Esc leaving it for now.
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
import { agentDoing, type AgentNow, type BoardLive, type Tone } from './strip';
import { TabKeyReader, type TabKey } from './tabKeys';
import { renderTab, type TabFrame, type TabPrompt } from './tabView';

const NOTE_MS = 6_000;

export interface TabAgent extends AgentNow {
  number: number; // what picks it, from 1
}

// What an agent Tricot can start looks like to the tab's "add".
export interface AddChoice {
  id: string; // claude, codex, opencode
  name: string; // Claude Code
  note?: string; // why it can't be started now, in a few words ("not installed")
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
  choices(): AddChoice[]; // the agents that could be added now
  add(id: string): string | undefined; // starts it in a tab of its own; a problem, if it can't
  stop(number: number): void; // hangs it up
}

export interface TricotTabOptions {
  url: string; // Tricot's address
  title?: string; // the board's, until the stream says otherwise
  answers?: Answers; // none: answering from here isn't possible (no board)
}

// The requests waiting from these agents, on this board or on none yet, oldest first.
export function waitingFrom(names: string[], live: BoardLive | undefined): Approval[] {
  if (!live) return [];
  return live.approvals.filter((a) => names.some((name) => samePerson(a.agent, name)) && (!a.on || a.on.board === live.board));
}

export class TricotTab {
  private readonly reader = new TabKeyReader();
  private prompt: TabPrompt = { kind: 'keys' };
  private addChoices: AddChoice[] = [];
  private stopping: number | undefined; // the agent asked about
  private selectedId: string | undefined;
  private denying: { id: string; reason: string } | undefined;
  private sending: { id: string; behavior: 'allow' | 'deny' } | undefined;
  private answeredHere = new Set<string>(); // gone from here at once, as the stream catches up
  private note: { text: string; tone: Tone; until: number } | undefined;
  private quitting = false;
  private admissionsLater = new Set<string>(); // left for now with Esc
  private admitting: string | undefined; // an answer to one is on its way
  private asking = false; // asking for this terminal to be let in

  constructor(
    private readonly host: TabHost,
    private readonly options: TricotTabOptions,
  ) {}

  // The requests the tab shows, oldest first.
  waiting(): Approval[] {
    const names = this.host.agents().map((a) => a.name);
    return waitingFrom(names, this.host.live()).filter((a) => !this.answeredHere.has(a.id));
  }

  get typing(): boolean {
    return this.denying !== undefined;
  }

  // The browser or terminal asking to act for the person that this terminal answers now.
  admission(): AdmissionView | undefined {
    return (this.host.live()?.admissions ?? []).find((a) => !this.admissionsLater.has(a.id));
  }

  closing(): void {
    this.quitting = true;
  }

  // ---- what it shows ---------------------------------------------------------------

  render(cols: number, rows: number, light = false): TabFrame {
    const now = this.host.now();
    const live = this.host.live();
    const waiting = this.settle();
    const selected = Math.max(0, waiting.findIndex((a) => a.id === this.selectedId));
    const showing = waiting[selected];
    return renderTab(
      {
        title: live?.title ?? this.options.title,
        url: this.options.url,
        connected: live !== undefined,
        agents: this.host.agents().map((agent) => ({ number: agent.number, name: agent.name, doing: agentDoing(agent, live, now) })),
        approvals: waiting,
        selected,
        ...(showing && this.sending?.id === showing.id && { sending: this.sending.behavior }),
        ...(showing && this.denying?.id === showing.id && { reason: this.denying.reason }),
        activity: live?.activity ?? [],
        ...(this.admission() && { admission: { ...this.admission()!, ...(this.admitting && { sending: true }) } }),
        ...(this.options.answers && { seat: { seated: this.options.answers.seated, ...(this.options.answers.seatCode && { code: this.options.answers.seatCode }), ...(this.asking && { asking: true }) } }),
        prompt: this.prompt,
        ...(this.note && this.note.until > now && { note: { text: this.note.text, tone: this.note.tone } }),
        quitting: this.quitting,
        now,
      },
      cols,
      rows,
      light,
    );
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

  key(data: Buffer): void {
    for (const key of this.reader.read(data)) {
      // Keys typed fast come in one read: each is a key of its own, as what it does may change what the next does.
      if (key.kind === 'text') for (const ch of key.text) this.one({ kind: 'text', text: ch });
      else this.one(key);
    }
    this.host.changed();
  }

  private one(key: TabKey): void {
    if (this.quitting) return;
    if (this.denying) return this.reasonKey(key);
    switch (this.prompt.kind) {
      case 'add':
        return this.addKey(key);
      case 'stop':
        return this.stopKey(key);
      case 'confirm-stop':
        return this.confirmKey(key);
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
          if (ch === 's' && !picked.forSession?.length) return this.say('"Allow for this session" isn\'t offered for this one: y allows it once.');
          void this.answer(picked, { behavior: 'allow', ...(ch === 's' && { session: true }) });
          return;
        case 'n':
          if (!picked) return this.say('Nothing is waiting for your OK.');
          if (picked.sealed) return this.say('Let this terminal answer for you first: y asks.');
          if (this.sending) return;
          this.denying = { id: picked.id, reason: '' };
          return;
        case 'o':
          this.host.open();
          return this.say('Opened the board in your browser.');
        case 'a':
          this.addChoices = this.host.choices();
          this.prompt = { kind: 'add', choices: this.addChoices.map((c) => ({ name: c.name, ...(c.note && { note: c.note }) })) };
          return;
        case 'x':
          this.prompt = { kind: 'stop', choices: this.running().map((a) => ({ number: a.number, name: a.name })) };
          return;
        case 'q':
          this.host.quit();
          return;
      }
    }
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

  private addKey(key: TabKey): void {
    this.prompt = { kind: 'keys' };
    const n = key.kind === 'text' && /^[1-9]$/.test(key.text) ? Number(key.text) : 0;
    const choice = this.addChoices[n - 1];
    if (!choice) return;
    if (choice.problem) return this.say(choice.problem, 'alert');
    const problem = this.host.add(choice.id);
    if (problem) this.say(problem, 'alert');
  }

  private stopKey(key: TabKey): void {
    this.prompt = { kind: 'keys' };
    const n = key.kind === 'text' && /^[1-9]$/.test(key.text) ? Number(key.text) : 0;
    const agent = this.running().find((a) => a.number === n);
    if (!agent) return;
    this.stopping = agent.number;
    this.prompt = { kind: 'confirm-stop', name: agent.name };
  }

  private confirmKey(key: TabKey): void {
    this.prompt = { kind: 'keys' };
    const agent = this.running().find((a) => a.number === this.stopping);
    this.stopping = undefined;
    if (!agent) return;
    if (key.kind === 'text' && key.text === 'y') {
      this.host.stop(agent.number);
      this.say(`Stopping ${agent.name}: it is hung up, as when its window closes.`);
    } else this.say(`${agent.name} keeps running.`);
  }

  // ---- letting in ----------------------------------------------------------------------

  // y allows it, n or Enter denies it, Esc leaves it for now (it still shows
  // on the board); the tab's other keys do what they always do.
  private admissionKey(admission: AdmissionView, key: TabKey): boolean {
    if (this.admitting) return true;
    if (key.kind === 'escape') {
      this.admissionsLater.add(admission.id);
      this.say('Left for now: it waits on the board until it lapses.');
      return true;
    }
    const allow = key.kind === 'text' && key.text.toLowerCase() === 'y';
    const deny = key.kind === 'enter' || (key.kind === 'text' && key.text.toLowerCase() === 'n');
    if (!allow && !deny) return false;
    void this.admit(admission, allow);
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
