import { z } from 'zod';
import { skillsWords } from '../agents/registry';
import { addFields, agentTypes, updateFields } from '../blocks/agent';
import { CORE_SEARCH_KINDS } from '../search';
import { describedIn } from '../words';
import { fields } from './fields';
import { reactionInput } from './shared';
import { newSkill } from './skills';
import { LIMITS } from './limits';
import { sized } from './text';

// What agents send: the arguments of each MCP tool, with the words that tell an
// agent what each one is for. The names and the words are the agents' contract,
// so they change only on purpose. The fields are the ones people's calls use
// (fields.ts, shared.ts), so a rule is the same for both.
//
// These are the board's own, which say nothing of a part: the arguments about a
// decision or a task, and the words about them, are its to add through its
// tool group. An
// argument whose words a group adds to is described in named pieces
// (`describedIn`, core/words.ts), as a tool's description is.

export const MAX_INLINE_IMAGES = 4;

// What `search` can look for on a board of the core's own: a group that keeps cards adds them (a part's cards).

// thread_id on the tools that make work: an agent answering a thread names it,
// and what it makes shows in the thread under its reply (core/threads.ts).
export const THREAD_HINT = "The thread you're answering, if any: what you make shows under your reply";

export const threadId = z.string().optional().describe(THREAD_HINT);

// then_wait on the tools that answer people: post, then listen in the same call (server/mcp.ts).
const thenWait = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Then wait up to this many seconds for what happens next (as wait_for_updates) and return it too');

// ---- blocks ------------------------------------------------------------------

// A block's type and content, shared by add_block and the blocks posted with a decision (a part's post_decision).
// Each kind says which fields it reads (core/blocks/); `type` is any of them.
export const blockShape = {
  type: z.enum(agentTypes()),
  title: z.string().optional(),
  ...addFields(),
  width: z.number().optional(),
  height: z.number().optional(),
};

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

// Which canvas a call is about: a Sketchbook page. The board context (board_id) and the cards' canvases are a part's to
// offer: its tool group adds them in front of page_id and says it optional, so a server
// with no group has a page_id every call must give and no board context to name.
const whichCanvas = {
  page_id: z.string().describe('For a Sketchbook page'),
};

// ---- the tools ---------------------------------------------------------------

export const tools = {
  create_board: {
    title: fields.boardTitle,
    goal: fields.goal.optional().describe('What this work is trying to achieve, in a sentence or two'),
    folder: fields.folder.optional().describe('The project folder on this computer, a full path or ~/… inside the home folder'),
  },
  set_project_folder: {
    board_id: z.string(),
    folder: fields.folder.nullable().describe('A full path or ~/… inside the home folder; null removes the project folder'),
  },
  get_board: { board_id: z.string() },
  search: {
    query: z.string().describe('Words to find, e.g. "retry backoff"'),
    board_id: z.string().optional().describe('The board to search (or pass all_boards)'),
    kinds: z.array(z.enum(CORE_SEARCH_KINDS)).optional().describe('Only these kinds; default all'),
    all_boards: z.boolean().optional().describe('Search every board, archived ones included'),
    limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
  },
  comment: {
    pin_id: z.string().optional().describe('A pinned part people commented on, by the pin id get_canvas lists'),
    body: fields.comment,
    then_wait: thenWait,
  },
  react: {
    thread_id: z.string().optional().describe('The thread the message is in'),
    pin_id: z.string().optional().describe('A pinned part people commented on, by the pin id get_canvas lists'),
    comment_id: describedIn(z.string().optional(), [
      ['comment', 'The comment, or thread message, by the id '],
      ['lists', 'get_thread'],
      ['lists-end', ' lists. Leave it out for the latest one there by someone else'],
    ]),
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
  take_request: {
    request_id: z.string(),
    title: fields.groupTitleOrNone.optional().describe('A short title for its group, if a better one fits than the one made from the request'),
  },
  finish_request: {
    request_id: z.string(),
    note: fields.requestNote.describe('What you made and why, in a sentence or two'),
  },
  get_thread: { thread_id: z.string() },
  reply_in_thread: {
    thread_id: z.string(),
    body: fields.message.describe('Your reply, in Markdown'),
    refs: describedIn(z.array(z.string()).optional(), [
      ['refs', 'Cards to show under your reply besides what you made with thread_id: '],
      ['refs-ids', 'block ids'],
    ]),
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
  add_block: { ...whichCanvas, ...blockShape, group_id: z.string().optional(), thread_id: threadId },
  update_block: {
    block_id: z.string(),
    rev: z.number().int().describe('The rev shown when you last read the block (get_canvas or get_block)'),
    title: z.string().optional(),
    ...undescribed(updateFields()),
    group_id: z.string().optional(),
    restore_rev: z
      .number()
      .int()
      .optional()
      .describe('Bring back an earlier version (get_block lists them) as a new one; the current one is kept. Pass it with block_id and rev only'),
    thread_id: threadId,
  },
  add_group: { ...whichCanvas, title: fields.groupTitle },
  add_page: { board_id: z.string(), title: fields.pageTitle, asked: fields.asked.optional() },
  update_page: { page_id: z.string(), title: fields.pageTitle },
  link: { from_block_id: z.string(), to_block_id: z.string(), label: fields.linkLabel.optional() },
  remove_item: { id: z.string() },
  restore_item: { id: z.string().describe('The removed item\'s id, as get_canvas or get_board lists it under "Deleted lately"') },
};

// read_guide takes one of the topics a session offers, which the tool groups
// decide (server/mcp/toolGroups.ts), so its argument is made where the session
// is: an enum of those topics.
export const readGuideArgs = (topics: readonly [string, ...string[]]) => ({ topic: z.enum(topics) });
