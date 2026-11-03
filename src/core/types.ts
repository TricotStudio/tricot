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

export interface Option {
  id: string; // lettered per decision: a, b, c…
  label: string;
  description?: string;
  pros?: string[];
  cons?: string[];
  proposedBy: Actor;
  createdAt: string;
  // The last person to propose or reword it, whose option it stays: agents
  // leave it as it is (see optionPerson).
  person?: Actor;
  revisedAt?: string; // when its wording last changed
  // No longer applies, e.g. the app moved on. It stays visible, with its
  // marks and findings, but can't be picked or recommended.
  outdated?: { reason?: string; by: Actor; at: string };
}

// What a question, context or option said before someone reworded it, so
// nothing a decision offered is lost.
export interface Revision {
  field: 'question' | 'context' | 'label' | 'description';
  optionId?: string; // for an option's label or description
  before?: string;
  by: Actor;
  at: string;
}

// What a card offered at a moment, so a refresh can say what it changed.
export interface CardSnapshot {
  question: string;
  context?: string;
  options: { id: string; label: string; description?: string; outdated: boolean }[];
  recommendation?: string;
}

// A person asking agents to re-check a card against the app as it is now.
export interface RefreshRequest {
  text?: string;
  by: Actor;
  at: string;
  before: CardSnapshot; // the card as it was asked about
}

// The last refresh an agent finished: what it changed since it was asked (or
// in its own call, unasked), and its note.
export interface Refreshed {
  by: Actor;
  at: string;
  changes: string[];
  note?: string;
  requestedBy?: Actor;
}

// Another decision an agent says this one could change or rests on, and why
// in its words. It always shows in the card's "Could affect" list (affects.ts).
export interface Affect {
  decisionId: string;
  why: string;
  by: Actor;
  at: string;
}

export interface Resolution {
  optionId?: string;
  answer?: string; // free-form answer when none of the options fit
  rationale?: string;
  by: Actor;
  at: string;
}

// An answer that no longer stands, kept so a reopened or changed decision
// still shows who decided what before.
export interface PastAnswer extends Resolution {
  status: 'decided' | 'provisional';
  ended: 'replaced' | 'confirmed' | 'reopened' | 'explore' | 'deferred' | 'retired';
  endedBy: Actor;
  endedAt: string;
  label?: string; // the chosen option's label as it read then, in case it is reworded since
}

// A question routed to a named person. It stays pending until they next act
// on the decision: comment, answer, mark a criterion, defer or explore.
export interface Ask {
  name: string;
  by: Actor;
  at: string;
  note?: string;
  answeredAt?: string;
}

// Criteria are what a choice should be judged on. Anyone can propose them,
// but only people mark options against them: marks are human judgement.
export interface Criterion {
  id: string; // c1, c2…
  label: string;
  description?: string;
  proposedBy: Actor;
  createdAt: string;
}

export type MarkValue = 'yes' | 'partly' | 'no';

export interface Mark {
  criterionId: string;
  optionId: string;
  value: MarkValue;
  by: Actor;
  at: string;
}

