import { z } from 'zod';
import { createContent, patchFields, pinParts } from '../blocks/people';
import { APPROVAL_REASON_LIMIT, APPROVAL_SESSION_ITEM, APPROVAL_SESSION_ITEMS, MAX_QUESTION_ANSWER, MAX_QUESTION_TEXT, MAX_QUESTIONS, approvalHarnesses } from '../approvals';
import { doors } from '../doors';
import { orNames } from '../format';
import { MAX_SEARCH_QUERY } from '../projectSearch';
import { searchKinds, type SearchKind } from '../search';
import type { BlockContent } from '../store/inputs';
import type { ThreadDoor } from '../types';
import { USAGE_SOURCES } from '../usage';
import { fields } from './fields';
import { LIMITS } from './limits';
import { lensInput, move, newGroup, reactionInput } from './shared';
import { skillName, tricotSkill } from './skills';
import { mustNotBeEmpty, tidy, tooLong } from './rules';
import { sized, text } from './text';

// What people send: the body of each call the browser makes today, and what a
// desktop shell will send later. The fields are the ones agents' tools use
// (fields.ts, shared.ts), so a rule is the same for both.

export const actorName = z
  .string()
  .trim()
  .refine((value) => value !== '', { error: mustNotBeEmpty('actor') })
  .refine((value) => value.length <= LIMITS.name, { error: tooLong('actor', LIMITS.name) });

const by = { actor: actorName };

// A kind a search looks for, among those registered here (the kinds of card a part registered, and the core's).
export const searchKind = z.custom<SearchKind>((value) => typeof value === 'string' && searchKinds().includes(value), {
  error: (issue) => `Unknown kind "${String(issue.input)}". Kinds: ${searchKinds().join(', ')}.`,
});

// A door into a thread: one of those registered here (core/doors.ts), refused as an enum of them would be.
const door = z.unknown().transform((value, ctx): ThreadDoor => {
  const known = doors();
  if (typeof value !== 'string' || !known.includes(value)) {
    ctx.issues.push({ code: 'invalid_value', values: known, input: value, message: `Invalid option: expected one of ${known.map((name) => `"${name}"`).join('|')}` });
  }
  return value as ThreadDoor;
});

// The content of a block people add, of one of the kinds registered when it is sent (core/blocks/people.ts): these schemas are
// made before a part registers its kinds, so it is checked as it comes, with the issues its own schema found.
const blockContent = z.unknown().transform((value, ctx): BlockContent => {
  const checked = createContent().safeParse(value);
  if (checked.success) return checked.data;
  ctx.issues.push(...(checked.error.issues as unknown as z.core.$ZodRawIssue[]));
  return z.NEVER;
});

// A thread's lens: a preset's name, or one's own with a brief; null or General takes it off.
const lens = lensInput.nullable();
// The lens a person asked for on one message (^Name): the same fields, and no
// agent (it is never routed). Absent, or null, asks for none.
const messageLens = lensInput.omit({ agent: true }).nullable().optional();

