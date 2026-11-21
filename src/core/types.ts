// Shared domain model. The board is the boundary object: agents read and
// write it through MCP tools, humans through the web UI, and both views are
// rendered from this one structure.

import type { BlocksOf, SnapshotsOf } from './blocks/kind';
import type { RegisteredKinds } from './blocks/registry';
import type { Deletion } from './deletions';
import type { DiffSide } from './blocks/diff/diff';
import type { Emoji } from './reactions';

// Retired is a person setting a card aside as no longer relevant: it leaves
// Open without counting as decided, and can be brought back.
export type Status = 'open' | 'exploring' | 'provisional' | 'decided' | 'deferred' | 'retired';

export const STATUSES: Status[] = ['open', 'exploring', 'provisional', 'decided', 'deferred', 'retired'];

export interface Actor {
  kind: 'human' | 'agent';
  name: string;
}

export interface Comment {
  id: string;
  author: Actor;
  body: string;
  createdAt: string;
  // Made on part of a block on the card's own canvas: the pin, and the part
  // as it read, which the comment quotes even after the pin is gone.
  pin?: { id: string; quote: string };
  // A person asking agents to act on the pinned part rather than just
  // commenting: on a Google Doc's paragraph, to edit it in the draft; on a
  // website's element, to change its file.
  ask?: true;
  // The kind of part it asks about, when it isn't a Google Doc's paragraph
  // (a website's element: 'site'), for the words agents read about it.
  askPart?: string;
  // The board's agents and people it @-mentions, by name (core/mentions.ts).
  mentions?: string[];
  // A person's request that agents run one of their skills (core/skills.ts).
  skill?: SkillRequest;
  // A person's ^Lens on this comment alone (^Design): agents answer it
  // through that lens (core/threads.ts commentLensNote). A preset, by its name.
  lens?: MessageLens;
  // An agent's reply to a skill request: the skill's name, which the reply shows it was made via.
  via?: string;
  reactions?: Reaction[]; // 👍, 👎 or 👀 from others, oldest first (core/reactions.ts)
  // An agent's mention of another agent that the loop guard holds
  // (core/agentTalk.ts): its place in the run of agent-to-agent mentions here
  // since a person last wrote. It reads to the agents it names as news, not
  // as asked of them, and wakes none of them.
  held?: number;
  // The line a person's pairing session left as they left it (core/pairing.ts):
  // the agent they paired with and the block. It reads as news, asking nobody.
  paired?: { agent: string; blockId: string };
}

// One person's or agent's 👍, 👎 or 👀 on a comment or a thread message: one
// of each per person or agent. A 👍 or 👎 answers what it asks of them, as a
// reply would; 👀 says they've seen it (core/reactions.ts).
export interface Reaction {
  emoji: Emoji;
  by: Actor;
  at: string;
}

// A message that starts with an agent's skill ("@Claude /avoid-ai-writing the
// intro"): a request to run it, with the rest of the text as its arguments,
// for the agents that have reported the skill. Nothing runs in Tricot.
export interface SkillRequest {
  name: string; // as the agent reported it, or as Tricot lists it (core/skills.ts)
  args: string;
  agents: string[]; // who it asks
  // A Tricot skill's instructions, as they were when it was called, for the
  // agents that don't have a skill of that name of their own: it carries what
  // they follow, so they needn't have the skill. The others run theirs.
  tricot?: { instructions: string; agents: string[] };
}

// ---- canvas ---------------------------------------------------------------
// A whiteboard of typed blocks. Every block is structured data with a visual
// rendering, so agents read and write meaning (rows, items, Mermaid source)
// while humans see and manipulate the visual. Layout meaning is explicit:
// named groups, labelled links, and blocks pinned to options.

export type BlockType = Block['type'];

