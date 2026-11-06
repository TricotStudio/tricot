// Several agents in one terminal, one showing at a time, a strip at the
// bottom listing them all, and a key to switch (`tricot claude codex`).
//
// Each agent runs in a pseudo-terminal of its own (pty.ts) the size of the
// terminal less the strip's row, and everything it draws goes into a screen
// Tricot keeps for it (screen.ts), whether it shows or not. The real terminal
// is painted from the screen of the agent showing: on a switch, the rows that
// differ; then as it draws. Hidden agents keep running, and their screens
// stay current, so a switch shows exactly where each one is, colours and all.
//
// The real terminal is set for the agent showing (modes.ts): its keys reach
// that agent alone (keys.ts sorts out the switch key), and a resize reaches
// them all. A bell or a notification from any agent reaches the person; a
// hidden one that rings "wants you" in the strip (strip.ts), which also
// shows each agent's step from the board (live.ts).
//
// The keyboard protocols an agent asks for (keyboard.ts) follow it too, so
// Shift+Enter reaches it as itself (T191). The real terminal is asked once,
// at the start, whether it speaks the kitty keyboard protocol. If it does,
// Tricot pushes an entry of its own on the terminal's stack, sets it to the
// flags of the agent showing as it switches, and pops it as it leaves; each
// agent that asks is answered with its own flags. If it doesn't, nothing of
// it is written and the agents' question goes unanswered, as before.
//
// With `tricot` set (the CLI always sets it, T192), the first tab is Tricot's
// own (tricotTab.ts), drawn by Tricot rather than an agent: the board, the
// agents, the requests for permission to answer, the board's activity. It
// shows first; the switch key then 0 comes back to it, and the switch key
// alone goes round every tab, it included. Keys typed there are its own.
// When a request comes in while an agent shows, the strip's right side says
// for a moment how to answer it. Agents added from the tab start in a tab of
// their own; one stopped from it is hung up, as a closing window would.
//
// When every agent has ended (and there is no Tricot tab to stay on), or the
// person quits (every agent is closed, as a terminal window closing would),
// the terminal is put back as it was and `done` gives each agent's exit code.
import type { Answers } from './answers';
import { InputRouter, ARM_MS, type HostAction, type SwitchKey } from './keys';
import type { LiveFeed } from './live';
import { modeChanges, PLAIN_MODES } from './modes';
import { spawnPty, type Pty, type PtyHelper } from './pty';
import { AgentScreen, type InputModes, type TerminalColours } from './screen';
import { agentWords, isLight, renderStrip, type AgentNow, type StripEntry, type StripLayout } from './strip';
import { TricotTab, waitingFrom, type AddChoice } from './tricotTab';

export interface HostedAgent {
  name: string; // its name on the board, and in the strip
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  id?: string; // which of the agents Tricot starts (claude, codex, opencode, gemini, pi, omp)
  // Takes away what was made for this session alone (a folder, for some):
  // called when the agent ends, or the host does. Safe to call twice.
  cleanup?: () => void;
}

// The real terminal: process.stdin and stdout in raw mode (run.ts), or a
// stand-in in tests.
export interface HostTerminal {
  input: NodeJS.EventEmitter; // 'data' with what is typed
  write(text: string): void;
  size(): { cols: number; rows: number };
  onResize(listener: () => void): () => void;
  raw?(on: boolean): void;
}

// The Tricot tab's part: where the board is, answering, and starting more agents.
export interface TricotSetup {
  url: string; // Tricot's address
  title?: string; // the board's
  answers?: Answers;
  open(): void; // the board, in the browser
  // The agents Tricot can start, but those running (by id); and one made
  // ready to start, as the others were, or why it can't be.
  choices?(running: string[]): AddChoice[];
  make?(id: string): HostedAgent | { problem: string };
}

export interface HostOptions {
  agents: HostedAgent[];
  terminal: HostTerminal;
  key: SwitchKey;
  live?: LiveFeed;
  tricot?: TricotSetup;
  helper?: PtyHelper;
  // The real terminal's colours, for agents that ask, and whether it speaks
  // the kitty keyboard protocol; both asked of it unless the colours are given.
  colours?: TerminalColours;
  kitty?: boolean;
  now?: () => number;
  closeMs?: number; // how long closing agents get before they are let go
}

