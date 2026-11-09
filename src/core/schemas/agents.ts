import { z } from 'zod';
import { skillsWords } from '../agents/registry';
import { addFields, agentTypes, pinFields, updateFields } from '../blocks/agent';
import { fields, askNames } from './fields';
import { searchKind } from './people';
import { newCriterion, newOption, reactionInput } from './shared';
import { newSkill } from './skills';
import { LIMITS } from './limits';
import { sized } from './text';

// What agents send: the arguments of each MCP tool, with the words that tell an
// agent what each one is for. The names and the words are the agents' contract,
// so they change only on purpose. The fields are the ones people's calls use
// (fields.ts, shared.ts), so a rule is the same for both.

export const MAX_INLINE_IMAGES = 4;

// The topics of the guide an agent reads when needed (server/mcp/guide.ts).
export const GUIDE_TOPICS = ['decisions', 'tasks', 'canvas', 'blocks', 'conversation'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

// thread_id on the tools that make work: an agent answering a thread names it,
// and what it makes shows in the thread under its reply (core/threads.ts).
export const THREAD_HINT = "The thread you're answering, if any: what you make shows in it, under your reply";

export const AREA_HINT = 'A short theme, e.g. "Connectors"; reuse one of the board\'s areas (Areas in get_board) when it fits';

const threadId = z.string().optional().describe(THREAD_HINT);

// then_wait on the tools that answer people: post, then listen in the same call (server/mcp.ts).
const thenWait = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('After it posts, wait up to this many seconds for what happens next, as wait_for_updates does, and return that too');

// ---- blocks ------------------------------------------------------------------

// A block's type and content, shared by add_block and post_decision's blocks.
// Each kind says which fields it reads (core/blocks/); `type` is any of them.
export const blockShape = {
  type: z.enum(agentTypes()),
  title: z.string().optional(),
  ...addFields(),
  width: z.number().optional(),
  height: z.number().optional(),
};
const optionPin = z.string().optional().describe('On a decision canvas: letter of the option this block is evidence for');

const inlineBlockFields = {
  option: optionPin,
  group: z.string().optional().describe('Title of a group to put it in; blocks giving the same title share one'),
};
const inlineBlockShape = z.object({ ...blockShape, ...inlineBlockFields });

// A block posted with a decision, as agents are shown it: its type, then the
// fields add_block takes for that type. It is checked against all of them
// (inlineBlockShape), but lists only these, so every session doesn't carry
// add_block's fields twice.
const inlineBlock = z
  .looseObject({ type: blockShape.type, title: blockShape.title, ...inlineBlockFields })
  .superRefine((block, ctx) => {
    const checked = inlineBlockShape.safeParse(block);
    if (!checked.success) for (const issue of checked.error.issues) ctx.addIssue({ ...issue } as Parameters<typeof ctx.addIssue>[0]);
  }) as unknown as typeof inlineBlockShape;

// Fields listed without their descriptions, where another tool's already give them.
const undescribed = <S extends Record<string, z.ZodType>>(shape: S): S =>
  Object.fromEntries(Object.entries(shape).map(([name, schema]) => [name, schema.meta({ description: undefined })])) as S;

// What an agent sent to add a block: its kind reads the fields it has.
export interface BlockArgs {
  type: string;
  title?: string;
  width?: number;
  height?: number;
  [field: string]: unknown;
}

const whichCanvas = {
  board_id: z.string().optional().describe("For the board context: the board's global context and current state"),
  decision_id: z.string().optional().describe("For a decision's canvas"),
  task_id: z.string().optional().describe("For a task's canvas"),
};

// ---- pins --------------------------------------------------------------------

export const pinShape = {
  block_id: z.string().optional().describe('The block the part is in (or pass pin_id)'),
  pin_id: z
    .string()
    .optional()
    .describe("Instead of block_id and a part: the same part as this pin, e.g. a decision you posted for a comment thread there"),
  task_id: z.string().optional().describe('The task to pin there (or pass decision_id)'),
  decision_id: z.string().optional(),
  text: z.string().optional().describe('Words to pin, exactly as they read in the note or task'),
  occurrence: z.number().int().min(1).optional().describe('Which occurrence of text, if it appears more than once (default 1)'),
  ...pinFields(),
};

// What an agent sent to pin work to part of a block: its kind reads the fields it has.
export interface PinArgs {
  block_id?: string;
  pin_id?: string;
  task_id?: string;
  decision_id?: string;
  text?: string;
  occurrence?: number;
  [field: string]: unknown;
}

// ---- the tools ---------------------------------------------------------------

// Decisions a decision could change or rests on, as an agent names them, each with why (core/affects.ts).
const affects = sized(
  z.object({
    decision_id: z.string().describe('A decision on this board, by id'),
    why: fields.affectWhy.describe('Why, in a few words, e.g. "pricing assumes the open core"'),
  }),
  { max: [LIMITS.affects, `Name at most ${LIMITS.affects} decisions it could affect.`] },
);

// A card posted with a decision: blank criteria and names are left out, so
// only their shape is checked here, and the Store holds what is left to its rules.
const criterionInPost = newCriterion.extend({ label: z.string().describe(newCriterion.shape.label.description!) });

export const tools = {
  create_board: {
    title: fields.boardTitle,
    goal: fields.goal.optional().describe('What this work is trying to achieve, in a sentence or two'),
  },
  get_board: { board_id: z.string() },
  get_decision: { decision_id: z.string() },
  search: {
    query: z.string().describe('Words to find, e.g. "retry backoff"'),
    board_id: z.string().optional().describe('The board to search (or pass all_boards)'),
    kinds: z.array(searchKind).optional().describe('Only these kinds; default all'),
    all_boards: z.boolean().optional().describe('Search every board, archived ones included'),
    include_closed: z.boolean().optional().describe('Default true'),
    limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
  },
  post_decision: {
    board_id: z.string(),
    question: fields.question.describe('One question, phrased so it can be answered by picking an option'),
    context: z.string().optional().describe('Why this matters and what it affects. Markdown. Keep it short.'),
    options: z.array(newOption).optional(),
    recommend: z.string().optional().describe('Letter of the option you recommend'),
    recommendation_reason: z.string().optional(),
    blocking: z.boolean().optional().describe('True only if you cannot continue any work until this is answered'),
    depends_on: z.array(z.string()).optional().describe('Ids of decisions that must be settled first'),
    affects: affects
      .optional()
      .describe('Past decisions this one could change or rests on, each with why'),
    area: fields.area.optional().describe(AREA_HINT),
    ask: z.array(z.string()).optional().describe('Names of people to route this question to (see People in get_board)'),
    ask_note: fields.note.optional().describe('What you need from them'),
    criteria: z.array(criterionInPost).optional().describe('What the options should be judged on; people mark them'),
    blocks: z
      .array(inlineBlock)
      .optional()
      .describe("Canvas blocks posted with it, each with the fields add_block takes for its type. Pin each to an option's letter with option"),
    thread_id: threadId,
  },
  update_decision: {
    decision_id: z.string(),
    question: fields.question.optional(),
    context: z.string().optional(),
    add_options: z.array(newOption).optional(),
    revise_options: z
      .array(
        z.object({
          option: z.string().describe('Letter of the option'),
          label: fields.optionLabelChange.optional(),
          description: fields.optionDescriptionChange.optional().describe('"" clears it'),
          outdated: fields.optionReason.optional().describe('Why it no longer applies; marks it outdated, so it can no longer be picked'),
          restore: z.boolean().optional().describe('Bring back an option marked outdated'),
        }),
      )
      .optional()
      .describe("Changes to existing options. Options a person proposed or reworded are theirs and can't be changed"),
    recommend: z.string().optional(),
    recommendation_reason: z.string().optional(),
    blocking: z.boolean().optional(),
    depends_on: z.array(z.string()).optional().describe('Replaces the current dependency list'),
    affects: affects.optional().describe('Replaces the decisions it names as ones it could change or rests on; [] clears them'),
    area: fields.area.optional().describe(`${AREA_HINT}. "" clears it`),
    refreshed: z
      .boolean()
      .optional()
      .describe("You re-checked the card against the app as it is now: finishes a person's refresh request"),
    note: fields.note.optional().describe('With refreshed: what changed, or why the options (or a settled answer) still hold, in a sentence'),
  },
  log_decision: {
    decision_id: z.string().optional(),
    board_id: z.string().optional(),
    question: z.string().optional().describe('The question you answered, for a new card'),
    choice: z.string().describe('What you chose: an option letter for an existing card, or a short description'),
    rationale: fields.rationale,
    alternatives: z.array(z.string()).optional().describe('Other options you considered, for a new card'),
    area: fields.area.optional().describe(`For a new card: ${AREA_HINT[0].toLowerCase()}${AREA_HINT.slice(1)}`),
  },
  plan_tasks: {
    board_id: z.string(),
    tasks: sized(
      z.object({
        title: fields.taskTitle.describe('A small, checkable unit of work'),
        detail: fields.taskDetail.optional().describe('What done looks like, briefly'),
        decision_ids: z
          .array(z.string())
          .optional()
          .describe('Settled decisions this task implements; leave out for work that implements none'),
        assignee: fields.assignee
          .optional()
          .describe("An agent to hand it to, by name as it shows on the board; only that agent can claim it. Leave out for any agent"),
      }),
      { max: [LIMITS.tasks, `Plan at most ${LIMITS.tasks} tasks at once.`] },
    ).min(1),
    backlog: z
      .boolean()
      .optional()
      .describe(
        `Open them in the backlog for people to shape and mark ready, not in to do; you can't claim them until then. At most ${LIMITS.backlogCards} an hour`,
      ),
    thread_id: threadId,
  },
  get_task: { task_id: z.string() },
  brief_task: { task_id: z.string() },
  claim_task: { task_id: z.string() },
  take_first_look: { task_id: z.string() },
  update_task: {
    task_id: z.string(),
    status: z.enum(['todo', 'in_progress', 'in_review', 'blocked', 'done']).optional(),
    note: fields.taskNote.optional().describe('Progress or what is blocking it; keep it to a sentence or two'),
    link: fields.taskLink.optional().describe('A PR, branch or file'),
    title: fields.taskTitle.optional(),
    detail: fields.taskDetail.optional(),
    decision_ids: z.array(z.string()).optional().describe('Replaces the linked decisions; [] unlinks'),
    still_valid: z.boolean().optional().describe('You re-read the decision that changed and the task still holds'),
    commit: z.string().optional().describe('The commit hash, once you commit a done task a person approved with a commit'),
    nothing_to_commit: fields.noCommit
      .optional()
      .describe("Why there's nothing to commit (a plan, a spike): with in_review, so people aren't offered a commit; or answering an approved commit"),
    assignee: fields.assignee.optional().describe('Hand it to an agent, by name; "" for any agent. Refused when a person set the assignee'),
  },
  ask_people: {
    decision_id: z.string(),
    people: askNames.describe('Names as they appear in the People line of get_board'),
    note: fields.note.optional().describe('What you need from them'),
  },
  propose_criteria: {
    decision_id: z.string(),
    criteria: sized(newCriterion, { max: [LIMITS.criteria, `A decision can have at most ${LIMITS.criteria} criteria.`] }).min(1),
  },
  attach_finding: {
    decision_id: z.string(),
    option: z.string().optional().describe('Option letter this finding is about'),
    summary: fields.findingSummary.describe('What you found, in a few sentences. Markdown.'),
    metrics: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe('Comparable measurements, e.g. {"tests passing": "58/60", "files touched": 12}'),
    links: z.array(z.string()).optional().describe('Branches, PRs, files or URLs with the details'),
  },
  comment: {
    decision_id: z.string().optional(),
    task_id: z.string().optional(),
    pin_id: z.string().optional().describe('A pinned part people commented on, by the pin id get_canvas lists'),
    body: fields.comment,
    thread_id: z.string().optional().describe(`With decision_id or task_id: ${THREAD_HINT[0].toLowerCase()}${THREAD_HINT.slice(1)}`),
    then_wait: thenWait,
  },
  react: {
    task_id: z.string().optional().describe("The task whose discussion has the comment"),
    decision_id: z.string().optional().describe("The decision whose discussion has the comment"),
    thread_id: z.string().optional().describe('The thread the message is in'),
    pin_id: z.string().optional().describe('A pinned part people commented on, by the pin id get_canvas lists'),
    comment_id: z
      .string()
      .optional()
      .describe('The comment, or thread message, by the id get_task, get_decision or get_thread lists. Leave it out for the latest one there by someone else'),
    emoji: reactionInput.shape.emoji.describe('👍 for yes or OK, 👎 for no, 👀 for seen it'),
    remove: reactionInput.shape.remove.describe('Take your reaction back'),
    then_wait: thenWait,
  },
  get_updates: {
    board_id: z.string(),
    since: z.number().int().min(0).describe('Cursor from a previous get_board or get_updates call'),
  },
  wait_for_updates: {
    board_id: z.string(),
    since: z.number().int().min(0),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('How long to wait at most; leave it out to wait as long as the server allows'),
  },
  report_skills: {
    skills: sized(newSkill, { max: [LIMITS.skills, `Report at most ${LIMITS.skills} skills.`] }).describe(
      `Every skill you have (${skillsWords()}); [] clears them`,
    ),
  },
  finish_sync: {
    board_id: z.string(),
    note: fields.note.optional().describe('What you updated or added, in a sentence'),
  },
  take_request: {
    request_id: z.string(),
    title: fields.groupTitleOrNone.optional().describe('A short title for its group, if a better one fits than the one made from the request'),
  },
  finish_request: {
    request_id: z.string(),
    note: fields.requestNote.describe('What you added, in a sentence'),
  },
  get_thread: { thread_id: z.string() },
  reply_in_thread: {
    thread_id: z.string(),
    body: fields.message.describe('Your reply, in Markdown'),
    refs: z
      .array(z.string())
      .optional()
      .describe('Cards to show under your reply besides what you made with thread_id: decision or task ids (or #N, TN), or block ids'),
    then_wait: thenWait,
  },
  start_thread: {
    board_id: z.string(),
    body: fields.message.describe('What you want to raise, in Markdown; the first sentence titles the thread'),
    lens: fields.lensNameOrNone.optional().describe('General (default), Legal, Design, Performance, Security, or a name of your own with lens_brief'),
    lens_brief: fields.lensBrief.optional().describe('For a lens of your own: how agents answer through it, in a sentence or two'),
  },
  get_canvas: {
    ...whichCanvas,
    include_images: z.boolean().optional().describe(`Attach image blocks as images (default true, at most ${MAX_INLINE_IMAGES})`),
  },
  get_block: { block_id: z.string() },
  add_block: { ...whichCanvas, ...blockShape, group_id: z.string().optional(), option: optionPin, thread_id: threadId },
  update_block: {
    block_id: z.string(),
    rev: z.number().int().describe('The rev shown when you last read the block (get_canvas or get_block)'),
    title: z.string().optional(),
    ...undescribed(updateFields()),
    option: z.string().optional(),
    group_id: z.string().optional(),
    restore_rev: z
      .number()
      .int()
      .optional()
      .describe('Bring back an earlier version (get_block lists them) as a new one; the current one is kept. Pass it with block_id and rev only'),
    thread_id: threadId,
  },
  add_group: { ...whichCanvas, title: fields.groupTitle },
  link: { from_block_id: z.string(), to_block_id: z.string(), label: fields.linkLabel.optional() },
  pin: pinShape,
  remove_item: { id: z.string() },
  read_guide: { topic: z.enum(GUIDE_TOPICS) },
  restore_item: { id: z.string().describe('The removed item\'s id, as get_canvas or get_board lists it under "Deleted lately"') },
};
