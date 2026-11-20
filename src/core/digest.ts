// Agent-facing renderings of the board: compact Markdown that tells an agent
// what it may build on, what is waiting on people, and where its cursor is.

import type { AgentBrowserHalf } from './agents/agent';
import { answerContext, discussionAt, quote, type Shown } from './answering';
import { blockLabel, blockPerson } from './canvas';
import { BoardCard, boardCardKindNamed, eventCards, findCard, namedCards } from './cards';
import { clip, peopleOn } from './format';
import { canvasesOf, pinAsk, pinComments, pinLost, pinPart, pinTarget, placePin, threadCanvases } from './pins';
import { filesPageOf, isFilesPage, pageName, pagesOf } from './scratchPad';
import { kindOf } from './blocks/registry';
import { askingWords, partAsks, partHooks, partOf } from './parts';
import { requestHeading, requestsDigest } from './requests';
import { threadGroupHeading } from './threadSelection';
import { commentLensNote, isThreadEvent, threadEventLine, threadsDigest, threadsSection } from './threads';
import { agentsIn, mentionEventLine, mentionsDigest, peopleIn } from './mentions';
import { reactionEventLine } from './reactions';
import { saying, type Told } from './words';
import type {
  Actor,
  Block,
  Board,
  BoardEvent,
  BoardSummary,
  Canvas,
  Comment,
  Pin,
  ScratchPage,
  SyncRequest,
} from './types';

export function who(actor: Actor): string {
  return `${actor.name} (${actor.kind})`;
}

// A comment as agents read it. One made on part of the card's canvas quotes
// the part, with its pin. `tag` says who it's for, when it @-mentions agents
// (mentionTag); `withId` gives its id, for get_task and get_decision, which
// react takes.
export function commentLine(comment: Comment, tag = '', withId = false): string {
  const asking = comment.ask ? `, ${askingWords(comment.askPart)?.asking}` : ''; // see partAsks
  const id = withId ? ` [comment id: ${comment.id}]` : '';
  const about = comment.pin ? ` on ${comment.pin.quote} [pin id: ${comment.pin.id}${asking}]` : '';
  const via = comment.via ? ` (via /${comment.via})` : '';
  return `- ${who(comment.author)} at ${comment.createdAt}${id}${about}${via}${tag}: ${comment.body}`;
}

// Archived boards come last, apart: they can be read for reference but not changed. A board's count of its decisions is
// said where a group offers them (`told`, core/words.ts): a server with none counts nothing.
export function boardListDigest(boards: BoardSummary[], told?: Told): string {
  if (boards.length === 0) return 'No boards yet. Create one with create_board.';
  const line = (b: BoardSummary) => {
    const goal = b.goal ? ` — ${b.goal}` : '';
    // The counts are a part's share of the entry (store/storePart.ts `summary`): a board whose entry has none says none.
    const { counts: held, blockingOpen } = b as { counts?: Record<string, number>; blockingOpen?: number };
    const blocking = blockingOpen ? `, ${blockingOpen} blocking` : '';
    const counts = held && told?.line('board.counts', { open: String(held.open), blocking, exploring: String(held.exploring), decided: String(held.decided + held.provisional) });
    return `- ${b.title} [id: ${b.id}]${goal}${counts ?? ''}`;
  };
  const active = boards.filter((b) => !b.archived);
  const archived = boards.filter((b) => b.archived);
  const lines = active.length ? active.map(line) : ['No active boards. Create one with create_board.'];
  if (archived.length) lines.push('', 'Archived (read-only):', ...archived.map(line));
  return lines.join('\n');
}