export interface HostOutcome {
  // Each agent's exit code, as named, then those added; none for one still
  // running when the person quit, or stopped from the Tricot tab, which was
  // closed rather than ended on its own.
  exits: (number | undefined)[];
  agents?: { name: string; id?: string }[]; // the same order: those named, then those added
  quit: boolean;
}

export interface HostView {
  visible: number; // the agent showing, from 0; TRICOT_TAB for the Tricot tab
  scrolling: boolean;
  strip: string;
  tab?: string[]; // the Tricot tab, as text, as last drawn
  agents: { name: string; state: AgentNow['state']; exitCode?: number; pid: number; screen: AgentScreen; modes: InputModes }[];
}

export interface Host {
  done: Promise<HostOutcome>;
  started: Promise<void>; // the agents are running
  quit(): void;
  redraw(): void; // all of it again (after the terminal was stopped and continued)
  restoreNow(): void; // the terminal as it was, at once: the process is ending
  view(): HostView;
}

interface Agent extends AgentNow {
  index: number;
  id?: string;
  screen: AgentScreen;
  pty?: Pty;
  cleanup?: () => void; // what was made for it alone, taken away when it ends
}

export const TRICOT_TAB = -1;
export const MAX_AGENTS = 9; // as many as the switch key's digits pick
const COLOUR_WAIT_MS = 500;
const FLASH_MS = 2_500;
const ANSWER_HINT_MS = 5_000;
const SYNC_WAIT_MS = 150; // the most a frame asked to be shown whole is waited for
const FRAME_MS = 8;
// The Tricot tab reads pastes whole (a reason for a denial), and nothing else.
const TAB_MODES: InputModes = { ...PLAIN_MODES, bracketedPaste: true };

