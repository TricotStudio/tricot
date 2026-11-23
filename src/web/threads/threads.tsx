import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { inWindow } from '../../core/delivery';
import { barPlaceholder, barSends, doorName } from '../../core/doors';
import { agentOnFile, type OpenFile } from '../../core/fileThread';
import { listNames, samePerson } from '../../core/format';
import { splitLensCommand } from '../../core/lensCommand';
import { boardAgents, splitQuestion } from '../../core/mentions';
import { agentsOf, coordinatorOf, onBoardNow, whoAnswers } from '../../core/whoAnswers';
import { STARTERS } from '../../core/requests';
import { askedTag, inConversation, threadGroups, threadMade, threadTag } from '../../core/threadList';
import { shownTitle, threadWaiting } from '../../core/threads';
import type { Actor, Board, MessageLens, ScratchPage, Thread, ThreadDoor, ThreadLens, ThreadMessage, ThreadRef } from '../../core/types';
import { api } from '../shared/api';
import type { PlainQuestion } from '../shared/cardKinds';
import { useBoardViews } from '../shared/boardViewsContext';
import { useCardKinds } from '../shared/cardKindsContext';
import { usePageSelection, useUndoDelete } from '../canvas';
import { ChatBar } from './chatBar';
import { moveDock } from './dockMotion';
import { lookAtBoard } from './justMade';
import { fileBar, pageBar, replyPlaceholder, viewOfDoor } from './chatDoor';
import { agentLineAt, commentAnchor, LoopLine, MessageFoot, onItsWay, outbox, Reactions, SaidTo, settledKeys, showComments, useMentionable, useOutgoing, withOutgoing, type Drawn } from '../conversation';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { PanelHandle } from '../shared/PanelHandle';
import { usePanelWidth } from '../shared/panelWidth';
import { CLOSED, dockOnArrival, type DockState, type Left } from './dockStays';
import { escapeCloses, followPress, useBeside, useDismiss, useReadOnly, useTick } from '../shared/hooks';
import { askDockToOpen, OPEN_THREAD } from '../shared/openThread';
import { dropFlag, flagged, flags, go, type BoardViewName } from '../shared/pages';
import { lensChoices, messageLensOf } from './lensChoices';
import { LensChip, LensLine, LensPicker } from './lenses';
import { useAgents } from '../agents';
import { CommentText, ViaSkill } from '../shared/mentions';
import { AskPeek } from './askPeek';
import { ThreadsList } from './threadsList';
import { useThreadsSeen } from './threadsSeen';
import { WorkCards } from './threadWork';
import './threads.css';
import { OwnerChip, useRouted, WorkStrip, type Routed } from './workStrip';
import { draftMessage, isLocal, replyInThread, startThread as sendNewThread } from './send';

// The board's threads: conversations with agents, each through a lens. The
// chat bar floats at the foot of every tab (chatBar.tsx); what's sent from it
// starts a thread through that tab's door (core/doors.ts), as a quick question
// of the board's conversation (core/threadList.ts inConversation), read whole
// on the board's Home: its answer peeks over the bar as it comes
// (askPeek.tsx), and the dock opens no thread for it. A thread opens in a
// panel docked on the right, the board still there beside it, and the bar
// becomes the panel's reply box. The panel shows one thread, under "← Threads"
// and its title, with where it was started and what it made; or New thread,
// the open-ended door; or the threads list, the conversation and then the
// work, which fills it. It stays open while the person uses the board: opening
// a card, following a link or a T6 chip, changing tabs, pressing a button,
// selecting text, dragging or panning the canvas all leave it be, and it is
// open again, on the same thread, when they come back from a card's own view.
// On another project it stays open, on that project's threads list (or the
// thread it had open there). It closes on its close button, on Escape, or on
// a dismiss click, a plain click on empty space that does nothing else
// (shared/dismissClick.ts), which puts the bar back at the bottom. The
// bar's threads button opens the threads list (threadsList.tsx), over the
// bar, its conversation's row going to Home; the panel's "← Threads" turns the panel
// into that list, a page of its own, where a row turns it back into its thread
// and the reply box starts a new one. A person deletes a thread from its row;
// a toast offers to undo it, as on a canvas (canvas/undo.tsx).
// Agents answer over MCP (core/threads.ts); replies arrive with the board.

// Asks the dock to open on a thread, e.g. from the notifications list, the changes feed, a
// notification or a card made from it. Where no dock of its board is there to
// hear it (a card's own view, Projects, another board), the board's tab opens
// (`from`), and its dock opens on the thread there. A view that holds its own
// conversation (the board's Home, timeline.tsx) hears it in the dock's place.
const docks: string[] = []; // the boards whose docks are on screen
let asked: { id: string; thread?: Thread } | null = null;

// Where a board's threads open while it is on screen: the dock, or the view
// that holds its own conversation. It opens one asked for before it was here too.
export function useThreadsOpenHere(boardId: string, open: (id: string, thread?: Thread) => void): void {
  useEffect(() => {
    docks.push(boardId);
    if (asked) {
      open(asked.id, asked.thread);
      asked = null;
    }
    const onOpen = (e: Event) => {
      const { id, thread } = (e as CustomEvent<{ id: string; thread?: Thread }>).detail;
      open(id, thread);
    };
    window.addEventListener(OPEN_THREAD, onOpen);
    return () => {
      docks.splice(docks.indexOf(boardId), 1);
      window.removeEventListener(OPEN_THREAD, onOpen);
    };
  }, [open, boardId]);
}

export function openThread(threadId: string, thread?: Thread, from?: { boardId: string; href: string }): void {
  if (!from || docks.includes(from.boardId)) {
    askDockToOpen(threadId, thread);
    return;
  }
  asked = { id: threadId, thread };
  location.hash = from.href;
}

// The board's conversation on its Home, at one of its messages (`at`) when
// given, scrolled to and flashed: where a quick question and its answer are
// read, from the threads list, the bell, the peek over the bar and search.
export function openConversation(boardId: string, at?: string): void {
  go.timeline(boardId);
  if (at) showComments([at]);
}