// `viewer` is the agent reading it: what's asked of it, and the tasks for it,
// say so. `now` is when, for first looks running out of time. `shown` is what
// the agent's session has read already, which it isn't told again (answering.ts).
// `kind` is which agent it is, for what a tag asks of it (mentions.ts taggedAsk).
// `told` is what a tool group says of the board here (core/words.ts): the chief of staff's cue, the areas, the board
// context's line, the status, the comment threads waiting on it, a sync of it, the requests asked on it, the first looks,
// refreshes and commits waiting on the agent, and the decisions and tasks, which a board read with none says nothing of.
export function boardDigest(board: Board, viewer?: string, now = Date.now(), shown?: Shown, kind?: AgentBrowserHalf, told?: Told): string {
  const lead = viewer ? told?.part('delegate', board, viewer) : undefined;
  const lines = [...(lead ? [lead, ''] : []), `# ${board.title} [id: ${board.id}]`];
  if (board.archived) {
    lines.push(`Archived by ${who(board.archived.by)} at ${board.archived.at}: read-only. Read it for reference; changes are refused.`);
  }
  if (board.goal) lines.push(`Goal: ${board.goal}`);
  if (board.folder) lines.push(`Project folder: ${board.folder}`);
  lines.push(`Cursor: ${board.seq} (pass as "since" to get_updates / wait_for_updates)`);
  const people = peopleOn(board).map((p) => p.name);
  lines.push(
    people.length
      ? saying(told, 'board.people', [
          ['people', `People: ${people.join(', ')}`],
          ['route', ''],
        ])
      : 'People: nobody has acted here yet.',
  );
  const areas = told?.part('areas', board, viewer);
  if (areas) lines.push(areas);
  const context = told?.part('context', board, viewer);
  if (context) lines.push(context);
  const standing = told?.part('standing', board, viewer);
  if (standing) lines.push(standing);
  const pad = scratchPadLine(board);
  if (pad) lines.push(pad);
  const files = filesLine(board);
  if (files) lines.push(files);
  for (const page of [undefined, ...pagesOf(board), ...(board.pages ?? []).filter(isFilesPage)]) {
    const line = page ? waitingLine(board, page) : told?.part('context-threads', board, viewer);
    if (line) lines.push(line);
  }
  const asks = partAsks(board, viewer);
  if (asks) lines.push(asks);
  const mentioned = mentionsDigest(board, viewer, shown, kind, told);
  if (mentioned) lines.push(mentioned);
  const sync = told?.part('sync', board, viewer);
  if (sync) lines.push(sync);
  const asked = requestsDigest(board, viewer, kind, told);
  if (asked) lines.push(asked);
  const talk = threadsDigest(board, viewer, shown, kind, told);
  if (talk) lines.push(talk);
  const looks = told?.part('first-looks', board, viewer, { now });
  if (looks) lines.push(looks);

  const refresh = told?.part('refresh', board, viewer);
  if (refresh) lines.push(refresh);
  const commits = told?.part('commits', board, viewer);
  if (commits) lines.push(commits);
  const talks = threadsSection(board, viewer, now, told);
  if (talks) lines.push('', talks);

  const cards = told?.part('cards', board, viewer);
  if (cards) lines.push(cards);
  return lines.join('\n');
}

// Where a pinned part is, for agents to find it, as its kind says: a box's
// fractions of the image, a spot's point on a 3D scene, the ids the Mermaid
// source gives a node or arrow, a line's text.
export function pinWhere(pin: Pin, block?: Block): string {
  return partHooks(pin.anchor.kind, block)?.where?.(pin) ?? '';
}

// Whether a pin links work: a card, which a server that offers no cards tells nothing of.
const holdsCard = (pin: Pin) => namedCards(pin).length > 0;
const pinsTold = (canvas: Canvas, told?: Told) => (told?.offers('cards') ? canvas.pins : canvas.pins.filter((pin) => !holdsCard(pin)));

// The pins on a block, as get_canvas lists them under it. A board context
// pin people commented on lists its thread under it, until it's resolved.
export function pinLines(board: Board, canvas: Canvas, block: Block, told?: Told): string[] {
  const owner = canvasesOf(board).find((o) => o.canvas === canvas) ?? {};
  return pinsTold(canvas, told)
    .filter((pin) => pin.blockId === block.id)
    .map((pin) => {
      const lost = placePin(block, pin) ? '' : ` (${pinLost(pin, block)})`;
      const pinned = `pinned ${pinPart(pin, block)}${pinWhere(pin, block)}${lost}`;
      if (pin.discussion) {
        const comments = pinComments(pin, owner);
        const count = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;
        // A part agents answer on reads with what people said about it, wherever it was said (a diff's or code block's line).
        const answeredOn = partHooks(pin.anchor.kind, block)?.answeredOn;
        const said =
          answeredOn
            ? `; answer on ${answeredOn} with comment(pin_id)${comments.map((c) => `\n    - ${who(c.author)} at ${c.createdAt}: ${c.body.replace(/\n/g, '\n      ')}`).join('')}`
            : '';
        // A person asking agents to edit a doc's paragraph, change a website's element or a code block's lines…: work, until an agent answers.
        const ask = pinAsk(comments);
        const words = ask ? partOf(block, pin.anchor.kind)?.ask : undefined;
        const request = words?.request ?? '';
        const act = words && waitsOnAgent(pin, comments) && !lost ? words.act : '';
        if (!pin.discussion.thread) return `${pinned} → ${request}${count} in the discussion, quoting it [pin id: ${pin.id}]${act && `; ${act}reply with comment(pin_id)`}${said}`;
        const { resolved } = pin.discussion;
        if (resolved) return `${pinned} → ${request}comment thread, resolved by ${who(resolved.by)}, ${count} [pin id: ${pin.id}]`;
        const thread = comments.map((c) => `\n    - ${who(c.author)} at ${c.createdAt}${c.ask ? ' (asking agents)' : ''}: ${c.body.replace(/\n/g, '\n      ')}`).join('');
        return `${pinned} → ${request}comment thread, open [pin id: ${pin.id}]; ${act}reply with comment(pin_id)${thread}`;
      }
      const target = pinTarget(board, pin);
      const to = target ? `${target.ref} (${target.status})` : 'work that is gone';
      const linked = namedCards(pin)[0];
      const ids = linked ? `${linked.kind} id: ${linked.id}; ` : '';
      return `${pinned} → ${to} [${ids}pin id: ${pin.id}]`;
    });
}

