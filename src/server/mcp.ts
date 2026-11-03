import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod';
import {
  askAdvice,
  decisionAdvice,
  duplicateAdvice,
  emptyCanvasAdvice,
  findingAdvice,
  peopleTextAdvice,
  withAdvice,
} from '../core/advice';
import { decisionDiscussion, Shown, taskDiscussion } from '../core/answering';
import { blockLabel, blockName, syncedBlocks } from '../core/canvas';
import { agentKind, contentFields, fieldsByType, guideSentences, moreSentences } from '../core/blocks/agent';
import { kindOf, kinds } from '../core/blocks/registry';
import { connectorAsks, connectorPinning } from '../core/connectors';
import { deletedLately } from '../core/deletions';
import { canvasName, pinPart, pinTarget } from '../core/pins';
import { requestsDigest } from '../core/requests';
import { threadAsRead, threadDetail, threadsDigest, workName } from '../core/threads';
import { FIRST_LOOK_MS, firstLooksDigest } from '../core/firstLook';
import { boardAgents, mentionsDigest } from '../core/mentions';
import { SKILLS_NUDGE } from '../core/skills';
import { taskBrief } from '../core/brief';
import { searchDigest, searchStore } from '../core/search';
import { IN_THREAD, MAX_INLINE_IMAGES, ONE_CANVAS, describeIssues, namesOneCanvas, tools, type BlockArgs, type PinArgs } from '../core/schemas';
import { clip, listNames, peopleOn } from '../core/format';
import {
  blockContentDigest,
  boardDigest,
  boardListDigest,
  canvasDigest,
  commitsDigest,
  decisionDetail,
  eventsDigest,
  pinLines,
  readyWork,
  refreshDigest,
  syncDigest,
  taskDetail,
} from '../core/digest';
import {
  BoardError,
  checkImage,
  inBlock,
  type CanvasRef,
  type PinPart,
  type ReactionPlace,
  type Store,
} from '../core/store';
import { boardKey, type Actor, type Block, type Board, type BoardEvent, type Thread } from '../core/types';
import { describe as hookStep } from '../../hooks/tricot-describe.mjs';
import type { ConnectorTool } from './connectors/connector';
import type { AgentFocus, Presence } from './presence';
import type { Steps } from './steps';

// What every agent is told when it connects. Clients show only the first
// 4,096 characters or so, so this stays under MAX_INSTRUCTIONS: the role first,
// then the essentials. How to use each tool well is in its description.
export const MAX_INSTRUCTIONS = 3800;
export const INSTRUCTIONS = `Your role: chief of staff
Your main session stays on the board: it listens, answers people, reviews, merges and keeps the whole picture. It hands the work out and never gets stuck doing it.
- When you connect, and each time before you wait, check what's ready: get_board and wait_for_updates name it.
- Hand each ready task to a background subagent: claim_task, then give it the brief from brief_task. Don't build it in the main session.
- Keep subagents off each other's files: a worktree or branch each.
- When idle, listen: call wait_for_updates, and again each time it returns.
- Answer people, and review what each subagent brings back. Merge it, then send it for review with something to look at.
- When a person sends a task back, hand it out again: its brief carries their note.
- Commit only when a person asks.
- Can't run subagents? Do the tasks yourself, one at a time, checking the board between them.

How the board works
- Tricot is a shared planning board: people see cards on a live board, you see them through these tools. Use it instead of asking questions in chat or presenting a long plan for approval.
- Find the board: list_boards, then get_board. If none fits, create_board. If it's ambiguous, ask which.
- Before you post a decision or plan a task, search for an existing one, so you don't re-ask what's decided.
- Each open question is one decision card (post_decision): one question, 2–4 concrete options, your recommendation and why, brief context, and a short area (theme), reusing the board's areas. Set blocking only when no work can go on without the answer; otherwise keep working while it's open.
- Show, don't describe: post the visuals with the card (blocks on post_decision): options side by side, screenshots, tables, diagrams, each pinned to its option.
- When decisions settle, plan the work with plan_tasks, linking each task to the decisions it implements.
- Respect statuses. decided = binding. provisional = proceed, but keep it cheap to change. deferred = don't build on it, use a reversible default. retired = set aside. exploring = gather evidence and report it with attach_finding.
- What people decided, deferred or retired is theirs, as is an area, assignee, option or block they set: comment and add evidence, but don't change it. Log your own judgement calls with log_decision, for people to confirm or overturn.
- People point work at one agent with an @-mention or a task's assignee. Act only on what's addressed to you or nobody: your updates say "asked you" or "for" another agent. @-mention to tell a person; ask_people to ask, which waits for an answer.
- When a new backlog card needs a first look (get_board names it), take it with take_first_look and comment with feasibility and approach. Don't claim or build a backlog card until a person marks it ready.
- People talk with you in threads, each with a lens (Legal, Design) and often a tab's aim: answer through both (get_thread, reply_in_thread), passing its thread_id to what you make.
- Stay reachable: you can't be notified, so check get_updates between steps; people see whether you're listening.

How to talk to people
- People read about 20x slower than you write. Write as a thoughtful colleague would: full sentences with a subject, short but never clipped. Say what it means for them first, then what you did.
- If you need something, ask in one plain line ("Sam, which option do you prefer?").
- Skip "Done:" and "Built:" openers, stacked fragments, noun-phrase bullet lists, headers in a comment, "Great point!", and restating what they said.
- Keep ids, hashes, test counts and jargon out unless asked ("the tests pass"). Write #N for a decision and TN for a task; the board links them.
- Have a writing skill such as avoid-ai-writing? Run it on long messages before posting.`;

// MCP clients abort calls that stay silent too long (Claude Code: 300s), so a
// wait is capped below that and sends progress while it lasts.
const MAX_WAIT_SECONDS = 240;
const PROGRESS_EVERY_MS = 30_000;

function canvasRef(args: { board_id?: string; decision_id?: string; task_id?: string }): CanvasRef {
  const ref = { boardId: args.board_id, decisionId: args.decision_id, taskId: args.task_id };
  if (!namesOneCanvas(ref)) throw new BoardError(ONE_CANVAS);
  return ref;
}

function imageContent(store: Store, assetId: string) {
  const { file, mimeType } = store.assetFile(assetId);
  return { type: 'image' as const, data: readFileSync(file).toString('base64'), mimeType };
}

// The part of a block a pin call names, checked against the block. Each kind
// reads the fields that name its parts (its own block's first): table rows and
// columns become 0-based ranges, an item's text becomes its id. Words, or
// nothing, pin words and the whole block.
function pinPartFrom(block: Block, args: PinArgs): PinPart {
  const own = kindOf(block.type);
  for (const kind of [own, ...kinds().filter((k) => k !== own)]) {
    const part = kind.agent.pinPart?.(block, args);
    if (part) return part;
  }
  if (args.text !== undefined) return { kind: 'text', quote: args.text, occurrence: args.occurrence };
  return { kind: 'block' };
}

// How many updates one get_updates or wait_for_updates call returns. A longer
// catch-up comes in pages: each says where it ended (its Cursor) and, when
// there is more, to call again with that.
const UPDATES_PAGE = 100;

// A page from events read up to one past it (to know whether there is more),
// with the cursor to give the agent: the last event's seq when a page is cut
// short, otherwise the board's, which also passes by the agent's own events.
function updatesPage(read: BoardEvent[], boardSeq: number): { events: BoardEvent[]; cursor: number; more: boolean } {
  const more = read.length > UPDATES_PAGE;
  const events = more ? read.slice(0, UPDATES_PAGE) : read;
  return { events, cursor: more ? events.at(-1)!.seq : boardSeq, more };
}

// A block's versions for get_block, one line each, newest first.
function versionLines(store: Store, block: Block): string {
  const lines = store.versionSummaries(block.id).map(
    (v) => `- v${v.rev}${v.rev === block.rev ? ' (current)' : ''} · ${v.at} · ${v.by.name} (${v.by.kind})${v.change ? ` · ${v.change}` : ''}`,
  );
  return `Versions, newest first (restore one with update_block, restore_rev):\n${lines.join('\n')}`;
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

// The step a hook in the agent's harness sends for a Tricot call, in its words
// and naming the card or thread the call does (hooks/tricot-describe.mjs):
// "Writing a comment" on the task it names. None for a call it keeps quiet.
const stepOfCall = (name: string, args: Record<string, unknown>) =>
  hookStep({ hook_event_name: 'PreToolUse', tool_name: `mcp__tricot__${name}`, tool_input: args });

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
}

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

