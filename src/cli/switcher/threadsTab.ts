// The Tricot tab's chat and the board's threads: what is shown and what its
// keys do (chatView.ts draws the stream, threadsView.ts the threads' panel at
// its side and the foot they share). The tab (tricotTab.ts) opens on the
// stream; it hands this every key while it shows, and asks it to draw.
//
//   the stream     the chat's main view (T21): every conversation on the board
//                  as one, oldest first (core/chatStream.ts), with a line under
//                  it that answers the latest message from someone else: in
//                  its thread, its task's or decision's discussion, or about
//                  its pinned part. With no message from anyone else it starts
//                  a thread, and so does a line that begins with @ (an @Claude
//                  first aims it at Claude); > and a place sends elsewhere
//                  (chatAim.ts: >T19, >#7, > and part of a thread's title),
//                  which Tab completes. Where it goes is fixed from the first
//                  character typed, so a message arriving meanwhile doesn't
//                  move it; an empty line follows the latest again.
//                  Tab on an empty line chooses a message to answer: the latest
//                  of someone else's, then each Tab (or ↑) one further back,
//                  Shift+Tab (or ↓) one later, marked with ❯; 1 2 3 react to
//                  it, and what is typed then answers it.
//                  ↑ ↓ scroll a line otherwise, Page Up Page Down a page, Home
//                  the oldest, End the latest (Home and End move the cursor
//                  while something is typed); the mouse's wheel scrolls it
//                  three lines a turn, whatever has the keys, while it is
//                  in view (T30). Enter brings a stream scrolled
//                  up back to the latest: on an empty line that is all it
//                  does, and sending goes there too; the row above the line
//                  says so, while typing as well. Esc clears what is typed; on an
//                  empty line it goes back from a message chosen, or a new
//                  thread asked for, to the latest; then from a thread picked
//                  to everything; and with none of those it opens the threads'
//                  panel. /new comes back to it with its line starting a new
//                  thread (as a lens chosen with Ctrl+L for one does); a thread
//                  started from it is picked, as if from the panel.
//   the panel      /threads (or t in the tab's status view) opens the threads
//                  beside the stream, or over it in a narrow window, and takes
//                  the keys: ↑ ↓ or k j move the highlight, wrapping round;
//                  Home End the first or last row; Enter picks the thread
//                  highlighted (or shows the rest of Earlier); n starts a new
//                  thread as /new does; l (or Ctrl+L) sets the lens of the
//                  thread highlighted; x asks to delete it (No by default), u
//                  undoes the latest deletion; / opens the local commands; Esc
//                  closes it, and goes back to the status view when it was
//                  opened from there.
//   a thread picked  the stream shows that thread alone, at its latest, and its
//                  line answers it (an @ at its start is a mention, not a new
//                  thread; > still sends elsewhere); the panel stays beside it,
//                  its highlight on the thread, and is out of sight in a
//                  narrow window. The line has the keys, as on the stream, Tab
//                  choosing a message of the thread's to react to and Ctrl+L
//                  setting its lens. Esc on its empty line goes back to the
//                  whole stream, the panel (if it was open) taking the keys
//                  again with the same thread highlighted; Esc there closes it.
//   the lens       l in the panel, or Ctrl+L on the line, lists the lenses in
//                  the panel's place, the page's way (threadsLens.ts): the
//                  presets, the lenses of the person's own that threads on the
//                  board have, and New lens…, which asks for a name and then a
//                  brief on the line at the foot. ↑ ↓ or k j move the
//                  highlight, starting on the thread's lens (marked ✓); Enter
//                  sets it, as the board is told, and Esc cancels. For a
//                  thread not started yet (Ctrl+L on the stream's line) Enter
//                  keeps the lens until its first message is sent, and the
//                  line then starts one; the row under it says first that it
//                  starts a new thread, with that lens unless it is General.
//   the commands   / in the panel or in the status view opens a line of the
//                  local commands, /status, /threads, /new, /add, /stop, /open
//                  and /quit (tabCommands.ts), without touching what is typed
//                  on the stream's line; Enter goes, Esc goes back. Typed on
//                  the stream's line, a command alone does the same, and is
//                  never sent. The row under the line says what Enter runs.
//                  /add, /stop, /open and /quit are the tab's (tricotTab.ts):
//                  the line closes first, back where it was opened from.
//
// The board is read (threadsRead.ts) when the tab first shows the chat, and
// again each time the board's stream says its conversations changed (live.ts
// chatVer: a thread, a comment on a card or a pinned part, the title of the
// card one is on; and when the stream connects again), so a new thread,
// message or comment shows as it comes, in the stream and the panel. The
// stream at its latest stays there as more come; one scrolled up stays where
// it is, kept by the item its first row is in. A thread picked that is
// deleted meanwhile gives way to the whole stream. The keys that scroll lay
// out only the lines they pass over, from the layout the frames draw from
// (chatView.ts ChatLayout). The host's tick draws the chat again only once a
// time it says would change: a head's "12 min ago", or a thread's in the panel.
//
// What waits on the person is the page's (core/threadList.ts), from what they
// have seen of each thread. That is kept here, in this process, and starts as
// the page's does on a first visit: every thread seen as it stands when they
// are first read. A thread whose latest message the stream shows to its end
// is seen (a thread picked is shown at its latest), and not one scrolled out
// of it; the panel beside it says so in the same frame.
//
// A message goes to the board as the person (threadsSend.ts) and shows at
// once in the stream, marked as sending, until the board has it; if the
// board refuses, the text is back on the line, aimed where it was sent, with
// why under it. A new thread waits for the board before it is picked. Under
// the line it says where the message goes and who will get it (chatAim.ts,
// threadsWho.ts). What is typed on the stream's line stays while the panel,
// the lens picker or the commands have the keys.
//
// A lens set, a reaction left or a thread deleted goes to the board as the
// person too, and the board's answer (the thread, or the message with its
// reactions as they are now) is put among the threads as a reply's is, so it
// shows at once. One of each is on its way at a time, and a refusal is said
// where the person is looking (in the picker or the panel, or under the line)
// with the choice kept. A reaction to a comment goes by where the comment is.
import { chatStream, type ChatItem, type ChatPlace } from '../../core/chatStream';
import { replyPlaceholder, type Where } from '../../core/delivery';
import { samePerson } from '../../core/format';
import { agentStateWords, boardAgents, boardPeople, findMentions, readTagTyping, readTyping } from '../../core/mentions';
import { EMOJIS, hasReaction, type Emoji } from '../../core/reactions';
import type { AgentSkills } from '../../core/skills';
import { threadGroups, type ThreadGroups, type ThreadsSeen } from '../../core/threadList';
import { lensChoice, presetLens, shownTitle } from '../../core/threads';
import type { Board, Thread, ThreadLens, ThreadMessage } from '../../core/types';
import { ago, type TabFrame } from './tabView';
import { aimRow, answerable, latestFrom, named, placeChoices, reactOn, replyOn, threadPlace, withComment, type CardPlace } from './chatAim';
import { linkTo } from '../../core/pages';
import { ChatLayout, chatGeometry, compareAt, conversationOf, renderChat, type CardLinks, type ChatFrame, type ChatLines, type ChatTop } from './chatView';
import type { BoardLive, Rgb, Tone, Working } from './strip';
import type { TabKey } from './tabKeys';
import { agentOf, choiceLabel, choiceNote, colonAfterName, completionAt, tabbed, type Choice, type Cycle, type Places, type Roster } from './threadsComplete';
import { OWN_STEPS, lensPicked, lensRows } from './threadsLens';
import { Line, editLine } from './threadsLine';
import type { ThreadsRead } from './threadsRead';
import type { CommentSent, ThreadSent, ThreadsSend } from './threadsSend';
import { choiceRows, composeFoot, cursorAcross, inputRows, inputWidth, itemId, listItems, panelGeometry, safe, type Compose, type LensRow, type LensView, type ListItem, type PanelView } from './threadsView';
import { hearsIt, heardBy } from './threadsWho';
import { TAB_COMMAND_LIST, tabCommand, tabCommandWords, type TabCommand } from './tabCommands';

// What the threads need of the board: who is asking, the board, read, what
// each agent can be asked to run, and sending as the person.
export interface ThreadsAccess {
  me: string; // the person's name, as the board has it (what answers.ts acts as)
  read(): Promise<ThreadsRead>;
  skills(): Promise<AgentSkills[]>; // for "/"; none when it can't be read
  send: ThreadsSend;
}