// Whether a pin's comments wait on an agent: open, and a person's last.
export function waitsOnAgent(pin: Pin, comments: Comment[]): boolean {
  return !pin.discussion?.resolved && comments.at(-1)?.author.kind === 'human';
}

// How many comment threads wait for a reply on one canvas, the board context (no page) or a Sketchbook page.
// Requests to edit a doc or change a website are named on their own (partAsks), as work.
export function threadsWaiting(board: Board, page?: ScratchPage): number {
  return threadsAwaitingReply(board).filter((waiting) => waiting.page === page && !pinAsk(waiting.pin.discussion!.thread!)).length;
}

// The line that says so for a Sketchbook page, none when none wait.
export function waitingLine(board: Board, page: ScratchPage): string | undefined {
  const threads = threadsWaiting(board, page);
  if (!threads) return undefined;
  const on = `${pageName(page)} [page id: ${page.id}]`;
  const many = threads === 1 ? `thread on ${on} waits` : `threads on ${on} wait`;
  return `${threads} comment ${many} for a reply: read them in get_canvas(page_id) and answer with comment(pin_id).`;
}

// Comment threads on the board context and the Sketchbook's pages whose
// last word is a person's, for an agent to answer, with the page each is on.
export function threadsAwaitingReply(board: Board): { pin: Pin; page?: ScratchPage }[] {
  return threadCanvases(board).flatMap(({ canvas, page }) =>
    canvas.pins
      .filter((pin) => {
        const thread = pin.discussion?.thread;
        return Boolean(thread?.length) && !pin.discussion!.resolved && thread!.at(-1)!.author.kind === 'human';
      })
      .map((pin) => ({ pin, page })),
  );
}

// The Sketchbook's pages, for agents to find one: each a canvas for an idea
// being explored. None until someone makes the first.
function scratchPadLine(board: Board): string | undefined {
  const pages = pagesOf(board);
  if (pages.length === 0) return undefined;
  const listed = pages.map((page) => {
    const blocks = page.canvas.blocks.length;
    return `"${clip(page.title, 60)}" [page id: ${page.id}] (${blocks ? `${blocks} block${blocks === 1 ? '' : 's'}` : 'empty'})`;
  });
  return `Sketchbook: ${pages.length} page${pages.length === 1 ? '' : 's'}, each a canvas for an idea being explored: ${listed.join(', ')}. Read one with get_canvas(page_id) and work on it as on any canvas (add_block(page_id)…); make one with add_page.`;
}

// The board's Files canvas, when someone has worked on a file:
// a code block for each, where people pair on them, so agents can find it.
function filesLine(board: Board): string | undefined {
  const page = filesPageOf(board);
  const held = page?.canvas.blocks.length ?? 0;
  if (!page || !held) return undefined;
  return `Files: the project files people edited or paired on, ${held} code block${held === 1 ? '' : 's'} [page id: ${page.id}]. Their pins are asks about the file itself: change the file, then answer. Read it with get_canvas(page_id).`;
}
export function readingOrder<T extends { x: number; y: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}

export function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// The content of a block as an agent should read it.
export function blockContentDigest(block: Block, full = false): string {
  return kindOf(block.type).digest(block, full);
}