// Where work made answering a thread shows: under the agent's reply, or its
// latest message there when it has replied already.
function inThread(thread: Thread): string {
  return `thread "${clip(thread.title, 60)}", under your reply`;
}

// How updates bring people's messages (core/answering.ts), and how an agent
// answers one and keeps listening, for the tools' descriptions.
const WHOLE =
  "A person's comment or message for you comes whole, with the card's title and status, the messages before it you haven't seen, and the call that answers it; one you've been given already is named, not repeated.";
const THEN_WAIT =
  'Answering while you listen? Pass then_wait (seconds, as for wait_for_updates): it posts first, then waits and brings back what happens next in the same result, and people see you listening throughout.';

// Tools whose result already brings the agent up to date on a board.
const CATCH_UP = new Set(['get_board', 'get_updates', 'wait_for_updates']);

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Handler = (args: Record<string, unknown>, extra: Extra) => Promise<CallToolResult>;

// A call the schemas refuse is answered in the words REST uses for the same
// input (core/schemas/issues.ts), not the SDK's: the SDK checks a tool's
// arguments before the handler runs, so this is where its message is set.
// The SDK still returns it as a tool error the agent reads and fixes.
function refuseInOurWords(server: McpServer): void {
  const sdk = server as unknown as { validateToolInput(tool: { inputSchema?: ZodType }, args: unknown, name: string): Promise<unknown> };
  const validate = sdk.validateToolInput.bind(server);
  sdk.validateToolInput = async (tool, args, name) => {
    const checked = tool.inputSchema?.safeParse(args ?? {});
    if (checked && !checked.success) throw new Error(describeIssues(checked.error));
    return validate(tool, args, name);
  };
}