export interface BlockBase {
  id: string;
  rev: number; // bumped on every content change; writers send the rev they read
  title?: string;
  // Position is relative to the group when groupId is set.
  x: number;
  y: number;
  w: number;
  h: number;
  groupId?: string;
  optionId?: string; // decision canvases only: the option this block is evidence for
  author: Actor;
  createdAt: string;
  updatedBy: Actor;
  updatedAt: string;
  person?: Actor; // the last person to make or edit it, whose block it stays (see blockPerson)
  // How many earlier versions it has. What it showed before each content
  // change (at most 50) is kept in their own table, not with the board; people
  // fetch them one block at a time when they open them, and agents see them in
  // get_block.
  versionCount?: number;
}

// Every kind of block the board has (core/blocks/): the registry's kinds say
// what each one holds, and these types are made from them.
export type Block = BlocksOf<RegisteredKinds>;

// ---- Google Doc drafts ------------------------------------------------------
// Edits to a Google Doc made in Tricot, kept with its link block until a
// person saves them to Google. Only what changed is kept: the doc itself is
// pulled from Google (the server keeps the version the draft started from),
// and paragraph ids ("p4") are its paragraphs in order at that revision.

export interface DocDraft {
  fileId: string; // the doc's Drive id, from the link
  revision: string; // Google's revisionId the edits apply to
  title?: string; // the doc's title then
  edits: DocEdit[];
  conflicts?: DocConflict[]; // the doc changed in Google meanwhile: what a person has to choose before saving
  rebased?: { at: string; theirs: number }; // moved onto a newer version of the doc; theirs: paragraphs changed in Google
}

// A paragraph reworded, removed, or added (after a paragraph id, or '' for the
// start of the doc; one added paragraph per place, so they chain in order).
export type DocEdit =
  | { op: 'edit'; id: string; was: string; text: string; by: Actor; at: string }
  | { op: 'delete'; id: string; was: string; by: Actor; at: string }
  | { op: 'add'; id: string; after: string; text: string; style?: string; list?: 'bullet' | 'numbered'; by: Actor; at: string };

// One paragraph both the draft and someone in Google changed. Keeping mine
// puts the draft's version back (as a new paragraph, if theirs is gone);
// taking theirs drops the draft's change.
export interface DocConflict {
  id: string; // c1, c2…
  paragraph?: string; // the paragraph in the newer version; none when they removed it
  after: string; // where mine goes if theirs is gone: a paragraph id, or '' for the start
  was: string; // as the draft started from
  theirs?: string; // as it is in Google now; none when they removed it
  mine?: string; // as the draft has it; none when the draft removed it
  by: Actor; // who made the draft's change
  style?: string; // the paragraph's style, when not normal text, for mine coming back as a new paragraph
}

// What a block shows, apart from where it is: its title and its type's content.
export type BlockSnapshot = SnapshotsOf<RegisteredKinds>;

// An earlier version of a block: what it showed at that rev, and who made it so, when.
export type BlockVersion = BlockSnapshot & { rev: number; at: string; by: Actor };

// A version as listed, without its content: what it changed from the version before it.
export interface VersionSummary {
  rev: number;
  at: string;
  by: Actor;
  change: string;
}

export interface Group {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  author: Actor;
  createdAt: string;
}

export interface Link {
  id: string;
  from: string; // block id
  to: string; // block id
  label?: string;
  weight?: 'medium' | 'thick'; // its line's, as drawn with the arrow tool; thin when none
  author: Actor;
  createdAt: string;
}

// ---- pins -----------------------------------------------------------------
// A precise part of a block, linked to the task or decision it is about, or
// commented on. People pin a part and turn it into work or a comment on the
// spot; agents link parts to work that already exists.