export function startHost(options: HostOptions): Host {
  const t = options.terminal;
  const now = options.now ?? Date.now;
  const key = options.key;
  const closeMs = options.closeMs ?? 2_000;
  const setup = options.tricot;
  let size = t.size();
  const appRows = () => Math.max(1, size.rows - 1);
  const agents: Agent[] = [];
  let visible = setup ? TRICOT_TAB : 0;
  let from = visible; // the tab showing before the switch key: where its second key acts
  let scroll: { top: number } | undefined;
  let flash: { text: string; until: number; answer?: boolean } | undefined;
  let painted: string[] = [];
  let tabShown: string[] = [];
  let stripShown = '';
  let cursorShown = '';
  let clearFirst = true;
  let outer: InputModes | undefined;
  let layout: StripLayout | undefined;
  let light = false;
  let colours: TerminalColours = {};
  let kitty = false; // the real terminal speaks the kitty keyboard protocol
  let progressShown = false;
  let timer: NodeJS.Timeout | undefined;
  let syncSince = 0;
  let begun = false;
  let quitting = false;
  let finished = false;
  const cleanups: (() => void)[] = [];
  let resolveDone!: (outcome: HostOutcome) => void;
  const done = new Promise<HostOutcome>((resolve) => (resolveDone = resolve));
  let pending = ''; // typed while the terminal's colours were asked for
  const seenRequests = new Set<string>();

  const router = new InputRouter({
    key: key.byte,
    tricotTab: Boolean(setup),
    stripRow: () => size.rows,
    scrolling: () => scroll !== undefined,
    emit: (action) => act(action),
    now,
  });

  const tab =
    setup &&
    new TricotTab(
      {
        agents: () => agents.map((agent) => ({ ...agent, number: agent.index + 1 })),
        live: () => options.live?.now(),
        now,
        changed: () => schedule(),
        open: () => setup.open(),
        quit: () => quit(),
        choices: () => setup.choices?.(agents.filter((a) => a.state !== 'ended' && a.id).map((a) => a.id!)) ?? [],
        add: (id) => addAgent(id),
        stop: (number) => stopAgent(number - 1),
      },
      { url: setup.url, title: setup.title, answers: setup.answers },
    );

  // ---- painting --------------------------------------------------------------------

  const schedule = (ms = FRAME_MS) => {
    if (!timer && begun && !finished) timer = setTimeout(frame, ms);
  };

  function hint(): string {
    const k = key.label;
    const first = setup ? 0 : 1;
    const range = agents.length + (setup ? 1 : 0) > 1 ? `${first}–${agents.length}` : `${first}`;
    // How to answer, only while something waits and the Tricot tab isn't showing.
    const answered = flash?.answer && (visible === TRICOT_TAB || (!waitingFrom(agents.map((a) => a.name), options.live?.now()).length && !options.live?.now()?.admissions?.length));
    if (flash && flash.until > now() && !answered) return flash.text;
    if (scroll) return `Scrolling ${agents[visible].name}: ↑↓ PgUp PgDn · q back`;
    if (quitting) return 'Closing the agents…';
    if (agents.length === 1 && !setup) return router.armed ? `then q quit · [ scroll · ${k} sends it` : `${k} q quit · ${k} [ scroll`;
    if (router.armed) return `then ${range} pick · q quit · [ scroll · ${k} sends it`;
    return `${k} next · ${k} ${range} pick · ${k} q quit`;
  }

  function strip(): StripLayout {
    const live = options.live?.now();
    const at = now();
    const entries: StripEntry[] = agents.map((agent) => ({ name: agent.name, ended: agent.state === 'ended', number: String(agent.index + 1), ...agentWords(agent, live, at) }));
    if (setup) entries.unshift({ name: 'Tricot', ended: false, number: '', words: '', tone: 'normal' });
    return renderStrip(entries, setup ? visible + 1 : visible, size.cols, hint(), light);
  }

  function frame(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!begun || finished) return;
    const agent = visible === TRICOT_TAB ? undefined : agents[visible];
    if (agent && !scroll && agent.screen.synchronizing) {
      syncSince ||= now();
      if (now() - syncSince < SYNC_WAIT_MS) return schedule(16);
    }
    syncSince = 0;
    let out = '';
    if (clearFirst) {
      out += '\x1b[0m\x1b[H\x1b[2J';
      clearFirst = false;
      painted = [];
      stripShown = '';
    }
    const drawn = agent ? undefined : tab!.render(size.cols, appRows(), light);
    if (drawn) tabShown = drawn.plain;
    for (let y = 0; y < appRows(); y++) {
      const row = drawn ? (drawn.rows[y] ?? '\x1b[0m\x1b[K') : scroll ? agent!.screen.historyRow(scroll.top + y) : agent!.screen.row(y);
      if (painted[y] !== row) {
        out += `\x1b[${y + 1};1H${row}`;
        painted[y] = row;
      }
    }
    painted.length = appRows();
    layout = strip();
    if (layout.line !== stripShown) {
      out += `\x1b[${size.rows};1H${layout.line}`;
      stripShown = layout.line;
    }
    const wanted = !agent ? TAB_MODES : scroll ? PLAIN_MODES : agent.screen.inputModes;
    const modes = modeChanges(outer, wanted, kitty);
    outer = wanted;
    let cursor: string;
    if (agent) {
      const c = agent.screen.cursor;
      cursor = `\x1b[${c.y + 1};${c.x + 1}H${c.visible && !scroll ? '\x1b[?25h' : ''}`;
    } else {
      // A reason being typed shows the cursor where it goes; otherwise none.
      const c = drawn!.cursor;
      cursor = c ? `\x1b[${c.y + 1};${c.x + 1}H\x1b[?25h` : `\x1b[${appRows()};1H`;
    }
    if (!out && !modes && cursor === cursorShown) return;
    cursorShown = cursor;
    t.write(`\x1b[?2026h\x1b[?25l\x1b[?7l${out}\x1b[?7h${modes}${cursor}\x1b[?2026l`);
  }

  // ---- switching -------------------------------------------------------------------

  // The tabs in the strip's order: the Tricot tab first, when there is one.
  const tabs = (): number[] => [...(setup ? [TRICOT_TAB] : []), ...agents.map((a) => a.index)];

  const nextRunning = (after: number): number => {
    const order = tabs();
    const at = Math.max(0, order.indexOf(after));
    for (let k = 1; k <= order.length; k++) {
      const j = order[(at + k) % order.length];
      if (j === TRICOT_TAB || agents[j].state !== 'ended') return j;
    }
    return after;
  };

  function switchTo(j: number): void {
    if (j === visible || (j !== TRICOT_TAB && !agents[j]) || (j === TRICOT_TAB && !setup)) {
      scroll = undefined;
      schedule();
      return;
    }
    const was = visible === TRICOT_TAB ? undefined : agents[visible];
    // Focus goes with the switch, for agents that asked to hear of it.
    if (was && was.state !== 'ended' && was.screen.inputModes.focus) was.pty?.write('\x1b[O');
    if (progressShown) {
      t.write('\x1b]9;4;0\x1b\\');
      progressShown = false;
    }
    visible = j;
    scroll = undefined;
    const shown = j === TRICOT_TAB ? undefined : agents[j];
    if (shown) {
      shown.wantsYou = false;
      if (shown.state !== 'ended' && shown.screen.inputModes.focus) shown.pty?.write('\x1b[I');
    }
    frame();
  }

  function say(text: string, ms = FLASH_MS, answer = false): void {
    flash = { text, until: now() + ms, ...(answer && { answer }) };
    schedule();
    setTimeout(() => schedule(), ms + 20).unref?.();
  }

  function moveScroll(lines: number): void {
    if (!scroll) return;
    scroll.top = Math.max(0, Math.min(agents[visible].screen.history, scroll.top - lines));
    schedule();
  }

  function act(action: HostAction): void {
    if (finished) return;
    const showing = visible === TRICOT_TAB ? undefined : agents[visible];
    switch (action.kind) {
      case 'send':
        if (!showing) tab?.key(action.data);
        else if (showing.state !== 'ended') showing.pty?.write(action.data);
        return;
      case 'next':
        from = visible;
        switchTo(nextRunning(visible));
        schedule();
        setTimeout(() => schedule(), ARM_MS + 20).unref?.();
        return;
      case 'pick':
        if (action.index === TRICOT_TAB ? setup : agents[action.index]) switchTo(action.index);
        else say(`There's no agent ${action.index + 1}.`);
        return;
      case 'literal': {
        switchTo(from);
        const back = from === TRICOT_TAB ? undefined : agents[from];
        if (back && back.state !== 'ended') back.pty?.write(action.data);
        return;
      }
      case 'quit':
        quit();
        return;
      case 'scroll-view': {
        switchTo(from);
        const agent = visible === TRICOT_TAB ? undefined : agents[visible];
        if (!agent) say('The Tricot tab has no history to scroll.');
        else if (agent.screen.altScreen) say(`${agent.name} draws its own screen: scroll inside it.`);
        else {
          scroll = { top: agent.screen.history };
          schedule();
        }
        return;
      }
      case 'click': {
        const hit = layout?.ranges.find((r) => action.column >= r.from && action.column < r.to);
        if (hit) switchTo(setup ? hit.index - 1 : hit.index);
        return;
      }
      case 'suspend':
        say(`Ctrl+Z does nothing here. ${key.label} then q quits.`);
        return;
      case 'scroll':
        moveScroll(action.lines);
        return;
      case 'scroll-page':
        moveScroll(action.pages * Math.max(1, appRows() - 1));
        return;
      case 'scroll-end':
        moveScroll(action.top ? Infinity : -Infinity);
        return;
      case 'leave-scroll':
        scroll = undefined;
        schedule();
        return;
    }
  }

  // ---- the agents --------------------------------------------------------------------

  // What was made for an agent alone is taken away once.
  function takeAway(agent: Agent): void {
    const cleanup = agent.cleanup;
    agent.cleanup = undefined;
    try {
      cleanup?.();
    } catch {
      // not worth stopping the host for
    }
  }

  function ended(agent: Agent, exitCode: number): void {
    if (agent.state === 'ended') return;
    agent.state = 'ended';
    agent.exitCode = exitCode;
    takeAway(agent);
    // With a Tricot tab, it stays, saying so, until the person quits or adds one.
    if (agents.every((a) => a.state === 'ended') && (quitting || !setup)) return finish();
    if (agent.index === visible && !quitting) switchTo(nextRunning(visible));
    schedule();
  }

  function startAgent(spec: HostedAgent): Agent {
    const index = agents.length;
    const agent: Agent = { index, name: spec.name, ...(spec.id && { id: spec.id }), ...(spec.cleanup && { cleanup: spec.cleanup }), state: 'starting', screen: undefined as unknown as AgentScreen };
    const hidden = () => index !== visible;
    const wants = () => {
      if (!hidden()) return;
      agent.wantsYou = true;
      schedule();
    };
    agent.screen = new AgentScreen(
      size.cols,
      appRows(),
      {
        reply: (data) => agent.pty?.write(data),
        bell: () => {
          t.write('\x07');
          wants();
        },
        notify: (sequence) => {
          t.write(sequence);
          wants();
        },
        progress: (sequence) => {
          if (hidden()) return;
          t.write(sequence);
          progressShown = !/^\x1b\]9;4;0/.test(sequence);
        },
        clipboard: (sequence) => {
          if (!hidden()) t.write(sequence);
        },
      },
      colours,
      kitty,
    );
    agents.push(agent);
    let pty: Pty;
    try {
      pty = spawnPty(spec.command, spec.args, { cols: size.cols, rows: appRows(), cwd: spec.cwd, env: spec.env, helper: options.helper });
    } catch (error) {
      void agent.screen.write(`Couldn't start ${spec.name}: ${error instanceof Error ? error.message : error}\r\n`);
      agent.state = 'ended';
      agent.exitCode = 127;
      takeAway(agent);
      return agent;
    }
    agent.pty = pty;
    void pty.ready.then(() => {
      if (agent.state === 'starting') agent.state = 'running';
      schedule();
    });
    let told = 0;
    pty.onData((data) => {
      agent.lastOutput = now();
      void agent.screen.write(data).then(() => {
        if (!hidden()) schedule();
        else if (now() - told > 500) {
          told = now();
          schedule(); // its words in the strip: working
        }
      });
    });
    pty.onExit(({ exitCode }) => ended(agent, exitCode));
    return agent;
  }

  // From the Tricot tab: another agent, in a tab of its own, shown at once.
  function addAgent(id: string): string | undefined {
    if (quitting || finished) return undefined;
    if (agents.length >= MAX_AGENTS) return `${MAX_AGENTS} agents is as many as ${key.label} and a digit can pick.`;
    const made = setup?.make?.(id);
    if (!made) return "Agents can't be added here.";
    if ('problem' in made) return made.problem;
    const agent = startAgent(made);
    switchTo(agent.index);
    return undefined;
  }

  // From the Tricot tab: hung up, as a closing window would; killed if it
  // is still there a moment later.
  function stopAgent(index: number): void {
    const agent = agents[index];
    if (!agent || agent.state === 'ended' || agent.closing) return;
    agent.closing = true;
    agent.pty?.kill('SIGHUP');
    schedule();
    setTimeout(() => {
      if (agent.state !== 'ended') agent.pty?.kill('SIGKILL');
    }, closeMs).unref?.();
  }

  // A request for permission new since the last look, from one of these
  // agents: while an agent shows, the strip says for a moment how to answer it.
  function newRequests(): void {
    const names = agents.map((a) => a.name);
    const waiting = waitingFrom(names, options.live?.now());
    const fresh = waiting.filter((a) => !seenRequests.has(a.id));
    for (const approval of waiting) seenRequests.add(approval.id);
    // A browser or terminal asking to act for the person, for this terminal to answer.
    const asking = options.live?.now()?.admissions ?? [];
    const freshAsking = asking.filter((a) => !seenRequests.has(a.id));
    for (const admission of asking) seenRequests.add(admission.id);
    if (freshAsking.length && setup && visible !== TRICOT_TAB && !quitting) {
      say(`${freshAsking[0].kind === 'terminal' ? 'A terminal' : 'A browser'} wants to act for you: ${key.label} 0 to answer`, ANSWER_HINT_MS, true);
      return;
    }
    if (fresh.length && setup && visible !== TRICOT_TAB && !quitting) say(`${key.label} 0 to answer`, ANSWER_HINT_MS, true);
  }

  // ---- the real terminal ---------------------------------------------------------------

  // Its colours (OSC 10, 11, 12), for agents that pick a light or dark look
  // from them, and whether it speaks the kitty keyboard protocol (CSI ? u,
  // answered only by one that does); the device attributes asked after them
  // end the wait early in a terminal that doesn't answer the others.
  function askTerminal(): Promise<{ colours: TerminalColours; kitty: boolean }> {
    return new Promise((resolve) => {
      let heard = '';
      const answers = /\x1b\](1[012]);([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[\?(\d+)u|\x1b\[\?[\d;]*c/g;
      const finish = () => {
        clearTimeout(wait);
        t.input.off('data', on);
        const colours: TerminalColours = {};
        let kitty = false;
        for (const m of heard.matchAll(answers)) {
          if (m[1] === '10') colours.foreground = m[2];
          if (m[1] === '11') colours.background = m[2];
          if (m[1] === '12') colours.cursor = m[2];
          if (m[3] !== undefined) kitty = true;
        }
        pending += heard.replace(answers, '');
        resolve({ colours, kitty });
      };
      const on = (data: Buffer) => {
        heard += data.toString('latin1');
        if (/\x1b\[\?[\d;]*c/.test(heard)) finish();
      };
      const wait = setTimeout(finish, COLOUR_WAIT_MS);
      t.input.on('data', on);
      t.write('\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\\x1b[?u\x1b[c');
    });
  }

  // The kitty keyboard's flags go back by popping what Tricot pushed as it began.
  function restoreSequence(): string {
    return `\x1b[?2026l\x1b[0m${progressShown ? '\x1b]9;4;0\x1b\\' : ''}${modeChanges(outer, PLAIN_MODES)}${kitty ? '\x1b[<u' : ''}\x1b[0 q\x1b[?25h\x1b[?7h\x1b[?1049l`;
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    router.dispose();
    for (const cleanup of cleanups.splice(0)) cleanup();
    if (begun) t.write(restoreSequence());
    t.raw?.(false);
    for (const agent of agents) {
      agent.pty?.dispose();
      agent.screen.dispose();
      takeAway(agent); // those let go while still there, as well as those that ended
    }
    resolveDone({
      exits: agents.map((a) => (a.closing ? undefined : a.exitCode)),
      agents: agents.map((a) => ({ name: a.name, ...(a.id && { id: a.id }) })),
      quit: quitting,
    });
  }

  function quit(): void {
    if (quitting || finished) return;
    quitting = true;
    tab?.closing();
    for (const agent of agents) {
      if (agent.state === 'ended') continue;
      agent.closing = true;
      agent.pty?.kill('SIGHUP');
    }
    if (agents.every((a) => a.state === 'ended')) return finish();
    schedule();
    // Those still there are let go: their helpers end them (SIGKILL) shortly.
    setTimeout(finish, closeMs).unref?.();
  }

  const onInput = (data: Buffer) => router.feed(data);

  const started = (async () => {
    t.raw?.(true);
    ({ colours, kitty } = options.colours ? { colours: options.colours, kitty: options.kitty ?? false } : await askTerminal());
    if (finished) return;
    light = isLight(colours.background);
    size = t.size();
    // On its own screen, with its own entry on the kitty keyboard's stack, set as each tab shows.
    t.write(`\x1b[?1049h\x1b[H\x1b[2J${kitty ? '\x1b[>0u' : ''}`);
    begun = true;
    for (const spec of options.agents) startAgent(spec);
    t.input.on('data', onInput);
    cleanups.push(() => t.input.off('data', onInput));
    cleanups.push(
      t.onResize(() => {
        size = t.size();
        for (const agent of agents) {
          agent.screen.resize(size.cols, appRows());
          agent.pty?.resize(size.cols, appRows());
        }
        if (scroll) scroll.top = Math.min(scroll.top, agents[visible].screen.history);
        clearFirst = true;
        frame();
      }),
    );
    if (options.live)
      cleanups.push(
        options.live.onChange(() => {
          newRequests();
          schedule();
        }),
      );
    newRequests();
    const tick = setInterval(() => schedule(), 1_000);
    tick.unref?.();
    cleanups.push(() => clearInterval(tick));
    if (pending) router.feed(Buffer.from(pending, 'latin1'));
    pending = '';
    if (!setup && agents.every((a) => a.state === 'ended')) return finish();
    if (visible !== TRICOT_TAB && agents[visible]?.state === 'ended') visible = nextRunning(visible);
    frame();
  })();

  return {
    done,
    started,
    quit,
    redraw() {
      clearFirst = true;
      outer = undefined;
      cursorShown = '';
      t.raw?.(true);
      frame();
    },
    restoreNow() {
      if (finished) return;
      if (begun) t.write(restoreSequence());
      for (const agent of agents) {
        agent.pty?.dispose();
        takeAway(agent);
      }
    },
    view: () => ({
      visible,
      scrolling: scroll !== undefined,
      strip: layout?.plain ?? '',
      ...(setup && { tab: tabShown }),
      agents: agents.map((a) => ({ name: a.name, state: a.state, exitCode: a.exitCode, pid: a.pty?.pid ?? 0, screen: a.screen, modes: a.screen.inputModes })),
    }),
  };
}
