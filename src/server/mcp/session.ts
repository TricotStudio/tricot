import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Shown } from '../../core/answering';
import { requestsDigest } from '../../core/requests';
import { threadsDigest } from '../../core/threads';
import { firstLooksDigest } from '../../core/firstLook';
import { mentionsDigest } from '../../core/mentions';
import { partAsks } from '../../core/parts';
import { clip } from '../../core/format';
import { commitsDigest, eventsDigest, readyWork, refreshDigest, syncDigest } from '../../core/digest';
import type { AgentKind } from '../../core/agents/agent';
import { agentOfMcpClient } from '../../core/agents/registry';
import { BoardError, type Store } from '../../core/store';
import { boardKey, type Actor, type Board, type BoardEvent } from '../../core/types';
import { describe as hookStep } from '../../../hooks/tricot-describe.mjs';
import type { ConnectorTool } from '../connectors/connector';
import type { PairingSessions } from '../pairing';
import type { AgentFocus, Presence } from '../presence';
import type { Steps } from '../steps';
import type { ToolCosts } from '../toolCosts';
import type { Hangups } from './hangups';
import type { Extra, Tool } from './tool';
import { agentBoard, hiddenBacklogTarget, seeBoardComments, taskVisible } from './backlog';

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
// Some clients cut a call that stays silent (Claude Code after 5 minutes; Pi
// after its timeout, 60 seconds unless set): progress keeps it going.
const PROGRESS_EVERY_MS = 30_000;

// How long one wait may last for the agent whose client calls itself this.
export function longestWait(clientName: string | undefined): number {
  const kind = agentOfMcpClient(clientName);
  if (!kind) return UNKNOWN_CLIENT_WAIT_SECONDS;
  const limit = kind.mcpClient.callLimitSeconds;
  return limit === undefined ? MAX_WAIT_SECONDS : Math.max(1, Math.min(MAX_WAIT_SECONDS, limit - CLIENT_LIMIT_MARGIN_SECONDS));
}

// What a session knows of the connection it serves, beyond MCP's own: the
// client's name once it has connected, and which calls it hung up on (hangups.ts).
export interface Connection {
  clientName(): string | undefined;
  hangups?: Hangups;
}

// How many updates one get_updates or wait_for_updates call returns. A longer
// catch-up comes in pages: each says where it ended (its Cursor) and, when
// there is more, to call again with that.
export const UPDATES_PAGE = 100;

export interface McpOptions {
  // Whether agents may attach images by local file path. Only safe when the
  // server is reachable from this machine alone.
  allowFilePaths: boolean;
  presence?: Presence;
  // What agents are doing, from their harness's hooks (steps.ts): a write's
  // step ends as it lands, and an agent's steps give way as it starts to listen.
  steps?: Steps;
  // The connectors: which are connected, for list_boards (never a token), and the tools they add once there is a store.
  connectors?: { line(): string; tools(store: Store): ConnectorTool[] };
  // Who is pairing with this agent (pairing.ts): said in get_board and its updates while it lasts.
  pairing?: PairingSessions;
  // The version of Tricot, which the server tells agents it is.
  version?: string;
  // What each tool call costs the agent, in sizes only (toolCosts.ts): every call is measured when given.
  costs?: ToolCosts;
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
// "Writing a comment" on the task it names. None for a call it keeps quiet.
const stepOfCall = (name: string, args: Record<string, unknown>) =>
  hookStep({ hook_event_name: 'PreToolUse', tool_name: `mcp__tricot__${name}`, tool_input: args });

// The board a tool call is about, from whichever id it was given.
function boardOf(store: Store, args: Record<string, unknown>): Board | undefined {
  const id = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  try {
    if (id('board_id')) return store.getBoard(id('board_id')!);
    if (id('decision_id')) return store.getDecision(id('decision_id')!).board;
    if (id('task_id')) return store.getTask(id('task_id')!).board;
    if (id('request_id')) return store.getRequest(id('request_id')!).board;
    if (id('thread_id')) return store.getThread(id('thread_id')!).board;
    const item = id('block_id') ?? id('from_block_id') ?? id('pin_id') ?? id('id');
    return item ? store.canvasOf(item).board : undefined;
  } catch {
    return undefined; // the tool itself reports the bad id
  }
}

// The card a tool call reads or changes, so people see the agent taking a
// look at it: a task or decision by id, else the card whose canvas holds the
// block, pin or item named. The board context and the board as a whole are no card.
function focusOf(store: Store, args: Record<string, unknown>): AgentFocus | undefined {
  const id = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  try {
    if (id('task_id')) return { kind: 'task', id: store.getTask(id('task_id')!).task.id };
    if (id('decision_id')) return { kind: 'decision', id: store.getDecision(id('decision_id')!).decision.id };
    const item = id('block_id') ?? id('from_block_id') ?? id('pin_id') ?? id('id');
    if (!item) return undefined;
    const { task, decision } = store.canvasOf(item);
    return task ? { kind: 'task', id: task.id } : decision ? { kind: 'decision', id: decision.id } : undefined;
  } catch {
    return undefined;
  }
}

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
  updates(board: Board, since: number, waited?: number): string;
  // Which agent this is, from its MCP client's name: what a tag asks of it
  // depends on what it can do (core/agentTags.ts). None for a client Tricot doesn't know.
  agent(): AgentKind | undefined;
  // Waits as many seconds as asked, or as long as this agent's client allows
  // when it asks for more or says nothing (longestWait).
  listen(board: Board, since: number, seconds: number | undefined, extra: Extra): Promise<string>;
  handle(tool: Tool, args: Record<string, unknown>, extra: Extra): Promise<CallToolResult>;
}