// The tab a thread opens on from a card's view: where it was started, else
// the card's own tab.
export function threadTab(board: Board, threadId: string, fallback: BoardViewName): BoardViewName {
  return viewOfDoor(board.threads?.find((t) => t.id === threadId)?.door) ?? fallback;
}

// ---- the dock ----------------------------------------------------------------

// Projects' "Ask an agent for the first questions" opens the Board Context with
// ?ask on its address: the bar takes the focus with this starter in it,
// selected so typing replaces it.
const FIRST_QUESTIONS = STARTERS.find((s) => s.label === 'Risks and open questions')?.text ?? '';

// What the dock had open, and what was typed where, per board (DockState),
// for as long as the page is open; and the board whose tabs were last on
// screen, with whether the panel was open as the person left them, for the
// next board's dock (dockOnArrival).
const remembered = new Map<string, DockState>();
let left: Left | null = null;

interface Props {
  board: Board;
  name: string;
  // The door of what the bar floats over: the tab's (chatDoor.ts doorOfView),
  // or on a part's window, the one it shows.
  door: ThreadDoor;
  // The Sketchbook page the bar floats over: a thread it starts is about that
  // page, and goes to the agent that made it, if one did.
  page?: ScratchPage;
  // The project file open in Files: a thread the bar starts is about that
  // file, and goes to the agent last asked about it.
  file?: OpenFile;
  onSeeItem?: (id: string) => void; // reading a thread sees its events in the notifications list
}

