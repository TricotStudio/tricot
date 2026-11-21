import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Command } from '../../install/handoff';
import { shellCommand } from '../../core/connect';
import { Shown } from '../../core/answering';
import { cardOwning, cardsOf } from '../../core/cards';
import { requestsDigest } from '../../core/requests';
import { threadsDigest } from '../../core/threads';
import { mentionsDigest } from '../../core/mentions';
import { partAsks } from '../../core/parts';
import { clip } from '../../core/format';
import { eventsDigest } from '../../core/digest';
import { concernsAgent } from '../../core/concerns';
import type { AgentKind, ListenTraits } from '../../core/agents/agent';
import { agentOfMcpClient } from '../../core/agents/registry';
import { BoardError, type Store } from '../../core/store';
import { boardKey, type Actor, type Board, type BoardEvent } from '../../core/types';
import { compareVersions } from '../../core/version';
import { describe as hookStep, type StepLabels } from '../../../hooks/tricot-describe.mjs';
import { CODEX_WAIT_WORDS, type CodexWakes } from '../codexWake';
import type { CommitFiles } from '../commitFiles';
import type { ConnectorTool } from '../connectors/connector';
import { DROP_GRACE_MS, REST_MS, STUCK_MS, STUCK_SHOWN_MS, WRONG_SLEEPS, type ListenSession } from '../listeners';
import type { PairingSessions } from '../pairing';
import type { AgentFocus, Presence } from '../presence';
import type { Steps } from '../steps';
import type { ToolCosts } from '../toolCosts';
import type { Hangups } from './hangups';
import type { Extra, Tool } from './tool';
import { LEAD_WORDS } from '../../core/roles';
import type { ToolGroups } from './toolGroups';
import type { Sayer } from '../../core/words';
import { Phrases } from './words';
import { agentBoard, cardVisible, eventVisibleTo, hiddenBacklogTarget, seeBoardComments } from './backlog';

// The longest one wait lasts (wait_for_updates, or then_wait after a reply).
// An idle agent wakes about this often, and each wake is a whole model turn
// over its context, so it is long; the agent shows as listening throughout.
export const MAX_WAIT_SECONDS = 15 * 60;
// Each agent's MCP client has its own limit on one call (its registry entry,
// core/agents/<id>/server.ts mcpClient), and a wait ends this far inside it,
// so its answer arrives before the client gives up.
export const CLIENT_LIMIT_MARGIN_SECONDS = 30;
// A client the registry doesn't name waits as long as every client did before.
export const UNKNOWN_CLIENT_WAIT_SECONDS = 240;
// Some clients cut a call that stays silent (Pi after its timeout, 60 seconds
// unless set; Claude Code after 5 minutes, though its waits end inside that
// anyway: its registry entry says why): progress keeps it going.
const PROGRESS_EVERY_MS = 30_000;

// How long one wait may last for the agent whose client calls itself this.
export function longestWait(clientName: string | undefined): number {
  const kind = agentOfMcpClient(clientName);
  if (!kind) return UNKNOWN_CLIENT_WAIT_SECONDS;
  const limit = kind.mcpClient.callLimitSeconds;
  return limit === undefined ? MAX_WAIT_SECONDS : Math.max(1, Math.min(MAX_WAIT_SECONDS, limit - CLIENT_LIMIT_MARGIN_SECONDS));
}

// What a session knows of the connection it serves, beyond MCP's own: the
// client's name and version once it has connected, which calls it hung up on
// (hangups.ts), whether Tricot's terminal started the agent and wakes it
// (its MCP address said so, core/sessions.ts wakeUrl), and where
// `tricot listen` reaches the board, when the session may sleep that way
// (it came from this computer, to a board that listens on it alone).
export interface Connection {
  clientName(): string | undefined;
  clientVersion?(): string | undefined;
  hangups?: Hangups;
  woken?: string; // the terminal that wakes it, by the word its address names it by
  listenAt?: string; // the board's address, as the agent's client reached it
  // As it sleeps by `tricot listen` on a board: takes the coordinator's role there (core/roles.ts), and says whether it
  // took it now, to be told so. None for a session that has a role, or that Tricot's terminal wakes.
  lead?(boardKey: string, extra: Extra): Promise<boolean>;
}

// Whether a session sleeps between turns by `tricot listen`
// (listeners.ts), and how its client runs that in the background: its client
// can (the registry's mcpClient.listens, from the version it says), it may
// (listenAt), and Tricot's terminal doesn't wake it already.
export function listensBy(client: { name?: string; version?: string } | undefined, listenAt: string | undefined, woken?: string): ListenTraits | undefined {
  if (woken || !listenAt || !client?.version) return undefined;
  const traits = agentOfMcpClient(client.name)?.mcpClient.listens;
  if (!traits) return undefined;
  try {
    return compareVersions(client.version, traits.since) >= 0 ? traits : undefined;
  } catch {
    return undefined; // a version it can't read
  }
}