export interface ThreadsHost {
  access?: ThreadsAccess; // none: there is no board to read them from
  live(): BoardLive | undefined;
  now(): number;
  changed(): void; // draw it again
  agents(): string[]; // the agents this terminal runs, to name one that isn't listening
  askSeat(): void; // asks for this terminal to be let in, when the board says it must be
  seatWords(): string | undefined; // what that asking waits on, while it does
  navigate?(command: TabCommand): void;
  working?(): Working[]; // the agents working now, for the row above the line (T38)
}

const NO_THREADS = { waiting: [], recent: [], earlier: [] } satisfies ThreadGroups;

// What is typed on a line, and why it did not go.
interface Draft {
  line: Line;
  problem?: { text: string; needsSeat?: boolean };
}

// The lens picker, open for a thread (by id) or for the new one: the row
// highlighted, whether the board is setting one, why it did not, and, while a
// lens of one's own is being asked for, the step it is at and what is typed.
interface LensMenu {
  for: string;
  at: number;
  busy: boolean;
  problem?: { text: string; needsSeat?: boolean };
  own?: { step: 'name' | 'brief'; name: string; line: Line };
}

interface DeleteMenu {
  thread: Thread;
  yes: boolean;
  busy: boolean;
  problem?: { text: string; needsSeat?: boolean };
}

// A message on its way, shown in the stream at its place as sending until the board has it.
interface Outgoing {
  id: string;
  place: ChatPlace;
  text: string;
  known: Set<string>; // the conversation's messages before it, to tell it from what arrives
}

// Where the stream's line sends what is typed: a new thread; a place, with
// the message to send there and how it was aimed there (at the latest from
// someone else, at a message chosen, at the thread picked, by > and its name,
// or as it was when typing began); or nowhere, and why.
type Aim =
  | { kind: 'new' }
  | { kind: 'place'; place: ChatPlace; text: string; how: 'latest' | 'chosen' | 'picked' | 'named' | 'held' }
  | { kind: 'unknown'; why: string };

// Where the stream's line was aimed when typing began, kept until it is empty again.
interface Held {
  place: ChatPlace | 'new';
  chosen: boolean; // at a message chosen with Tab
}

// Where a key scrolls the stream's lines (`laid`), `body` of them shown from
// `top`: ↑ ↓ a line, Page Up and Page Down a page, Home the first, End the
// latest. None for a key that doesn't scroll. Only the lines it passes over
// are laid out.
function scrolled(top: ChatTop, key: TabKey, laid: ChatLines, body: number): ChatTop | undefined {
  if (key.kind === 'home') return laid.top({ item: 0, line: 0 }, body);
  if (key.kind === 'end') return 'end';
  const page = Math.max(1, body - 1);
  const step = ({ up: -1, down: 1, pageup: -page, pagedown: page } as Partial<Record<TabKey['kind'], number>>)[key.kind];
  return step === undefined ? undefined : laid.top(laid.move(laid.find(top, body), step), body); // at the latest, it stays there as more come
}

// Where the stream's lines (`laid`) shown from `top` scroll to, if they must,
// so the message at `index` shows: its start, if it is taller than the `body`.
function revealed(top: ChatTop, laid: ChatLines, index: number, body: number): ChatTop {
  const first = { item: index, line: 0 };
  const end = { item: index, line: laid.of(index).length - 1 };
  const now = laid.find(top, body);
  const lowest = laid.move(end, 1 - body); // the first line shown with the message's last at the bottom
  const to = compareAt(first, now) < 0 ? first : compareAt(end, laid.move(now, body)) >= 0 ? (compareAt(first, lowest) < 0 ? first : lowest) : now;
  return laid.top(to, body);
}

const mine = (author: ChatItem['author'], me: string) => author.kind === 'human' && samePerson(author.name, me);

// The keys of what is typed: the stream's line, and the local commands' line.
const NEW = '\u0000new';
const NAVIGATION = '\u0000navigation';
// What "/" lists is read again when a "/" is typed after this long.
const SKILLS_FRESH_MS = 60_000;

export class ThreadsTab {
  showing = false;
  private board: Board | undefined; // as last read; none before
  private seen: ThreadsSeen | null = null; // the last message seen in each thread, by id: none until they are first read
  private failed: string | undefined; // why the last reading didn't work
  private reading = false;
  private readFor: number | undefined; // the live count (chatVer) the board was last read at
  private readSeq = 0; // readings begun
  private appliedSeq = 0; // the latest begun that has been taken
  private staleBefore = 0; // readings begun up to this are older than what a send brought back
  private panel = false; // the threads' panel is open
  private panelFromStatus = false; // and was opened from the tab's status view, which closing it goes back to
  private at: string | undefined; // the panel's row highlighted (threadsView.ts itemId)
  private allEarlier = false;
  private picked: string | undefined; // the thread picked from the panel, by id: the stream shows it alone
  private size = { cols: 80, rows: 24 }; // as last drawn: what keys scroll by
  private streamTop: ChatTop = 'end'; // the stream's first line shown, or its latest
  private streamOf: { board: Board; items: ChatItem[] } | undefined; // the stream as last gathered, from the board as read then
  private cardsOf: { board: Board; cards: CardLinks } | undefined; // the cards linked, from the board as read then
  private shownOf: { all: ChatItem[]; picked: string; items: ChatItem[] } | undefined; // the thread picked's items, as last gathered
  private readonly layout = new ChatLayout(); // the stream's items laid out, kept from frame to frame
  private drawn: { now: number; times: string[]; panel: boolean; working: string } | undefined; // the frame last drawn, for what the time alone changes in it
  private chosen: string | undefined; // the message in the stream chosen with Tab, by key: the line answers it
  private aimNew = false; // the stream's line starts a new thread, asked for with /new or a lens
  private held: Held | undefined; // where the stream's line was aimed when typing began
  private navigating: { fromStatus: boolean } | undefined; // the local commands' line, and whether the status view opened it
  private newLens: ThreadLens | undefined; // the lens a new thread begins with: none is General
  private reacting = false; // a reaction is on its way
  private lens: LensMenu | undefined;
  private deleting: DeleteMenu | undefined;
  private undo: Thread | undefined;
  private restoring = false;
  private listProblem: { text: string; needsSeat?: boolean } | undefined;
  private posting = false; // a new thread is on its way
  private readonly drafts = new Map<string, Draft>();
  private outgoing: Outgoing[] = [];
  private sent = 0;
  private cycle: (Cycle & { line: Line }) | undefined; // Tab pressed, and not yet moved on from
  private skills: AgentSkills[] = [];
  private skillsAt: number | undefined;
  private loadingSkills = false;

  constructor(private readonly host: ThreadsHost) {}

  // Whether what is typed goes to a line, so a letter is not a command of the tab's.
  get typing(): boolean {
    return this.showing && (this.navigating !== undefined || this.lens?.own !== undefined || this.target() === NEW);
  }

  show(): void {
    this.showing = true;
    if (this.failed) {
      this.failed = undefined;
      this.readFor = undefined; // asked for again
    }
  }

  // The chat as it was left, at its latest: from the tab's status view.
  chat(): void {
    this.navigating = undefined;
    this.lens = undefined;
    this.streamTop = 'end';
    this.show();
  }

  // The stream, with the line under it: `fresh` (/new), the whole stream,
  // the panel closed, and the line starting a new thread rather than
  // answering the latest.
  start(fresh = false): void {
    this.navigating = undefined;
    this.lens = undefined;
    this.streamTop = 'end';
    if (fresh) {
      this.panel = false;
      this.panelFromStatus = false;
      this.picked = undefined;
      this.aimNew = true;
      this.chosen = undefined;
      if (this.held) this.held = { place: 'new', chosen: false }; // and what is typed already goes there too
    }
    this.show();
  }

  // The threads' panel, with the keys: the whole stream beside it, the thread
  // that was picked highlighted.
  list(): void {
    const fromStatus = !this.showing || this.navigating?.fromStatus === true;
    this.navigating = undefined;
    this.lens = undefined;
    if (this.picked !== undefined) this.unpick();
    this.chosen = undefined;
    this.panelFromStatus = fromStatus || (this.panel && this.panelFromStatus); // open already: from where it was
    this.panel = true;
    this.show();
  }

  // The local commands' line: `fromStatus`, opened from the tab's status view, which Esc goes back to.
  commands(fromStatus = false): void {
    this.lens = undefined;
    this.navigating = { fromStatus };
    this.draftOf(NAVIGATION).line.set('/');
    this.show();
  }