export interface Note {
  text?: string;
  by: Actor;
  at: string;
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
  // commenting: on a Google Doc's paragraph, to edit it in the draft.
  ask?: true;
  // The board's agents and people it @-mentions, by name (core/mentions.ts).
  mentions?: string[];
  // A person's request that agents run one of their skills (core/skills.ts).
  skill?: SkillRequest;
  // An agent's reply to a skill request: the skill's name, which the reply shows it was made via.
  via?: string;
  reactions?: Reaction[]; // 👍, 👎 or 👀 from others, oldest first (core/reactions.ts)
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

// Evidence gathered while exploring: research, prototypes, measurements.
// Metrics keyed by name let the UI line options up in a comparison table.
export interface Finding {
  id: string;
  optionId?: string;
  author: Actor;
  summary: string;
  metrics?: Record<string, string | number>;
  links?: string[];
  createdAt: string;
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
  // block's line is the same, on its new side, with its path as `file`.
  | { kind: 'line'; file: string; line: number; side: DiffSide }
  // Words in a paragraph of the Google Doc a link block points to: the
  // paragraph by its id at a revision of the doc (p7, or n2 for one added in
  // the draft), and the words by the text around them. When a save or a newer
  // version renumbers the paragraphs, the pin follows its paragraph, and is
  // `gone` once it isn't there. `title` is the doc's, to name it by.
  | { kind: 'doc'; paragraph: string; revision: string; prefix: string; suffix: string; title?: string; gone?: true }
  // A chart's bar, point or slice: its category (the first column's value) and,
  // on a chart of several series, the series (its column's name), found again
  // by name when the data changes.
  | { kind: 'point'; category: string; series?: string }
  // A spot on a 3D scene: on one of its named objects (`object` its uuid when
  // it has one, `name` what it is called, found again by either), as a point
  // in that object's own coordinates, so the spot moves with the object; or,
  // on no named object, a point in the scene. `view` is where it was seen
  // from, in the scene's coordinates, which the scene turns back to. `n`
  // numbers it on the scene: spot 1, spot 2.
  | { kind: 'spot'; n: number; x: number; y: number; z: number; object?: string; name?: string; view?: SceneView }
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
  taskId?: string; // what it is linked to: a task…
  decisionId?: string; // …or a decision…
  discussion?: PinDiscussion; // …or neither: comments on the part
  author: Actor;
  createdAt: string;
}

// Comments on a pinned part. On a task's or decision's canvas they are in that
// card's discussion, each carrying the pin; the board context has no
// discussion, so there the pin keeps its own thread, which a person can mark
// resolved.
export interface PinDiscussion {
  thread?: Comment[]; // the board context's
  resolved?: { by: Actor; at: string };
}

export interface Canvas {
  blocks: Block[];
  groups: Group[];
  links: Link[];
  pins: Pin[];
}

export interface Decision {
  id: string;
  number: number; // per-board display number (#3)
  boardId: string;
  question: string;
  context?: string;
  options: Option[];
  recommendation?: { optionId: string; reason?: string; by: Actor; at?: string };
  status: Status;
  // A short theme it belongs to ("Connectors", "Name and mark"), which groups
  // it on the decision map. One a person set is theirs: agents leave it.
  area?: string;
  areaPerson?: Actor; // the person who set the area, if a person did
  blocking: boolean; // the poster cannot make progress until this is answered
  dependsOn: string[];
  affects?: Affect[]; // decisions an agent named that this one could change or rests on
  resolution?: Resolution;
  history: PastAnswer[];
  asks: Ask[];
  criteria: Criterion[];
  marks: Mark[];
  exploreRequest?: Note;
  planRequest?: Note; // a person asked agents to break this decision into tasks
  refreshRequest?: RefreshRequest;
  refreshed?: Refreshed;
  revisions?: Revision[]; // oldest first
  deferral?: Note;
  retirement?: Note; // why a person retired it
  comments: Comment[];
  findings: Finding[];
  canvas: Canvas;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  fromThread?: FromThread; // made by an agent answering a thread
}

// ---- tasks ----------------------------------------------------------------
// Work that implements settled decisions. A task goes stale when a decision it
// builds on changes, and stays stale until someone re-checks it. Tasks people
// add wait in the backlog, out of agents' reach, until a person marks them
// ready (to do).

// Dropped is a person setting a task aside as work that won't be done, as
// retiring does a decision: it leaves the lanes without counting as done, and
// can be brought back.
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'dropped';

// The lanes, in order. Dropped is out of them.
export const TASK_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done'];

export interface TaskNote {
  text: string;
  by: Actor;
  at: string;
}

// A person approving the work and its commit in one review ("Looks good,
// commit it"). The agent commits, then reports the hash. It holds only while
// the task is done: reopening the work drops it.
export interface TaskCommit {
  approvedBy: Actor;
  approvedAt: string;
  hash?: string; // reported by whoever committed it
  committedAt?: string;
}

// An agent's word that a task's work has nothing to commit (a plan, a spike, a
// cut-over): given with the review, so people are offered "Looks good" alone, or
// after a person approved a commit, which it answers. It holds while the task
// is in review or done.
export interface NoCommit {
  reason: string;
  by: Actor;
  at: string;
}

export interface Task {
  id: string;
  number: number; // per-board display number (T3)
  title: string;
  detail?: string;
  decisionIds: string[];
  status: TaskStatus;
  claimedBy?: Actor;
  links: string[]; // pull requests, branches
  notes: TaskNote[];
  stale?: { decisionId: string; reason: string; at: string };
  doneAt?: string; // when it last moved to done
  rank?: number; // its place in its lane, once a person placed it (taskOrder.ts)
  commit?: TaskCommit; // a person approved a commit of the work
  noCommit?: NoCommit; // there is nothing to commit, and why
  // The agent it is for, by name: only that agent claims it. None: any agent,
  // first to claim. Whoever set it; one a person set is theirs (agents leave it).
  assignee?: string;
  assignedBy?: Actor;
  // One agent's first take on a card a person added to the backlog
  // (core/firstLook.ts). None on tasks agents plan, and on older boards.
  firstLook?: FirstLook;
  dropped?: Note; // who dropped it as work that won't be done, and why, while it is dropped
  comments: Comment[]; // discussion with the agent doing the work
  canvas: Canvas; // context and results for this piece of work
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  fromThread?: FromThread; // planned by an agent answering a thread
}

// A short feasibility and approach comment on a card a person added to the
// backlog, from exactly one agent (and a mock on its canvas, for UI work).
// Open until an agent takes it with take_first_look; taken while that agent
// writes it, going back to open if no comment comes in time; done with the
// taker's comment. `mentions` are the agents the card's text @-mentions: only
// they take it (a task's assignee outranks them).
export type FirstLook =
  | { status: 'open'; openedAt: string; mentions?: string[] }
  | {
      status: 'taken';
      openedAt: string;
      mentions?: string[];
      by: Actor;
      takenAt: string;
      activeAt?: string; // the taker's last call about the card, which keeps it theirs
    }
  | { status: 'done'; openedAt: string; mentions?: string[]; by: Actor; takenAt?: string; doneAt: string; commentId: string };

export type EventType =
  | 'board_created'
  | 'decision_posted'
  | 'decision_updated'
  | 'option_added'
  | 'decision_resolved'
  | 'exploration_requested'
  | 'decision_deferred'
  | 'decision_reopened'
  | 'comment_added'
  | 'comment_reacted'
  | 'finding_attached'
  | 'canvas_changed'
  | 'decision_asked'
  | 'criteria_changed'
  | 'criterion_marked'
  | 'task_planned'
  | 'plan_requested'
  | 'task_updated'
  | 'task_reordered'
  | 'tasks_stale'
  | 'board_updated'
  | 'board_archived'
  | 'board_unarchived'
  | 'sync_requested'
  | 'sync_cancelled'
  | 'sync_finished'
  | 'decision_revised'
  | 'refresh_requested'
  | 'refresh_cancelled'
  | 'refresh_finished'
  | 'decision_retired'
  | 'request_asked'
  | 'request_taken'
  | 'request_finished'
  | 'request_cancelled'
  | 'first_look_taken'
  | 'first_look_lapsed'
  | 'thread_started'
  | 'thread_replied'
  | 'thread_lens_changed'
  | 'thread_deleted'
  | 'thread_restored'
  | 'task_dropped'
  | 'task_brought_back'
  | 'card_deleted';

export interface BoardEvent {
  seq: number;
  at: string;
  actor: Actor;
  type: EventType;
  decisionId?: string;
  itemId?: string; // canvas block, group, link or task the event is about
  taskId?: string; // the task the event is about, or whose canvas changed
  summary: string;
  mentions?: string[]; // who a comment or request @-mentions, so each agent reads it as for them or not
  commentId?: string; // the comment or thread message the event is about; events logged before this one don't say, and are found by their time
  // The one agent it's for: a person reacting to that agent's comment
  // (core/reactions.ts), or anything about a task assigned to that agent, but
  // the change of who it's assigned to (core/assignee.ts). Other agents'
  // updates leave it out, but for one it @-mentions, so it wakes nobody else.
  forAgent?: string;
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
// board context, e.g. "Get me an architecture view of the project". A light
// request, not a task: an agent takes it, answers with blocks in a group made
// for it, and finishes it with a note. A person can cancel it until then.
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
}

// A conversation on the board through which people work on the project with
// agents (core/threads.ts). Anyone starts one with a message, which titles
// it; agents answer in it. Kept in full: nothing in a thread is dropped.
export interface Thread {
  id: string;
  title: string; // from its first message; "General" for the General thread
  general?: true; // the board's General thread, where the Board Context's Ask agents bar used to post
  lens?: ThreadLens; // none: General
  door?: ThreadDoor; // where a person started it from the chat bar (core/doors.ts); none: an agent, or before doors