export function createSession(store: Store, getActor: () => Actor, options: McpOptions, connection: Connection = { clientName: () => undefined }): Session {
  // MCP can't push to an agent, so every call is a chance to tell it what it
  // hasn't seen: other people's activity since it last caught up on a board.
  // The same calls tell people which agents are here, and what they're doing.
  // Both are keyed by boardKey, so they follow a board when people rename it.
  const caughtUp = new Map<string, number>(); // board key -> last seq this session has been shown
  // Where a page of updates ended when there was more after it, by board key: that, not the board's last event, is how far the agent is caught up.
  const pageEnd = new Map<string, number>();
  const told = new Shown();
  const agent = () => agentOfMcpClient(connection.clientName());
  // A deleted task is reported only to sessions that could see it. This
  // prevents a hidden backlog card's deletion from exposing its title.
  const knownTasks = new Set<string>();
  const taskKey = (board: Board, id: string) => `${boardKey(board)}:${id}`;
  const rememberTasks = (board: Board) => {
    for (const task of board.tasks) if (taskVisible(board, task, getActor().name)) knownTasks.add(taskKey(board, task.id));
  };
  const eventVisible = (board: Board, event: BoardEvent): boolean => {
    const id = event.taskId ?? (board.deletedCards?.some((card) => card.kind === 'task' && card.id === event.itemId) ? event.itemId : undefined);
    if (!id) return true;
    const task = board.tasks.find((item) => item.id === id);
    if (!task) return knownTasks.has(taskKey(board, id));
    const visible = taskVisible(board, task, getActor().name);
    if (visible) knownTasks.add(taskKey(board, task.id));
    return visible;
  };
  const visibleEvents = (board: Board, since: number) => {
    try {
      return store.eventsSince(board.id, since, getActor()).filter((event) => eventVisible(board, event));
    } catch (error) {
      if (error instanceof BoardError && error.code === 'not_found') return [];
      throw error;
    }
  };

  // A board's updates after a cursor, from events read up to one past a page:
  // the page, then what still waits on the agent. A wait (`waited`, its
  // seconds) adds that nothing came, and the ready work to hand out before
  // waiting again. What the session was told in full isn't told again (core/answering.ts).
  function updates(board: Board, since: number, waited?: number): string {
    const { events, cursor, more } = updatesPage(visibleEvents(board, since), board.seq);
    if (more) pageEnd.set(boardKey(board), cursor);
    const viewer = getActor().name;
    const view = agentBoard(board, viewer);
    const kind = agent();
    told.begin();
    const digest = eventsDigest(events, cursor, { board: view, viewer, shown: told, kind }, more);
    const pending = [
      ...(options.pairing?.lines(boardKey(board), viewer) ?? []),
      syncDigest(view),
      requestsDigest(view, viewer, kind),
      threadsDigest(view, viewer, told, kind),
      mentionsDigest(view, viewer, told, kind),
      firstLooksDigest(view, viewer, store.now()),
      refreshDigest(view),
      commitsDigest(view, viewer),
      partAsks(view, viewer),
      waited === undefined ? undefined : readyWork(view, viewer),
    ].filter(Boolean);
    const quiet = waited !== undefined && events.length === 0 ? `\nNothing yet after ${waited}s; call again to keep waiting.` : '';
    seeBoardComments(store, board, getActor(), events); // 👀 on what people wrote that reached it
    return `${digest}${quiet}${pending.map((line) => `\n${line}`).join('')}`;
  }

  // Waits until someone else acts on a board after the cursor, or `asked`
  // seconds pass (at most longestWait), sending progress while it lasts: for
  // wait_for_updates, and for a reply with then_wait. It ends at once when
  // the agent cancels the call or hangs up (handle gives it that signal).
  async function listen(board: Board, since: number, asked: number | undefined, extra: Extra): Promise<string> {
    const most = longestWait(connection.clientName());
    const seconds = Math.min(asked ?? most, most);
    // It listens now: what it last did on the board is behind it (steps.ts).
    options.steps?.listening(boardKey(board), getActor().name);
    const progressToken = extra._meta?.progressToken;
    let elapsed = 0;
    const heartbeat =
      progressToken === undefined
        ? undefined
        : setInterval(() => {
            elapsed += PROGRESS_EVERY_MS / 1000;
            const params = { progressToken, progress: elapsed, total: seconds, message: 'Waiting for someone to act on the board' };
            extra.sendNotification({ method: 'notifications/progress', params }).catch(() => {});
          }, PROGRESS_EVERY_MS);
    try {
      await store.waitForEvents(board.id, since, { timeoutMs: seconds * 1000, signal: extra.signal, exclude: getActor(), limit: UPDATES_PAGE + 1, accept: (event) => eventVisible(board, event) });
      store.lapseFirstLooks(board); // one may have run out while it waited
      return updates(board, since, seconds);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function handle(tool: Tool, args: Record<string, unknown>, called: Extra): Promise<CallToolResult> {
    // A call whose connection closes before its answer is over, as one the agent cancels is.
    const hungUp = connection.hangups?.signal(called.requestId);
    const extra: Extra = hungUp ? { ...called, signal: AbortSignal.any([called.signal, hungUp]) } : called;
    // A call that changes the board: once it lands, its step is over (steps.ts).
    const writes = !tool.readOnly;
    const board = boardOf(store, args);
    const key = board && boardKey(board);
    // A reply with then_wait listens once it's posted, and the agent shows as listening all along.
    const thenWait = typeof args.then_wait === 'number' ? args.then_wait : undefined;
    const waits = tool.listens === true || thenWait !== undefined;
    const agent = getActor().name;
    if (hiddenBacklogTarget(store, args, agent)) return { content: [{ type: 'text', text: 'This backlog card is not addressed to you. A person must assign you, or someone must @-mention you, before you read or change it.' }], isError: true };
    options.presence?.connect(agent);
    if (key) {
      rememberTasks(board);
      // First looks that ran out of time open again before anything reads the board.
      store.lapseFirstLooks(board);
      if (!caughtUp.has(key)) caughtUp.set(key, board.seq);
      const focus = tool.listens ? undefined : focusOf(store, args);
      if (waits) options.presence?.startWaiting(key, agent);
      if (!tool.listens) options.presence?.seen(key, agent, tool.takesFirstLook ? undefined : focus);
      if (focus?.kind === 'task') store.keepFirstLook(focus.id, getActor());
    }
    try {
      const result = await tool.handler(args, extra);
      if (board) rememberTasks(board);
      if (writes && !result.isError) {
        // What it wrote is on the board: the step its hook sent for this
        // call ("Writing a comment") is over, as no end comes for it.
        const step = stepOfCall(tool.name, args);
        if (step) options.steps?.wrote(key, agent, step);
      }
      if (!key || result.isError) return result;
      // Only the agent that gets a first look shows on its card: one refused isn't looking.
      if (tool.takesFirstLook) options.presence?.seen(key, agent, focusOf(store, args));
      if (thenWait !== undefined) {
        // From where this session last caught up: what came while it wrote comes at once.
        const heard = await listen(board, caughtUp.get(key)!, thenWait, extra);
        caughtUp.set(key, pageEnd.get(key) ?? board.seq);
        pageEnd.delete(key);
        return { ...result, content: [...result.content, { type: 'text' as const, text: heard }] };
      }
      if (tool.catchesUp) {
        caughtUp.set(key, pageEnd.get(key) ?? board.seq);
        pageEnd.delete(key);
        return result;
      }
      const since = caughtUp.get(key)!;
      const unreadEvents = visibleEvents(board, since);
      const unread = unreadEvents.length;
      if (unread === 0) {
        caughtUp.set(key, board.seq);
        return result;
      }
      const latest = unreadEvents.at(-1)!;
      const notice = `Unread on this board: ${unread} update${unread === 1 ? '' : 's'} from others since you last checked (latest: ${latest.actor.name} ${clip(latest.summary, 100)}). Call get_updates with since: ${since}.`;
      return { ...result, content: [...result.content, { type: 'text' as const, text: notice }] };
    } finally {
      if (key && waits) options.presence?.stopWaiting(key, agent);
    }
  }

  return { told, skillsReported: false, updates, agent, listen, handle };
}