  hide(): void {
    this.navigating = undefined;
    this.showing = false;
  }

  // ---- reading them -----------------------------------------------------------------------

  // Reads the threads if the board's stream says they may have changed since.
  private sync(): void {
    const live = this.host.live();
    const access = this.host.access;
    if (!access || !live || this.reading) return;
    const version = live.chatVer ?? 0;
    if (this.readFor === version) return;
    this.reading = true;
    const seq = ++this.readSeq;
    void access.read().then((result) => {
      this.reading = false;
      // One begun before what a send brought back, or before one already taken, is out of date: read again.
      const old = seq <= this.staleBefore || seq < this.appliedSeq;
      this.readFor = old ? undefined : version; // a failure waits for the next change, or for the tab to be opened again
      if (!old) {
        this.appliedSeq = seq;
        if (result.ok) this.take(result.board);
        else this.failed = result.error;
      }
      this.host.changed();
    });
  }

  private take(board: Board): void {
    this.failed = undefined;
    this.board = board;
    const deleting = this.deleting;
    if (deleting && !deleting.busy && !board.threads?.some((t) => t.id === deleting.thread.id)) this.deleting = undefined;
    if (this.undo && !this.restoring && board.threads?.some((t) => t.id === this.undo!.id)) this.undo = undefined;
    const threads = board.threads ?? [];
    this.seen ??= Object.fromEntries(threads.flatMap((t) => (t.messages.length ? [[t.id, t.messages.at(-1)!.id]] : [])));
    if (this.picked !== undefined && !threads.some((t) => t.id === this.picked)) this.unpick(); // deleted meanwhile: everything again
  }

  // The thread as the board answered to a message sent, put among the board's
  // threads; the threads are read again, as what is read from now on is newer.
  private merge(thread: Thread): void {
    if (!this.board) return;
    const threads = this.board.threads ?? [];
    this.board = { ...this.board, threads: threads.some((t) => t.id === thread.id) ? threads.map((t) => (t.id === thread.id ? thread : t)) : [...threads, thread] };
    this.refresh();
  }

  private markSeen(thread: Thread): void {
    const last = thread.messages.at(-1)?.id;
    if (last) this.seen = { ...this.seen, [thread.id]: last };
  }

  private groups(): ThreadGroups {
    if (!this.board || !this.host.access) return NO_THREADS;
    return threadGroups(this.board, this.host.access.me, this.seen, this.host.now());
  }

  // The thread picked, while the board still has it.
  private pickedThread(): Thread | undefined {
    return this.picked === undefined ? undefined : this.board?.threads?.find((t) => t.id === this.picked);
  }

  // Whether the panel has the keys: it is open, and no thread is picked from it.
  private panelHasKeys(): boolean {
    return this.panel && this.pickedThread() === undefined;
  }

  // Picks a thread: the stream shows it alone, at its latest, and the line answers it.
  private pick(thread: Thread): void {
    this.picked = thread.id;
    this.at = thread.id;
    this.streamTop = 'end';
    this.chosen = undefined;
    this.aimNew = false;
    this.newLens = undefined;
    const draft = this.draftOf(NEW);
    draft.problem = undefined;
    this.held = draft.line.empty ? undefined : { place: threadPlace(thread), chosen: false }; // what is typed already goes there too
  }

  // Back from the thread picked to the whole stream, its row still highlighted in the panel.
  private unpick(): void {
    if (this.picked !== undefined) this.at = this.picked;
    this.picked = undefined;
    this.streamTop = 'end';
    this.chosen = undefined;
  }

  // ---- what it shows --------------------------------------------------------------------------

  // `tintFrom`: the terminal's background, where it draws 24-bit colour, for the stream's tints (chatView.ts chatTints).
  render(cols: number, rows: number, light: boolean, notice?: string, tintFrom?: Rgb): TabFrame {
    this.size = { cols, rows };
    this.sync();
    const { items, sending } = this.shownStream();
    const draft = this.draftOf(NEW);
    if (this.chosen && !this.chosenItem()) this.chosen = undefined; // gone meanwhile
    const compose = this.composeView();
    const aim = this.target() === NEW && this.board && this.host.access ? this.aim(draft) : undefined;
    const picked = this.pickedThread();
    const status = this.streamStatus(items.length);
    const now = this.host.now();
    let panelShown = false;
    const draw = (): ChatFrame => {
      const panel = this.panelView();
      panelShown = panel !== undefined;
      return renderChat(
        {
          items,
          top: this.streamTop,
          layout: this.layout,
          ...(status && { status }),
          ...(compose && { compose }),
          ...(sending.size && { sending: [...sending] }),
          ...(this.chosen && { selected: this.chosen }),
          ...(aim && aim.kind !== 'new' && { replying: true }),
          ...(draft.line.empty && this.chosen && { choosing: true }),
          ...(draft.line.empty && this.backToLatest() && { chosen: true }),
          ...(this.enterLatest(compose, draft) && { enterLatest: true }),
          ...(picked && { only: shownTitle(picked) }),
          ...(panel && { panel }),
          me: this.host.access?.me ?? '',
          now,
          ...(notice && { notice }),
          ...(this.cards() && { cards: this.cards() }),
        },
        cols,
        rows,
        light,
        tintFrom,
      );
    };
    let frame = draw();
    // A thread read as it was drawn waits on the person no longer: the panel beside it says so at once
    // (drawn again from the stream's lines as laid out for the first).
    if (this.seenIn(items, frame.seen) && this.panelView()) frame = draw();
    this.drawn = { now, times: frame.times, panel: panelShown, working: this.workingKey(now) };
    return frame;
  }

  // Whether the time alone, at `now`, changes what was last drawn: the time
  // an item's head says ("12 min ago"), or the panel's threads, their times
  // and which of them are Earlier. The host's tick draws the chat again only
  // then; anything else that changes it asks for a frame of its own.
  due(now: number): boolean {
    const drawn = this.drawn;
    return !drawn || this.clock(now, drawn) !== this.clock(drawn.now, drawn) || this.workingKey(now) !== drawn.working;
  }

  // What the row of who is working says at `now`, its spinner's turn included (T38): it turns each second while it shows.
  private workingKey(now: number): string {
    const working = this.host.working?.() ?? [];
    return working.length ? `${Math.floor(now / 1000)}\u0000${working.map((w) => `${w.name}\u0001${w.words}\u0001${w.lasted ?? ''}`).join('\u0000')}` : '';
  }

  // What the time changes in a frame drawn, as words at `now`: what the heads
  // shown say, and with the panel, its threads.
  private clock(now: number, drawn: { times: string[]; panel: boolean }): string {
    const heads = drawn.times.map((at) => ago(at, now)).join('\u0000');
    if (!drawn.panel || !this.board || !this.host.access) return heads;
    const threads = listItems(threadGroups(this.board, this.host.access.me, this.seen, now), this.allEarlier);
    return `${heads}\u0001${threads.map((item) => (item.kind === 'thread' ? `${item.entry.thread.id} ${ago(item.entry.thread.updatedAt, now)}` : `+${item.count}`)).join('\u0000')}`;
  }

  // Every conversation on the board as one (core/chatStream.ts), gathered again when the board is read again.
  private stream(): ChatItem[] {
    if (!this.board) return [];
    if (this.streamOf?.board !== this.board) this.streamOf = { board: this.board, items: chatStream(this.board) };
    return this.streamOf.items;
  }

  // The stream as it shows: the thread picked alone, else all of it.
  private shown(): ChatItem[] {
    const all = this.stream();
    const picked = this.pickedThread();
    if (!picked) return all;
    if (this.shownOf?.all !== all || this.shownOf.picked !== picked.id) this.shownOf = { all, picked: picked.id, items: all.filter((item) => item.place.kind === 'thread' && item.place.id === picked.id) };
    return this.shownOf.items;
  }

  // The stream as drawn: what shows of the board's, then the messages on
  // their way that the board doesn't have yet, and the keys of those.
  private shownStream(): { items: ChatItem[]; sending: Set<string> } {
    const items = this.shown();
    const me = this.host.access?.me ?? '';
    const at = new Date(this.host.now()).toISOString();
    const picked = this.pickedThread();
    const here = picked && conversationOf(threadPlace(picked));
    const going = this.outgoing.filter((o) => (!here || conversationOf(o.place) === here) && !this.landed(o, this.stream(), me)).map((o): ChatItem => ({ key: `sending:${o.id}`, id: o.id, author: { kind: 'human', name: me }, body: o.text, at, place: o.place }));
    return { items: going.length ? [...items, ...going] : items, sending: new Set(going.map((item) => item.key)) };
  }

