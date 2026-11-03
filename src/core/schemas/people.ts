import { z } from 'zod';
import { createContent, patchFields } from '../blocks/people';
import { DOORS } from '../doors';
import { SEARCH_KINDS, type SearchKind } from '../search';
import { fields } from './fields';
import { LIMITS } from './limits';
import { ONE_CANVAS, canvasRef, lensInput, move, namesOneCanvas, newCriterion, newGroup, newTask, optionChange, reactionInput, resolveInput, taskPatch } from './shared';
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

export const searchKind = z.enum(SEARCH_KINDS as [SearchKind, ...SearchKind[]], {
  error: (issue) => `Unknown kind "${String(issue.input)}". Kinds: ${SEARCH_KINDS.join(', ')}.`,
});

// A thread's lens: a preset's name, or one's own with a brief; null or General takes it off.
const lens = lensInput.nullable();

export const people = {
  createBoard: z.object({ ...by, title: fields.boardTitle, goal: fields.goal.optional() }),
  // The board's title, typed out, as the person's go-ahead to delete it for good.
  deleteBoard: z.object({ ...by, confirm: z.string() }),
  updateBoard: z.object({ ...by, title: fields.boardTitle.optional(), goal: fields.goal.optional() }),
  postDecision: z.object({
    ...by,
    question: fields.question,
    context: z.string().optional(),
    options: z.array(z.string()).optional(),
    area: fields.area.optional(),
  }),
  // A person files a card under an area (theme); '' clears it.
  area: z.object({ ...by, area: fields.area }),
  addOption: z.object({ ...by, label: fields.optionLabel, description: z.string().optional() }),
  // A person's edit of a card: its wording, and changes to options (nothing is deleted).
  revise: z.object({
    ...by,
    question: fields.question.optional(),
    context: z.string().optional(),
    options: sized(optionChange, { max: [LIMITS.options, `A decision can have at most ${LIMITS.options} options.`] }).optional(),
  }),
  retire: z.object({ ...by, note: fields.retireReason }),
  resolve: resolveInput.extend(by),
  explore: z.object({ ...by, note: fields.longNote.optional() }),
  defer: z.object({ ...by, note: fields.longNote.optional() }),
  note: z.object({ ...by, note: fields.note.optional() }),
  actorOnly: z.object(by),
  sync: z.object({
    ...by,
    // none: sync all
    blockIds: sized(z.string(), { max: [LIMITS.syncBlocks, `Sync at most ${LIMITS.syncBlocks} blocks at once.`] }).optional(),
  }),
  askAgents: z.object({ ...by, text: fields.request }),
  comment: z.object({ ...by, body: fields.comment }),
  // A 👍, 👎 or 👀 on a comment or thread message, or taking one's own back.
  react: reactionInput.extend(by),
  message: z.object({ ...by, body: fields.message }), // in a thread
  // `door`: the tab whose chat bar it was started from, or the threads list (core/doors.ts).
  startThread: z.object({ ...by, body: fields.message, lens: lens.optional(), door: z.enum(DOORS).optional() }),
  threadLens: z.object({ ...by, lens }),
  ask: z.object({
    ...by,
    names: sized(fields.personName, {
      min: [1, 'Ask at least one person.'],
      max: [LIMITS.askNames, `Ask at most ${LIMITS.askNames} people at once.`],
    }),
    note: fields.note.optional(),
  }),
  task: newTask.omit({ assignee: true }).extend(by),
  // Dropping a task as work that won't be done, with why if they like; and bringing it back.
  dropTask: z.object({ ...by, note: fields.note.optional() }),
  bringBack: z.object({ ...by, to: z.enum(['backlog', 'todo'], { error: 'Bring it back to backlog or todo.' }) }),
  taskPatch: taskPatch.pick({ status: true, note: true, link: true, stillValid: true, decisionIds: true, approveCommit: true, nothingToCommit: true, after: true, assignee: true }).extend(by),
  unask: z.object({ ...by, name: z.string() }),
  // A Tricot skill, which people add and edit: its name, what it does, what the agent follows, and which agent it is for (none: every agent).
  addSkill: z.object({ ...by, name: skillName, description: tricotSkill.description, instructions: tricotSkill.instructions, agent: tricotSkill.agent.optional() }),
  editSkill: z.object({ ...by, name: skillName.optional(), description: tricotSkill.description.optional(), instructions: tricotSkill.instructions.optional(), agent: tricotSkill.agent.optional() }),
  criterion: newCriterion.extend(by),
  mark: z.object({
    ...by,
    criterionId: z.string(),
    optionId: z.string(),
    value: z.enum(['yes', 'partly', 'no']).nullable(),
  }),
};

const span = z.tuple([z.number().int(), z.number().int()]);
const point3 = z.tuple([z.number(), z.number(), z.number()]);
const sceneView = z.object({ eye: point3, target: point3 });