// The command a session's wait gives its agent: the board's address,
// the board, and the session's own word, each a single shell word as it is
// (an address the board checked, a board id, base64url). Each is in one word
// with its option, `--session=<word>`: base64url has `-`, and a value
// after the option's own word that starts with one is read as an option
// ("argument is ambiguous"), which left the agent unable to wait one time in
// 64. Every `tricot` that knows listen reads the `=` form too.
//
// It runs as the board's own `tricot`: the board can't know which
// `tricot` the agent's PATH finds, and an older one doesn't know the command
// (0.1.6 answered "Unknown option '--session'"). So, when the board knows how
// it was started (`cli`: its Node, Node's options and its script), the
// command is that, quoted for the shell an agent's tool runs it in: bash or
// zsh, Git Bash on Windows, as the only client that listens (Claude Code)
// has. Plain `tricot listen` when it doesn't, or when a file of that is gone
// (the install it ran from was upgraded under it): the wait then says what
// to do if that `tricot` is too old (LISTEN_WORDS.older).
export function listenCommand(listenAt: string, boardId: string, word: string, cli?: Command): { line: string; own: boolean } {
  const words = ['listen', `--board=${boardId}`, `--session=${word}`, `--url=${listenAt}`];
  const own = cli !== undefined && [cli.command, ...cli.args].every((part) => !path.isAbsolute(part) || existsSync(part));
  return { line: shellCommand(own ? [cli.command, ...cli.args, ...words] : ['tricot', ...words]), own };
}

// A session's word for its command: random base64url that doesn't
// start with `-`, so it reads as a value even where the option is a
// word of its own, as boards wrote it before (`--session <word>`).
function sessionWord(): string {
  for (;;) {
    const word = randomBytes(18).toString('base64url');
    if (!word.startsWith('-')) return word;
  }
}

// What a wait tells an agent Tricot's terminal wakes, after its
// updates: in place of waiting, to end its turn, or to act first; and when it
// waited after all, why, and what to do next.
export const WAIT_WORDS = {
  asleep:
    "Nothing here needs you, and Tricot's terminal wakes you in this session, so this didn't wait: end your turn now, without another call. When something on the board needs you, Tricot types a line in your prompt: read your updates then.",
  act: "Tricot's terminal wakes you in this session, so this didn't wait: act on what's above, then call wait_for_updates again and end your turn.",
  spun: 'You called wait_for_updates again right after it ended your turn, so this one waited. Next time, end your turn when it says so: Tricot types a line in your prompt when something on the board needs you.',
  unheld: "Tricot's terminal isn't holding you to wake you on this board now, so this waited, as it will each time: keep calling wait_for_updates while you're idle, as an agent connected on its own does.",
};

// What a wait tells an agent that sleeps by `tricot listen`, after
// its updates: run the command in the background and end its turn (start),
// act first and then do so (startAct), end its turn as the command still
// runs (asleep), or act and call it again (act); and when it waited after
// all, called again at once with nothing new instead of ending its turn, why (spun).
export const LISTEN_WORDS = {
  start: (command: string, background: string) =>
    `Nothing here needs you, so this didn't wait. Run this in the background (${background}), then end your turn: ${command}\nIt ends when something on the board needs you, and its end wakes you: call wait_for_updates then.`,
  startAct: (command: string, background: string) => `This didn't wait: act on what's above, then run this in the background (${background}) and end your turn: ${command}`,
  asleep: "Nothing here needs you, and your tricot listen still runs, so this didn't wait: end your turn now, without another call. It ends when something on the board needs you, and its end wakes you.",
  act: "This didn't wait: act on what's above, then call wait_for_updates again.",
  spun: 'You called wait_for_updates again rather than end your turn, so this one waited. Next time, end your turn when it says so, once you have run the tricot listen command it gives, if it gave one.',
  // After the command, when it is the PATH's `tricot` and not the board's own (listenCommand).
  older: (version: string | undefined) =>
    `If it fails at once, saying it doesn't know listen or an option, the tricot on your PATH is older than this board${version ? ` (Tricot ${version})` : ''}: don't run it again, call wait_for_updates while you're idle instead, and tell the person to update it with: tricot update`,
};

// How many updates one get_updates or wait_for_updates call returns. A longer
// catch-up comes in pages: each says where it ended (its Cursor) and, when
// there is more, to call again with that.
export const UPDATES_PAGE = 100;