  // Whether the board has the message sent: new in its conversation since, the person's, and what was typed.
  private landed(sent: Outgoing, items: ChatItem[], me: string): boolean {
    const here = conversationOf(sent.place);
    return items.some((item) => conversationOf(item.place) === here && !sent.known.has(item.id) && mine(item.author, me) && item.body.trim() === sent.text);
  }

  // The stream's lines as drawn, at `width`: laid out as the keys ask for
  // them, from the layout the frames draw from, which keeps them for the next.
  private laid(items: ChatItem[], width: number, sending: ReadonlySet<string>): ChatLines {
    return this.layout.lines(items, width, this.host.access?.me ?? '', this.host.now(), sending, this.chosen, this.pickedThread() === undefined, this.cards());
  }

  // The cards a message can name, each to its page on the board (T36), as the board was read.
  private cards(): CardLinks | undefined {
    const board = this.board;
    if (!board) return undefined;
    if (this.cardsOf?.board === board) return this.cardsOf.cards;
    const tasks = new Map(board.tasks.map((t) => [t.number, t.id]));
    const decisions = new Map(board.decisions.map((d) => [d.number, d.id]));
    const cards: CardLinks = {
      key: `${board.id}\u0000${[...tasks.keys()].join(',')}\u0000${[...decisions.keys()].join(',')}`,
      link: (kind, number) => {
        const id = (kind === 'task' ? tasks : decisions).get(number);
        return id === undefined ? undefined : kind === 'task' ? linkTo.task(board.id, id) : linkTo.decision(board.id, id);
      },
    };
    this.cardsOf = { board, cards };
    return cards;
  }

  // The stream's columns and rows as drawn, for the keys that scroll it: the panel beside it takes some.
  private streamShape(): { width: number; body: number } {
    const { cols, rows } = this.size;
    const side = panelGeometry(cols);
    return chatGeometry(cols, rows, this.footRows(), { beside: side.wide && this.panelShows() ? side.width : 0, only: this.pickedThread() !== undefined });
  }

  // A thread whose latest message the stream shows to its end is seen. Whether one was, that wasn't before.
  private seenIn(items: ChatItem[], shown: string[]): boolean {
    if (!this.board || !shown.length) return false;
    const keys = new Set(shown);
    let more = false;
    for (const item of items) {
      if (item.place.kind !== 'thread' || !keys.has(item.key)) continue;
      const id = item.place.id;
      const thread = this.board.threads?.find((t) => t.id === id);
      if (thread && thread.messages.at(-1)?.id === item.id && this.seen?.[thread.id] !== item.id) {
        this.markSeen(thread);
        more = true;
      }
    }
    return more;
  }

  // What the stream says in its place when it has nothing to show.
  private streamStatus(count: number): { text: string; hint?: string; tone?: 'alert' } | undefined {
    if (this.board) return count ? undefined : { text: 'No conversations on the board yet.', hint: 'What you type below starts a thread; its replies, and comments on cards, show here as they come.' };
    if (!this.host.access) return { text: 'The chat needs the board, which this terminal is not connected to.', tone: 'alert' };
    if (this.failed) return { text: `The board could not be read: ${this.failed}`, hint: 'It is read again when the board next changes.', tone: 'alert' };
    return { text: this.host.live() ? 'Reading the board…' : 'Connecting to the board…' };
  }

  // Whether something shows in the panel's place: the lens picker, the
  // question about deleting, or the threads, open (out of sight in a narrow
  // window while a thread picked from them shows).
  private panelShows(): boolean {
    return Boolean(this.menu() || this.deleting || (this.panel && (this.pickedThread() === undefined || panelGeometry(this.size.cols).wide)));
  }

  // The panel as threadsView.ts draws it, while it shows.
  private panelView(): PanelView | undefined {
    if (!this.panelShows()) return undefined;
    const menu = this.menu();
    const groups = this.groups();
    const items = listItems(groups, this.allEarlier);
    if (!items.some((item) => itemId(item) === this.at)) this.at = items[0] && itemId(items[0]);
    const deletion = this.deletionView();
    const said = this.listSaid();
    return {
      ...this.panelStatus(items.length),
      groups,
      allEarlier: this.allEarlier,
      ...(this.at && { at: this.at }),
      keys: Boolean(menu || this.deleting) || (this.panelHasKeys() && !this.navigating),
      ...(menu && { lens: this.lensView(menu) }),
      ...(deletion && { deletion }),
      ...(this.undo && { undo: true }),
      ...(said && { said }),
      now: this.host.now(),
    };
  }

  // What the question about deleting says about a change or a refusal.
  private deletionView(): PanelView['deletion'] {
    const menu = this.deleting;
    if (!menu) return undefined;
    const seat = this.host.seatWords();
    const said = menu.problem
      ? { text: menu.problem.needsSeat ? 'This terminal must be let in first: Enter asks, and your choice is kept.' : menu.problem.text, tone: 'alert' as const }
      : seat ? { text: seat, tone: 'normal' as const } : undefined;
    return { title: shownTitle(menu.thread), yes: menu.yes, busy: menu.busy, ...(said && { said }) };
  }

  // What the panel says of a deletion undone, or of a refusal to undo it.
  private listSaid(): PanelView['said'] {
    if (this.listProblem) return { text: this.listProblem.needsSeat ? 'This terminal must be let in first: u asks, and undo is kept.' : this.listProblem.text, tone: 'alert' };
    const text = this.restoring ? 'Restoring the thread…' : this.panelHasKeys() ? this.host.seatWords() ?? (this.undo ? 'Thread deleted. Press u to undo.' : undefined) : undefined;
    return text ? { text, tone: 'normal' } : undefined;
  }

  // What the panel says instead of rows, when it has none.
  private panelStatus(count: number): Pick<PanelView, 'status'> {
    if (this.board) return count ? {} : { status: { text: 'No threads yet.', hint: "n starts one here, as the page's chat bar does, and so does an agent." } };
    if (!this.host.access) return { status: { text: 'Threads need the board, which this terminal is not connected to.', tone: 'alert' } };
    if (this.failed) return { status: { text: `The threads could not be read: ${this.failed}`, hint: this.panelFromStatus ? 'Esc goes back, and t tries again.' : 'Esc closes this, and /threads tries again.', tone: 'alert' } };
    return { status: { text: this.host.live() ? 'Reading the threads…' : 'Connecting to the board…' } };
  }

  // ---- the line ---------------------------------------------------------------------------------

  // The key of the line that has the keys: the local commands', or the stream's; none while the panel, the picker or the question has them.
  private target(): string | undefined {
    if (this.navigating) return NAVIGATION;
    return this.deleting || this.menu() || this.panelHasKeys() ? undefined : NEW;
  }

  private draftOf(key: string): Draft {
    let draft = this.drafts.get(key);
    if (!draft) this.drafts.set(key, (draft = { line: new Line(undefined, key !== NAVIGATION) })); // a message's takes new lines; a command's doesn't
    return draft;
  }

  // Who an @ can name, the page's way: the agents on the board, those here now first, and the people.
  private roster(): Roster {
    const me = this.host.access?.me ?? '';
    if (!this.board) return { agents: [], people: [], me };
    const presence = this.host.live()?.presence ?? [];
    const order: Record<string, number> = { listening: 0, working: 1, away: 2 };
    const rank = (name: string) => order[presence.find((p) => samePerson(p.name, name))?.state ?? ''] ?? 3;
    const agents = boardAgents(this.board, presence.map((p) => p.name)).sort((a, b) => rank(a) - rank(b));
    return { agents, people: boardPeople(this.board).filter((p) => !samePerson(p, me)), me };
  }

  // What Tab completes to now: the cycle begun and left alone, else what is typed.
  private choicesFor(draft: Draft): { choices: Cycle['choices']; at: number } | undefined {
    const { line } = draft;
    const cycle = this.cycle;
    if (cycle && cycle.line === line && cycle.left.text === line.text && cycle.left.cursor === line.cursor) return { choices: cycle.choices, at: cycle.at };
    const found = completionAt(line, this.roster(), this.navigating ? [] : this.skills, Boolean(this.host.navigate), this.places());
    return found && { choices: found.choices, at: 0 };
  }

  // The places a > at the start of the stream's line can name (chatAim.ts); none on the commands' line.
  private places(): Places | undefined {
    const board = this.board;
    if (!board || this.navigating) return undefined;
    return (query) => placeChoices(board, this.stream(), query);
  }