// `sync` is the open sync request, on the board context: each block it may
// touch or must leave says so. Its pins follow its content.
function blockEntry(board: Board, canvas: Canvas, block: Block, owner: BoardCard | undefined, sync?: SyncRequest, told?: Told): string {
  const meta = [`[id: ${block.id}]`, `rev ${block.rev}`];
  const evidence = owner?.blockNote(block);
  if (evidence) meta.push(evidence);
  meta.push(`by ${who(block.author)}`);
  if (block.updatedBy.name !== block.author.name || block.updatedBy.kind !== block.author.kind) {
    meta.push(`last edited by ${who(block.updatedBy)}`);
  }
  const mark = sync && syncMark(block, sync);
  if (mark) meta.push(mark);
  const pins = pinLines(board, canvas, block, told).map((line) => `\n  ${line}`).join('');
  // A link is all label and address, so it fits on its line: link "Design file" → https://…
  if (kindOf(block.type).inline) return `- ${blockLabel(block)} ${blockContentDigest(block)} ${meta.join(' · ')}${pins}`;
  return `- ${blockLabel(block)} ${meta.join(' · ')}\n${indent(blockContentDigest(block))}${pins}`;
}

// During a sync of all, a person's block is theirs to leave; during a sync of
// selected blocks, each block is in it or not, whoever's it is.
function syncMark(block: Block, sync: SyncRequest): string | undefined {
  const person = blockPerson(block);
  if (!sync.blockIds) return person && `${person.name}'s block: leave it during this sync`;
  const mark = sync.blockIds.includes(block.id) ? 'in this sync' : 'leave it during this sync';
  return person ? `${person.name}'s block: ${mark}` : mark;
}

// The card a canvas belongs to, if it belongs to one: its id is enough, the registered kinds (cards.ts) say the rest.
interface CanvasCard {
  id: string;
}

export function canvasDigest(board: Board, canvas: Canvas, held?: CanvasCard, page?: ScratchPage, told?: Told): string {
  const owner = held && findCard(board, held.id);
  const heading = owner
    ? `# Canvas of ${owner.label} ${owner.title} [${owner.kind.kind} id: ${owner.id}]`
    : page && isFilesPage(page)
        ? `# Files of ${board.title}: the project files people edited or paired on [page id: ${page.id}; board id: ${board.id}]`
        : page
        ? `# Sketchbook page "${page.title}" of ${board.title} [page id: ${page.id}; board id: ${board.id}]`
        : `# Board context: ${board.title} [board id: ${board.id}]`;
  const { blocks, groups, links } = canvas;
  const lines = [heading];
  // The board context is read with the board's status, which isn't on it.
  const standing = !held && !page ? told?.part('standing', board) : undefined;
  if (standing) lines.push(standing, '');
  if (blocks.length === 0 && groups.length === 0) {
    lines.push('Empty. Add context with add_block.');
    return lines.join('\n');
  }
  const pins = pinsTold(canvas, told).length;
  const pinned = pins
    ? saying(told, 'canvas.pins', [
        ['pins', `, ${pins} pin${pins === 1 ? '' : 's'} (parts of blocks `],
        ['linked', ''],
        ['commented', 'commented on, listed under their block)'],
      ])
    : '';
  lines.push(
    `${blocks.length} blocks, ${groups.length} groups, ${links.length} links${pinned}. Blocks are listed in reading order; people may have arranged, edited or ticked things since you last looked.`,
  );
  const sync = held || page ? undefined : board.syncRequest;
  const syncing = sync ? told?.part('sync', board) : undefined;
  if (syncing) lines.push(syncing);

  for (const group of readingOrder(groups)) {
    const members = readingOrder(blocks.filter((b) => b.groupId === group.id));
    const answers = held ? '' : requestHeading(board, group.id, told) || threadGroupHeading(board, group.id, told);
    lines.push('', `## Group "${group.title}" [id: ${group.id}]${answers}`);
    lines.push(...(members.length ? members.map((b) => blockEntry(board, canvas, b, owner, sync, told)) : ['(empty)']));
  }
  const loose = readingOrder(blocks.filter((b) => !b.groupId));
  if (loose.length) {
    lines.push('', groups.length ? '## Not in a group' : '## Blocks', ...loose.map((b) => blockEntry(board, canvas, b, owner, sync, told)));
  }
  if (links.length) {
    lines.push('', '## Links');
    for (const link of links) {
      const from = blocks.find((b) => b.id === link.from);
      const to = blocks.find((b) => b.id === link.to);
      if (!from || !to) continue;
      const said = link.label ? `: "${clip(link.label, 80)}"` : '';
      const weight = link.weight ? ` (${link.weight} line)` : '';
      lines.push(`- ${blockLabel(from)} → ${blockLabel(to)}${said}${weight} [id: ${link.id}] by ${who(link.author)}`);
    }
  }
  return lines.join('\n');
}