export const people = {
  createBoard: z.object({ ...by, title: fields.boardTitle, goal: fields.goal.optional(), folder: fields.folder.optional() }),
  // The board's title, typed out, as the person's go-ahead to delete it for good.
  deleteBoard: z.object({ ...by, confirm: z.string() }),
  updateBoard: z.object({ ...by, title: fields.boardTitle.optional(), goal: fields.goal.optional(), folder: fields.folder.nullable().optional() }),
  // A project file to edit or pair on in Files: its path from the project folder.
  fileBlock: z.object({ ...by, path: z.string().min(1).max(1024) }),
  // An edit to a project file: its text, and the version it changes (its hash as it was read).
  fileWrite: z.object({ ...by, path: z.string().min(1).max(1024), text: z.string().max(2 * 1024 * 1024), base: z.string().regex(/^[0-9a-f]{64}$/) }),
  // A Sketchbook page: made with a title, then renamed, or put right after another page (or first, null).
  addPage: z.object({ ...by, title: fields.pageTitle }),
  updatePage: z.object({ ...by, title: fields.pageTitle.optional(), after: z.string().nullable().optional() }),
  actorOnly: z.object(by),
  sync: z.object({
    ...by,
    // none: sync all
    blockIds: sized(z.string(), { max: [LIMITS.syncBlocks, `Sync at most ${LIMITS.syncBlocks} blocks at once.`] }).optional(),
  }),
  askAgents: z.object({ ...by, text: fields.request }),
  // About blocks a person selected on a Sketchbook page: asking agents (in their
  // words, which a decision or tasks may leave to agents).
  askOnPage: z.object({
    ...by,
    blockIds: sized(z.string(), { min: [1, 'Select the blocks to ask about.'], max: [LIMITS.blocks, `Ask about at most ${LIMITS.blocks} blocks at once.`] }),
    kind: z.string().optional(), // a kind of card a part registered: the Store refuses one it does not know
    text: fields.request.optional(),
  }),
  comment: z.object({ ...by, body: fields.comment }),
  // A 👍, 👎 or 👀 on a comment or thread message, or taking one's own back.
  react: reactionInput.extend(by),
  message: z.object({ ...by, body: fields.message }), // in a thread's General ask
  // A message in a thread, with the lens it asks for on this message alone, if any (core/lensCommand.ts).
  threadMessage: z.object({ ...by, body: fields.message, messageLens }),
  // `door`: the tab whose chat bar it was started from, or the threads list (core/doors.ts);
  // `messageLens`: the lens its first message asks for, which is not the thread's own (`lens`);
  // `pageId`: the Sketchbook page whose chat bar it was started from;
  // `blockIds`: the blocks selected there, which it is about (core/threadSelection.ts);
  // `file`: the project file open in Files, whose block it is about (core/fileThread.ts), by its path from the project folder.
  startThread: z.object({
    ...by,
    body: fields.message,
    lens: lens.optional(),
    messageLens,
    door: door.optional(),
    pageId: z.string().optional(),
    blockIds: sized(z.string(), { max: [LIMITS.blocks, `Start a thread about at most ${LIMITS.blocks} blocks at once.`] }).optional(),
    file: z.string().min(1).max(1024).optional(),
  }),
  threadLens: z.object({ ...by, lens }),
  // A Tricot skill, which people add and edit: its name, what it does, what the agent follows, and which agent it is for (none: every agent).
  addSkill: z.object({ ...by, name: skillName, description: tricotSkill.description, instructions: tricotSkill.instructions, agent: tricotSkill.agent.optional() }),
  editSkill: z.object({ ...by, name: skillName.optional(), description: tricotSkill.description.optional(), instructions: tricotSkill.instructions.optional(), agent: tricotSkill.agent.optional() }),
  // Pairing (core/pairing.ts): a person starting a session with an agent on a
  // block's parts of a kind ('site', 'doc'), its page saying it is still there
  // (active: the person did something since), and leaving it.
  pairingStart: z.object({ ...by, blockId: z.string().trim().min(1).max(200), part: z.string().trim().min(1).max(20), agent: actorName }),
  pairingBeat: z.object({ ...by, active: z.boolean().optional() }),
  pairingEnd: z.object(by),
};

// What part of a block people pin: each kind says its parts (core/blocks/).
export const pinPart = pinParts();

const placement = { x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional() };