  private composeView(): Compose | undefined {
    const menu = this.menu();
    if (menu?.own) return this.ownView(menu, menu.own); // the line is the picker's
    const key = this.target();
    if (key === undefined || !this.host.access || !this.board) return undefined;
    const draft = this.draftOf(key);
    const roster = this.roster();
    const names = [...roster.agents, ...roster.people, ...(roster.me ? [roster.me] : [])];
    const listed = this.choicesFor(draft);
    const seat = this.host.seatWords();
    const aim = key === NEW ? this.aim(draft) : undefined;
    const command = this.commandIn(draft); // what Enter runs instead of sending
    const status = draft.problem
      ? { text: draft.problem.needsSeat ? 'This terminal must be let in first: Enter asks, and your text is kept.' : draft.problem.text, tone: 'alert' as const }
      : command
        ? { text: `${tabCommandWords(command)}; no message is sent.`, tone: 'normal' as const }
        : this.posting && key === NEW
          ? { text: 'Starting the thread…', tone: 'normal' as const }
          : seat
            ? { text: seat, tone: 'normal' as const }
            : aim
              ? this.aimWords(aim, draft, names, Boolean(listed?.choices.some((c) => c.kind === 'place')))
              : { text: 'Navigate in Tricot; no message is sent.', tone: 'normal' as const };
    const placeholder = key === NAVIGATION ? `Choose ${TAB_COMMAND_LIST}` : aim?.kind === 'place' ? this.replyTo(aim) : 'What do you want to work through?';
    const working = this.host.working?.() ?? [];
    return {
      text: draft.line.text,
      cursor: draft.line.cursor,
      ...(working.length && { working }),
      ...(key === NAVIGATION && { navigation: true }),
      placeholder,
      status,
      ...(listed && { choices: listed.choices.map((c) => this.choiceView(c)), at: listed.at }),
      ...(this.arrowsPick(draft) && { picking: true }),
    };
  }

  // Whether ↑ ↓ go through the list over the line rather than scroll: while
  // the line is a / alone, or a /, @ or > list shows, as one Tab wrote and
  // left (a skill reads "@Claude /review ") or as what is typed fits (T39).
  // A tag's models, on one row, leave them to scrolling.
  private arrowsPick(draft: Draft): boolean {
    if (!this.host.navigate) return false;
    if (/^\s*\/\S*\s*$/.test(draft.line.text)) return true;
    const first = this.choicesFor(draft)?.choices[0];
    return Boolean(first && first.kind !== 'tag');
  }

  // A choice as its row shows it. The /, @ and > lists take a row each (T39):
  // a command or skill with what it does, an agent with what it is doing, a
  // person as one, a place with its title; a tag's models stay on one row.
  private choiceView(c: Choice): { label: string; note?: string; description?: string } {
    const label = choiceLabel(c);
    if (c.kind === 'command' || c.kind === 'skill') return { label, ...(choiceNote(c) && { note: choiceNote(c)! }), description: c.description };
    if (c.kind === 'place') return { label, description: c.note ?? '' };
    if (c.kind === 'name') {
      if (!c.agent) return { label, description: 'person' };
      const presence = (this.host.live()?.presence ?? []).find((p) => samePerson(p.name, c.name));
      return { label, description: this.board ? agentStateWords(this.board, c.name, presence) : 'agent' };
    }
    return { label };
  }

  // ---- where the stream's line goes ----------------------------------------------------

  // The latest message from someone else in the stream as it shows, which the line answers.
  private latestOther(): ChatItem | undefined {
    return latestFrom(this.shown(), this.host.access?.me ?? '');
  }

  // The message chosen with Tab, while the stream still shows it.
  private chosenItem(): ChatItem | undefined {
    return this.chosen === undefined ? undefined : this.shown().find((item) => item.key === this.chosen);
  }

  // Whether Esc on the empty line has something to go back from to the latest:
  // a message chosen, or a new thread asked for while there is a latest to answer.
  private backToLatest(): boolean {
    return this.chosen !== undefined || (this.aimNew && this.latestOther() !== undefined);
  }

  // Whether Enter brings a stream scrolled up back to the latest, for the
  // stream to say so: the stream's line is drawn and has the keys, and Enter
  // neither runs a command nor asks first for this terminal to be let in, nor
  // waits on a new thread on its way.
  private enterLatest(compose: Compose | undefined, draft: Draft): boolean {
    return compose !== undefined && this.target() === NEW && !this.posting && !draft.problem?.needsSeat && this.commandIn(draft) === undefined;
  }

  // Where the stream's line sends what is typed: the place a > names; a new
  // thread for an @ at its start, unless a thread is picked; else where it was
  // aimed when typing began; with nothing typed, the message chosen, the
  // thread picked, a new thread asked for, or the latest from someone else,
  // and a new thread when there is none.
  private aim(draft: Draft): Aim {
    const text = draft.line.text;
    const said = this.board && named(text, this.board);
    if (said) return said.kind === 'place' ? { kind: 'place', place: said.place, text: said.text, how: 'named' } : said;
    if (/^\s*@/.test(text) && !this.pickedThread()) return { kind: 'new' };
    const held = this.held;
    if (!draft.line.empty && held) return held.place === 'new' ? { kind: 'new' } : { kind: 'place', place: held.place, text: text.trim(), how: held.chosen ? 'chosen' : 'held' };
    return this.loose(text.trim());
  }

  private loose(text: string): Aim {
    const chosen = this.chosenItem();
    if (chosen) return { kind: 'place', place: chosen.place, text, how: 'chosen' };
    const picked = this.pickedThread();
    if (picked) return { kind: 'place', place: threadPlace(picked), text, how: 'picked' };
    if (this.aimNew) return { kind: 'new' };
    const latest = this.latestOther();
    return latest ? { kind: 'place', place: latest.place, text, how: 'latest' } : { kind: 'new' };
  }

  // From the first character typed, the line keeps where it was aimed, so a
  // message arriving meanwhile doesn't move it; empty, it follows the latest again.
  private holdAim(draft: Draft): void {
    if (draft.line.empty) this.held = undefined;
    else if (!this.held) {
      const loose = this.loose('');
      this.held = loose.kind === 'place' ? { place: loose.place, chosen: loose.how === 'chosen' } : { place: 'new', chosen: false };
    }
  }

  // What a place is on the board, as core/delivery.ts reads whom a message there is for; none once it is gone.
  private whereOf(place: ChatPlace): Where | undefined {
    const board = this.board;
    if (!board) return undefined;
    if (place.kind === 'board') return { boardContext: true };
    if (place.kind === 'thread') {
      const thread = board.threads?.find((t) => t.id === place.id);
      return thread && { thread };
    }
    if (place.kind === 'task') {
      const task = board.tasks.find((t) => t.id === place.id);
      return task && { task };
    }
    const decision = board.decisions.find((d) => d.id === place.id);
    return decision && { decision };
  }

  // The row under the stream's line: a new thread, with the lens it begins
  // with unless that is General, and who will get it; else where it goes,
  // and who hears it there (threadsWho.ts); or why it can go nowhere. A
  // thread picked is where it goes unless said otherwise, so the row doesn't
  // call it the latest. `listed`: Tab has places to choose from for what is
  // typed after a >.
  private aimWords(aim: Aim, draft: Draft, names: string[], listed: boolean): { text: string; tone: Tone } {
    const board = this.board!;
    // The board's agents, and which each is, for what a tag on one asks (threadsWho.ts).
    const agents = this.roster().agents;
    const input = { board, names, agents, kindOf: (name: string) => agentOf(name, this.skills), presence: this.host.live()?.presence ?? [], connected: this.host.agents() };
    if (aim.kind === 'unknown') return listed ? { text: "Where to? T19, #7 or part of a thread's title: Tab chooses.", tone: 'normal' } : { text: aim.why, tone: 'alert' };
    if (aim.kind === 'new') {
      const heard = heardBy({ ...input, text: draft.line.text });
      const lens = this.newLens && this.newLens.name !== 'General' ? ` · ${this.newLens.name}` : '';
      return { ...heard, text: `New thread${lens} · ${heard.text}` };
    }
    const latest = this.latestOther();
    const atLatest = !this.pickedThread() && (aim.how === 'latest' || (aim.how === 'held' && latest !== undefined && conversationOf(latest.place) === conversationOf(aim.place)));
    const how = atLatest ? ', the latest' : aim.how === 'chosen' ? ', the one chosen' : '';
    const where = this.whereOf(aim.place);
    const heard = where ? hearsIt(where, { ...input, text: aim.text }) : { text: 'it is no longer on the board', tone: 'alert' as const };
    return { text: aimRow(aim.place, how, heard.text, this.size.cols), tone: heard.tone };
  }