export function createMcpServer(store: Store, getActor: () => Actor, options: McpOptions): McpServer {
  const server = new McpServer(
    { name: 'tricot', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );
  refuseInOurWords(server);
  // Connected as soon as its session starts, before it touches any board, so
  // Home can say so on a first run (presence.ts). Each call says so again.
  server.server.oninitialized = () => options.presence?.connect(getActor().name);

  // MCP can't push to an agent, so every call is a chance to tell it what it
  // hasn't seen: other people's activity since it last caught up on a board.
  // The same calls tell people which agents are here, and what they're doing.
  // Both are keyed by boardKey, so they follow a board when people rename it.
  const caughtUp = new Map<string, number>(); // board key -> last seq this session has been shown
  // Where a page of updates ended when there was more after it, by board key: that, not the board's last event, is how far the agent is caught up.
  const pageEnd = new Map<string, number>();
  // Whether this session has told Tricot its skills: until it has, get_board and wait_for_updates ask.
  let skillsReported = false;
  // What this session has been shown of what people and agents said, so a
  // message reaches it whole once and its context only as far as it hasn't
  // read it (core/answering.ts). A new session is told it all once.
  const told = new Shown();
  const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: Handler) => unknown;
  const tool = ((name: string, config: unknown, handler: Handler) => {
    // A call that changes the board: once it lands, its step is over (steps.ts).
    const writes = (config as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint !== true;
    return register(name, config, async (args, extra) => {
      const board = boardOf(store, args);
      const key = board && boardKey(board);
      // A reply with then_wait listens once it's posted, and the agent shows as listening all along.
      const thenWait = typeof args.then_wait === 'number' ? Math.min(args.then_wait, MAX_WAIT_SECONDS) : undefined;
      const waits = name === 'wait_for_updates' || thenWait !== undefined;
      const agent = getActor().name;
      options.presence?.connect(agent);
      if (key) {
        // First looks that ran out of time open again before anything reads the board.
        store.lapseFirstLooks(board);
        if (!caughtUp.has(key)) caughtUp.set(key, board.seq);
        const focus = name === 'wait_for_updates' ? undefined : focusOf(store, args);
        if (waits) options.presence?.startWaiting(key, agent);
        if (name !== 'wait_for_updates') options.presence?.seen(key, agent, name === 'take_first_look' ? undefined : focus);
        if (focus?.kind === 'task') store.keepFirstLook(focus.id, getActor());
      }
      try {
        const result = await handler(args, extra);
        if (writes && !result.isError) {
          // What it wrote is on the board: the step its hook sent for this
          // call ("Writing a comment") is over, as no end comes for it.
          const step = stepOfCall(name, args);
          if (step) options.steps?.wrote(key, agent, step);
        }
        if (!key || result.isError) return result;
        // Only the agent that gets a first look shows on its card: one refused isn't looking.
        if (name === 'take_first_look') options.presence?.seen(key, agent, focusOf(store, args));
        if (thenWait !== undefined) {
          // From where this session last caught up: what came while it wrote comes at once.
          const heard = await listen(board, caughtUp.get(key)!, thenWait, extra);
          caughtUp.set(key, pageEnd.get(key) ?? board.seq);
          pageEnd.delete(key);
          return { ...result, content: [...result.content, { type: 'text' as const, text: heard }] };
        }
        if (CATCH_UP.has(name)) {
          caughtUp.set(key, pageEnd.get(key) ?? board.seq);
          pageEnd.delete(key);
          return result;
        }
        const since = caughtUp.get(key)!;
        const unread = store.countEvents(key, { since, exclude: getActor() });
        if (unread === 0) return result;
        const [latest] = store.events(key, { since, exclude: getActor(), order: 'desc', limit: 1 });
        const notice = `Unread on this board: ${unread} update${unread === 1 ? '' : 's'} from others since you last checked (latest: ${latest.actor.name} ${clip(latest.summary, 100)}). Call get_updates with since: ${since}.`;
        return { ...result, content: [...result.content, { type: 'text' as const, text: notice }] };
      } finally {
        if (key && waits) options.presence?.stopWaiting(key, agent);
      }
    });
  }) as unknown as typeof server.registerTool;

  // A board's updates after a cursor, from events read up to one past a page:
  // the page, then what still waits on the agent. A wait (`waited`, its
  // seconds) adds that nothing came, and the ready work to hand out before
  // waiting again. What the session was told in full isn't told again (core/answering.ts).
  function updates(board: Board, read: BoardEvent[], waited?: number): string {
    const { events, cursor, more } = updatesPage(read, board.seq);
    if (more) pageEnd.set(boardKey(board), cursor);
    const viewer = getActor().name;
    told.begin();
    const digest = eventsDigest(events, cursor, { board, viewer, shown: told }, more);
    const pending = [
      syncDigest(board),
      requestsDigest(board, viewer),
      threadsDigest(board, viewer, told),
      mentionsDigest(board, viewer, told),
      firstLooksDigest(board, viewer, store.now()),
      refreshDigest(board),
      commitsDigest(board, viewer),
      connectorAsks(board, viewer),
      waited === undefined ? undefined : readyWork(board, viewer),
    ].filter(Boolean);
    const quiet = waited !== undefined && events.length === 0 ? `\nNothing yet after ${waited}s; call again to keep waiting.` : '';
    store.seeComments(board.id, getActor(), events); // 👀 on what people wrote that reached it
    return `${digest}${quiet}${pending.map((line) => `\n${line}`).join('')}`;
  }

  // Waits until someone else acts on a board after the cursor, or `seconds`
  // pass, sending progress while it lasts: for wait_for_updates, and for a
  // reply with then_wait.
  async function listen(board: Board, since: number, seconds: number, extra: Extra): Promise<string> {
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
      const read = await store.waitForEvents(board.id, since, { timeoutMs: seconds * 1000, signal: extra.signal, exclude: getActor(), limit: UPDATES_PAGE + 1 });
      store.lapseFirstLooks(board); // one may have run out while it waited
      return updates(board, read, seconds);
    } finally {
      clearInterval(heartbeat);
    }
  }

  tool(
    'list_boards',
    {
      title: 'List boards',
      description:
        "List planning boards with their goals and how many decisions are open. Read the one that fits the work with get_board. If none fits, create_board with the objective; if it's ambiguous which, ask the person.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const boards = boardListDigest(store.listBoards());
      return text(options.connectors ? `${boards}\n\n${options.connectors.line()}` : boards);
    },
  );

  tool(
    'create_board',
    {
      title: 'Create board',
      description: 'Create a planning board for a piece of work. The goal is the objective the decisions serve.',
      inputSchema: tools.create_board,
    },
    async ({ title, goal }) => {
      const board = store.createBoard({ title, goal }, getActor());
      return text(boardDigest(board));
    },
  );

  tool(
    'get_board',
    {
      title: 'Get board',
      description:
        "Read a board: the tasks ready for you first, then every decision grouped by status with chosen options and rationales, the tasks by lane (to do top first: people order it by priority), what people asked of agents, the board's threads, the People and Areas lines, and the cursor for get_updates. Read it when you connect and before you wait, and hand out what's ready (brief_task).",
      inputSchema: tools.get_board,
      annotations: { readOnlyHint: true },
    },
    async ({ board_id }) => {
      const board = store.getBoard(board_id);
      const renamed = board.id === board_id ? '' : `\n\nThis board was renamed: its id is now ${board.id}. The old one still works.`;
      const nudge = skillsReported ? '' : `\n\n${SKILLS_NUDGE}`;
      told.begin();
      const digest = boardDigest(board, getActor().name, store.now(), told);
      store.seeComments(board.id, getActor()); // 👀 on what people asked of it, which the digest quotes
      return text(`${digest}${renamed}${nudge}`);
    },
  );

  tool(
    'get_decision',
    {
      title: 'Get decision',
      description:
        "Read one decision in full: context, options, recommendation, resolution, findings and comments, and the other decisions it could affect, to weigh when you recommend. Re-read it, and its canvas (get_canvas with decision_id), before you act on the decision: people may have changed it.",
      inputSchema: tools.get_decision,
      annotations: { readOnlyHint: true },
    },
    async ({ decision_id }) => {
      const { board, decision } = store.getDecision(decision_id);
      told.readAll(decisionDiscussion(decision));
      return text(decisionDetail(board, decision, undefined, getActor().name));
    },
  );

  tool(
    'search',
    {
      title: 'Search',
      description:
        'Search a board for past and current work: decisions (question, context, options, answer, rationale), tasks (title, detail, notes), comments, findings and canvas blocks. Search before you post a decision or plan a task, so you don\'t ask again what\'s already decided. Every word must appear; case and accents are ignored. Closed cards (decided, retired, done, dropped) are included unless include_closed is false. Each result names its ids: read it with get_decision, get_task or get_block.',
      inputSchema: tools.search,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      if (!args.board_id && !args.all_boards) throw new BoardError('Pass board_id, or all_boards: true to search every board.');
      const options = {
        boardId: args.board_id,
        allBoards: args.all_boards,
        kinds: args.kinds,
        openOnly: args.include_closed === false,
        limit: args.limit ?? 20,
      };
      const found = searchStore(store, args.query, options);
      const boardTitle = args.board_id ? store.getBoard(args.board_id).title : undefined;
      return text(searchDigest(found, args.query, { ...options, boardTitle }));
    },
  );

  tool(
    'post_decision',
    {
      title: 'Post decision',
      description:
        [
          'Ask people a question as a decision card: one question, 2–4 concrete options, your recommendation and why, and brief context (detail only when it changes the decision; refer to cards as #N and TN, which the board links). Search first, so you don\'t ask again what\'s already decided.',
          'Options are lettered a, b, c… in the order given. Give it an area (theme) so it joins the right row on the decision map. Set blocking only when you can\'t continue any work without the answer; keep working on whatever it doesn\'t block.',
          'Show, don\'t describe: pass blocks to put what people need to see on its canvas in the same call (options side by side, screenshots, tables, diagrams), the fields of add_block, each optionally pinned to an option letter and named group. Lead with the single visual that most changes the decision.',
          'Route it to the person who has the context with ask (names from the People line of get_board): their next comment or answer clears the wait. When the choice hinges on trade-offs, pass criteria (see propose_criteria). Returns the decision id.',
          'Name past decisions it could change or rests on with affects, each with why: people see them beside it.',
          IN_THREAD,
        ].join(' '),
      inputSchema: tools.post_decision,
    },
    async (args) => {
      const thread = args.thread_id ? store.threadOn(args.thread_id, store.getBoard(args.board_id)) : undefined;
      const blocks = args.blocks ?? [];
      // Every block is read and checked before any image is saved.
      const contents = blocks.map((block, i) => inBlock(i, () => readContent(block)));
      const decision = store.postDecision(
        args.board_id,
        {
          question: args.question,
          context: args.context,
          options: args.options,
          recommend: args.recommend,
          recommendationReason: args.recommendation_reason,
          blocking: args.blocking,
          dependsOn: args.depends_on,
          affects: args.affects?.map((a) => ({ decisionId: a.decision_id, why: a.why })),
          area: args.area,
          ask: args.ask,
          askNote: args.ask_note,
          criteria: args.criteria,
          blocks: blocks.map((block, i) => ({
            content: contents[i](),
            title: block.title,
            optionId: block.option,
            group: block.group,
            w: block.width,
            h: block.height,
          })),
        },
        getActor(),
      );
      if (thread) store.addThreadWork(thread.id, { kind: 'decision', id: decision.id }, getActor());
      const people = peopleOn(store.getBoard(args.board_id)).map((p) => p.name);
      const onCanvas = blocks.length ? ` with ${blocks.length} block${blocks.length === 1 ? '' : 's'} on its canvas` : '';
      const shown = thread ? ` It shows in ${inThread(thread)}.` : '';
      const posted = `Posted #${decision.number} [id: ${decision.id}] (status: open)${onCanvas}.${shown} Keep working on anything it doesn't block.`;
      const advice = [
        ...decisionAdvice({ context: args.context, options: args.options, recommend: args.recommend }),
        ...(args.ask?.length ? askAdvice(args.ask, people) : []),
        ...(blocks.length ? [] : emptyCanvasAdvice()),
      ];
      return text(withAdvice(posted, advice));
    },
  );

  tool(
    'update_decision',
    {
      title: 'Update decision',
      description:
        [
          'Refine a decision card: reword it, add context or options, revise options (reword one, or mark it outdated with a reason when it no longer applies; nothing is deleted, and outdated options can\'t be picked), change the recommendation, blocking flag, dependencies, area, or the decisions it could affect (affects).',
          'An area can be set on any card, settled ones included, unless a person set it: then it is theirs. Once a person has decided, deferred or retired a question, it is theirs too: comment, attach findings and add canvas blocks, but don\'t reword or answer it.',
          'Options go stale as the app changes. When a person asks for a refresh of a decision (get_board, get_decision and your updates show it), do it next: re-check the card against the app as it is now, then reword the question or context, update or add options, and mark options that no longer apply as outdated with a reason (revise_options), passing refreshed: true with a one-line note, in the same call or on its own.',
          'An option a person proposed or reworded is theirs: leave it and mention it in your note. A card that says it may be out of date can be refreshed the same way unasked. Only people retire a card: if one looks no longer relevant, say so in a comment.',
          'A refresh asked of a decided or provisional card (often because a decision that may change it was just answered) checks its answer still holds: pass refreshed: true with a note saying whether it does, and nothing else. It stays as it is; if it no longer holds, say so in a comment so a person can reopen it.',
          'When a person changes what a decision offers (rewords, outdates or adds options), re-check your recommendation on it.',
        ].join(' '),
      inputSchema: tools.update_decision,
    },
    async (args) => {
      const decision = store.updateDecision(
        args.decision_id,
        {
          question: args.question,
          context: args.context,
          addOptions: args.add_options,
          reviseOptions: args.revise_options?.map((change) => ({
            id: change.option,
            label: change.label,
            description: change.description,
            outdated: change.restore ? false : change.outdated !== undefined ? true : undefined,
            reason: change.outdated,
          })),
          recommend: args.recommend,
          recommendationReason: args.recommendation_reason,
          blocking: args.blocking,
          dependsOn: args.depends_on,
          affects: args.affects?.map((a) => ({ decisionId: a.decision_id, why: a.why })),
          area: args.area,
          refreshed: args.refreshed,
          note: args.note,
        },
        getActor(),
      );
      const { board } = store.getDecision(decision.id);
      const reshaped = args.context !== undefined || args.add_options !== undefined || args.revise_options !== undefined;
      const advice = reshaped
        ? decisionAdvice({
            context: decision.context,
            options: decision.options.filter((o) => !o.outdated),
            recommend: decision.recommendation?.optionId,
          })
        : [];
      const settled = decision.status === 'decided' || decision.status === 'provisional';
      const refreshed = !args.refreshed
        ? ''
        : settled
          ? `Re-checked #${decision.number}, which stays ${decision.status}; people see your note.\n\n`
          : `Refreshed #${decision.number}; people see: ${decision.refreshed!.changes.join(', ') || 'no changes'}.\n\n`;
      return text(withAdvice(`${refreshed}${decisionDetail(board, decision)}`, advice));
    },
  );

  tool(
    'log_decision',
    {
      title: 'Log decision',
      description:
        'Record a judgement call you made on your own mid-task, so people can confirm or overturn it. It lands as provisional. Either pass decision_id to answer an existing card (choice may be an option letter), or board_id + question (and an area) to log a new one.',
      inputSchema: tools.log_decision,
    },
    async (args) => {
      const actor = getActor();
      let decisionId = args.decision_id;
      let optionId: string | undefined;
      let answer: string | undefined;

      if (decisionId) {
        if (args.area !== undefined) throw new BoardError("area is for a new card. Set an existing card's area with update_decision.");
        const { decision } = store.getDecision(decisionId);
        if (decision.options.some((o) => o.id === args.choice.trim())) optionId = args.choice.trim();
        else answer = args.choice;
      } else {
        if (!args.board_id || !args.question) {
          throw new BoardError('Pass decision_id, or board_id and question.');
        }
        const options = [args.choice, ...(args.alternatives ?? [])].map((label) => ({ label }));
        decisionId = store.postDecision(args.board_id, { question: args.question, options, area: args.area }, actor).id;
        optionId = 'a';
      }

      const decision = store.resolve(decisionId, { optionId, answer, rationale: args.rationale, provisional: true }, actor);
      return text(`Logged #${decision.number} [id: ${decision.id}] as provisional. People can confirm it or reopen it.`);
    },
  );

  tool(
    'plan_tasks',
    {
      title: 'Plan tasks',
      description:
        [
          'When decisions settle (decided or provisional), break the work into tasks, each linked to the decisions it implements. People see them on the Tasks tab, and the tasks go stale if one of those decisions changes.',
          'A task can also stand alone (a bug, a chore), but link it whenever it implements a decision: only linked tasks are flagged stale when a decision changes. Keep each small enough to finish and review on its own.',
          'When a person asks for a task plan on a decision, do that first. Search first, so you don\'t plan a task twice. You can hand a task to an agent with assignee.',
          IN_THREAD,
        ].join(' '),
      inputSchema: tools.plan_tasks,
    },
    async ({ board_id, tasks, thread_id }) => {
      const thread = thread_id ? store.threadOn(thread_id, store.getBoard(board_id)) : undefined;
      const planned = store.planTasks(
        board_id,
        tasks.map((t) => ({ title: t.title, detail: t.detail, decisionIds: t.decision_ids ?? [], assignee: t.assignee })),
        getActor(),
      );
      for (const task of planned) if (thread) store.addThreadWork(thread.id, { kind: 'task', id: task.id }, getActor());
      const line = (t: (typeof planned)[number]) => `T${t.number} [id: ${t.id}] ${t.title}${t.assignee ? ` (assigned to ${t.assignee})` : ''}`;
      const shown = thread ? ` ${planned.length === 1 ? 'It shows' : 'They show'} in ${inThread(thread)}.` : '';
      return text(`Planned ${planned.map(line).join('; ')}.${shown} claim_task before starting one, then hand it to a subagent with the brief from brief_task.`);
    },
  );

  tool(
    'get_task',
    {
      title: 'Get task',
      description:
        "Read one task in full: status, the decisions it implements, detail, links, progress notes, its discussion, and what is on its canvas. Check it between steps for new comments, and reply with comment(task_id). When a person sends a task back, their note says what to fix. To hand the task to a subagent, brief_task gives all of this as one brief.",
      inputSchema: tools.get_task,
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const { board, task } = store.getTask(task_id);
      told.readAll(taskDiscussion(task));
      return text(taskDetail(board, task, getActor().name, store.now()));
    },
  );

  tool(
    'brief_task',
    {
      title: 'Brief a subagent on a task',
      description: [
        'A complete, ready-to-paste brief for a subagent to build one task: the task and what done looks like, the decisions it implements (question, chosen option, rationale, people\'s comments), its discussion and people\'s latest notes, what\'s on its canvas, pins pointing at it, the board\'s people and agents, and how to work (own worktree, no commits, run the tests, bring back a patch, screenshots and a report).',
        'As chief of staff, claim_task, then hand this brief to a background subagent and stay on the board. When the work comes back, review and merge it, then send it for review. Read-only: it changes nothing, and works for a task in any status.',
      ].join(' '),
      inputSchema: tools.brief_task,
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const { board, task } = store.getTask(task_id);
      return text(taskBrief(board, task, boardAgents(board, store.presentAgents(boardKey(board)))));
    },
  );

  tool(
    'claim_task',
    {
      title: 'Claim task',
      description:
        [
          'Take a task before working on it, so nobody else starts it. Claim ready tasks from the top of to do: people order it, and the order is their priority (get_board lists it top first). Claim the ones assigned to you first, then unassigned ones.',
          'Refused if it is in the backlog (people are still shaping it: comment and add to its canvas, but claim it only once a person marks it ready), stale, claimed by another agent, or assigned to another agent.',
          'As chief of staff, claim it, then hand it to a background subagent with the brief from brief_task. Report with update_task.',
        ].join(' '),
      inputSchema: tools.claim_task,
    },
    async ({ task_id }) => {
      const task = store.claimTask(task_id, getActor());
      return text(`Claimed T${task.number}; it is in progress. Hand it to a subagent with the brief from brief_task, and report with update_task.`);
    },
  );

  tool(
    'take_first_look',
    {
      title: 'Take first look',
      description:
        "Take the first look at a card a person added to the backlog (get_board and your updates name the ones that need one), so no other agent does it too. Only one agent gets it: the others are refused, as is everyone but the agent a card is assigned to or @-mentions. Then comment on the card (comment with task_id) with feasibility and approach, adding a mock to its canvas for UI work: that comment gives the first look. Don't claim or build the card until a person marks it ready; it's in the backlog. If you're refused, leave it.",
      inputSchema: tools.take_first_look,
    },
    async ({ task_id }) => {
      const task = store.takeFirstLook(task_id, getActor());
      const minutes = FIRST_LOOK_MS / 60_000;
      return text(
        `You're taking the first look at T${task.number} "${clip(task.title, 80)}". Read it (get_task), then comment on it (comment with task_id: ${task.id}) with feasibility and approach, and for UI work add a mock to its canvas first (add_block with task_id: ${task.id}). Your comment gives the first look; if none comes within ${minutes} minutes of your last call about the card, it goes back to open for another agent. Don't claim or build it until a person marks it ready.`,
      );
    },
  );

  tool(
    'update_task',
    {
      title: 'Update task',
      description:
        [
          'Report progress on a task: status (in_review with the PR or branch as link, once its canvas shows the work; blocked with what\'s in the way as note, and post_decision if a person has to resolve it; done once verified; todo to release it), a note, or a link. Refer to cards as #N and TN in notes: the board links them.',
          'Before in_review, put what shows the work on the task\'s canvas (add_block with task_id): screenshots of the result, a task list of what\'s done, and for code work a diff block. in_review is refused while the canvas is empty.',
          'Commits are part of the review. Don\'t post a "Commit …?" card for a task\'s own work: people approve its commit with "Looks good, commit it", and your updates and get_task say so. Then commit that task\'s work alone, from your main session, and pass the hash as commit; it is refused when no commit was approved. "Looks good" alone approves without a commit. When the work isn\'t in the repository (a plan, a spike, a cut-over), send it for review with nothing_to_commit: why, and people are offered only "Looks good"; the same answers a commit someone already approved. Only work that spans several tasks, or isn\'t a task, needs a card of its own.',
          'A stale task means a decision it builds on changed: stop work on it and re-read the decision, then pass still_valid: true, or revise its title, detail or decision_ids. It can\'t move forward until you do.',
        ].join(' '),
      inputSchema: tools.update_task,
    },
    async (args) => {
      const task = store.updateTask(
        args.task_id,
        {
          status: args.status,
          note: args.note,
          link: args.link,
          title: args.title,
          detail: args.detail,
          decisionIds: args.decision_ids,
          stillValid: args.still_valid,
          commit: args.commit,
          nothingToCommit: args.nothing_to_commit,
          assignee: args.assignee === undefined ? undefined : args.assignee.trim() || null,
        },
        getActor(),
      );
      const committed = args.commit
        ? `, and its commit ${task.commit!.hash!.slice(0, 7)} is recorded`
        : args.nothing_to_commit
          ? ', and it has nothing to commit'
          : '';
      const updated = `T${task.number} is ${task.status.replace('_', ' ')}${committed}${task.stale ? '. It is still stale' : ''}.`;
      return text(withAdvice(updated, peopleTextAdvice(args.note, 'note')));
    },
  );

  tool(
    'ask_people',
    {
      title: 'Ask people',
      description:
        "Route a decision to named people, e.g. the one who has the context (names from the People line of get_board). It shows as waiting for them, and lands under their Needs you. Their next comment, answer or criteria mark clears the wait; you'll see it in get_updates. This is how to ask a person: an @-mention in a comment only tells them, and clears once they have seen it.",
      inputSchema: tools.ask_people,
    },
    async ({ decision_id, people, note }) => {
      const decision = store.askPeople(decision_id, people, note, getActor());
      const known = peopleOn(store.getDecision(decision.id).board).map((p) => p.name);
      return text(withAdvice(`Asked. #${decision.number} is now waiting for ${people.join(', ')}.`, askAdvice(people, known)));
    },
  );

  tool(
    'propose_criteria',
    {
      title: 'Propose criteria',
      description:
        'When a choice hinges on trade-offs, propose what it should be judged on (or pass criteria on post_decision). People mark each option yes, partly or no against each criterion; you cannot mark them. Read their marks as their reasoning, and don\'t argue with a "no" without new evidence. Good criteria are concrete and checkable ("No silent behaviour change at existing call sites"), not vague ("quality").',
      inputSchema: tools.propose_criteria,
    },
    async ({ decision_id, criteria }) => {
      const decision = store.proposeCriteria(decision_id, criteria, getActor());
      return text(`#${decision.number} now has ${decision.criteria.length} criteria. People will mark the options against them.`);
    },
  );

  tool(
    'attach_finding',
    {
      title: 'Attach finding',
      description:
        'Report evidence on a decision: research results, a prototype outcome, measurements. When people want evidence first (status exploring), investigate (read code, prototype each option, run experiments) and attach each result. Attach to an option when it is about one. Use the same metric names across options so they line up side by side in a comparison.',
      inputSchema: tools.attach_finding,
    },
    async (args) => {
      const decision = store.attachFinding(
        args.decision_id,
        { optionId: args.option, summary: args.summary, metrics: args.metrics, links: args.links },
        getActor(),
      );
      const attached = `Attached finding to #${decision.number} (${decision.findings.length} findings total).`;
      return text(withAdvice(attached, findingAdvice(decision, { optionId: args.option, summary: args.summary, metrics: args.metrics })));
    },
  );

  tool(
    'comment',
    {
      title: 'Comment',
      description:
        [
          "Reply in a decision's or a task's discussion thread (pass decision_id or task_id), e.g. to answer a person's question or report on work they sent back, or in the comment thread on a pinned part (pin_id), such as a line of a diff or code block, or a person's request to edit a Google Doc's paragraph.",
          "A comment people make on a pinned part of a task's or decision's canvas is in that card's discussion, quoting the part: reply there as usual. On the board context it starts a thread on the pin, which get_canvas lists: reply with pin_id, and if it needs a person's call, post a decision and pin it to the same part with pin(pin_id).",
          'To tell a person something on a card, mention them (@Sam): it shows as new for them until they have seen it, and nothing waits on them. To ask, use ask_people, which waits for an answer. Refer to cards as #N for a decision and TN for a task (e.g. "posted as #32", "done in T35"): the board turns them into links.',
          'When you comment on a decision or task answering a thread, pass thread_id: people see the comment in the thread, under your reply.',
          THEN_WAIT,
        ].join(' '),
      inputSchema: tools.comment,
    },
    async ({ decision_id, task_id, pin_id, body, thread_id }) => {
      if ([decision_id, task_id, pin_id].filter(Boolean).length !== 1) {
        throw new BoardError('Pass decision_id, task_id or pin_id (exactly one).');
      }
      if (thread_id && pin_id) throw new BoardError('Pass thread_id with decision_id or task_id: a comment on a pin stays on its pin.');
      const card = task_id ? store.getTask(task_id).board : decision_id ? store.getDecision(decision_id).board : undefined;
      const thread = thread_id && card ? store.threadOn(thread_id, card) : undefined;
      const shown = thread ? ` It shows in ${inThread(thread)}.` : '';
      const advise = (reply: string) => withAdvice(reply, peopleTextAdvice(body, 'comment'));
      if (pin_id) {
        const { pin, comment } = store.commentOnPin(pin_id, body, getActor());
        told.read(comment.id); // it wrote it
        const { canvas, task, decision } = store.canvasOf(pin.id);
        const block = canvas.blocks.find((b) => b.id === pin.blockId)!;
        const card = task ? `T${task.number}` : decision ? `#${decision.number}` : undefined;
        const owner = connectorPinning(pin.anchor.kind)?.pins;
        const part = `${pinPart(pin, block)} in ${owner?.label?.(block, pin) ?? blockLabel(block)}`;
        if (card) return text(advise(`Commented on ${card} about ${part}, in its discussion.`));
        const count = pin.discussion?.thread?.length ?? 0;
        const seen = owner?.seen ?? 'People see it on the pin';
        return text(advise(`Replied in the comment thread on ${part}, on the board context (${count} comments). ${seen}.`));
      }
      if (task_id) {
        const task = store.addTaskComment(task_id, body, getActor());
        told.read(task.comments.at(-1)!.id);
        if (thread) store.addThreadWork(thread.id, { kind: 'comment', id: task.comments.at(-1)!.id, on: task.id }, getActor());
        const gave = task.firstLook?.status === 'done' && task.firstLook.commentId === task.comments.at(-1)?.id;
        if (gave) return text(advise(`Commented on T${task.number}: that gives it its first look, and ${task.createdBy.name} sees it. Leave the card in the backlog until a person marks it ready.${shown}`));
        return text(advise(`Commented on T${task.number}.${shown}`));
      }
      const decision = store.addComment(decision_id!, body, getActor());
      told.read(decision.comments.at(-1)!.id);
      if (thread) store.addThreadWork(thread.id, { kind: 'comment', id: decision.comments.at(-1)!.id, on: decision.id }, getActor());
      return text(advise(`Commented on #${decision.number}.${shown}`));
    },
  );

  tool(
    'react',
    {
      title: 'React',
      description: [
        'React to a comment or a thread message with 👍, 👎 or 👀. When a reply would only say "yes", "no" or "seen", react instead: people see it under what they wrote.',
        "👍 means yes or OK, 👎 means no; either answers a comment that asks you, so it no longer waits on you. Your 👀 shows up on its own when a person's comment or message reaches you in get_board or your updates.",
        'Pass where it is (task_id, decision_id, thread_id or pin_id): it reacts to the latest comment there by someone else, or to comment_id. One of each per comment; remove takes yours back.',
        'People\'s reactions to your own comments reach your updates ("Sam reacted 👎 to your comment on T115"): read 👍 as a yes or OK, 👎 as a no.',
        'then_wait works as on comment.',
      ].join(' '),
      inputSchema: tools.react,
    },
    async ({ task_id, decision_id, thread_id, pin_id, comment_id, emoji, remove }) => {
      const places: ReactionPlace[] = [
        ...(task_id ? [{ taskId: task_id }] : []),
        ...(decision_id ? [{ decisionId: decision_id }] : []),
        ...(thread_id ? [{ threadId: thread_id }] : []),
        ...(pin_id ? [{ pinId: pin_id }] : []),
      ];
      if (places.length !== 1) throw new BoardError('Pass one of task_id, decision_id, thread_id or pin_id: where the comment is.');
      const { item, on, changed, answered } = store.react(places[0], { commentId: comment_id, emoji, remove }, getActor());
      const whose = `${item.author.name}'s ${thread_id ? 'message' : 'comment'} ${on}`;
      if (remove) return text(changed ? `Took back your ${emoji} on ${whose}.` : `You hadn't reacted ${emoji} to ${whose}; nothing changed.`);
      if (!changed) return text(`You had already reacted ${emoji} to ${whose}.`);
      const reply = answered ? ' It counts as your reply, so it no longer waits on you.' : '';
      return text(`Reacted ${emoji} to ${whose}: "${clip(item.body, 80)}".${reply} ${item.author.name} sees it under it.`);
    },
  );

  tool(
    'get_updates',
    {
      title: 'Get updates',
      description:
        `Activity on a board since a cursor, from anyone but you: answers, exploration requests, comments, messages in threads, new questions, and what people asked of agents. Returns the new cursor. Check it between steps: you can't be notified. Other tools' results also say when there's unread activity; act on it. ${WHOLE}`,
      inputSchema: tools.get_updates,
      annotations: { readOnlyHint: true },
    },
    async ({ board_id, since }) => {
      const board = store.getBoard(board_id);
      return text(updates(board, store.eventsSince(board_id, since, getActor(), UPDATES_PAGE + 1)));
    },
  );

  tool(
    'wait_for_updates',
    {
      title: 'Wait for updates',
      description:
        `Block until someone else acts on the board, or until the timeout: how you listen. Call it whenever you're idle (your tasks handed out to subagents, or waiting on people), and again each time it returns; people see on the board whether you're listening. Before each wait, hand out the ready tasks it names (brief_task). Each call waits at most 240 seconds. ${WHOLE} Answer from it, and pass then_wait to your reply to keep listening in the same call.`,
      inputSchema: tools.wait_for_updates,
      annotations: { readOnlyHint: true },
    },
    async ({ board_id, since, timeout_seconds }, extra) => {
      return text(await listen(store.getBoard(board_id), since, Math.min(timeout_seconds ?? 60, MAX_WAIT_SECONDS), extra));
    },
  );

  tool(
    'report_skills',
    {
      title: 'Report skills',
      description: [
        'Tell Tricot which skills you have (Claude Code skills, Codex prompts, Pi or OMP skills, Gemini CLI or OpenCode skills and commands): each with its name and a one-line description. Call it once per session, with the whole list: it replaces what you reported before.',
        'People then call them from a card comment or a thread message by typing "/". A message that starts with one of your skills reaches your updates as "asks you to run /name", with the rest of their text as its arguments: run it, then reply on that card or thread as usual, and your reply shows it was made via the skill.',
      ].join(' '),
      inputSchema: tools.report_skills,
    },
    async ({ skills }) => {
      const list = store.reportSkills(getActor().name, skills);
      skillsReported = true;
      const count = list.skills.length;
      return text(
        count === 0
          ? 'Cleared your skills: people see none of yours to call.'
          : `Reported ${count} skill${count === 1 ? '' : 's'}: people can call ${count === 1 ? 'it' : 'them'} with "/" from a card comment or a thread message. A request comes through your updates as "asks you to run /name".`,
      );
    },
  );

  tool(
    'finish_sync',
    {
      title: 'Finish sync',
      description:
        [
          "Mark a person's sync of the board context done, once the blocks it covers reflect the board's current state.",
          'When a person asks for a sync (get_board and your updates show it), do it next: re-read the board (decisions, tasks, recent activity with get_updates) and the board context, bring the blocks it covers up to date with the current state, pin existing work to the parts about it (pin), then call this with a one-line note on what changed.',
          "A sync of all covers the blocks agents made: update them or add new ones, but a block a person made or edited is theirs, and changes to it are refused. A sync of selected blocks names them (get_canvas marks each \"in this sync\" or \"leave it\"): refresh exactly those, people's included, since selecting is their OK; changes to other blocks, and new blocks, are refused until you finish.",
          'In the note, mention anything you had to leave that looks out of date.',
        ].join(' '),
      inputSchema: tools.finish_sync,
    },
    async ({ board_id, note }) => {
      const board = store.finishSync(board_id, note, getActor());
      const blocks = board.synced?.blockIds ? syncedBlocks(board.canvas, board.synced.blockIds) : [];
      if (blocks.length === 0) return text(`Synced the board context of ${board.title}; people see it is up to date.`);
      const names = listNames(blocks.map((b) => blockName(b)));
      return text(`Synced ${names} in the board context of ${board.title}; people see ${blocks.length === 1 ? 'it is' : 'they are'} up to date.`);
    },
  );

  tool(
    'take_request',
    {
      title: 'Take request',
      description:
        [
          "Take a person's request on the board context (get_board and your updates show them with a request id), e.g. \"Get me an architecture view of the project\". It makes a group on the board context for your answer and returns its id: add your blocks there with add_block(group_id), then finish_request. A request that @-mentions other agents is theirs, and is refused.",
          'People now ask from the Board Context in the board\'s General thread: answer those there (reply_in_thread). Requests are what they asked before, which a board may still have open.',
          'Take one with take_request, read the project as needed (code, decisions, tasks, the board context), answer with visuals (diagrams, tables) as blocks in the request\'s group, and finish_request with a one-line note.',
        ].join(' '),
      inputSchema: tools.take_request,
    },
    async ({ request_id, title }) => {
      const { request, group } = store.takeRequest(request_id, getActor(), title);
      const { board } = store.getRequest(request_id);
      const asked = `${request.by.name}'s request: "${request.text}"`;
      if (!group) return text(`You took ${asked}, but its group is gone: add a group with add_group(board_id: ${board.id}) for your answer, then finish_request.`);
      return text(
        `Took ${asked}. Its group on the board context is "${group.title}" [group id: ${group.id}]. Build the answer there as blocks (add_block with board_id: ${board.id} and group_id: ${group.id}), reading the project as needed: diagrams and tables over prose. Then finish_request with a one-line note.`,
      );
    },
  );

  tool(
    'finish_request',
    {
      title: 'Finish request',
      description:
        "Mark a person's request on the board context done, once your answer is in its group. Only the agent who took it finishes it. The note says what you added, in a line.",
      inputSchema: tools.finish_request,
    },
    async ({ request_id, note }) => {
      const request = store.finishRequest(request_id, note, getActor());
      const { board } = store.getRequest(request_id);
      const group = board.canvas.groups.find((g) => g.id === request.groupId);
      const where = group ? ` in group "${group.title}"` : '';
      return text(`Finished ${request.by.name}'s request${where}; people see it's done, with your note.`);
    },
  );

  // ---- threads ---------------------------------------------------------------

  tool(
    'get_thread',
    {
      title: 'Get thread',
      description:
        [
          'Read a thread in full: its lens, every message, who wrote it and when, and whether it waits on you.',
          'Threads are conversations through which people work on the project with agents. get_board lists a board\'s threads, and your updates name each new message, "asked you" when it @-mentions you and "for Codex" when it\'s another agent\'s. A message that mentions no agent is for the agent its lens is routed to, if any, else for any agent: the first to reply answers it.',
          'Each thread has a lens (General, Legal, Design, Performance, Security, or one people named) whose brief says how to answer: as a reviewer of licences, as a product designer… Answer through it.',
          'Your updates bring a message for you whole, with the messages before it you haven\'t seen: that is enough to answer it. Read the thread when you need more.',
        ].join(' '),
      inputSchema: tools.get_thread,
      annotations: { readOnlyHint: true },
    },
    async ({ thread_id }) => {
      const { board, thread } = store.getThread(thread_id);
      told.readAll(threadAsRead(thread));
      return text(threadDetail(board, thread, getActor().name));
    },
  );

  tool(
    'reply_in_thread',
    {
      title: 'Reply in thread',
      description: [
        "Answer in a thread (get_board and your updates give its thread id). Leave a message that's for another agent to them; one for any agent is yours if you reply first.",
        "Answer in the thread itself, not in a comment elsewhere, through the thread's lens (its brief is in get_thread and your updates), and keep it short.",
        "When a message needs a person's decision, post one (post_decision); when it needs work, plan a task (plan_tasks); when it asks for a view of the project, add blocks to the board context (add_block with board_id).",
        'Pass this thread_id to those tools, and to update_block and comment: what you make then shows in the thread under your reply, live, and the decision or task links back to the thread. Make it first, then reply.',
        'refs puts other cards under your reply too: one you made without thread_id, or one that already answers the question.',
        'Say in your reply what you did, with #N for a decision and TN for a task (e.g. "Posted it as #57", "Planned T80"): the board links them.',
        'To ask a person something, @-mention them (@Sam).',
        THEN_WAIT,
      ].join(' '),
      inputSchema: tools.reply_in_thread,
    },
    async ({ thread_id, body, refs }) => {
      const thread = store.postToThread(thread_id, body, getActor(), refs);
      told.read(thread.messages.at(-1)!.id);
      const { board } = store.getThread(thread_id);
      const count = `${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}`;
      const shown = thread.messages.at(-1)!.refs ?? [];
      const under = shown.length ? `, with ${listNames(shown.map((ref) => workName(board, ref)))} under it` : '';
      return text(withAdvice(`Replied in thread "${thread.title}" (${count})${under}. People see it in the thread.`, peopleTextAdvice(body, 'reply')));
    },
  );

  tool(
    'start_thread',
    {
      title: 'Start thread',
      description: [
        "Open a thread on a board to raise something with people: a risk you found, a question that isn't a decision yet, a heads-up. Its first sentence titles it.",
        'Give it the lens it belongs to, e.g. Security for a way data could leak: General (the default), Legal, Design, Performance or Security, or a name of your own with lens_brief.',
        'For a clear choice between options, post a decision instead; for work, plan a task. Write #N for a decision and TN for a task, and @-mention a person to ask them.',
        "People's replies come through your updates: answer them with reply_in_thread.",
      ].join(' '),
      inputSchema: tools.start_thread,
    },
    async ({ board_id, body, lens, lens_brief }) => {
      if (lens_brief !== undefined && !lens) throw new BoardError('Pass lens_brief with lens: the name of the lens it describes.');
      const thread = store.startThread(board_id, body, getActor(), lens ? { name: lens, brief: lens_brief } : undefined);
      told.read(thread.messages[0].id); // it wrote it
      const through = thread.lens ? `, through the ${thread.lens.name} lens` : '';
      const started = `Started thread "${thread.title}" [thread id: ${thread.id}]${through}. People see it under Threads on the board; their replies come through your updates.`;
      return text(withAdvice(started, peopleTextAdvice(body, 'message')));
    },
  );

  // ---- canvas ----------------------------------------------------------------

  tool(
    'get_canvas',
    {
      title: 'Get canvas',
      description:
        [
          'Read a canvas: every block in reading order grouped by its named group, with full content (tables, task lists, Mermaid source, link addresses), links between blocks, and images attached. Pass board_id, decision_id or task_id.',
          "Every board has a board context (board_id): the canvas that holds the board's global context and current state (goal, constraints, architecture, what's done). Read it before planning, and keep it current: update it when a decision settles or a task finishes. Every decision and task also has its own canvas for its evidence and work; re-read a decision's before acting on it.",
          'People edit blocks directly. Treat their edits as instructions: a ticked item is done, a changed cell is a correction, a block moved into a group or a new link is a claim about how things relate.',
          "Pins are listed under their block: parts linked to tasks and decisions, and parts people commented on, with what they said on a diff's or code block's lines (answer on the line with comment(pin_id)) and the board context's comment threads.",
        ].join(' '),
      inputSchema: tools.get_canvas,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { board, decision, task, canvas } = store.getCanvas(canvasRef(args));
      const deleted = deletedLately(board.deleted, { decisionId: decision?.id, taskId: task?.id });
      const content: ({ type: 'text'; text: string } | ReturnType<typeof imageContent>)[] = [
        { type: 'text', text: [canvasDigest(board, canvas, decision, task), deleted].filter(Boolean).join('\n\n') },
      ];
      const images = [...canvas.blocks]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .flatMap((block) => {
          const assetId = kindOf(block.type).agent.picture?.(block);
          return assetId ? [{ block, assetId }] : [];
        });
      if (images.length && args.include_images !== false) {
        const attached = images.slice(0, MAX_INLINE_IMAGES);
        const rest = images.length - attached.length;
        content.push({
          type: 'text',
          text: `Attached images, in order: ${attached.map(({ block }) => `${blockLabel(block)} [id: ${block.id}]`).join(', ')}${rest ? `. ${rest} more: use get_block.` : ''}`,
        });
        for (const { assetId } of attached) content.push(imageContent(store, assetId));
      }
      return { content };
    },
  );

  tool(
    'get_block',
    {
      title: 'Get block',
      description:
        'Read one canvas block in full, without truncation, with its earlier versions listed (update_block with restore_rev brings one back). Image blocks come back as the image itself.',
      inputSchema: tools.get_block,
      annotations: { readOnlyHint: true },
    },
    async ({ block_id }) => {
      const { board, canvas } = store.canvasOf(block_id);
      const block = canvas.blocks.find((b) => b.id === block_id);
      if (!block) throw new BoardError(`"${block_id}" is not a block.`);
      const header = `${blockLabel(block)} [id: ${block.id}] · rev ${block.rev}`;
      const pins = pinLines(board, canvas, block).join('\n');
      const versions = block.versionCount ? versionLines(store, block) : '';
      const content: ({ type: 'text'; text: string } | ReturnType<typeof imageContent>)[] = [
        { type: 'text', text: [`${header}\n${blockContentDigest(block, true)}`, pins, versions].filter(Boolean).join('\n\n') },
      ];
      const picture = kindOf(block.type).agent.picture?.(block);
      if (picture) content.push(imageContent(store, picture));
      return { content };
    },
  );

  tool(
    'add_block',
    {
      title: 'Add block',
      description: [
        'Add a block to a canvas (pass board_id, decision_id or task_id). It is placed automatically, inside group_id if given.',
        fieldsByType(),
        ...guideSentences(),
        'Use a block when text alone carries the idea poorly: a table for comparable data, a Mermaid diagram for flows, states, sequences or architecture, a task list in a note for steps, an image for screenshots of prototypes or UI, a link for a doc, pull request or design file people should open. Notes are for short prose.',
        "Lead with the single visual that most changes the decision; don't build walls of blocks. Make layout meaning explicit: put related blocks in a named group (add_group), connect blocks with labelled links (link), and pin evidence to the option it supports (option).",
        "On a task's canvas, put what shows the work before you send it for review: screenshots of the result, a task list of what's done.",
        ...moreSentences(),
        'Add a block only for something new. A new version of something already on a canvas (a mock, a screenshot, a table) goes in that block: update_block on it, images included, not a new block. If you added a duplicate, remove the old one with remove_item: people should see only the latest version.',
        IN_THREAD,
      ].join(' '),
      inputSchema: tools.add_block,
    },
    async (args) => {
      const ref = canvasRef(args);
      const thread = args.thread_id ? store.threadOn(args.thread_id, store.getCanvas(ref).board) : undefined;
      const content = readContent(args)();
      const block = store.addBlock(
        ref,
        { content, title: args.title, groupId: args.group_id, optionId: args.option, w: args.width, h: args.height },
        getActor(),
      );
      if (thread) store.addThreadWork(thread.id, { kind: 'block', id: block.id }, getActor());
      const added = `Added ${blockLabel(block)} [id: ${block.id}] (rev ${block.rev}).${thread ? ` It shows in ${inThread(thread)}.` : ''}`;
      const { canvas } = store.canvasOf(block.id);
      const advice = [...(kindOf(block.type).agent.adviceAdded?.(block, args) ?? []), ...duplicateAdvice(block, canvas.blocks, getActor())];
      return text(withAdvice(added, advice));
    },
  );

  // What a block's kind reads of what an agent sent, checked now; the function
  // it returns saves what is pending (an image's file) and gives its content.
  // A type a kind still answers to (a checklist) makes a block of that kind.
  function readContent(args: BlockArgs) {
    const kind = agentKind(args.type);
    if (!kind) throw new BoardError(`Unknown block type "${args.type}".`);
    return kind.agent.read(args, io);
  }

  // What kinds need of this server: images from files, and saved assets.
  const io = {
    readImage: (imagePath?: string, base64?: string) => readImage(imagePath, base64),
    saveAsset: (data: Uint8Array) => store.saveAsset(data),
  };

  function readImage(imagePath?: string, base64?: string): Buffer {
    if (!imagePath === !base64) throw new BoardError('An image block needs image_path or image_base64 (exactly one).');
    let data: Buffer;
    if (base64) {
      data = Buffer.from(base64, 'base64');
    } else {
      if (!options.allowFilePaths) {
        throw new BoardError('This server is reachable from other machines, so image_path is disabled. Send image_base64.');
      }
      const file = path.resolve(imagePath!);
      try {
        if (statSync(file).size > 8 * 1024 * 1024) throw new BoardError('Images must be 8 MB or smaller.');
        data = readFileSync(file);
      } catch (error) {
        if (error instanceof BoardError) throw error;
        throw new BoardError(`Cannot read "${file}" (${(error as NodeJS.ErrnoException).code ?? 'unreadable'}).`);
      }
    }
    checkImage(data);
    return data;
  }

  tool(
    'update_block',
    {
      title: 'Update block',
      description:
        `When you update it answering a thread, pass thread_id: it shows in the thread, under your reply. Change a block in place: title, content fields for its type (${contentFields()}), the option it is pinned to ("" to unpin), or its group ("" to take it out). Use it for each new version of a block, not add_block. Rows replace the whole list. Items replace a note's task list and leave the prose around it alone; a task keeps its tick when its words match. Each content change keeps what the block showed before as a version: restore_rev brings one back (get_block lists them). Pass the rev you last read: if a person has changed the block since, the update is refused and you get the current content to reapply your change to.`,
      inputSchema: tools.update_block,
    },
    async (args) => {
      const { block_id, rev, restore_rev, thread_id, ...changes } = args;
      const thread = thread_id ? store.threadOn(thread_id, store.canvasOf(block_id).board) : undefined;
      if (restore_rev !== undefined && Object.values(changes).some((v) => v !== undefined)) {
        throw new BoardError('Pass restore_rev with block_id and rev only: it brings back the whole version. Change the block after, if you need to.');
      }
      const found = store.canvasOf(block_id).canvas.blocks.find((b) => b.id === block_id);
      const before = found && structuredClone(found); // as it was, for what the update did to it
      let block: Block;
      try {
        block =
          restore_rev !== undefined
            ? store.restoreBlock(block_id, restore_rev, getActor(), rev)
            : store.updateBlock(
                block_id,
                {
                  ...Object.assign({}, ...kinds().map((kind) => kind.agent.patch?.(args, io))),
                  title: args.title,
                  optionId: args.option === undefined ? undefined : args.option || null,
                  groupId: args.group_id === undefined ? undefined : args.group_id || null,
                },
                getActor(),
                rev,
              );
      } catch (error) {
        if (!(error instanceof BoardError) || error.code !== 'conflict') throw error;
        const current = store.canvasOf(args.block_id).canvas.blocks.find((b) => b.id === args.block_id)!;
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `${error.message}\n\nCurrent content (rev ${current.rev}):\n${blockContentDigest(current, true)}` }],
        };
      }
      const updated =
        restore_rev !== undefined
          ? `Restored v${restore_rev} of ${blockLabel(block)} [id: ${block.id}] (now rev ${block.rev}). The version it replaced is kept.`
          : `Updated ${blockLabel(block)} [id: ${block.id}] (now rev ${block.rev}).`;
      if (thread) store.addThreadWork(thread.id, { kind: 'block', id: block.id }, getActor());
      const shown = thread ? `It shows in ${inThread(thread)}.` : '';
      const kind = kindOf(block.type);
      const noticed = before && before.type === block.type ? kind.agent.noticeUpdated?.(before, block, store.canvasOf(block.id).canvas.pins) : undefined;
      const notice = [updated, noticed, shown].filter(Boolean).join(' ');
      const advice = kind.agent.adviceUpdated?.(block, args) ?? [];
      return text(withAdvice(notice, advice));
    },
  );

  tool(
    'add_group',
    {
      title: 'Add group',
      description: 'Add a named group to a canvas, then add blocks into it with group_id. The name says why the blocks belong together.',
      inputSchema: tools.add_group,
    },
    async (args) => {
      const group = store.addGroup(canvasRef(args), { title: args.title }, getActor());
      return text(`Added group "${group.title}" [id: ${group.id}].`);
    },
  );

  tool(
    'link',
    {
      title: 'Link blocks',
      description: 'Draw a labelled arrow between two blocks on the same canvas, e.g. "contradicts", "implements", "measured by".',
      inputSchema: tools.link,
    },
    async ({ from_block_id, to_block_id, label }) => {
      const link = store.addLink(from_block_id, to_block_id, label, getActor());
      return text(`Linked [id: ${link.id}].`);
    },
  );

  tool(
    'pin',
    {
      title: 'Pin work to part of a block',
      description: [
        'Link an existing task or decision to a precise part of a block, so people see what the work is about where they read it, with its status. get_canvas lists pins under their block, and get_task and get_decision say where the work was pinned from. Pin existing work to the parts about it, e.g. during a sync.',
        'Pass pin_id instead of block_id and a part for the same part as that pin, e.g. a decision answering a comment thread there.',
        'The part: words in a note (text, with occurrence if they appear more than once); a task in a note (item, by its words), or words in one (item and text);',
        'table cells (row and/or column; to_row and to_column make a range; a row alone is the whole row, a column alone the whole column);',
        'a box on an image (box, as fractions of it), numbered on the image; a flowchart node (node, by its id in the Mermaid source)',
        "or the arrow (edge) from it to another (node and to_node); a line of a diff (file and line, with side \"old\" for a removed line); a chart's bar, point or slice (category, and series on a chart of several);",
        'or, with none of these, the whole block, e.g. a link card. remove_item with the pin id undoes it.',
      ].join(' '),
      inputSchema: tools.pin,
    },
    async (args) => {
      const work = { taskId: args.task_id, decisionId: args.decision_id };
      if (!args.block_id === !args.pin_id) throw new BoardError('Pass block_id and the part, or pin_id for the same part as that pin.');
      const { block_id: _block, pin_id: _pin, task_id: _task, decision_id: _decision, ...part } = args;
      if (args.pin_id && Object.values(part).some((v) => v !== undefined)) throw new BoardError("With pin_id, leave out the part: it's that pin's.");
      const { board, canvas } = store.canvasOf(args.pin_id ?? args.block_id!);
      const pinned = args.pin_id ? store.pinAlongside(args.pin_id, work, getActor()) : undefined;
      const block = canvas.blocks.find((b) => b.id === (pinned?.blockId ?? args.block_id));
      if (!block) throw new BoardError(`"${args.block_id}" is not a block.`);
      const pin = pinned ?? store.pin(block.id, pinPartFrom(block, args), work, getActor());
      const target = pinTarget(board, pin)!;
      return text(
        `Pinned ${pinPart(pin, block)} in ${blockLabel(block)} to ${target.ref} [pin id: ${pin.id}]. People see it there, linked, with ${target.ref}'s status.`,
      );
    },
  );

  tool(
    'remove_item',
    {
      title: 'Remove canvas item',
      description:
        'Remove a block (and its links and pins), a group (its blocks stay), a link, or a pin. Deletions are kept for 30 days: restore_item puts one back as it was. If you added a duplicate of a block, remove the old one: people should see only the latest version. Threads, tasks and decisions are people\'s to delete.',
      inputSchema: tools.remove_item,
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const deletion = store.removeItem(id, getActor());
      return text(`Removed ${deletion.label} [id: ${id}]. restore_item with this id puts it back.`);
    },
  );

  tool(
    'restore_item',
    {
      title: 'Restore canvas item',
      description:
        'Put back a block, group, link or pin removed from a canvas in the last 30 days, as it was and with the same id, so references and pins to it resolve again. A block comes back with its links, pins and earlier versions; a group around the blocks it held. Earlier versions a person deleted from a block come back among its versions, and a thread a person deleted with all it said. get_canvas lists what was deleted lately from a canvas, get_board the threads.',
      inputSchema: tools.restore_item,
    },
    async ({ id }) => {
      const { deletion, notes } = store.restoreItem(id, getActor());
      if (deletion.kind === 'thread') return text(`Restored ${deletion.label} [thread id: ${id}], with its messages. People see it under Threads again.`);
      const where = canvasName(store.canvasOf(deletion.blockId ?? id));
      const missed = notes.length ? ` Not everything could come back: ${notes.join('; ')}.` : '';
      return text(`Restored ${deletion.label} [id: ${id}] (${where}).${missed}`);
    },
  );

  // The connectors' own tools, after the board's (read_google_doc, edit_google_doc…).
  for (const connectorTool of options.connectors?.tools(store) ?? []) {
    tool(connectorTool.name, connectorTool.config, (args) => connectorTool.run(args, getActor()));
  }

  return server;
}