  startedBy: Actor;
  startedAt: string;
  updatedAt: string; // its latest message
  messages: ThreadMessage[]; // oldest first
  // What agents made answering it ahead of their reply, which it then shows under.
  pending?: (ThreadRef & { by: Actor })[];
}

// Where a person started a thread: the chat bar on the Decisions tab, the
// Tasks tab or the Board Context, each aimed at what that tab holds, or the
// threads list, which is open-ended (core/doors.ts).
export type ThreadDoor = 'decisions' | 'tasks' | 'canvas' | 'threads';

// What a thread looks at the project through, e.g. Legal or Design: agents
// answer in it as its brief says (core/threads.ts).
export interface ThreadLens {
  name: string;
  brief?: string; // how agents answer, in a sentence or two; General has none
  agent?: string; // the agent a person's messages are for when they @-mention nobody
}

export interface ThreadMessage {
  id: string;
  author: Actor;
  body: string;
  at: string; // shared with its event, which finds one from the other
  mentions?: string[]; // the board's agents and people it @-mentions (core/mentions.ts)
  skill?: SkillRequest; // a person's request that agents run a skill (core/skills.ts)
  via?: string; // an agent's reply to a skill request: the skill's name
  refs?: ThreadRef[]; // what it led to, shown under it as it is now
  reactions?: Reaction[]; // 👍, 👎 or 👀 from others, oldest first (core/reactions.ts)
}

// A card a thread's message led to: a decision, a task, a block, or a
// comment on a decision or task (`on`).
export interface ThreadRef {
  kind: 'decision' | 'task' | 'block' | 'comment';
  id: string;
  on?: string;
}

// The thread a decision or task was made from; its title stays to name it
// should the thread be deleted.
export interface FromThread {
  id: string;
  title: string;
}

// A task or decision a person deleted for good. Nothing of it is kept but
// this: its number stays taken, text that names it reads as deleted, and its
// id tells agents still holding it what happened.
export interface DeletedCard {
  kind: 'task' | 'decision';
  id: string;
  number: number;
  by: Actor;
  at: string;
}

export interface Board {
  id: string; // a slug of the title; renaming the board gives it a new one
  aliases?: string[]; // its earlier ids, oldest first, which still reach it
  title: string;
  goal?: string;
  archived?: { by: Actor; at: string }; // read-only until a person unarchives it
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  seq: number; // last event sequence number; doubles as the sync cursor
  nextDecisionNumber: number;
  canvas: Canvas; // context shared across the board's decisions
  syncRequest?: SyncRequest;
  synced?: { by: Actor; at: string; note?: string; blockIds?: string[] }; // the last finished sync, and what it covered
  // People asking agents on the board context, oldest first; the open ones and the
  // last few others. Asks go to the General thread now; older boards keep theirs.
  requests?: ContextRequest[];
  threads?: Thread[]; // conversations with agents, oldest first
  deleted?: Deletion[]; // canvas items removed lately, kept to restore (core/deletions.ts), oldest first
  deletedCards?: DeletedCard[]; // tasks and decisions people deleted for good, oldest first (core/cardLinks.ts)
  decisions: Decision[];
  tasks: Task[];
  nextTaskNumber: number;
  // What the event log says of who did what, kept small beside the board. The
  // log itself is not on the board: it is read from its own table when asked for.
  activity: BoardActivity;
}

// Who acted on a board and some moves of its tasks, from the event log (see
// core/activity.ts, which keeps it up as events are logged). Read from the log
// when the board loads, never saved with the board.
export interface BoardActivity {
  actors: ActorSeen[]; // whoever has acted, most recently first
  done: Record<string, TaskDone>; // by task id: its latest move to done
  reviewSentAt: Record<string, string>; // by task id: when it was last sent for review
}

export interface ActorSeen {
  actor: Actor; // as their latest event spells the name
  at: string; // when it was
}

export interface TaskDone {
  by: Actor;
  at: string;
  approved: boolean; // approved from review, rather than marked done from another lane
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
  counts: Record<Status, number>;
  blockingOpen: number;
}