  // What the empty line says it is for: a reply to whoever wrote the message
  // it answers, or the latest from someone else in the thread picked, else
  // to the agent the thread is for (core/delivery.ts replyPlaceholder).
  private replyTo(aim: Extract<Aim, { kind: 'place' }>): string {
    const to = aim.how === 'chosen' ? this.chosenItem() : aim.how === 'latest' || aim.how === 'picked' ? this.latestOther() : undefined;
    if (to) return `Reply to ${safe(to.author.name)}…`;
    const picked = aim.how === 'picked' ? this.pickedThread() : undefined;
    const here = (this.host.live()?.presence ?? []).filter((p) => p.state !== 'away').map((p) => p.name);
    return picked ? replyPlaceholder(picked, here) : 'Reply…';
  }

  // The rows the line takes at the foot, as drawn, for the keys that scroll.
  private footRows(): number {
    const key = this.target();
    const compose = key === undefined ? undefined : this.composeView();
    return compose ? composeFoot(this.size.rows, choiceRows(compose.choices), inputRows(compose.text, this.size.cols), Boolean(compose.working)).rows : 0;
  }

  // "/" lists what each agent can be asked to run, which is read from the
  // board when one is typed, and again after a minute; the same list says
  // which agent each is, for a tag after an "@" (threadsComplete.ts agentOf).
  private wantSkills(line: Line): void {
    const access = this.host.access;
    const fresh = this.skillsAt !== undefined && this.host.now() - this.skillsAt < SKILLS_FRESH_MS;
    if (!access || this.loadingSkills || fresh || (readTyping(line.text.slice(0, line.cursor), true)?.trigger !== '/' && !this.tagging(line))) return;
    this.loadingSkills = true;
    void access.skills().then((list) => {
      this.skills = list;
      this.skillsAt = this.host.now();
      this.loadingSkills = false;
      this.host.changed();
    });
  }

  // Whether the line tags an agent, or is typing a tag after its name (core/agentTags.ts).
  private tagging(line: Line): boolean {
    const { agents, people, me } = this.roster();
    return Boolean(readTagTyping(line.text.slice(0, line.cursor), agents) || findMentions(line.text, [...agents, ...people, me], agents).some((m) => m.tag));
  }

  // What a key does to the line, if it is a key of the line's: typing, pasting,
  // the cursor, deleting, Tab (threadsLine.ts editLine has all but Tab).
  private edit(key: TabKey, draft: Draft): boolean {
    const { line } = draft;
    const navigation = Boolean(this.host.navigate);
    if (key.kind === 'tab' || key.kind === 'backtab' || (this.arrowsPick(draft) && (key.kind === 'up' || key.kind === 'down'))) {
      this.wantSkills(line);
      const next = tabbed(line, this.cycle?.line === line ? this.cycle : undefined, this.roster(), this.navigating ? [] : this.skills, navigation, key.kind === 'up' || key.kind === 'backtab' ? -1 : 1, this.places());
      this.cycle = next && { ...next, line };
      return true;
    }
    // ↑ ↓ move between the rows of a text on several (T37); from its first up or its last down, they scroll.
    if ((key.kind === 'up' || key.kind === 'down') && line.multiline) {
      const to = cursorAcross(line.text, line.cursor, inputWidth(this.size.cols), key.kind === 'up' ? -1 : 1);
      if (to !== undefined) {
        line.cursor = to;
        return true;
      }
    }
    if (key.kind === 'text' && key.text === ':') colonAfterName(line, this.cycle?.line === line ? this.cycle : undefined);
    const done = editLine(line, key);
    if (done === 'typed') {
      draft.problem = undefined;
      this.wantSkills(line);
    }
    return done !== undefined;
  }

  // ---- what is typed -----------------------------------------------------------------------

  // A turn of the mouse's wheel (T30): the stream scrolls `lines`, up when
  // positive, as ↑ ↓ do, wherever the keys are, while it is in view (not
  // under the panel in a narrow window).
  wheel(lines: number): void {
    if (!this.showing || (this.panelShows() && !panelGeometry(this.size.cols).wide)) return;
    const { items, sending } = this.shownStream();
    const { width, body } = this.streamShape();
    const laid = this.laid(items, width, sending);
    this.streamTop = laid.top(laid.move(laid.find(this.streamTop, body), -lines), body);
  }

  key(key: TabKey): void {
    const menu = this.menu();
    if (this.deleting) this.deleteKey(this.deleting, key);
    else if (menu) this.lensKey(menu, key);
    else if (this.navigating) this.commandKey(key);
    else if (this.panelHasKeys()) this.panelKey(key);
    else {
      const draft = this.draftOf(NEW);
      this.streamKey(key, draft);
      this.holdAim(draft);
    }
  }

  // The keys of the panel (the header says what each does).
  private panelKey(key: TabKey): void {
    if (key.kind === 'escape' || key.kind === 'interrupt') {
      this.panel = false;
      if (this.panelFromStatus) this.showing = false; // back to the status view it was opened from
      this.panelFromStatus = false;
      return;
    }
    const text = key.kind === 'text' ? key.text : '';
    if (text === '/' && this.host.navigate) return this.commands();
    if (text === 'u' && this.undo) return void this.restore();
    if (text === 'n' && this.board && this.host.access) return this.start(true);
    const items = listItems(this.groups(), this.allEarlier);
    const at = Math.max(0, items.findIndex((item) => itemId(item) === this.at));
    const count = items.length;
    if (!count) return;
    const here = items[at];
    if (text === 'x' && here.kind === 'thread' && !this.restoring) {
      this.deleting = { thread: here.entry.thread, yes: false, busy: false };
      return;
    }
    if ((text === 'l' || key.kind === 'lens') && here.kind === 'thread') return this.openLens(here.entry.thread.id);
    let next = at;
    if (key.kind === 'up' || text === 'k') next = (at - 1 + count) % count;
    else if (key.kind === 'down' || text === 'j') next = (at + 1) % count;
    else if (key.kind === 'home') next = 0;
    else if (key.kind === 'end') next = count - 1;
    else if (key.kind === 'enter') return this.pickRow(here, at);
    this.at = itemId(items[next]);
  }

  private pickRow(item: ListItem, row: number): void {
    if (item.kind === 'thread') return this.pick(item.entry.thread);
    // The rest of Earlier: the highlight goes to the first of them.
    this.allEarlier = true;
    const all = listItems(this.groups(), true);
    this.at = itemId(all[row] ?? all[all.length - 1]);
  }

  // The same Yes / No pair as stopping an agent: arrows choose, Enter confirms,
  // y/n answer, and Esc or Ctrl+C keeps the thread. No is chosen to begin with.
  private deleteKey(menu: DeleteMenu, key: TabKey): void {
    if (menu.busy) return;
    if (key.kind === 'enter' && menu.problem?.needsSeat) {
      menu.problem = undefined;
      return this.host.askSeat();
    }
    const text = key.kind === 'text' ? key.text.toLowerCase() : '';
    if (key.kind === 'left' || key.kind === 'right') {
      menu.yes = !menu.yes;
      return;
    }
    if (text === 'n' || key.kind === 'escape' || key.kind === 'interrupt' || (key.kind === 'enter' && !menu.yes)) {
      this.deleting = undefined;
      return;
    }
    if (text === 'y' || (key.kind === 'enter' && menu.yes)) void this.remove(menu);
  }

  private async remove(menu: DeleteMenu): Promise<void> {
    const access = this.host.access;
    if (!access) return;
    menu.busy = true;
    menu.problem = undefined;
    this.host.changed();
    const result = await access.send.remove(menu.thread.id);
    menu.busy = false;
    if (result.ok) {
      this.undo = menu.thread;
      this.listProblem = undefined;
      this.deleting = undefined;
      if (this.board) this.take({ ...this.board, threads: this.board.threads?.filter((t) => t.id !== menu.thread.id) });
      this.refresh();
    } else menu.problem = { text: result.error, ...(result.needsSeat && { needsSeat: true }) };
    this.host.changed();
  }