// Where a pin sits in its block. Each kind is found again after edits by
// what it pinned, not where it was: words by the text around them, an item by
// its id, cells by their column names and contents, a diagram's node or arrow
// by its id in the Mermaid source (or a node by its label, if renamed).
export type PinAnchor =
  | { kind: 'text'; prefix: string; suffix: string } // words in a note, or a task in its task list
  // Table cells, by 0-based inclusive ranges: no rows spans whole columns, no
  // columns whole rows. `headers` are the pinned columns' names, `cells` the
  // pinned rows' contents, as they were.
  | { kind: 'cells'; rows?: [number, number]; columns?: [number, number]; headers: string[]; cells: string[][] }
  // A box drawn on an image, as fractions of its width and height from the top
  // left, so it holds at any size. `n` numbers it on the image: box 1, box 2.
  | { kind: 'box'; x: number; y: number; w: number; h: number; n: number }
  | { kind: 'node'; nodeId: string; label: string } // a node of a flowchart
  // An arrow of a flowchart, by the nodes it joins: the n-th from `from` to
  // `to`, from 0, with its text if it has any.
  | { kind: 'arrow'; from: string; to: string; n: number; label?: string }
  // A line of a diff: in `file`, numbered `line` on its side of the change,
  // found again by its text (the pin's quote) nearest that number. A code
  // block's line is the same, on its new side, with its path as `file`; on a
  // code block, `last` makes it a range of lines, `line` to `last`, found
  // again by its first line and keeping its length.
  | { kind: 'line'; file: string; line: number; side: DiffSide; last?: number }
  // Words in a paragraph of the Google Doc a link block points to: the
  // paragraph by its id at a revision of the doc (p7, or n2 for one added in
  // the draft), and the words by the text around them. When a save or a newer
  // version renumbers the paragraphs, the pin follows its paragraph, and is
  // `gone` once it isn't there. `title` is the doc's, to name it by.
  | { kind: 'doc'; paragraph: string; revision: string; prefix: string; suffix: string; title?: string; gone?: true }
  // A chart's bar, point or slice: its category (the first column's value) and,
  // on a chart of several series, the series (its column's name), found again
  // by name when the data changes. A series alone, with no category, is the
  // whole series (picked in the legend).
  | { kind: 'point'; category?: string; series?: string }
  // A spot on a 3D scene: on one of its named objects (`object` its uuid when
  // it has one, `name` what it is called, found again by either), as a point
  // in that object's own coordinates, so the spot moves with the object; or,
  // on no named object, a point in the scene. `view` is where it was seen
  // from, in the scene's coordinates, which the scene turns back to. `n`
  // numbers it on the scene: spot 1, spot 2.
  | { kind: 'spot'; n: number; x: number; y: number; z: number; object?: string; name?: string; view?: SceneView }
  // An element on a page of a website block (core/blocks/site): the page's
  // path, a CSS selector that finds it (its id, or a short path from the
  // nearest ancestor with one), its tag, and its text as it read, clipped.
  // On a site whose files are on this computer, `file` and `line` are where
  // it starts in the page's file, from the folder. A person's view of the
  // page finds it again by the selector, then by its text, and shows it lost
  // when neither does; that stays in the view, as the page's own scripts
  // could say anything of it.
  | { kind: 'site'; page: string; selector: string; tag: string; text: string; file?: string; line?: number }
  | { kind: 'block' }; // the whole block, e.g. a link card

// Where a 3D scene is seen from: the camera's place and the point it looks at.
export interface SceneView {
  eye: [number, number, number];
  target: [number, number, number];
}

export interface Pin {
  id: string;
  blockId: string;
  anchor: PinAnchor;
  quote: string; // the part as it read when pinned: the words, the item, the cells, box 1, a node's text, an arrow's ends, the card's title
  discussion?: PinDiscussion; // …or neither: comments on the part
  author: Actor;
  createdAt: string;
}

// Comments on a pinned part. On a task's or decision's canvas they are in that
// card's discussion, each carrying the pin; the board context and the
// Sketchbook's pages have no discussion, so there the pin keeps its own
// thread, which a person can mark resolved.
export interface PinDiscussion {
  thread?: Comment[]; // the board context's, or a Sketchbook page's
  resolved?: { by: Actor; at: string };
}