export interface McpOptions {
  // Whether agents may attach images by local file path. Only safe when the
  // server is reachable from this machine alone.
  allowFilePaths: boolean;
  // Whether an agent connected from this computer may sleep between turns by
  // `tricot listen`. Only when the board listens on this machine
  // alone, where the command needs no token.
  offerListen?: boolean;
  presence?: Presence;
  // What agents are doing, from their harness's hooks (steps.ts): a write's
  // step ends as it lands, and an agent's steps give way as it starts to listen.
  steps?: Steps;
  // The connectors: which are connected, for list_boards (never a token), and the tools they add once there is a store.
  connectors?: { line(words?: Sayer): string; tools(store: Store): ConnectorTool[] };
  // The groups of tools registered besides the board's own, with the guide topics and the lines of the instructions
  // they add (toolGroups.ts): a part's cards, and its role. None: the board's own tools alone,
  // and the instructions the core says.
  groups?: ToolGroups;
  // Who is pairing with this agent (pairing.ts): said in get_board and its updates while it lasts.
  pairing?: PairingSessions;
  // The version of Tricot, which the server tells agents it is.
  version?: string;
  // What each tool call costs the agent, in sizes only (toolCosts.ts): every call is measured when given.
  costs?: ToolCosts;
  // Where an area lives, from its done tasks' commits (commitFiles.ts), for
  // get_board(area) and brief_task. None beyond this computer, and in tests.
  commitFiles?: CommitFiles;
  // Wakes a Codex connected on its own in its own session (codexWake.ts). None: it listens.
  codexWakes?: CodexWakes;
  // The board's own address, as `tricot` prints it (app.ts): the links agents give people start with it.
  address?: string;
  // How to run this board's own `tricot`, as it was started (server/start.ts):
  // the command a wait hands an agent runs as it (listenCommand). None: `tricot`.
  cli?: Command;
}

// A page from events read up to one past it (to know whether there is more),
// with the cursor to give the agent: the last event's seq when a page is cut
// short, otherwise the board's, which also passes by the agent's own events.
function updatesPage(read: BoardEvent[], boardSeq: number): { events: BoardEvent[]; cursor: number; more: boolean } {
  const more = read.length > UPDATES_PAGE;
  const events = more ? read.slice(0, UPDATES_PAGE) : read;
  return { events, cursor: more ? events.at(-1)!.seq : boardSeq, more };
}

// The step a hook in the agent's harness sends for a Tricot call, in its words
// and naming the card or thread the call does (hooks/tricot-describe.mjs):
// "Writing a comment" on the card it names. None for a call it keeps quiet. The words of a part's
// tools are the part's (its group's `stepLabels`), as the file its hook reads beside itself is.
const stepOfCall = (name: string, args: Record<string, unknown>, labels: StepLabels) =>
  hookStep({ hook_event_name: 'PreToolUse', tool_name: `mcp__tricot__${name}`, tool_input: args }, { labels });

// The board a tool call is about, from whichever id it was given.
function boardOf(store: Store, args: Record<string, unknown>): Board | undefined {
  const id = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  try {
    if (id('board_id')) return store.getBoard(id('board_id')!);
    for (const kind of store.cardKinds()) if (id(`${kind}_id`)) return store.getCard(kind, id(`${kind}_id`)!).board;
    if (id('request_id')) return store.getRequest(id('request_id')!).board;
    if (id('thread_id')) return store.getThread(id('thread_id')!).board;
    const item = id('block_id') ?? id('from_block_id') ?? id('pin_id') ?? id('id');
    return item ? store.canvasOf(item).board : undefined;
  } catch {
    return undefined; // the tool itself reports the bad id
  }
}

// The card a tool call reads or changes, so people see the agent taking a
// look at it: a card of a kind the Store keeps (a task or decision) by id, else the card whose canvas holds the
// block, pin or item named. The board context and the board as a whole are no card.
function focusOf(store: Store, args: Record<string, unknown>): AgentFocus | undefined {
  const id = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  try {
    // The kind registered last first: a task, which serves a decision, is the card a call that names both is about.
    for (const kind of [...store.cardKinds()].reverse()) if (id(`${kind}_id`)) return { kind: kind as AgentFocus['kind'], id: store.getCard(kind, id(`${kind}_id`)!).card.id };
    const item = id('block_id') ?? id('from_block_id') ?? id('pin_id') ?? id('id');
    if (!item) return undefined;
    const owner = cardOwning(store.canvasOf(item));
    return owner && { kind: owner.kind.kind as AgentFocus['kind'], id: owner.id };
  } catch {
    return undefined;
  }
}