// A person's comment or thread message that reaches the agent reading its
// updates without asking an agent by name (mentionEventLine and
// threadEventLine say those): whole, with the call that answers it and what
// its session needs to (answering.ts). Not one for people (it @-mentions
// them), on a card (the group that has cards says how to reply: its `card-reply` part, which
// is none on another agent's task), or that an agent has answered since: those read as logged.
function personLine(e: BoardEvent, board: Board, viewer: string | undefined, shown: Shown | undefined, target: string, logged: string, told?: Told): string | undefined {
  if (e.actor.kind !== 'human' || !viewer || (e.type !== 'comment_added' && !isThreadEvent(e))) return undefined;
  if (agentsIn(board, e.mentions).length || peopleIn(board, e.mentions).length) return undefined;
  const found = discussionAt(e, board);
  if (!found) return undefined;
  const { discussion, said } = found;
  if (said.paired) return undefined; // a pairing session's summary asks nothing
  if (discussion.items.slice(discussion.items.indexOf(said) + 1).some((m) => m.author.kind === 'agent')) return undefined;
  const onCard = eventCards(e).length > 0;
  const cardReply = onCard ? told?.part('card-reply', board, viewer, { events: [e] }) : undefined;
  if (onCard && !cardReply) return undefined;
  const short = `: "${clip(said.body, 200)}"`; // as the event logged it
  if (!logged.includes(short)) return undefined;
  const summary = logged.replace(short, quote(said.body, said.id, shown));
  const reply = onCard ? cardReply : isThreadEvent(e) ? undefined : `comment(pin_id: ${e.itemId})`;
  const lens = isThreadEvent(e) ? undefined : commentLensNote(said);
  const line = `- (${e.seq}) ${who(e.actor)} ${summary}${target}${reply ? `. Reply with ${reply}.` : ''}${lens ? ` ${lens}` : ''}`;
  return [line, ...answerContext(discussion, said, viewer, shown)].join('\n');
}

// An event's summary as the log has it, where a server that offers no board context says none: the log names it after
// a comment on a pinned part wherever the part is, a page's included.
function loggedSummary(event: BoardEvent, told?: Told): string {
  return told?.offers('board-context') ? event.summary : event.summary.replace(' (board context)', '');
}

// `told` is what a tool group says here (core/words.ts): the line about a card people changed, and whether the board context is named. `about` is the board and the agent reading it: a comment, request or
// thread message that @-mentions agents reads as asked of it, or as for them
// (mentionEventLine, threadEventLine), and a person's reaction to its comment
// as to "your comment" (reactionEventLine). A person's message for it comes
// whole, with what its session (`shown`) needs to answer it, and what a tag
// asks of it (`kind`: which agent it is).
export function eventsDigest(events: BoardEvent[], cursor: number, about?: { board: Board; viewer?: string; shown?: Shown; kind?: AgentBrowserHalf }, more = false, told?: Told): string {
  if (events.length === 0) return `No new activity. Cursor: ${cursor}`;
  const lines = events.map((e) => {
    const addressed =
      about &&
      (mentionEventLine(e, about.board, about.viewer, about.shown, about.kind) ??
        threadEventLine(e, about.board, about.viewer, about.shown, about.kind, told) ??
        reactionEventLine(e, about.board, about.viewer));
    if (addressed) return addressed;
    // A board context thread's comments are about its pin.
    const cards = eventCards(e);
    const pin = e.type === 'comment_added' && cards.length === 0 && e.itemId;
    const thread = isThreadEvent(e) && e.itemId;
    const tagged = cards.find((card) => boardCardKindNamed(card.kind)?.idInEvents);
    const target = tagged ? ` [id: ${tagged.id}]` : pin ? ` [pin id: ${pin}]` : thread ? ` [thread id: ${thread}]` : '';
    const logged = loggedSummary(e, told);
    return (about && personLine(e, about.board, about.viewer, about.shown, target, logged, told)) || `- (${e.seq}) ${who(e.actor)} ${logged}${target}`;
  });
  // A person changing what a card offers may change what's best on it: a line of the group that has cards.
  const changed = [...new Set(events.filter((e) => e.actor.kind === 'human').flatMap((e) => eventCards(e).filter((card) => boardCardKindNamed(card.kind)?.revisedEvent === e.type).map((card) => card.id)))];
  const revised = changed.length ? told?.line('events.revised', { ids: changed.join(',') }) : undefined;
  if (revised) lines.push(revised);
  const next = more ? [`There are more updates after these: call get_updates with since: ${cursor} for the next page.`] : [];
  return [...lines, ...next, '', `Cursor: ${cursor}`].join('\n');
}