export interface Canvas {
  blocks: Block[];
  groups: Group[];
  links: Link[];
  pins: Pin[];
}

export interface EventTypeNames {
  board_created: true;
  comment_added: true;
  comment_reacted: true;
  canvas_changed: true;
  board_updated: true;
  board_archived: true;
  board_unarchived: true;
  sync_requested: true;
  sync_cancelled: true;
  sync_finished: true;
  request_asked: true;
  request_taken: true;
  request_finished: true;
  request_cancelled: true;
  thread_started: true;
  thread_replied: true;
  thread_lens_changed: true;
  thread_deleted: true;
  thread_restored: true;
  thread_routed: true;
  thread_status_changed: true;
  pairing_started: true;
  pairing_ended: true;
  seats_changed: true;
}
export type EventType = keyof EventTypeNames;

export interface BoardEvent {
  seq: number;
  at: string;
  actor: Actor;
  type: EventType;
  itemId?: string; // canvas block, group, link or task the event is about
  summary: string;
  mentions?: string[]; // who a comment or request @-mentions, so each agent reads it as for them or not
  commentId?: string; // the comment or thread message the event is about; events logged before this one don't say, and are found by their time
  // The one agent it's for: a person reacting to that agent's comment
  // (core/reactions.ts), or anything about a task assigned to that agent, but
  // the change of who it's assigned to. Other agents'
  // updates leave it out, but for one it @-mentions, so it wakes nobody else.
  forAgent?: string;
  // An agent's message to other agents that the loop guard holds
  // (core/agentTalk.ts): it wakes no agent's wait.
  held?: true;
}

// A person asking agents to bring the board context up to date with the
// board. It stays open until an agent finishes it or a person cancels it.
// A sync of all covers the blocks agents made: agents may add blocks, but not
// change people's. A sync of selected blocks covers exactly those, people's
// included: selecting one is its owner's OK. While it is open, agents may not
// change other blocks or add new ones.
export interface SyncRequest {
  by: Actor;
  at: string;
  blockIds?: string[]; // the blocks the person selected, in canvas order; none for a sync of all
}

// A person asking agents to generate something about the project into the
// board context, e.g. "Get me an architecture view of the project", or
// about blocks they selected on a Sketchbook page. A light request, not a
// task: an agent takes it, answers with blocks in a group made for it (or
// with the decision or tasks it asks for), and finishes it with a note. A
// person can cancel it until then.
export interface ContextRequest {
  id: string;
  text: string;
  by: Actor; // the person who asked
  at: string;
  status: 'open' | 'working' | 'done' | 'cancelled';
  takenBy?: Actor; // the agent answering it, once taken
  groupId?: string; // the group on the board context its answer goes in, made when taken
  note?: string; // the agent's one-line note on finishing
  doneAt?: string; // when it was finished or cancelled
  mentions?: string[]; // the agents it @-mentions: only they take it
  // Asked about a selection on a Sketchbook page (core/requests.ts): the
  // page, and the blocks it is about, in canvas order. Its group is made
  // beside them as it is asked, and its answer lands there.
  pageId?: string;
  blockIds?: string[];
  kind?: RequestKind; // none: anything, answered as blocks in its group
}

// What a request asks for, beyond blocks in its group: a card of a kind a part registered (the kinds of card a person can
// ask agents for from a Sketchbook page, core/askedCards.ts), or several. It is its answer, and finishes it. The names are
// the parts': a part adds its two.
export interface RequestKinds {}
export type RequestKind = keyof RequestKinds;

// A conversation on the board through which people work on the project with
// agents (core/threads.ts). Anyone starts one with a message, which titles
// it; agents answer in it. Kept in full: nothing in a thread is dropped.
export interface Thread {
  id: string;
  title: string; // from its first message; "General" for the General thread
  general?: true; // the board's General thread, where the Board Context's Ask agents bar used to post
  lens?: ThreadLens; // none: General
  door?: ThreadDoor; // where a person started it from the chat bar (core/doors.ts); none: an agent, or before doors
  pageId?: string; // the Sketchbook page whose chat bar a person started it from: what it asks is about that page
  // The blocks a person had selected on that page when they started it, in
  // canvas order: what it is about. It is a conversation first;
  // what agents make from it is pinned to those still there and shown in a
  // group beside them (core/threadSelection.ts).
  blockIds?: string[];
  groupId?: string; // that group, made beside the blocks when the first thing was made