export const canvas = {
  addBlock: z.object({
    ...by,
    ...placement,
    title: z.string().optional(),
    groupId: z.string().optional(),
    optionId: z.string().optional(),
    content: blockContent,
  }),
  // A change to a block: what any block takes, and the fields of each kind (core/blocks/).
  patchBlock: z.object({
    ...by,
    title: z.string().optional(),
    ...patchFields(),
    optionId: z.string().nullable().optional(),
    rev: z.number().int().optional(),
  }),
  // Copies of the blocks and groups with these ids, from one canvas, centred on a point of this one.
  pasteBlocks: z.object({
    ...by,
    ids: sized(z.string(), { min: [1, 'Name the blocks to paste.'], max: [LIMITS.blocks, `Paste at most ${LIMITS.blocks} blocks at once.`] }),
    at: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
  move: z.object({ ...by, moves: sized(move, { max: [LIMITS.moves, `Move at most ${LIMITS.moves} items at once.`] }) }),
  addGroup: newGroup.extend(by),
  renameGroup: z.object({ ...by, title: fields.groupTitle }),
  addLink: z.object({ ...by, from: z.string(), to: z.string(), label: fields.linkLabel.optional() }),
  relabelLink: z.object({ ...by, label: fields.linkLabel }),
  pin: z.object({ ...by, part: pinPart }), // and the card it is linked to, by its kind's `<kind>Id` (cardIdsOf)
  // ask: a request for agents to act on the part, on parts that take one (a website's elements).
  pinComment: z.object({ ...by, part: pinPart, body: fields.comment, ask: z.boolean().optional() }),
  resolvePin: z.object({ ...by, resolved: z.boolean() }),
  // rev is the version to bring back; blockRev, the rev being looked at, refuses it if the block has moved on.
  restore: z.object({ ...by, rev: z.number().int(), blockRev: z.number().int().optional() }),
};

// A board's search, from the query string: kinds is a comma-separated list,
// all and open are flags. A query under two characters finds nothing.
export const searchParams = z.object({
  q: text({ name: 'A search', max: 500 }).optional(),
  kinds: z
    .string()
    .optional()
    .transform((list) => list?.split(',').map((kind) => kind.trim()).filter(Boolean) ?? [])
    .pipe(z.array(searchKind)),
  all: z.enum(['0', '1', 'true', 'false']).optional(),
  open: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// What the board list asks of /api/needs: who is asking, and the last event they saw on each board.
export const needsParams = z.object({ name: actorName, seen: z.string().max(20_000).optional() });
export const seenCursors = z.record(z.string(), z.number().int().min(0));

// The agents and their skills, for the "/" list and the user menu: with a
// board, where each is on that board; without, anywhere.
export const agentsParams = z.object({ board: z.string().min(1).max(200).optional() });

// A step an agent's harness sends while it works (server/steps.ts): one line
// of what it is doing, never content. session and worker say which run of the
// agent it is (a subagent has a worker id), the card (by its kind: task, decision) or
// thread its own Tricot call named, at when the hook fired (ms), done that
// its turn ended. A step that lasts (a test run) is sent running when it
// starts and ended when it ends, both with its tool call's id, the end with
// how long it took (ms) when the harness says; narration is a line of what
// the agent said, which a person chose to show.
const stepId = z.string().trim().min(1).max(LIMITS.stepId);
export const agentStep = z.object({
  text: text({ empty: 'text', name: 'text', max: LIMITS.step, tidy: true }).transform(tidy),
  session: stepId.optional(),
  worker: stepId.optional(),
  role: z.string().trim().min(1).max(LIMITS.name).optional(),
  thread: stepId.optional(),
  done: z.boolean().optional(),
  running: z.boolean().optional(),
  ended: z.boolean().optional(),
  tool: stepId.optional(),
  ms: z.number().int().min(0).max(7 * 24 * 60 * 60_000).optional(),
  narration: z.boolean().optional(),
  at: z.number().int().min(0).optional(),
});
// The card a step's own Tricot call named, by the name of its kind (`task`, `decision`): one field for each kind of card a Store
// keeps, read with the step's others (`store.cardKinds()`).
export const agentStepCards = (kinds: readonly string[]) => z.object(Object.fromEntries(kinds.map((kind) => [kind, stepId.optional()])));
export const agentStepName = z.object({ name: actorName });

// What a Tricot terminal says of the agents it started and holds to wake on
// a board (server/sleepers.ts): which terminal it is (a word of its
// own for this run), its view of each agent it holds (asleep or not, the
// board's event from which what concerns it is due, as of when, and whether
// a wake typed into it started no turn), and those it let go of since
// (ended, stopped, or the terminal quitting).
export const wakes = z.object({
  holder: z.string().trim().min(8).max(80),
  agents: z
    .array(
      z.object({
        name: actorName,
        asleep: z.boolean(),
        since: z.number().int().min(0).optional(),
        at: z.number().int().min(0),
        stuck: z.boolean().optional(),
      }),
    )
    .max(20),
  gone: z.array(actorName).max(20).optional(),
});

// What `tricot listen` sends (server/listeners.ts): the word the
// board gave the MCP session it listens for, in that session's wait reply,
// and the command's own id, the same each time it connects again.
const word = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{16,64}$/, { error: what });
export const listen = z.object({
  session: word('session is the word from your wait_for_updates reply.'),
  listener: word('listener is the id tricot listen gives itself.'),
});

// An agent's permission prompt, from the hook in its harness
// (hooks/tricot-approve.mjs, server/approvals.ts): the tool and its input,
// as the agent sent them (the route's body limit holds their size), why in
// the agent's words, which run of the agent asks, and what "Allow for this
// session" would also allow, in words. The hook waits with the key it was
// given; a person answers from the page by the request's id, and may say why
// they deny it. The harness is one of the agents whose prompts come to the
// board (the registry's).
const harnesses = approvalHarnesses() as [string, ...string[]];
export const approvals = {
  request: z.object({
    harness: z.enum(harnesses, { error: `harness is ${orNames(harnesses.map((id) => `"${id}"`))}.` }),
    tool: z.string().trim().min(1).max(200),
    input: z.unknown(),
    description: z.string().max(2_000).optional(),
    session: stepId.optional(),
    worker: stepId.optional(),
    role: z.string().trim().min(1).max(LIMITS.name).optional(),
    cwd: z.string().max(2_000).optional(),
    // Every item in full, as the card shows it: more than it shows is refused, never cut.
    forSession: sized(z.string().min(1).max(APPROVAL_SESSION_ITEM, { error: `Each "for this session" item is at most ${APPROVAL_SESSION_ITEM} characters.` }), {
      max: [APPROVAL_SESSION_ITEMS, `"For this session" lists at most ${APPROVAL_SESSION_ITEMS} items.`],
    }).optional(),
    canAnswer: z.literal(true, { error: 'canAnswer is true, or left out.' }).optional(), // the hook can give answers to a question back (core/approvals.ts)
    at: z.number().int().min(0).optional(),
  }),
  id: z.object({ id: z.string().trim().min(1).max(64) }),
  key: z.object({ key: z.string().min(20).max(128) }),
  // `terminal` leaves the agent's prompt to its terminal. `answers` are an agent's
  // question's, by the question's text (approvals.ts): only an allow has them,
  // and the server checks them against the request.
  reply: z
    .object({
      actor: actorName,
      behavior: z.enum(['allow', 'deny', 'terminal'], { error: 'behavior is "allow", "deny" or "terminal".' }),
      session: z.boolean().optional(),
      reason: text({ name: 'A reason', max: APPROVAL_REASON_LIMIT, trim: true }).optional(),
      answers: z
        .record(z.string().min(1).max(MAX_QUESTION_TEXT), z.string().trim().min(1, { error: 'Each answer is some words.' }).max(MAX_QUESTION_ANSWER, { error: `Each answer is at most ${MAX_QUESTION_ANSWER} characters.` }))
        .refine((answers) => Object.keys(answers).length <= MAX_QUESTIONS, { error: `At most ${MAX_QUESTIONS} questions are answered at once.` })
        .optional(),
    })
    .refine((reply) => reply.answers === undefined || (reply.behavior === 'allow' && !reply.session), { error: 'Answers go with an allow that is not for the session.' }),
};

// An agent's plan usage, from its harness (server/usage.ts): numbers only,
// and a closed set of everything else. A window is the plan's 5-hour one
// ("5h"), its weekly one ("7d"), or a model's own weekly one ("7d:opus"), with
// how much of it is used, when it resets (ms) and how long it is (minutes);
// tokens and cost are the session's so far; at is when the harness read them
// (ms). Anything else in the body is refused, not dropped, so a harness can't
// send more than this by mistake.
const usageCount = z.number().int().min(0).max(1e15);
const usagePercent = z.number().min(0).max(1000); // past 100 once over a limit, as a tool may say
const usageWindow = z.strictObject({
  id: z.string().regex(/^(5h|7d|7d:[A-Za-z0-9._-]{1,40})$/, { error: 'A window id is "5h", "7d" or "7d:<model>".' }),
  usedPercent: usagePercent,
  resetsAt: z.number().int().min(0).max(8_640_000_000_000),
  minutes: z.number().int().min(1).max(366 * 24 * 60).optional(),
});
export const agentUsage = z.strictObject({
  usage: z.strictObject({
    source: z.enum(USAGE_SOURCES, { error: `source is one of ${USAGE_SOURCES.join(', ')}.` }),
    plan: z.string().regex(/^[A-Za-z0-9 _.-]{1,32}$/, { error: 'plan is a short name, such as "plus".' }).optional(),
    windows: z
      .array(usageWindow)
      .min(1)
      .max(8)
      .refine((windows) => new Set(windows.map((w) => w.id)).size === windows.length, { error: 'Each window is sent once.' })
      .optional(),
    tokens: z
      .strictObject({ input: usageCount, output: usageCount, cacheRead: usageCount, cacheWrite: usageCount, reasoning: usageCount, total: usageCount })
      .optional(),
    costUsd: z.number().min(0).max(10_000_000).optional(),
    context: z.strictObject({ usedPercent: usagePercent, window: usageCount }).optional(),
  }),
  at: z.number().int().min(0).max(8_640_000_000_000),
});

// An agent's usage and what it did on a board, for its panel: the board, and
// where today and this week start in the person's own time (ms).
export const agentUsageParams = z.object({
  board: z.string().min(1).max(200).optional(),
  day: z.coerce.number().int().min(0).optional(),
  week: z.coerce.number().int().min(0).optional(),
});

// A person turning an agent's live steps on or off in Tricot
// (server/liveStepsRoutes.ts): which agent (an installer's id), which way,
// the name it sends steps as, and the scope: every project (user), or the
// hook the project Tricot was started in has from earlier (project), which
// is only taken out. Applying takes the fingerprint of the preview the person
// saw, and is refused without it.
const liveStepsChange = {
  actor: actorName,
  action: z.enum(['on', 'off'], { error: 'action is "on" or "off".' }),
  name: actorName.optional(),
  scope: z.enum(['user', 'project'], { error: 'scope is "user" or "project".' }).optional(),
};
export const liveSteps = {
  agent: z.object({ agent: z.string().trim().min(1).max(40) }),
  preview: z.object(liveStepsChange),
  apply: z.object({
    ...liveStepsChange,
    fingerprint: z
      .string({ error: "Turning live steps on or off needs the fingerprint of the preview the person saw: ask for the preview first, and send its fingerprint." })
      .regex(/^[0-9a-f]{64}$/, { error: "That isn't a preview's fingerprint: ask for the preview, and send the fingerprint it gives." }),
  }),
};

// A person setting the model and thinking level an agent starts on
// (server/agentRulesRoutes.ts): which agent (its id), then each, or null or
// nothing for the agent's own. What the agent takes is checked against it
// (core/agentRules.ts ruleProblem).
export const agentRule = {
  agent: z.object({ agent: z.string().trim().min(1).max(40) }),
  rule: z.object({
    model: z.string({ error: 'model is the name of a model, or null for its own.' }).max(200).nullable().optional(),
    effort: z.string({ error: 'effort is a thinking level, or null for its own.' }).max(40).nullable().optional(),
  }),
};

export const EVENTS_PAGE = 100;
export const EVENTS_PAGE_MAX = 500;

// A board's events, from the query string, a page at a time. With since, they
// are the ones after that cursor, oldest first; otherwise newest first, and
// before pages back from a seq. decision and task keep to what is about one
// card; unseen_by is the notifications list's: what others changed that this person hasn't seen;
// actor keeps to what one agent did, as an agent's panel shows it.
// Any other parameter names a kind of card whose events to read (`?decision=…`, `?task=…`): the Store answers one it keeps
// no events about in a sentence (core/store/eventTables.ts), so the route hands them on by their kind (`decisionId`).
export const eventsParams = z
  .object({
    since: z.coerce.number().int().min(0).optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_MAX).default(EVENTS_PAGE),
    unseen_by: z.string().max(200).optional(),
    actor: z.string().min(1).max(200).optional(), // what this agent did: its own events
  })
  .catchall(z.string().max(100));

// A file of the board's project folder, for its preview (server/projectFiles.ts checks the path).
export const projectFileParams = z.object({
  path: z.string().min(1).max(1024),
  lines: z.string().max(40).optional(),
});

// A search inside the project's files (core/projectSearch.ts), from the query string: q, and the flags case, word and regex, each 1 to turn it on.
const flag = z.enum(['0', '1']).optional();
export const projectSearchParams = z.object({
  q: z.string().min(1).max(MAX_SEARCH_QUERY),
  case: flag,
  word: flag,
  regex: flag,
});