// The chat bar, floating at the foot of the tab, and the conversation it
// opens, docked on the right as a column of the board's layout (BoardView).
// One of them holds the bar at any time.
export function ThreadDock({ board, name, door, page: shownPage, file: shownFile, onSeeItem }: Props) {
  const readOnly = useReadOnly();
  const threads = board.threads ?? [];
  const { seen, markSeen } = useThreadsSeen(board);
  const groups = useMemo(() => threadGroups(board, name, seen, Date.now()), [board, name, seen]);
  const present = useAgents();
  const asker = useCardKinds().question();
  const listening = present.filter((a) => a.state !== 'away').map((a) => a.name);
  const names = useMentionable(name);
  const [askedHere] = useState(() => door === 'canvas' && flagged(flags.ask));
  // As it was on this board, or as the person left the last one (dockStays.ts).
  const [state, setState] = useState<DockState>(() => {
    const kept = dockOnArrival(remembered.get(board.id) ?? CLOSED, board.id, left, (id) => threads.some((t) => t.id === id));
    return askedHere ? { ...kept, open: false, drafts: { ...kept.drafts, bar: FIRST_QUESTIONS } } : kept;
  });
  useEffect(() => {
    remembered.set(board.id, state);
  }, [board.id, state]);
  const set = useCallback((patch: Partial<DockState> | ((current: DockState) => Partial<DockState>)) => {
    setState((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  }, []);
  const { open, page, selected, newLens, drafts } = state;
  const [started, setStarted] = useState<Thread | null>(null); // one just started, until the board has it
  // The ask sent last from the floating bar, whose answer peeks over it (askPeek.tsx): its thread's id, and the
  // thread as last known (the stand-in, then the server's) until the board has it.
  const [peek, setPeek] = useState<{ id: string; shown: Thread } | null>(null);
  const landed = useRef(new Set<string>()); // the asks the board has had, so one it no longer has has moved or gone
  const [busy, setBusy] = useState(false); // a question card on its way
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const { remove, toast } = useUndoDelete(name, report);
  const field = useRef<HTMLInputElement>(null);
  const [listOpen, setListOpen] = useState(false); // the threads list over the floating bar
  const listButton = useRef<HTMLButtonElement>(null); // what opened it, which toggles it
  const listScroll = useRef<number | null>(null); // where the panel's list was scrolled, for coming back to it

  // The bar's field moves between the bottom and the panel (dockMotion.ts),
  // and each place keeps its caret: by its draft's key, where it was when the
  // bar left it, else after what's typed. Set as each render reads them.
  const isDocked = useRef(false);
  const fieldKey = useRef('bar');
  const carets = useRef(new Map<string, [number, number]>());
  const caretNow = useCallback((): [number, number] | null => {
    const el = field.current;
    return el && document.activeElement === el ? [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length] : null;
  }, []);
  const keepCaret = useCallback(() => {
    const caret = caretNow();
    if (caret) carets.current.set(fieldKey.current, caret);
  }, [caretNow]);
  // Into the bar, at its caret (or with all of it selected). Without the
  // focus, the caret waits in the field for when the person comes back to it.
  const placeCaret = useCallback((select = false, focus = true) => {
    const el = field.current;
    if (!el) return;
    if (focus) el.focus({ preventScroll: true });
    if (select) return el.select();
    const length = el.value.length;
    const [start, end] = carets.current.get(fieldKey.current) ?? [length, length];
    carets.current.delete(fieldKey.current);
    el.setSelectionRange(Math.min(start, length), Math.min(end, length));
  }, []);
  const focusBar = useCallback((select = false) => requestAnimationFrame(() => placeCaret(select)), [placeCaret]);
  // A press outside the panel that can be a dismiss click, which closes it
  // once it's over (below).
  const press = useRef<(() => void) | null>(null); // calls it off
  const leaving = useRef(false); // closing on a press, not closed yet
  // A change that docks the bar into the panel or lets go of it goes through
  // the motion; any other, as it is. The bar's field has the focus after,
  // unless a click elsewhere put it there (`focus` false). What that click
  // opens in the panel (a thread, from the changes feed) stays open.
  const dock = useCallback(
    (docks: boolean, change: () => void, focus = true) => {
      if (docks) {
        press.current?.();
        press.current = null;
        leaving.current = false;
      }
      keepCaret();
      if (docks === isDocked.current) {
        change();
        if (focus) focusBar();
      } else moveDock(docks ? 'open' : 'close', change, () => placeCaret(false, focus));
    },
    [keepCaret, placeCaret, focusBar],
  );

  // Projects' ask lands with the bar focused, its starter selected: at once, the
  // bar being drawn by then, and again a frame later, after what else the
  // page puts in place.
  useEffect(() => {
    if (!askedHere) return;
    dropFlag(flags.ask);
    placeCaret(true);
    focusBar(true);
  }, [askedHere, focusBar, placeCaret]);

  const showThread = useCallback(
    (id: string, thread?: Thread) =>
      dock(true, () => {
        if (thread) setStarted(thread);
        setError(null);
        setListOpen(false);
        set({ open: true, page: 'thread', selected: id });
      }),
    [set, dock],
  );
  // The notifications list, the changes feed or a card asks for a thread: this dock opens
  // on it, and one asked for from a card's view before this dock was here.
  useThreadsOpenHere(board.id, showThread);
  const thread = page === 'thread' ? (threads.find((t) => t.id === selected) ?? (started?.id === selected ? started : undefined)) : undefined;
  // Docked: a thread, New thread or the list. One deleted (or not found)
  // while open lets the bar go back to the bottom.
  const docked = open && (page === 'new' || page === 'list' || Boolean(thread));
  isDocked.current = docked;
  // The coordinator sent the viewer's message on (core/roles.ts): the dock
  // showing the thread it was asked in follows it there, with a way back, or
  // without one where the message moved and that thread is gone; anywhere
  // else, the floating bar offers to (workStrip.tsx).
  const routed = useRouted(board, name);
  const [back, setBack] = useState<{ from: string; to: string } | null>(null);
  const follow = routed.latest;
  const followTo = useCallback(
    (to: Routed) => {
      routed.done(to.id);
      setBack({ from: to.from, to: to.to });
      showThread(to.to);
    },
    [routed, showThread],
  );
  useEffect(() => {
    if (follow && open && page === 'thread' && selected === follow.from) followTo(follow);
  }, [follow, open, page, selected, followTo]);
  const backTo = back && thread?.id === back.to ? threads.find((t) => t.id === back.from) : undefined;

  // The ask whose answer peeks over the floating bar: as the board has it, else as last known until it lands. Once
  // landed, one the board no longer has has moved into the thread it follows up (core/store/threads.ts
  // routeToThread), or is gone. Moved into a thread of the conversation, the peek follows it there; into work, it says
  // so; gone, it goes. It goes too as the dock opens, which then holds the bar.
  const peekOnBoard = peek ? threads.find((t) => t.id === peek.id) : undefined;
  if (peekOnBoard) landed.current.add(peekOnBoard.id);
  const peekGone = Boolean(peek && !peekOnBoard && landed.current.has(peek.id));
  const peekThread = peekOnBoard ?? (peekGone ? undefined : peek?.shown);
  const movedTo = peek && peekGone ? threads.find((t) => t.messages.some((m) => m.movedFrom === peek.id)) : undefined;
  useEffect(() => {
    if (!peek || !peekGone) return;
    if (movedTo && inConversation(movedTo)) setPeek({ id: movedTo.id, shown: movedTo });
    else if (!movedTo) setPeek(null);
  }, [peek, peekGone, movedTo]);
  useEffect(() => {
    if (docked) setPeek(null);
  }, [docked]);
  // Sent on, the peek says where it went and opens it: the chip that offers to follow it is not needed.
  useEffect(() => {
    if (follow && peek && (follow.from === peek.id || follow.to === peek.id)) routed.done(follow.id);
  }, [follow, peek, routed]);
  // Closed, the board has the eye again: what was made meanwhile in view is seen.
  useEffect(() => {
    if (!docked) lookAtBoard();
  }, [docked]);

  const close = useCallback(() => dock(false, () => set({ open: false })), [set, dock]);
  // It stays open while the person uses the board. Besides its close button,
  // Escape closes it, and so does a dismiss click (shared/dismissClick.ts),
  // as the changes feed's (useSidePanel): a plain click on empty space outside it
  // that does nothing else, such as the page's background, an empty part of
  // a list or the empty canvas. A press on something that does something (a
  // card, a link or T6 chip, a tab, a button, a field, a canvas block or
  // link) goes through and leaves it open; so do a drag, a selection, the
  // canvas panning, and a right-click or a modified click. Something over it
  // takes Escape and a press first, and closes alone: the threads list, a
  // menu, a dialog, or a popover, such as the Connect panel from "Connect
  // one". The Feed, beside it, isn't over it: with both open, Escape closes
  // the one opened last. A dismiss click is known once the press is over
  // (followPress), and then the panel goes: the click has done what it
  // would have, on the board as it was. The focus stays where the click put
  // it; the bar keeps what's typed and its caret.
  const panel = useRef<HTMLElement>(null);
  const dismiss = useCallback(
    (escape: boolean, event: MouseEvent | KeyboardEvent) => {
      if (escape) {
        if (escapeCloses(panel, event as KeyboardEvent)) close();
        return;
      }
      const caret = caretNow(); // before the press moves the focus
      const follow = followPress(event as MouseEvent, (dismissed) => {
        press.current = null;
        if (dismissed && isDocked.current) {
          if (caret) carets.current.set(fieldKey.current, caret);
          dock(false, () => set({ open: false }), false);
        } else leaving.current = false;
      });
      if (!follow) return;
      leaving.current = true;
      press.current?.();
      press.current = follow;
    },
    [close, caretNow, dock, set],
  );
  useBeside(docked, panel);
  useDismiss(docked && !listOpen, dismiss, panel, undefined, true);
  if (!docked) leaving.current = false;
  // Leaving the board's tabs, for a card's view, Projects or another project: a
  // dismiss click under way closes it, as it would have, and the next
  // board's dock hears whether it was open (dockOnArrival).
  useEffect(
    () => () => {
      press.current?.();
      const kept = remembered.get(board.id);
      if (leaving.current && kept) remembered.set(board.id, { ...kept, open: false });
      left = { board: board.id, open: isDocked.current && !leaving.current };
    },
    [board.id],
  );

  // What's on screen is seen, replies arriving while it's open included: the
  // thread docked, or the exchange peeking over the floating bar.
  const lastId = thread?.messages.at(-1)?.id;
  useEffect(() => {
    if (!docked || !thread || isLocal(thread)) return;
    markSeen(thread);
    onSeeItem?.(thread.id);
  }, [docked, thread?.id, lastId, markSeen, onSeeItem]); // once per message seen
  const peekLast = peekOnBoard?.messages.at(-1)?.id;
  useEffect(() => {
    if (docked || listOpen || !peekOnBoard) return;
    markSeen(peekOnBoard);
    onSeeItem?.(peekOnBoard.id);
  }, [docked, listOpen, peekOnBoard?.id, peekLast, markSeen, onSeeItem]); // once per message seen

  const toggleList = () => {
    setError(null);
    setListOpen((was) => !was);
  };
  // In the panel, "← Threads" turns it into the list, which takes the focus
  // (threadsList.tsx); the reply box keeps its caret for coming back.
  const showList = () =>
    dock(
      true,
      () => {
        setError(null);
        set({ open: true, page: 'list' });
      },
      false,
    );
  // Closed by Escape, the focus goes back to what opened it; by a click
  // elsewhere, it stays where the click put it.
  const closeList = useCallback((escape: boolean) => {
    setListOpen(false);
    if (escape) listButton.current?.focus();
  }, []);
  const startNew = () =>
    dock(true, () => {
      setError(null);
      setListOpen(false);
      set({ open: true, page: 'new' });
    });
  const openFromList = (id: string) => showThread(id);
  // The open one closes the panel, the list staying open over the bar; Undo
  // in the toast brings it back.
  const deleteThread = (gone: Thread) => {
    setError(null);
    if (gone.id === selected && page === 'thread' && docked) dock(false, () => set({ open: false }));
    remove([gone.id]);
  };
  const setLens = (target: Thread, lens: ThreadLens | null) => {
    setError(null);
    api.setThreadLens(target.id, name, lens).catch(report);
  };

  // The bar is the open thread's reply box, the open-ended door's on New
  // thread and on the list, and else the tab's own door.
  const through: ThreadDoor | undefined = docked && page === 'thread' ? undefined : docked ? 'threads' : door;
  const draftKey = through === undefined ? thread!.id : through === 'threads' ? 'new' : 'bar';
  // Floating over a Sketchbook page, the bar asks about it, of its agent if it has one.
  const overPage = !docked && door === 'threads' ? shownPage : undefined;
  // Blocks selected on it go with what's sent, as what the thread it starts is
  // about: agents talk it through there before they make anything.
  const selection = usePageSelection(overPage?.id);
  // The board's coordinator a message from the bar goes to, when it @-mentions none (core/roles.ts): the one seen last.
  const lead = coordinatorOf(present);
  // In Files, with a file open, it asks about the file, of the agent last asked about it, if one was.
  const overFile = !docked && door === 'threads' && !shownPage ? shownFile : undefined;
  const fileAgent = useMemo(() => overFile && agentOnFile(board, overFile.named, boardAgents(board, present.map((a) => a.name))), [board, overFile, present]);
  // Who the bar names, and the thread it starts goes to, by the one rule (core/whoAnswers.ts): the page's agent or the
  // file's while it is on the board, else the coordinator, else the one agent here; none, "agents".
  const named = overPage ? overPage.agent?.name : fileAgent;
  const answerer = useMemo(() => whoAnswers({ agents: agentsOf(board, present), named: named ? [named] : [], coordinator: lead }), [board, present, named, lead]);
  const routedTo = onBoardNow(named, present.map((a) => a.name));
  const pageWords = overPage && pageBar(overPage, selection?.blockIds.length ?? 0, answerer, lead);
  const fileWords = overFile && fileBar(overFile.path, answerer, lead);
  fieldKey.current = draftKey;
  const draft = drafts[draftKey] ?? '';
  const setDraft = (key: string, body: string) => set((current) => ({ drafts: { ...current.drafts, [key]: body } }));
  // On Decisions, with no agent listening, the bar posts the words as a plain question, when the kinds of card registered have one (shared/cardKinds.ts): with none it starts a thread.
  const barWay = through ? barSends(through, listening.length) : 'reply';
  const sends = barWay === 'question' && !asker ? 'thread' : barWay;

  // A new thread shows the moment it's sent, then becomes the one the server
  // made, unless the person has moved on to another meanwhile. The panel
  // opens through the dock's motion, which runs its change a frame or more
  // later (dockMotion.ts): the server may answer first, and then the panel
  // opens on the server's thread rather than an empty stand-in.
  // From the floating bar, it is a quick question of the conversation: the bar
  // stays where it is, and its answer peeks over it.
  const startThread = (text: string, from: ThreadDoor, lens: ThreadLens | null, own?: MessageLens, onPage?: ScratchPage, blockIds?: string[], onFile?: string) => {
    const floating = !docked;
    const sending = sendNewThread(
      { boardId: board.id, name, names, text, door: from, lens, own, page: onPage, blockIds, file: onFile, to: onPage || onFile ? routedTo : undefined },
      (made) => {
        markSeen(made);
        setStarted((current) => (current?.id === sending.local.id ? made : current));
        set((current) => (current.selected === sending.local.id ? { selected: made.id } : {}));
        setPeek((current) => (current?.id === sending.local.id ? { id: made.id, shown: made } : current));
      },
    );
    // What was sent leaves the bar as the panel, or the peek, takes it.
    carets.current.delete(from === 'threads' ? 'new' : 'bar');
    if (floating) {
      setPeek({ id: sending.local.id, shown: sending.local });
      set((current) => ({ drafts: { ...current.drafts, [from === 'threads' ? 'new' : 'bar']: '' }, ...(from === 'threads' && { newLens: null }) }));
      return;
    }
    dock(true, () => {
      const shown = sending.made() ?? sending.local;
      setStarted(shown);
      set((current) => ({
        open: true,
        page: 'thread',
        selected: shown.id,
        drafts: { ...current.drafts, [from === 'threads' ? 'new' : 'bar']: '' },
        ...(from === 'threads' && { newLens: null }),
      }));
    });
  };

  // No agent to turn it into a card: on Decisions it goes up as a plain
  // question, as the old Ask a question bar did. An @-mention in it says who
  // it's for: from the mention on, it goes up as a comment on the card,
  // which routes it as any comment does.
  const postQuestion = async (asks: PlainQuestion, text: string) => {
    const { question, comment } = splitQuestion(text, names.filter((n) => !samePerson(n, name)));
    if (!question) return;
    setBusy(true);
    try {
      // Posted, it's on the board now: sending again would post it twice.
      const note = await asks.post(board.id, name, { question, comment }, () => setDraft('bar', ''));
      if (note) setError(note);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  // What ^ offers, by the lens of the thread the message goes to (the open
  // one's, the new one's, or none): a message's own lens, on it alone.
  // Decisions' question bar has no lens to ask for.
  const toLens = docked && page === 'thread' ? thread?.lens : docked ? (newLens ?? undefined) : undefined;
  const lenses = useMemo(() => (sends === 'question' ? undefined : lensChoices(toLens)), [sends, toLens]);

  const send = () => {
    // The ^Lens it asks for is a command, not content: it goes beside the text.
    const typed = draft.trim();
    const { body: text, lens: asked } = lenses ? splitLensCommand(typed, lenses.map((l) => l.name)) : { body: typed, lens: undefined };
    const own = asked ? messageLensOf(asked, toLens) : undefined;
    if (!text || busy) return;
    setError(null);
    if (!through) {
      if (!thread || isLocal(thread)) return; // nothing goes to a thread the server hasn't made yet
      replyInThread(thread, name, text, own);
      setDraft(thread.id, '');
      return;
    }
    if (sends === 'question' && asker) return void postQuestion(asker, text);
    // With blocks selected on the page, the thread is about them: the
    // selection goes with the message, and lets go once it is sent.
    const about = through === 'threads' && overPage && selection ? selection : undefined;
    startThread(text, through, through === 'threads' ? newLens : null, own, overPage, about?.blockIds, through === 'threads' ? overFile?.path : undefined);
    about?.clear();
  };

  // One not sent goes back where it was typed: a thread just started back to
  // its bar, a reply back to its thread's.
  const editUnsent = (said: string, lens?: MessageLens) => {
    const body = lens ? `^${lens.name} ${said}` : said; // its ^Lens goes back with it
    if (isLocal(thread)) {
      const from = thread?.door ?? door;
      const back = (patch: (current: DockState) => Partial<DockState>) => () => {
        setStarted(null);
        set(patch);
      };
      if (from === 'threads') dock(true, back((current) => ({ page: 'new', newLens: thread?.lens ?? null, drafts: { ...current.drafts, new: body } })));
      else dock(false, back((current) => ({ open: false, drafts: { ...current.drafts, bar: body } })));
    } else if (thread) {
      setDraft(thread.id, body);
      focusBar();
    }
  };

  // Threads waiting on you: the threads button's count, and the panel's for
  // those besides the one open.
  const waitingCount = groups.waiting.length;
  const othersWaiting = groups.waiting.filter((e) => e.thread.id !== thread?.id).length;
  // Over a page or a file, the bar says what it asks about.
  const aboutWords = pageWords ?? fileWords;
  // On the list, it says it starts a thread, not a reply to one.
  const onList = docked && page === 'list';
  const placeholder = through
    ? aboutWords
      ? aboutWords.placeholder
      : onList
        ? newLens
          ? `Start a thread in ${newLens.name}…`
          : 'Start a thread…'
        : through === 'threads' && newLens
          ? `What do you want to work through in ${newLens.name}?`
          : barPlaceholder(through)
    : replyPlaceholder(thread!, listening);
  const bar = readOnly ? null : (
    <ChatBar
      docked={docked}
      value={draft}
      onValue={(body) => setDraft(draftKey, body)}
      onSend={send}
      placeholder={placeholder}
      label={
        through
          ? aboutWords
            ? aboutWords.label
            : through === 'threads'
              ? 'Start a new thread'
              : `Talk to agents from ${doorName(through) ?? through}`
          : `Reply in ${thread!.title}`
      }
      sendLabel={sends === 'reply' ? 'Send' : sends === 'question' ? 'Post as a question' : selection ? 'Start a thread about these blocks' : fileWords ? 'Start a thread about this file' : 'Start a thread'}
      busy={busy || isLocal(thread)}
      field={field}
      lenses={lenses}
      threads={docked ? undefined : { count: waitingCount, open: listOpen, onOpen: toggleList, button: listButton }}
      context={
        selection
          ? {
              label: `${selection.blockIds.length} block${selection.blockIds.length === 1 ? '' : 's'}`,
              title: `What the thread you start is about:\n${selection.names.join('\n')}`,
              onRemove: () => {
                selection.clear();
                focusBar();
              },
            }
          : undefined
      }
      error={docked ? null : error}
    />
  );
  // Over the floating bar, the list rises from its threads button. Its
  // conversation's row goes to Home, the dock closed behind it.
  const toConversation = () => {
    setListOpen(false);
    set({ open: false });
    openConversation(board.id);
  };
  const threadsList = listOpen && !docked && (
    <ThreadsList groups={groups} name={name} readOnly={readOnly} onOpen={openFromList} onConversation={toConversation} onNew={startNew} onDelete={deleteThread} onClose={closeList} toggle={listButton} />
  );

  // The answer to the ask just sent, peeking over the floating bar (askPeek.tsx).
  // One not sent goes back into the bar to be changed, its ^Lens with it.
  const closePeek = () => {
    setPeek(null);
    focusBar();
  };
  const peekWork = peekThread && !inConversation(peekThread) ? { thread: peekThread, how: 'taken' as const } : movedTo && !inConversation(movedTo) ? { thread: movedTo, how: 'moved' as const } : undefined;
  const peekAt = (movedTo?.messages.find((m) => m.movedFrom === peek?.id) ?? peekThread?.messages.at(-1))?.id;
  const peeking = !docked && !listOpen && peek && (peekThread || peekWork) && (
    <AskPeek
      asked={peekThread && askedTag(peekThread, board)?.replace(/^Asked/, 'asked')}
      work={peekWork}
      onHome={() => {
        setPeek(null);
        openConversation(board.id, peekAt);
      }}
      onWork={(id) => showThread(id)}
      onClose={closePeek}
    >
      {peekThread && (
        <Conversation
          board={board}
          thread={peekThread}
          name={name}
          onOpen={noop}
          onEdit={(said, lens) => {
            setPeek(null);
            setDraft(draftKey, lens ? `^${lens.name} ${said}` : said);
            focusBar();
          }}
          onThread={(id) => showThread(id)}
        />
      )}
    </AskPeek>
  );

  // The docked conversation's width (shared/panelWidth.ts), as its edge was last
  // dragged on this browser. It widens over the board, which stays as it is
  // under it: the board's column keeps the conversation's usual width, and
  // narrower when the conversation is, so narrowing gives the board the room.
  const usual = Math.round(Math.min(DOCK_USUAL, window.innerWidth * 0.4));
  const dockWidth = usePanelWidth(panel, { key: 'tricot:dock-width', initial: usual, min: 320, share: 0.66, side: 'right' });
  const column = Math.min(dockWidth.width, usual);
  // How far it reaches over the board, past its column: the layout says it
  // too (--dock-over), so what covers the tab, a block's full view, ends where
  // the panel begins (pairing.css), following its edge as it is dragged.
  const over = dockWidth.width - column;
  useLayoutEffect(() => {
    const layout = docked ? panel.current?.parentElement : undefined;
    if (!layout) return;
    layout.style.setProperty('--dock-width', `${column}px`);
    layout.style.setProperty('--dock-over', `${over}px`);
    return () => {
      layout.style.removeProperty('--dock-width');
      layout.style.removeProperty('--dock-over');
    };
  }, [docked, column, over]);

  if (!docked) {
    return (
      <>
        <div className="chat-float">
          {threadsList}
          {!listOpen && (
            <div className="chat-over">
              {peeking}
              <WorkStrip board={board} routed={follow} onOpen={(id) => showThread(id)} onFollow={followTo} onDismiss={routed.done} />
            </div>
          )}
          {/* Over a canvas that can be drawn on, the bar has its drawing tools beside it, as every floating bar does (chatBar.tsx). */}
          {bar ?? (
            <button type="button" className="chat-threads-only" ref={listButton} onClick={toggleList} aria-expanded={listOpen} aria-haspopup="dialog">
              <Icon name="thread" /> Threads
            </button>
          )}
        </div>
        {toast && <div className="threads-toast">{toast}</div>}
      </>
    );
  }

  const closeButton = (
    <button type="button" className="dock-close" onClick={close} aria-label="Close the conversation" title="Close (Esc)">
      <Icon name="x" />
    </button>
  );
  return (
    <aside
      className={`thread-dock${dockWidth.width > column ? ' is-over' : ''}${dockWidth.dragging ? ' is-resizing' : ''}`}
      ref={panel}
      aria-label="Threads"
      style={{ '--dock-w': `${dockWidth.width}px`, '--dock-over': `${over}px` } as CSSProperties}
    >
      <PanelHandle {...dockWidth} label="Conversation width" />
      <header className="dock-head">
        {onList ? (
          <>
            <h2 className="dock-heading">Threads</h2>
            {!readOnly && (
              <button type="button" className="btn btn-small tl-new" onClick={startNew}>
                <Icon name="plus" /> New thread
              </button>
            )}
          </>
        ) : (
          <button type="button" className="dock-back" onClick={showList} aria-label={`All threads${othersWaiting ? `, ${othersWaiting} waiting on you` : ''}`}>
            <Icon name="arrow-left" /> Threads
            {othersWaiting > 0 && (
              <span className="dock-count" aria-hidden>
                {othersWaiting}
              </span>
            )}
          </button>
        )}
        {closeButton}
      </header>
      {onList && (
        <ThreadsList
          groups={groups}
          name={name}
          current={selected ?? undefined}
          readOnly={readOnly}
          page={{ scroll: listScroll }}
          onOpen={openFromList}
          onConversation={toConversation}
          onNew={startNew}
          onDelete={deleteThread}
        />
      )}
      {error && (
        <p className="error threads-error" role="alert">
          {error}
        </p>
      )}
      {page === 'thread' && thread && (
        <>
          {backTo && (
            <button
              type="button"
              className="dock-crumb"
              onClick={() => {
                setBack(null);
                showThread(backTo.id);
              }}
            >
              <Icon name="arrow-left" />
              <span className="dock-crumb-title">Back to “{shownTitle(backTo)}”</span>
            </button>
          )}
          <ThreadTitle board={board} thread={thread} readOnly={readOnly || isLocal(thread)} onPick={(lens) => setLens(thread, lens)} />
          <Conversation board={board} thread={thread} name={name} onOpen={noop} onEdit={editUnsent} onThread={(id) => showThread(id)} />
        </>
      )}
      {page === 'new' && (
        <>
          <div className="dock-title">
            <h2 className="dock-heading">New thread</h2>
          </div>
          {!readOnly && <LensLine lens={newLens ?? undefined} onPick={(lens) => set({ newLens: lens })} />}
          <Conversation board={board} thread={undefined} name={name} onOpen={noop} onEdit={editUnsent} />
        </>
      )}
      {bar && <div className="dock-foot">{bar}</div>}
      {toast && <div className="threads-toast">{toast}</div>}
    </aside>
  );
}

const noop = () => {};
const DOCK_USUAL = 440; // the conversation's width until it is dragged, at most 40% of the window (board.css)

// The open thread's title, and under it where it was started, what it made
// (#78, T48, 3 blocks) and when, and its lens, whose chip changes it.
export function ThreadTitle(props: { board: Board; thread: Thread; readOnly: boolean; onPick: (lens: ThreadLens | null) => void }) {
  const { board, thread, readOnly, onPick } = props;
  const made = threadMade(board, thread);
  const tag = threadTag(thread, board);
  const generalNote = useBoardViews().boardContext()?.generalThread;
  return (
    <div className="dock-title">
      <h2 className="dock-heading" title={shownTitle(thread)}>
        {shownTitle(thread)}
      </h2>
      <div className="dock-meta">
        {tag && <span className="dock-door">{tag}</span>}
        <OwnerChip thread={thread} />
        {made.map((m) => (
          <span key={m} className="dock-made">
            → {m}
          </span>
        ))}
        <span className="dock-when" title={new Date(thread.startedAt).toLocaleString()}>
          started {timeAgo(thread.startedAt)}
        </span>
        <LensPicker
          lens={thread.lens}
          readOnly={readOnly}
          onPick={onPick}
          label={`${thread.lens?.name ?? 'General'} lens`}
          note={thread.general ? generalNote : undefined}
        />
      </div>
    </div>
  );
}

// The open thread's messages, each with what it led to under it (work an
// agent made ahead of its reply waits at the foot), kept scrolled to the
// latest, and a quiet line on who'll answer: nobody while no agent is
// listening. What the person sends shows at once, and the line under their
// latest says what became of it (delivery.tsx), in place of that one, until
// an agent's reply takes its place. An agent's latest message to another
// agent has that line too, and says who it is for ("Claude → Codex"); once
// the loop guard holds one, the foot says the agents wait for a person
// (agentTalk.tsx). An archived board's threads are only read.
// Drawn again when what it is given changes (memo), not as the bar under it is typed in, and each half minute for
// the line at its foot, which goes by the clock.
export const Conversation = memo(function Conversation(props: {
  board: Board;
  thread: Thread | undefined;
  name: string;
  onOpen: () => void;
  onEdit: (body: string, lens?: MessageLens) => void;
  onThread?: (id: string) => void;
  children?: ReactNode; // drawn in the scroller after the messages (Home's yarn beside them)
}) {
  const { board, thread, name, onOpen, onEdit, onThread, children } = props;
  useTick(30_000);
  const readOnly = useReadOnly();
  const scroller = useRef<HTMLDivElement>(null);
  const names = useMentionable(name);
  const drawn = withOutgoing(thread?.messages ?? [], useOutgoing(`thread:${thread?.id ?? ''}`), name, (o) => draftMessage(o, name, names));
  const settled = settledKeys(drawn).join();
  useEffect(() => {
    for (const key of settled ? settled.split(',') : []) outbox.remove(key);
  }, [settled]);
  // Agents' replies that come while the thread is open fade in where the line was.
  const opened = useRef<{ id: string | undefined; ids: Set<string> } | null>(null);
  if (opened.current?.id !== thread?.id) opened.current = { id: thread?.id, ids: new Set(thread?.messages.map((m) => m.id)) };
  const { lineAt, agentLine } = footsOf(board, thread, drawn, name);
  // While that line speaks for the latest message, the line at the foot keeps quiet.
  const line = lineAt >= 0 ? drawn[lineAt] : undefined;
  const speaking = Boolean(line && thread && (onItsWay(line) || (inWindow(line.item, Date.now()) && (line.outgoing || threadWaiting(board, thread)?.message.id === line.item.id))));
  // What's drawn, with what each message led to: work made ahead of a reply
  // moves under it, so the reply adds one where it takes one away.
  const count = drawn.reduce((n, d) => n + 1 + (d.item.refs?.length ?? 0), 0) + (thread?.pending?.length ?? 0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.id, count]);
  // Ahead of a reply, by agent.
  const ahead = new Map<string, { by: Actor; refs: ThreadRef[] }>();
  for (const { by, ...ref } of thread?.pending ?? []) {
    const entry = ahead.get(by.name) ?? { by, refs: [] };
    entry.refs.push(ref);
    ahead.set(by.name, entry);
  }

  return (
    <div className="threads-conversation" ref={scroller} aria-label={thread ? `Thread: ${shownTitle(thread)}` : 'New thread'} role="region">
      {thread ? (
        <ol className="thread-messages">
          {drawn.map((d, i) => (
            <MessageRow
              key={d.key}
              board={board}
              thread={thread}
              drawn={d}
              after={drawn.slice(i + 1).map((x) => x.item)}
              name={name}
              foot={Boolean(onItsWay(d)) || i === lineAt || d.item.id === agentLine}
              arriving={d.item.author.kind === 'agent' && !opened.current!.ids.has(d.item.id)}
              prev={drawn[i - 1]?.item}
              onOpen={onOpen}
              onEdit={onEdit}
              onThread={onThread}
            />
          ))}
          {[...ahead.values()].map(({ by, refs }) => (
            <li key={`ahead:${by.name}`} className="thread-message">
              <ActorBadge actor={by} showName={false} />
              <div className="thread-message-main">
                <div className="thread-message-head">
                  <strong>{by.name}</strong>
                  <span className="thread-message-time">made, ahead of a reply</span>
                </div>
                <WorkCards board={board} refs={refs} onOpen={onOpen} />
              </div>
            </li>
          ))}
        </ol>
      ) : readOnly ? (
        <p className="threads-intro">No threads.</p>
      ) : (
        <p className="threads-intro">Start a thread to work something through with agents. @ an agent to ask that one.</p>
      )}
      {thread && <LoopLine board={board} items={thread.messages} className="threads-quiet" />}
      {!readOnly && !speaking && <Listening board={board} thread={thread} />}
      {children}
    </div>
  );
});

// Which of a thread's drawn messages has the line under it that says what
// became of it (delivery.tsx): the person's latest, while it is theirs
// (`lineAt`), and an agent's latest to another agent (`agentLine`).
export function footsOf(board: Board, thread: Thread | undefined, drawn: Drawn<ThreadMessage>[], name: string): { lineAt: number; agentLine: string | undefined } {
  const latest = drawn.findLastIndex((d) => d.item.author.kind === 'human');
  const mine = latest >= 0 && drawn[latest].item.author.kind === 'human' && samePerson(drawn[latest].item.author.name, name);
  const agentAt = thread ? agentLineAt(board, thread.messages) : -1;
  return { lineAt: mine ? latest : -1, agentLine: agentAt >= 0 ? thread!.messages[agentAt].id : undefined };
}

// One message of a thread, as a conversation draws it: who and when, its
// text, where it was sent on, what it led to, and its reactions, with the
// line that says what became of it when it has one (`foot`). Home's
// conversation draws its messages with it too, several threads' in one
// (timeline.tsx), with a tag that says where a thread was asked (`tag`), its
// own time (`when`) and what was sent on from it (`children`).
//
// Read as a conversation, in every place that draws one: the viewer's own
// messages are compact bubbles on the right, with no name; an agent's reply
// is prose on the left at a reading size and measure, its first paragraph a
// little heavier to skim by; another person's message reads on the left too,
// under their name, as an agent's does. Messages from one author in a row
// (`prev`) sit close, as one turn; turns sit well apart (threads.css).
export function MessageRow(props: {
  board: Board;
  thread: Thread;
  drawn: Drawn<ThreadMessage>;
  after: ThreadMessage[]; // what came after it in its thread
  name: string;
  foot: boolean;
  arriving: boolean;
  onOpen: () => void;
  onEdit: (body: string, lens?: MessageLens) => void;
  onThread?: (id: string) => void;
  tag?: ReactNode;
  when?: (iso: string) => string;
  prev?: ThreadMessage; // the message drawn just before it: one of the same author's makes this one part of their turn
  next?: ThreadMessage; // and the one after, else the next of its thread
  children?: ReactNode;
}) {
  const { board, thread, drawn: d, after, name, foot, arriving, onOpen, onEdit, onThread, tag, when = timeAgo, prev, next = after[0], children } = props;
  const message = d.item;
  const way = onItsWay(d);
  const draft = message.id === d.outgoing?.key;
  const reactions = draft || isLocal(thread) ? null : <Reactions item={message} place={{ threadId: thread.id }} name={name} />;
  const state = way === 'sending' ? ' is-sending' : way === 'failed' ? ' is-unsent' : '';
  const mine = message.author.kind === 'human' && samePerson(message.author.name, name);
  const turn = (other: ThreadMessage | undefined) =>
    Boolean(other && other.author.kind === message.author.kind && samePerson(other.author.name, message.author.name) && Math.abs(Date.parse(other.at) - Date.parse(message.at)) < TURN_MS);
  const cont = turn(prev);
  const who = mine ? ' is-mine' : message.author.kind === 'agent' ? ' is-agent' : ' is-person';
  const time = (
    <span className="thread-message-time" title={new Date(message.at).toLocaleString()}>
      {when(message.at)}
    </span>
  );
  const rest = (
    <>
      {message.sent && <SentOn board={board} sent={message.sent} onThread={onThread} />}
      {message.refs?.length ? <WorkCards board={board} refs={message.refs} onOpen={onOpen} /> : null}
      {children}
      {way || foot ? (
        <MessageFoot board={board} where={{ thread }} said={message} after={after} onItsWay={way} outgoing={d.outgoing} onEdit={onEdit} onConnect={onOpen}>
          {reactions}
        </MessageFoot>
      ) : (
        reactions
      )}
    </>
  );
  const li = {
    id: draft ? undefined : commentAnchor(message.id),
    className: `thread-message${who}${cont ? ' is-cont' : ''}${arriving ? ' is-arriving' : ''}${state}`,
    'data-at': message.at,
    'data-message': message.id,
    onAnimationEnd: (e: React.AnimationEvent<HTMLLIElement>) => e.currentTarget.classList.remove('is-flash'),
  };
  if (mine) {
    // Yours: a bubble on the right, its time under it at the end of your turn, with what it asked for beside.
    const last = !turn(next);
    return (
      <li {...li}>
        <div className="thread-message-main">
          <div className="thread-bubble" aria-label={`You, ${when(message.at)}`}>
            <CommentText comment={message} />
          </div>
          <div className="thread-message-meta">
            {last && tag}
            <SaidTo board={board} said={message} />
            {message.lens && <MessageLensChip lens={message.lens} thread={thread} />}
            <ViaSkill via={message.via} />
            {(last || way) && time}
          </div>
          {rest}
        </div>
      </li>
    );
  }
  return (
    <li {...li}>
      <ActorBadge actor={message.author} showName={false} />
      <div className="thread-message-main">
        <div className="thread-message-head">
          <strong>{message.author.name}</strong>
          <SaidTo board={board} said={message} />
          {message.lens && <MessageLensChip lens={message.lens} thread={thread} />}
          {time}
          <ViaSkill via={message.via} />
          {tag}
        </div>
        <div className="thread-prose">
          <CommentText comment={message} />
        </div>
        {rest}
      </div>
    </li>
  );
}

// Messages from one author this close together read as one turn.
const TURN_MS = 10 * 60_000;

// Where a coordinator sent a message on (core/roles.ts): the thread, to open.
function SentOn({ board, sent, onThread }: { board: Board; sent: NonNullable<ThreadMessage['sent']>; onThread?: (id: string) => void }) {
  const to = board.threads?.find((t) => t.id === sent.threadId);
  if (!to || !onThread) return null;
  return (
    <button type="button" className="thread-sent" onClick={() => onThread(to.id)}>
      Open “{shownTitle(to)}” <Icon name="arrow-right" />
    </button>
  );
}

// The lens a person asked for on one message (^Design), by the message's
// author: the same chip as the thread's, with the ^ it was typed with. Its
// title says it is for this message alone.
function MessageLensChip({ lens, thread }: { lens: MessageLens; thread: Thread }) {
  const instead = thread.lens ? `, in place of the thread's ${thread.lens.name} lens` : '';
  const words = lens.name === 'General' ? 'Asked agents to answer without a lens' : `Asked agents to answer through the ${lens.name} lens`;
  return (
    <span className="thread-message-lens" title={`${words}, for this message alone${instead}.`}>
      <LensChip lens={lens}>^{lens.name}</LensChip>
    </span>
  );
}

function Listening({ board, thread }: { board: Board; thread: Thread | undefined }) {
  const here = useAgents().filter((a) => a.state !== 'away');
  const waiting = thread ? threadWaiting(board, thread) : undefined;
  if (here.length === 0) {
    return <p className="threads-quiet">No agent listening. What you write waits until an agent connects.</p>;
  }
  if (!waiting) return null;
  const named = waiting.agents;
  if (named.length && !named.some((a) => here.some((h) => samePerson(h.name, a)))) {
    return (
      <p className="threads-quiet">
        {listNames(named)} {named.length === 1 ? "isn't" : "aren't"} listening. It waits until {named.length === 1 ? 'it connects' : 'they connect'}.
      </p>
    );
  }
  return <p className="threads-quiet">Waiting for {named.length ? listNames(named) : 'an agent'} to reply.</p>;
}