  // The agent that owns it (core/roles.ts): the board's coordinator on one a
  // person started from a chat bar while a coordinator was on the board, an
  // orchestrator on one a coordinator sent work to. A person's message there
  // that @-mentions nobody is for it, and so is another agent's.
  owner?: string;
  status?: ThreadStatus; // where its owner's work stands: only on one a coordinator sent work to
  launch?: string; // the agent Tricot's terminal starts as its owner while none of that name is on the board, by its id ("claude")

  startedBy: Actor;
  startedAt: string;
  updatedAt: string; // its latest message
  messages: ThreadMessage[]; // oldest first
  // What agents made answering it ahead of their reply, which it then shows under.
  pending?: (ThreadRef & { by: Actor })[];
}

// Where a person started a thread: the chat bar over the board context (`canvas`, a part's), or the threads list, which
// is open-ended, and a door for each tab a part adds, aimed at what the tab holds (a part's cards).
// The words of a door are core/doors.ts's, and a part registers its own.
export interface ThreadDoors {
  canvas: true;
  threads: true;
}
export type ThreadDoor = keyof ThreadDoors;

// Where the work of a thread a coordinator sent work to stands (core/roles.ts):
// its owner at work, waiting on a person, or done. A person's message in one
// that waits or is done sets it back to work.
export type ThreadStatus = 'working' | 'needs-you' | 'done';

// What a thread looks at the project through, e.g. Legal or Design: agents
// answer in it as its brief says (core/threads.ts).
export interface ThreadLens {
  name: string;
  brief?: string; // how agents answer, in a sentence or two; General has none
  agent?: string; // the agent a person's messages are for when they @-mention nobody
}

// The lens a person asked for on one message, with ^Name in the chat bar
// (core/lensCommand.ts): agents answer that message through it, in place of
// the thread's lens, and the next message goes back to the thread's. A copy
// of what it was when sent: a preset by its name (its brief is read from
// LENSES), one of one's own with the brief too. It is never routed to an agent.
export type MessageLens = Pick<ThreadLens, 'name' | 'brief'>;

export interface ThreadMessage {
  id: string;
  author: Actor;
  body: string;
  at: string; // shared with its event, which finds one from the other
  lens?: MessageLens; // a person's ^Lens on this message alone; none: the thread's lens
  mentions?: string[]; // the board's agents and people it @-mentions (core/mentions.ts)
  skill?: SkillRequest; // a person's request that agents run a skill (core/skills.ts)
  via?: string; // an agent's reply to a skill request: the skill's name
  refs?: ThreadRef[]; // what it led to, shown under it as it is now
  reactions?: Reaction[]; // 👍, 👎 or 👀 from others, oldest first (core/reactions.ts)
  held?: number; // an agent's mention of another agent that the loop guard holds (Comment.held)
  sent?: { threadId: string; messageId: string }; // a coordinator's word that it sent this thread's message (messageId) on to another thread
  movedFrom?: string; // a person's message a coordinator moved here from the thread it was asked in, which held nothing else and is gone
}

// A card a thread's message led to: a card of a registered kind (a decision, a task: a part adds them), a
// block, or a comment on one of those cards (`on`).
export interface ThreadRefKinds {
  block: true;
  comment: true;
}
export interface ThreadRef {
  kind: keyof ThreadRefKinds;
  id: string;
  on?: string;
}