  private async restore(): Promise<void> {
    const thread = this.undo;
    const access = this.host.access;
    if (!thread || !access || this.restoring) return;
    if (this.listProblem?.needsSeat) {
      this.listProblem = undefined;
      return this.host.askSeat();
    }
    this.restoring = true;
    this.listProblem = undefined;
    this.host.changed();
    const result = await access.send.restore(thread.id);
    this.restoring = false;
    if (result.ok) {
      this.undo = undefined;
      this.at = thread.id;
      this.merge(thread);
    } else this.listProblem = { text: result.error, ...(result.needsSeat && { needsSeat: true }) };
    this.host.changed();
  }

  // Reads begun before a successful change must not put the old list back.
  private refresh(): void {
    this.staleBefore = this.readSeq;
    this.readFor = undefined;
    this.sync();
  }

  // The local commands' line: Enter goes, Esc goes back to where it was opened from.
  private commandKey(key: TabKey): void {
    const draft = this.draftOf(NAVIGATION);
    if (key.kind === 'escape' || key.kind === 'interrupt') return this.closeCommands();
    if (key.kind === 'enter') return void this.submit(draft, NAVIGATION);
    this.edit(key, draft);
  }

  // Closes the local commands' line, if it is open, back to where it was
  // opened from: the status view, or the chat as it was. A command that acts
  // rather than moves (/add, /stop, /open, /quit) goes back there first.
  closeCommands(): void {
    if (!this.navigating) return;
    const { fromStatus } = this.navigating;
    this.navigating = undefined;
    this.draftOf(NAVIGATION).problem = undefined;
    if (fromStatus) this.host.navigate?.('status');
  }

  // The keys of the stream's line (the header says what each does).
  private streamKey(key: TabKey, draft: Draft): void {
    if (this.chosen && !this.chosenItem()) this.chosen = undefined; // gone meanwhile
    if (key.kind === 'escape' || key.kind === 'interrupt') {
      draft.problem = undefined;
      if (!draft.line.empty) return draft.line.clear();
      if (this.backToLatest()) {
        this.chosen = undefined;
        this.aimNew = false;
        this.newLens = undefined;
        return;
      }
      if (this.pickedThread()) return this.unpick();
      this.aimNew = false;
      this.newLens = undefined;
      return this.list();
    }
    if (this.posting) return; // on its way: the line is as it was sent
    if (key.kind === 'lens') return this.openLens(this.pickedThread()?.id ?? NEW);
    if (key.kind === 'enter') return void this.submit(draft, NEW);
    if (draft.line.empty && this.chosen && this.chooseKey(key)) return;
    if (draft.line.empty && key.kind === 'tab') return this.choose(draft);
    if (this.edit(key, draft)) return;
    const { items, sending } = this.shownStream();
    const { width, body } = this.streamShape();
    const next = scrolled(this.streamTop, key, this.laid(items, width, sending), body);
    if (next !== undefined) this.streamTop = next;
  }

  // Tab on the stream's empty line: the latest message of someone else's is chosen, to answer or react to.
  private choose(draft: Draft): void {
    const last = this.latestOther();
    if (!last) {
      draft.problem = { text: this.pickedThread() ? 'There is nothing to react to here: reactions go to what others wrote, not to your own messages.' : 'There is no message from anyone else to answer: what you type starts a thread.' };
      return;
    }
    draft.problem = undefined;
    this.chosen = last.key;
    this.aimNew = false;
    this.revealChosen();
  }

  // The keys of a message chosen in the stream, while nothing is typed: Tab
  // or ↑ the one before (the earliest stops it), Shift+Tab or ↓ the one
  // after (the latest stops it), 1 2 3 react 👍 👎 👀. Anything else is the
  // line's, false: typing answers the message chosen.
  private chooseKey(key: TabKey): boolean {
    const items = answerable(this.shown(), this.host.access?.me ?? '');
    const at = items.findIndex((item) => item.key === this.chosen);
    if (at < 0) return false;
    const step = key.kind === 'tab' || key.kind === 'up' ? -1 : key.kind === 'backtab' || key.kind === 'down' ? 1 : 0;
    if (step) {
      this.chosen = items[Math.min(Math.max(0, at + step), items.length - 1)].key;
      this.draftOf(NEW).problem = undefined;
      this.revealChosen();
      return true;
    }
    if (key.kind !== 'text') return false;
    const emoji = key.text.length === 1 ? EMOJIS[Number(key.text) - 1] : undefined;
    if (emoji) void this.react(items[at], emoji);
    return emoji !== undefined;
  }

  // Scrolls the stream, if it must, so the message chosen shows.
  private revealChosen(): void {
    const { items, sending } = this.shownStream();
    const index = items.findIndex((item) => item.key === this.chosen);
    if (index < 0) return;
    const { width, body } = this.streamShape();
    this.streamTop = revealed(this.streamTop, this.laid(items, width, sending), index, body);
  }

  // ---- reacting ------------------------------------------------------------------------------

  // Leaves 👍, 👎 or 👀 on the message chosen, or takes the person's own back,
  // as the page does (the board says what it means to an agent): in its
  // thread, or on a comment by where it is (chatAim.ts reactOn). One at a
  // time: the next waits for the board. A refusal is said under the line.
  private async react(item: ChatItem, emoji: Emoji): Promise<void> {
    const access = this.host.access;
    if (!access || this.reacting) return;
    const draft = this.draftOf(NEW);
    const { place } = item;
    const remove = hasReaction(item, emoji, { kind: 'human', name: access.me });
    this.reacting = true;
    draft.problem = undefined;
    this.host.changed();
    if (place.kind === 'thread') {
      const result = await access.send.react(place.id, item.id, emoji, remove);
      this.reacting = false;
      if (result.ok) {
        const now = this.board?.threads?.find((t) => t.id === place.id);
        if (now) this.merge({ ...now, messages: now.messages.map((m): ThreadMessage => (m.id === item.id ? result.message : m)) });
      } else draft.problem = { text: result.error, ...(result.needsSeat && { needsSeat: true }) };
    } else {
      const result = await access.send.reactToComment(reactOn(place), item.id, emoji, remove);
      this.reacting = false;
      this.commented(place, result, draft);
    }
    this.host.changed();
  }

  // What the board answered about a comment: the comment as it is now, put
  // where it is so it shows at once, or why it refused.
  private commented(place: CardPlace, result: CommentSent, draft: Draft): void {
    if (!result.ok) {
      draft.problem = { text: result.error, ...(result.needsSeat && { needsSeat: true }) };
      return;
    }
    if (this.board) this.board = withComment(this.board, place, result.comment);
    this.refresh();
  }

  // ---- the lens ---------------------------------------------------------------------------------

  // The picker, if one is open for a thread or the new one that is still there.
  private menu(): LensMenu | undefined {
    const menu = this.lens;
    if (menu && (!this.board || (menu.for !== NEW && !this.board.threads?.some((t) => t.id === menu.for)))) this.lens = undefined;
    return this.lens;
  }

  // The lens now of the thread (by id) or the one to be started.
  private lensOf(key: string): ThreadLens | undefined {
    return key === NEW ? this.newLens : this.board?.threads?.find((t) => t.id === key)?.lens;
  }

  private lensRowsOf(menu: LensMenu): LensRow[] {
    return lensRows(this.board?.threads ?? [], this.lensOf(menu.for));
  }

  // Opens the picker with the current lens highlighted.
  private openLens(key: string): void {
    if (!this.board || !this.host.access) return;
    const rows = lensRows(this.board.threads ?? [], this.lensOf(key));
    this.lens = { for: key, at: Math.max(0, rows.findIndex((r) => r.current)), busy: false };
  }

  // Why the lens was not set, or what is being waited for, as words for the picker.
  private lensSaid(menu: LensMenu): { text: string; tone: 'alert' | 'normal' } | undefined {
    if (menu.problem) return { text: menu.problem.needsSeat ? 'This terminal must be let in first: Enter asks, and your choice is kept.' : menu.problem.text, tone: 'alert' };
    return menu.busy ? { text: 'Setting the lens…', tone: 'normal' } : undefined;
  }

  private lensView(menu: LensMenu): LensView {
    const rows = this.lensRowsOf(menu);
    const { own } = menu;
    const thread = this.board?.threads?.find((t) => t.id === menu.for);
    const said = this.lensSaid(menu);
    return {
      title: thread ? shownTitle(thread) : 'New thread',
      rows,
      at: Math.min(menu.at, rows.length - 1),
      enter: menu.for === NEW ? 'use' : 'set',
      ...(said && !own && { said }),
      ...(own && { form: { lines: own.step === 'name' ? [OWN_STEPS.name.help] : [`Name: ${own.name}`, OWN_STEPS.brief.help], enter: own.step === 'name' ? 'next' : 'use this lens' } }),
    };
  }