const pinPart = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('text'),
      quote: z.string(),
      prefix: fields.pinContext.optional(),
      suffix: fields.pinContext.optional(),
    }),
    z.object({ kind: z.literal('cells'), rows: span.optional(), columns: span.optional() }),
    z.object({ kind: z.literal('box'), x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    z.object({ kind: z.literal('node'), nodeId: z.string() }),
    z.object({ kind: z.literal('arrow'), from: z.string(), to: z.string(), n: z.number().int().min(0).optional() }),
    z.object({ kind: z.literal('block') }),
    z.object({ kind: z.literal('line'), file: z.string(), line: z.number().int().min(1), side: z.enum(['new', 'old']).optional() }),
    z.object({ kind: z.literal('point'), category: z.string(), series: z.string().optional() }),
    z.object({
      kind: z.literal('spot'),
      object: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      z: z.number().optional(),
      view: sceneView.optional(),
    }),
  ],
  { error: 'A pinned part\'s kind is one of: text, item, cells, box, node, arrow, block, line, point, spot.' },
);

const placement = { x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional() };

export const canvas = {
  addBlock: z.object({
    ...by,
    ...canvasRef.shape,
    ...placement,
    title: z.string().optional(),
    groupId: z.string().optional(),
    optionId: z.string().optional(),
    content: createContent(),
  }).refine(namesOneCanvas, { error: ONE_CANVAS }),
  // A change to a block: what any block takes, and the fields of each kind (core/blocks/).
  patchBlock: z.object({
    ...by,
    title: z.string().optional(),
    ...patchFields(),
    optionId: z.string().nullable().optional(),
    rev: z.number().int().optional(),
  }),
  move: z
    .object({ ...by, ...canvasRef.shape, moves: sized(move, { max: [LIMITS.moves, `Move at most ${LIMITS.moves} items at once.`] }) })
    .refine(namesOneCanvas, { error: ONE_CANVAS }),
  addGroup: newGroup.extend({ ...by, ...canvasRef.shape }).refine(namesOneCanvas, { error: ONE_CANVAS }),
  renameGroup: z.object({ ...by, title: fields.groupTitle }),
  addLink: z.object({ ...by, from: z.string(), to: z.string(), label: fields.linkLabel.optional() }),
  relabelLink: z.object({ ...by, label: fields.linkLabel }),
  pin: z.object({ ...by, part: pinPart, taskId: z.string().optional(), decisionId: z.string().optional() }),
  pinTask: z.object({ ...by, part: pinPart, text: fields.prompt, ready: z.boolean().optional() }),
  pinQuestion: z.object({ ...by, part: pinPart, text: fields.prompt }),
  pinComment: z.object({ ...by, part: pinPart, body: fields.comment }),
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

// What the people's Needs view sends: who is asking, and the last event they saw on each board.
export const needsParams = z.object({ name: actorName, seen: z.string().max(20_000).optional() });
export const seenCursors = z.record(z.string(), z.number().int().min(0));

// Dismissing needs from the list: who, on which board, and each need by its
// key and its time (core/needs.ts Dismissed).
export const dismissNeeds = z.object({
  name: actorName,
  board: z.string().min(1).max(200),
  items: z.array(z.object({ key: z.string().min(1).max(200), at: z.string().min(1).max(40) })).min(1).max(200),
});

// The agents and their skills, for the "/" list and the user menu: with a
// board, where each is on that board; without, anywhere.
export const agentsParams = z.object({ board: z.string().min(1).max(200).optional() });

// A step an agent's harness sends while it works (server/steps.ts): one line
// of what it is doing, never content. session and worker say which run of the
// agent it is (a subagent has a worker id), task, decision or thread the card
// or thread its own Tricot call named, at when the hook fired (ms), done that
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
  task: stepId.optional(),
  decision: stepId.optional(),
  thread: stepId.optional(),
  done: z.boolean().optional(),
  running: z.boolean().optional(),
  ended: z.boolean().optional(),
  tool: stepId.optional(),
  ms: z.number().int().min(0).max(7 * 24 * 60 * 60_000).optional(),
  narration: z.boolean().optional(),
  at: z.number().int().min(0).optional(),
});
export const agentStepName = z.object({ name: actorName });

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

export const EVENTS_PAGE = 100;
export const EVENTS_PAGE_MAX = 500;

// A board's events, from the query string, a page at a time. With since, they
// are the ones after that cursor, oldest first; otherwise newest first, and
// before pages back from a seq. decision and task keep to what is about one
// card; unseen_by is the inbox's: what others changed that this person hasn't seen;
// actor keeps to what one agent did, as an agent's panel shows it.
export const eventsParams = z.object({
  since: z.coerce.number().int().min(0).optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_MAX).default(EVENTS_PAGE),
  decision: z.string().max(100).optional(),
  task: z.string().max(100).optional(),
  unseen_by: z.string().max(200).optional(),
  actor: z.string().min(1).max(200).optional(), // what this agent did: its own events
});