// A card a person deleted for good. Nothing of it is kept but this: its number stays taken, text that names it reads as
// deleted, and its id tells agents still holding it what happened. The kinds are the parts' (a card's kind is its canvas
// owner's name): a part adds its two.
export interface DeletedCardKinds {}
export interface DeletedCard {
  kind: keyof DeletedCardKinds;
  id: string;
  number: number;
  by: Actor;
  at: string;
}

// The thread a decision or task was made from; its title stays to name it
// should the thread be deleted.
export interface FromThread {
  id: string;
  title: string;
}

// A page of the Sketchbook: a canvas of its own for an idea being explored,
// with every kind of block, as the board context has. Its pins keep their own
// comment threads, as the board context's do: a page has no discussion.
export interface ScratchPage {
  id: string;
  title: string;
  rank: number; // its place among the pages, as people arranged them (core/scratchPad.ts)
  canvas: Canvas;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  agent?: PageAgent; // the agent that made it; none: a person made it, or it was made before agents' pages kept theirs
  files?: true; // the board's Files canvas: not a Sketchbook page, but the project files worked on (core/scratchPad.ts)
}

// The agent that made a Sketchbook page, often at a person's ask in its
// own terminal: "show me how signup works on Tricot". What a person asks on
// the page that @-mentions nobody is for it, from the chat bar or a
// selection, as a thread's lens can route a person's messages to one agent.
export interface PageAgent {
  name: string; // as the board names it
  tool?: string; // which agent it is, by its registry id (core/agents/registry.ts), from its MCP client; none: a client Tricot doesn't know
  asked?: string; // what the person asked to see, in their words
}

// The board's status: a short note on the project, in Markdown, that agents
// keep from the record, in plain words for someone who hasn't
// followed the board. Each write replaces the whole text; who wrote it last,
// and when, show with it.
export interface Standing {
  text: string;
  by: Actor;
  at: string;
}

export interface Board {
  id: string; // a slug of the title; renaming the board gives it a new one
  aliases?: string[]; // its earlier ids, oldest first, which still reach it
  title: string;
  goal?: string;
  folder?: string; // the project's checked folder, ~/… or a full path
  standing?: Standing; // the status, once an agent has written it
  archived?: { by: Actor; at: string }; // read-only until a person unarchives it
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  seq: number; // last event sequence number; doubles as the sync cursor
  canvas: Canvas; // context shared across the board's decisions
  // The Sketchbook: a canvas for each idea being explored, in the order
  // people arranged them. None until someone makes the first.
  pages?: ScratchPage[];
  syncRequest?: SyncRequest;
  synced?: { by: Actor; at: string; note?: string; blockIds?: string[] }; // the last finished sync, and what it covered
  // People asking agents on the board context, oldest first; the open ones and the
  // last few others. Asks go to the General thread now; older boards keep theirs.
  requests?: ContextRequest[];
  threads?: Thread[]; // conversations with agents, oldest first
  deleted?: Deletion[]; // canvas items removed lately, kept to restore, oldest first
  deletedCards?: DeletedCard[]; // cards people deleted for good, oldest first
  // What the event log says of who did what, kept small beside the board. The
  // log itself is not on the board: it is read from its own table when asked for.
  activity: BoardActivity;
}

// Who acted on a board and some moves of its tasks, from the event log (see
// core/activity.ts, which keeps it up as events are logged). Read from the log
// when the board loads, never saved with the board.
export interface BoardActivity {
  actors: ActorSeen[]; // whoever has acted, most recently first
}

export interface ActorSeen {
  actor: Actor; // as their latest event spells the name
  at: string; // when it was
}

// The id a board was created with. Links and tools use its current id (earlier
// ones still resolve), but whatever follows a board over time, such as event
// streams, presence and read cursors, keys on this one, so renames don't break it.
export function boardKey(board: Pick<Board, 'id' | 'aliases'>): string {
  return board.aliases?.[0] ?? board.id;
}

export interface BoardSummary {
  id: string;
  title: string;
  goal?: string;
  archived: boolean;
  updatedAt: string;
}