  // The line a lens of one's own is typed on: its name, then its brief.
  private ownView(menu: LensMenu, own: NonNullable<LensMenu['own']>): Compose {
    const step = OWN_STEPS[own.step];
    return { text: own.line.text, cursor: own.line.cursor, placeholder: step.placeholder, status: this.lensSaid(menu) ?? { text: `${own.line.text.length} of ${step.limit} characters`, tone: 'normal' } };
  }

  // The keys of the picker: ↑ ↓ (or k j) move the highlight, wrapping round; Home
  // End the first or last row; Enter picks it, Esc cancels. Nothing while the board is setting one.
  private lensKey(menu: LensMenu, key: TabKey): void {
    if (menu.busy) return;
    if (key.kind === 'enter' && menu.problem?.needsSeat) {
      menu.problem = undefined;
      return this.host.askSeat();
    }
    if (menu.own) return this.ownKey(menu, menu.own, key);
    if (key.kind === 'escape' || key.kind === 'interrupt') {
      this.lens = undefined;
      return;
    }
    const rows = this.lensRowsOf(menu);
    const at = Math.min(menu.at, rows.length - 1);
    const text = key.kind === 'text' ? key.text : '';
    if (key.kind === 'enter') return void this.pickLens(menu, rows[at]);
    if (key.kind === 'up' || text === 'k') menu.at = (at - 1 + rows.length) % rows.length;
    else if (key.kind === 'down' || text === 'j') menu.at = (at + 1) % rows.length;
    else if (key.kind === 'home') menu.at = 0;
    else if (key.kind === 'end') menu.at = rows.length - 1;
    else return;
    menu.problem = undefined;
  }

  private async pickLens(menu: LensMenu, row: LensRow): Promise<void> {
    if (row.fresh) {
      menu.problem = undefined;
      menu.own = { step: 'name', name: '', line: new Line(OWN_STEPS.name.limit) };
      return;
    }
    await this.setLens(menu, lensPicked(row, this.lensOf(menu.for)));
  }

  // The two steps of a lens of one's own, typed on a line: Esc goes back to the lenses.
  private ownKey(menu: LensMenu, own: NonNullable<LensMenu['own']>, key: TabKey): void {
    if (key.kind === 'escape' || key.kind === 'interrupt') {
      menu.own = undefined;
      menu.problem = undefined;
      return;
    }
    if (key.kind === 'enter') return void this.ownDone(menu, own);
    if (editLine(own.line, key) === 'typed') menu.problem = undefined;
  }

  private async ownDone(menu: LensMenu, own: NonNullable<LensMenu['own']>): Promise<void> {
    const text = own.line.text.trim();
    if (!text) {
      menu.problem = { text: own.step === 'name' ? 'Give it a name first.' : 'Say how agents should answer through it first.' };
      return;
    }
    if (own.step === 'name') {
      const preset = presetLens(text);
      if (preset) menu.problem = { text: `${preset.name} is one of the lenses already: name yours something else.` };
      else menu.own = { step: 'brief', name: text, line: new Line(OWN_STEPS.brief.limit) };
      return;
    }
    await this.setLens(menu, lensChoice(own.name, text, this.lensOf(menu.for)?.agent));
  }

  // Sets the lens: of the thread, as the board is told; of the new one, which
  // takes it when it is started (and the stream's line then starts one).
  private async setLens(menu: LensMenu, lens: ThreadLens | null): Promise<void> {
    if (menu.for === NEW) {
      this.newLens = lens ?? undefined;
      this.lens = undefined;
      this.aimNew = true;
      this.chosen = undefined;
      if (this.held) this.held = { place: 'new', chosen: false };
      return;
    }
    const access = this.host.access;
    if (!access) return;
    menu.busy = true;
    menu.problem = undefined;
    this.host.changed();
    const result = await access.send.lens(menu.for, lens);
    menu.busy = false;
    if (result.ok) {
      this.merge(result.thread);
      if (this.lens === menu) this.lens = undefined;
    } else {
      menu.problem = { text: result.error, ...(result.needsSeat && { needsSeat: true }) };
    }
    this.host.changed();
  }

  // ---- sending -----------------------------------------------------------------------------------

  // Enter: a local command goes; else asks to be let in when the board said
  // that must come first; else, on an empty line, takes the stream back to
  // the latest, as End does; else sends what is typed where the line is
  // aimed, which takes it back to the latest too.
  private async submit(draft: Draft, key: string): Promise<void> {
    const access = this.host.access;
    const text = draft.line.text.trim();
    const command = this.commandIn(draft);
    if (command) {
      draft.line.clear();
      draft.problem = undefined;
      this.cycle = undefined;
      this.host.navigate!(command);
      return;
    }
    if (key === NAVIGATION) {
      draft.problem = { text: `Choose ${TAB_COMMAND_LIST}. Agent skills are available in a conversation.` };
      return;
    }
    if (draft.problem?.needsSeat) {
      draft.problem = undefined;
      this.host.askSeat();
      return;
    }
    if (!text) {
      this.streamTop = 'end';
      return;
    }
    if (!access) return;
    draft.problem = undefined;
    this.cycle = undefined;
    const aim = this.aim(draft);
    if (aim.kind !== 'new') return this.answer(draft, aim, access);
    this.posting = true;
    this.host.changed();
    this.started(draft, await access.send.start(text, this.newLens));
  }

  // The local command Enter runs for what is typed: a command alone, or the
  // first that a "/" and the start of a name, with the cursor after it, completes to.
  private commandIn(draft: Draft): TabCommand | undefined {
    if (!this.host.navigate) return undefined;
    const text = draft.line.text.trim();
    const first = draft.line.cursor === draft.line.text.length && /^\/\w*$/.test(text) ? completionAt(draft.line, this.roster(), [], true)?.choices[0] : undefined;
    return tabCommand(text) ?? (first?.kind === 'command' ? first.name : undefined);
  }

  // A message from the stream's line, where it is aimed: in a thread, or a
  // comment where the message answered is (chatAim.ts replyOn), shown in the
  // stream at once as sending. The line goes back to following the latest (or
  // the thread picked); a refusal puts the text back aimed where it was sent,
  // before anything typed since. A place it can't name, or nothing after the
  // name, sends nothing.
  private async answer(draft: Draft, aim: Exclude<Aim, { kind: 'new' }>, access: ThreadsAccess): Promise<void> {
    if (aim.kind === 'unknown') {
      draft.problem = { text: aim.why };
      return;
    }
    if (!aim.text) {
      const { place } = aim;
      draft.problem = { text: `Write what to say after ${place.kind === 'thread' ? 'the title' : place.kind === 'board' ? 'it' : `${place.kind === 'task' ? 'T' : '#'}${place.number}`}.` };
      return;
    }
    const typed = draft.line.text.trim();
    const to = aim.place.kind === 'thread' || !this.board ? undefined : replyOn(aim.place, this.board);
    const place = to?.place ?? aim.place;
    const here = conversationOf(place);
    const sent: Outgoing = { id: `sending-${++this.sent}`, place, text: aim.text, known: new Set(this.stream().filter((item) => conversationOf(item.place) === here).map((item) => item.id)) };
    this.outgoing.push(sent);
    draft.line.clear();
    this.held = undefined;
    this.chosen = undefined;
    this.aimNew = false;
    this.streamTop = 'end';
    this.host.changed();
    const result = place.kind === 'thread' ? await access.send.reply(place.id, aim.text) : await access.send.comment(to!.on, aim.text);
    this.outgoing = this.outgoing.filter((o) => o !== sent);
    if (result.ok && 'thread' in result) this.merge(result.thread);
    else if (result.ok) this.commented(place as CardPlace, result, draft);
    else {
      draft.line.set(draft.line.empty ? typed : `${typed} ${draft.line.text}`);
      draft.problem = { text: result.error, ...(result.needsSeat && { needsSeat: true }) };
      if (aim.how !== 'named') this.held = { place: aim.place, chosen: false };
    }
    this.host.changed();
  }

  // What the board answered to a new thread: the thread, which is then
  // picked, or why it did not take it, the text still on the line.
  private started(draft: Draft, result: ThreadSent): void {
    this.posting = false;
    if (result.ok) {
      this.merge(result.thread);
      this.drafts.delete(NEW);
      this.held = undefined;
      this.pick(result.thread);
    } else draft.problem = { text: result.error, ...(result.needsSeat && { needsSeat: true }) };
    this.host.changed();
  }
}