// How a wait went, for the updates it returns: how long it was, and whether
// something that concerns the agent ended it (core/concerns.ts), or the time
// ran out; and in a session Tricot's terminal wakes, what it is told after
// (WAIT_WORDS): `asleep` and `act` when it didn't wait.
export interface Waited {
  seconds: number;
  heard: boolean;
  words?: keyof typeof WAIT_WORDS;
  said?: string; // what a session that sleeps by `tricot listen` is told instead (LISTEN_WORDS)
}

// How a wait goes in a session Tricot's terminal wakes (waitMode): it ends
// the turn (sleep); it waits after all, because the same session called it
// again at once with nothing new (spun), or because no terminal holds the
// agent on this board now (unheld); or it is any other agent's (listen). In
// a session that sleeps by `tricot listen`, it gives the command to
// run before the agent ends its turn (start), ends the turn while that
// command runs (sleep), or waits after all (spun).
type WaitMode = 'sleep' | 'spun' | 'unheld' | 'listen' | 'start';

// What one agent's connection keeps between its calls, and what it does around
// each one (handle). The tools use the same session for what it was shown (told),
// whether it has reported its skills, and the updates and the wait.
export interface Session {
  // What this session has been shown of what people and agents said, so a
  // message reaches it whole once and its context only as far as it hasn't
  // read it (core/answering.ts). A new session is told it all once.
  readonly told: Shown;
  // Whether this session has told Tricot its skills: until it has, get_board and wait_for_updates ask.
  skillsReported: boolean;
  updates(board: Board, since: number, waited?: Waited): string;
  // Which agent this is, from its MCP client's name: what a tag asks of it
  // depends on what it can do (core/agentTags.ts). None for a client Tricot doesn't know.
  agent(): AgentKind | undefined;
  // Waits as many seconds as asked, or as long as this agent's client allows
  // when it asks for more or says nothing (longestWait), for something that
  // concerns it.
  listen(board: Board, since: number, seconds: number | undefined, extra: Extra): Promise<string>;
  handle(tool: Tool, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult>;
  // Tricot's terminal started the agent to be woken: its tools say so.
  readonly woken: boolean;
  // Its connection closed: a `tricot listen` of its ends, and a Codex
  // Tricot wakes is let go of.
  close(): void;
}

export function createSession(store: Store, getActor: () => Actor, options: McpOptions, connection: Connection = { clientName: () => undefined }): Session {
  // What the tool groups say of the board in what an agent reads (core/words.ts Told): the board context's parts of its updates.
  const said = options.groups?.phrases() ?? new Phrases();
  const stepLabels = options.groups?.stepLabels() ?? {};
  // MCP can't push to an agent, so every call is a chance to tell it what it
  // hasn't seen: other people's activity since it last caught up on a board.
  // The same calls tell people which agents are here, and what they're doing.
  // Both are keyed by boardKey, so they follow a board when people rename it.
  const caughtUp = new Map<string, number>(); // board key -> last seq this session has been shown
  // Where a page of updates ended when there was more after it, by board key: that, not the board's last event, is how far the agent is caught up.
  const pageEnd = new Map<string, number>();
  // The furthest caughtUp has reached on each board, by board key. caughtUp
  // goes back when the session pages through older updates, but what it read
  // before stays read: a listener of its counts from here, so it
  // doesn't wake the agent for what it was told already.
  const furthest = new Map<string, number>();
  const catchUp = (key: string, seq: number): void => {
    caughtUp.set(key, seq);
    furthest.set(key, Math.max(furthest.get(key) ?? seq, seq));
  };
  // How far a wait that ended its turn has read: where its page ended, and never short of what it read before.
  const readTo = (key: string, board: Board): number => Math.max(pageEnd.get(key) ?? board.seq, furthest.get(key) ?? 0);
  // How far its updates have reminded it to refresh the status, by board key.
  const standingReminded = new Map<string, number>();
  const told = new Shown();
  const agent = () => agentOfMcpClient(connection.clientName());
  // A Codex connected on its own is woken in its own session: its waits end its turn while Tricot holds it.
  const queued = options.codexWakes?.session(connection, getActor);
  // A deleted task is reported only to sessions that could see it. This
  // prevents a hidden backlog card's deletion from exposing its title.
  const knownTasks = new Set<string>();
  const taskKey = (board: Board, id: string) => `${boardKey(board)}:${id}`;
  const rememberTasks = (board: Board) => {
    for (const card of cardsOf(board)) if (card.kind.backlog && cardVisible(board, card, getActor().name)) knownTasks.add(taskKey(board, card.id));
  };
  // An event the board logged is told only where the server tells its kind (core/eventsTold.ts): a board kept by a part holds
  // events of cards and the board context that a server with neither says nothing of, and its log stays as it is.
  const eventVisible = (board: Board, event: BoardEvent): boolean =>
    said.tells(event, board) &&
    eventVisibleTo(board, event, getActor().name, { has: (id) => knownTasks.has(taskKey(board, id)), add: (id) => knownTasks.add(taskKey(board, id)) });
  const visibleEvents = (board: Board, since: number) => {
    try {
      return store.eventsSince(board.id, since, getActor()).filter((event) => eventVisible(board, event));
    } catch (error) {
      if (error instanceof BoardError && error.code === 'not_found') return [];
      throw error;
    }
  };

  // A board's updates after a cursor, from events read up to one past a page:
  // the page, then what still waits on the agent. A wait (`waited`) adds that
  // nothing came, or nothing for it, and the ready work to hand out before
  // waiting again. What the session was told in full isn't told again (core/answering.ts).
  function updates(board: Board, since: number, waited?: Waited): string {
    const { events, cursor, more } = updatesPage(visibleEvents(board, since), board.seq);
    if (more) pageEnd.set(boardKey(board), cursor);
    const viewer = getActor().name;
    const view = agentBoard(board, viewer);
    const kind = agent();
    told.begin();
    const digest = eventsDigest(events, cursor, { board: view, viewer, shown: told, kind }, more, said);
    // A decision settled or a task finished: refresh the status, said once
    // for each, however often its event is read again (a part of the group that has the status).
    const reminded = standingReminded.get(boardKey(board)) ?? 0;
    const standing = said.part('standing-reminder', view, viewer, { events: events.filter((e) => e.seq > reminded) });
    if (events.length) standingReminded.set(boardKey(board), Math.max(reminded, events.at(-1)!.seq));
    const pending = [
      standing, // about the events above
      ...(options.pairing?.lines(boardKey(board), viewer) ?? []),
      said.part('sync', view, viewer),
      requestsDigest(view, viewer, kind, said),
      threadsDigest(view, viewer, told, kind, said),
      mentionsDigest(view, viewer, told, kind, said),
      said.part('first-looks', view, viewer, { now: store.now() }),
      said.part('refresh', view, viewer),
      said.part('commits', view, viewer),
      partAsks(view, viewer),
      waited === undefined ? undefined : said.part('ready', view, viewer),
    ].filter(Boolean);
    const asleep = waited?.words === 'asleep' || waited?.words === 'act' || (waited?.said !== undefined && waited.seconds === 0);
    const quiet = !waited || waited.heard || asleep ? '' : `\nNothing ${events.length ? 'new for you' : 'yet'} after ${waited.seconds}s; call again to keep waiting.`;
    seeBoardComments(store, board, getActor(), events, said); // 👀 on what people wrote that reached it
    const words = waited?.said ?? (waited?.words ? (queued?.told ? CODEX_WAIT_WORDS : WAIT_WORDS)[waited.words] : undefined);
    return `${digest}${quiet}${pending.map((line) => `\n${line}`).join('')}${words ? `\n${words}` : ''}`;
  }

  // How a wait on this board goes (WaitMode). In a session Tricot's terminal
  // wakes, a wait ends the agent's turn while the terminal holds it there,
  // but one called again at once, with no other call between and nothing
  // new for it since, waits as any agent's does, so a model that keeps
  // calling it doesn't spin.
  let lastSleep: { key: string; cursor: number; at: number } | undefined;
  const concerning = (board: Board, since: number) => visibleEvents(board, since).some((event) => concernsAgent(event, board, getActor().name));
  function waitMode(board: Board): WaitMode {
    // Held by its terminal, or a Codex Tricot wakes through Codex;
    // otherwise `tricot listen` decides, where its client can.
    const holder = connection.woken ?? queued?.hold(board);
    if (!holder) return queued?.told ? 'unheld' : listener.mode(board);
    const key = boardKey(board);
    const held = options.presence?.sleepers.held(key, getActor().name);
    // Held by its own terminal (or Codex session): one holding another agent of its name doesn't wake this one.
    if (!held || held.holder !== holder) return 'unheld';
    // Still the sleep it ended its turn in: the terminal hasn't woken it, nor the person written to it, since.
    const same = lastSleep?.key === key && held.asleep && held.at === lastSleep.at;
    return same && !concerning(board, lastSleep!.cursor) ? 'spun' : 'sleep';
  }
  // How it sleeps between turns by `tricot listen`, when its client can
  // (server/listeners.ts). The session's word goes in the command its
  // waits give; a listener under that word holds it asleep on a board while
  // the command runs, and its waits there end its turn meanwhile.
  const listener = (() => {
    const word = sessionWord();
    const listeners = options.presence?.listeners;
    const sleepers = options.presence?.sleepers;
    const wokeFor = new Map<string, number>(); // what its last wake on each board was for, by board key
    // How its sleeps went (listeners.ts). One that went wrong (a wake that
    // started no call, a listener that went with nothing for it) is no reason
    // to stop: the computer may have slept, or the agent been busy. Only
    // WRONG_SLEEPS in a row, with no wake answered in time between, have it
    // wait on the board until `restsUntil`, and then it is given the command again.
    let wrong = 0;
    let restsUntil: number | undefined;
    let closed = false;
    let started: { key: string; cursor: number } | undefined; // its last wait gave the command, and no listener or other call came since
    let woke: { key: string; timer: NodeJS.Timeout } | undefined; // its listener ended for something, and no call came since
    let stuck: string | undefined; // the board a stuck wake of its shows on
    const dropped = new Map<string, { listener: string; timer: NodeJS.Timeout }>(); // a listener whose connection closed, by board key, until its command connects again
    const waits = () => closed || (restsUntil !== undefined && Date.now() < restsUntil);
    const wentWrong = (): void => {
      wrong += 1;
      if (wrong >= WRONG_SLEEPS) restsUntil = Date.now() + (listeners?.restMs ?? REST_MS);
    };
    const wentRight = (): void => {
      wrong = 0;
      restsUntil = undefined;
    };
    const traits = () =>
      waits() || !listeners || !sleepers ? undefined : listensBy({ name: connection.clientName(), version: connection.clientVersion?.() }, connection.listenAt, connection.woken);
    // Any call: a turn began after a wake, or the agent is back after a stuck one.
    const called = (): void => {
      if (woke) {
        clearTimeout(woke.timer);
        sleepers?.letGo(woke.key, word, getActor().name);
        woke = undefined;
        wentRight();
      }
      if (stuck !== undefined) {
        sleepers?.letGo(stuck, word, getActor().name);
        stuck = undefined;
      }
    };
    const lent: ListenSession = {
      name: () => getActor().name,
      cursor: (key) => furthest.get(key),
      wokeFor: (key) => wokeFor.get(key) ?? -1,
      waits,
      listening(key, id) {
        if (started?.key === key) started = undefined;
        const drop = dropped.get(key);
        if (!drop) return;
        clearTimeout(drop.timer);
        dropped.delete(key);
        // Another command in its place: the one whose connection closed went.
        if (drop.listener !== id) wentWrong();
      },
      woke(key, due) {
        wokeFor.set(key, due);
        if (woke) clearTimeout(woke.timer);
        const timer = setTimeout(() => {
          // No call since its listener ended: the wake started no turn.
          woke = undefined;
          wentWrong();
          stuck = key;
          sleepers?.keep(key, word, getActor().name, STUCK_SHOWN_MS, true);
        }, listeners?.stuckMs ?? STUCK_MS);
        timer.unref?.();
        woke = { key, timer };
      },
      ended(key, id) {
        // The command connects again after a dropped connection: it went only
        // if it doesn't in time. (Each connection says `listening` first, which
        // settles the drop before it, so one board has one drop at a time.)
        const timer = setTimeout(() => {
          dropped.delete(key);
          wentWrong();
        }, listeners?.dropGraceMs ?? DROP_GRACE_MS);
        timer.unref?.();
        dropped.set(key, { listener: id, timer });
      },
    };
    return {
      traits,
      // How a wait goes in a session Tricot's terminal doesn't wake (waitMode).
      mode(board: Board): WaitMode {
        if (!traits() || !/^[A-Za-z0-9_-]+$/.test(board.id)) return 'listen';
        const key = boardKey(board);
        const held = sleepers!.held(key, getActor().name);
        // Another session or a terminal holds its name here: it waits, as ever.
        if (held && held.holder !== word) return 'listen';
        if (held && listeners!.listens(key, word)) {
          // Still the sleep it ended its turn in, called again with nothing new: it waits.
          const same = lastSleep?.key === key && held.asleep && held.at === lastSleep.at;
          return same && !concerning(board, lastSleep!.cursor) ? 'spun' : 'sleep';
        }
        // Told to start one, and called again at once, with no other call and nothing new between: it waits.
        return started?.key === key && !concerning(board, started.cursor) ? 'spun' : 'start';
      },
      // The wait gave the command: one called again at once, with nothing new, waits.
      gave(key: string, cursor: number): void {
        listeners!.add(word, lent);
        started = { key, cursor };
      },
      // Its turn ended at a wait while its listener runs: what is due counts from what it read.
      slept(key: string, cursor: number): void {
        if (sleepers!.sleep(key, getActor().name, cursor, word)) lastSleep = { key, cursor, at: sleepers!.held(key, getActor().name)!.at };
      },
      called,
      // A call other than a wait, or a wait that waited (cut off by its
      // client or not): a wait after it is no spin, and is given the command.
      other(): void {
        started = undefined;
      },
      command: (board: Board) => listenCommand(connection.listenAt!, board.id, word, options.cli),
      // Its connection closed: a listener of its is told its session is gone,
      // and a wake or stuck wake of its shows no longer.
      close(): void {
        closed = true;
        called();
        for (const { timer } of dropped.values()) clearTimeout(timer);
        dropped.clear();
        listeners?.drop(word);
      },
    };
  })();

  // Each call's mode, as handle decided it for the wait it makes.
  const modes = new WeakMap<Extra, WaitMode>();

  // Waits until something after the cursor concerns the agent (core/concerns.ts),
  // or `asked` seconds pass (at most longestWait), sending progress while it
  // lasts: for wait_for_updates, and for a reply with then_wait. What else
  // came meanwhile doesn't end it, and comes in the updates it returns, from
  // the same cursor. It ends at once when the agent cancels the call or hangs
  // up (handle gives it that signal).
  //
  // In a session Tricot's terminal wakes, it doesn't wait while the terminal
  // holds the agent (waitMode): it returns the updates at once, and tells the
  // agent to end its turn, or to act on what came first. With nothing for it,
  // its turn ends there: it is asleep, and what is due counts from what it
  // read (sleepers.ts).
  async function listen(board: Board, since: number, asked: number | undefined, extra: Extra): Promise<string> {
    const most = longestWait(connection.clientName());
    const seconds = Math.min(asked ?? most, most);
    const key = boardKey(board);
    const mode = modes.get(extra) ?? waitMode(board);
    // It listens now, or sleeps: what it last did on the board is behind it (steps.ts).
    options.steps?.listening(key, getActor().name);
    const by = connection.woken ? undefined : listener.traits();
    if (by && (mode === 'start' || mode === 'sleep')) {
      // A session that sleeps by `tricot listen` doesn't wait. With
      // its listener running, its turn ends here; without one, it is given
      // the command to run before it ends its turn, after acting on what
      // came for it, if anything did. It takes the coordinator's role there,
      // as each agent Tricot's terminal starts has it, and is told so first
      // (core/roles.ts).
      const leads = (await connection.lead?.(key, extra)) ? `${LEAD_WORDS}\n` : '';
      if (mode === 'sleep') {
        // New for it is what came after its cursor, and after what its
        // listener holds it from: a stale cursor doesn't keep it from sleeping.
        const from = options.presence?.sleepers.held(key, getActor().name)?.since ?? since;
        const heard = concerning(board, Math.max(since, from));
        const said = updates(board, since, { seconds: 0, heard, said: `${leads}${heard ? LISTEN_WORDS.act : LISTEN_WORDS.asleep}` });
        if (!heard) listener.slept(key, readTo(key, board));
        return said;
      }
      const heard = concerning(board, since);
      const { line, own } = listener.command(board);
      const start = `${leads}${heard ? LISTEN_WORDS.startAct(line, by.background) : LISTEN_WORDS.start(line, by.background)}`;
      const said = updates(board, since, { seconds: 0, heard, said: own ? start : `${start}\n${LISTEN_WORDS.older(options.version)}` });
      listener.gave(key, pageEnd.get(key) ?? board.seq);
      return said;
    }
    if (mode === 'sleep') {
      // New for it is what came after its cursor, and after what its
      // terminal last woke it for, which it was told to read: a stale cursor
      // doesn't keep it from sleeping.
      const woke = options.presence?.sleepers.held(key, getActor().name)?.since ?? since;
      const heard = concerning(board, Math.max(since, woke));
      const said = updates(board, since, { seconds: 0, heard, words: heard ? 'act' : 'asleep' });
      if (!heard) {
        const cursor = pageEnd.get(key) ?? board.seq;
        const sleepers = options.presence?.sleepers;
        if (sleepers?.sleep(key, getActor().name, cursor, connection.woken ?? queued!.holder()!)) lastSleep = { key, cursor, at: sleepers.held(key, getActor().name)!.at };
      }
      return said;
    }
    const progressToken = extra._meta?.progressToken;
    let elapsed = 0;
    const heartbeat =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            elapsed += PROGRESS_EVERY_MS / 1000;
            const params = { progressToken, progress: elapsed, total: seconds, message: 'Waiting for something on the board that needs you' };
            extra.sendNotification({ method: 'notifications/progress', params }).catch(() => {});
          }, PROGRESS_EVERY_MS);
    try {
      const concerns = (event: BoardEvent) => eventVisible(board, event) && concernsAgent(event, board, getActor().name);
      const heard = await store.waitForEvents(board.id, since, { timeoutMs: seconds * 1000, signal: extra.signal, exclude: getActor(), limit: 1, accept: concerns });
      store.sweepKinds(board); // one may have run out while it waited
      // A session that sleeps by `tricot listen` and spun is told so in its own words.
      const said = mode === 'spun' && !connection.woken ? LISTEN_WORDS.spun : undefined;
      return updates(board, since, { seconds, heard: heard.length > 0, ...((mode === 'spun' || mode === 'unheld') && { words: mode }), ...(said && { said }) });
    } finally {
      clearInterval(heartbeat);
      // It waited, to its end or until its client cut it off: the next wait
      // is no spin, and a session that sleeps by `tricot listen` is given the
      // command again.
      listener.other();
    }
  }

  async function handle(tool: Tool, args: Record<string, unknown>, called: Extra): Promise<CallToolResult> {
    listener.called();
    // A call whose connection closes before its answer is over, as one the agent cancels is.
    const hungUp = connection.hangups?.signal(called.requestId);
    queued?.heard(called._meta);
    const extra: Extra = hungUp ? { ...called, signal: AbortSignal.any([called.signal, hungUp]) } : called;
    // A call that changes the board: once it lands, its step is over (steps.ts).
    const writes = !tool.readOnly;
    const board = boardOf(store, args);
    const key = board && boardKey(board);
    // A reply with then_wait listens once it's posted, and the agent shows as listening all along.
    const thenWait = typeof args.then_wait === 'number' ? args.then_wait : undefined;
    const waits = tool.listens === true || thenWait !== undefined;
    // In a session Tricot's terminal wakes, or one that sleeps by `tricot
    // listen`, a wait may end the agent's turn instead: asleep, not listening.
    const mode = waits && board !== undefined ? waitMode(board) : undefined;
    if (mode) modes.set(extra, mode);
    else listener.other();
    const sleeps = mode === 'sleep' || mode === 'start';
    const agent = getActor().name;
    if (hiddenBacklogTarget(store, args, agent)) return { content: [{ type: 'text', text: 'This backlog card is not addressed to you. A person must assign you, or someone must @-mention you, before you read or change it.' }], isError: true };
    options.presence?.connect(agent);
    if (key) {
      rememberTasks(board);
      // First looks that ran out of time open again before anything reads the board.
      store.sweepKinds(board);
      if (!caughtUp.has(key)) catchUp(key, board.seq);
      const focus = tool.listens ? undefined : focusOf(store, args);
      if (waits && !sleeps) options.presence?.startWaiting(key, agent);
      if (!tool.listens) options.presence?.seen(key, agent, tool.takesFirstLook ? undefined : focus);
      else if (sleeps) options.presence?.seen(key, agent); // seen as its turn ends, on no card
      if (focus) store.touchOnKind(focus.kind, focus.id, getActor());
    }
    try {
      const result = await tool.handler(args, extra);
      if (board) rememberTasks(board);
      if (writes && !result.isError) {
        // What it wrote is on the board: the step its hook sent for this
        // call ("Writing a comment") is over, as no end comes for it.
        const step = stepOfCall(tool.name, args, stepLabels);
        if (step) options.steps?.wrote(key, agent, step);
      }
      if (!key || result.isError) return result;
      // Only the agent that gets a first look shows on its card: one refused isn't looking.
      if (tool.takesFirstLook) options.presence?.seen(key, agent, focusOf(store, args));
      if (thenWait !== undefined) {
        // From where this session last caught up: what came while it wrote comes at once.
        const heard = await listen(board, caughtUp.get(key)!, thenWait, extra);
        catchUp(key, pageEnd.get(key) ?? board.seq);
        pageEnd.delete(key);
        return { ...result, content: [...result.content, { type: 'text' as const, text: heard }] };
      }
      if (typeof tool.catchesUp === 'function' ? tool.catchesUp(args) : tool.catchesUp) {
        catchUp(key, pageEnd.get(key) ?? board.seq);
        pageEnd.delete(key);
        return result;
      }
      const since = caughtUp.get(key)!;
      const unreadEvents = visibleEvents(board, since);
      const unread = unreadEvents.length;
      if (unread === 0) {
        catchUp(key, board.seq);
        return result;
      }
      const latest = unreadEvents.at(-1)!;
      const notice = `Unread on this board: ${unread} update${unread === 1 ? '' : 's'} from others since you last checked (latest: ${latest.actor.name} ${clip(latest.summary, 100)}). Call get_updates with since: ${since}.`;
      return { ...result, content: [...result.content, { type: 'text' as const, text: notice }] };
    } finally {
      if (key && waits && !sleeps) options.presence?.stopWaiting(key, agent);
    }
  }

  const close = (): void => {
    listener.close();
    queued?.close();
  };
  return { told, skillsReported: false, updates, agent, listen, handle, woken: Boolean(connection.woken), close };
}
