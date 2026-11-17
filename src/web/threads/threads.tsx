import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { inWindow } from '../../core/delivery';
import { barPlaceholder, barSends, doorName } from '../../core/doors';
import { agentOnFile, type OpenFile } from '../../core/fileThread';
import { listNames, samePerson } from '../../core/format';
import { splitLensCommand } from '../../core/lensCommand';
import { boardAgents, resolveMentions, splitQuestion } from '../../core/mentions';
import { STARTERS } from '../../core/requests';
import { threadGroups, threadMade, threadTag } from '../../core/threadList';
import { pageLens } from '../../core/scratchPad';
import { shownTitle, threadTitle, threadWaiting } from '../../core/threads';
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
import { agentLineAt, commentAnchor, LoopLine, MessageFoot, newestMine, onItsWay, outbox, Reactions, SaidTo, settledKeys, useMentionable, useOutgoing, withOutgoing, type Outgoing } from '../conversation';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { CLOSED, dockOnArrival, type DockState, type Left } from './dockStays';
import { escapeCloses, followPress, useBeside, useDismiss, useReadOnly } from '../shared/hooks';
import { askDockToOpen, OPEN_THREAD } from '../shared/openThread';
import { dropFlag, flagged, flags, type BoardViewName } from '../shared/pages';
import { lensChoices, messageLensOf } from './lensChoices';
import { LensChip, LensLine, LensPicker } from './lenses';
import { useAgents } from '../agents';
import { CommentText, ViaSkill } from '../shared/mentions';
import { ThreadsList } from './threadsList';
import { useThreadsSeen } from './threadsSeen';
import { WorkCards } from './threadWork';
import './threads.css';

// A thread just started, drawn until the server has it: its first message is
// in the outbox (outbox.ts). Nothing is sent to it, nor changed on it.
const LOCAL = 'local-';
const isLocal = (thread: Thread | undefined) => Boolean(thread?.id.startsWith(LOCAL));

// A message being sent, drawn until the board has it.
function draftMessage(o: Outgoing, name: string, names: string[]): ThreadMessage {
  const mentions = resolveMentions(o.body, names);
  return { id: o.key, author: { kind: 'human', name }, body: o.body, at: o.at, ...(o.lens && { lens: o.lens }), ...(mentions.length && { mentions }) };
}

// The board's threads: conversations with agents, each through a lens. The
// chat bar floats at the foot of every tab (chatBar.tsx); what's sent from it
// starts a thread through that tab's door (core/doors.ts), which opens in a
// panel docked on the right, the board still there beside it, and the bar
// becomes the panel's reply box. The panel shows one thread, under "← Threads"
// and its title, with where it was started and what it made, or New thread,
// the open-ended door. It stays open while the person uses the board: opening
// a card, following a link or a T6 chip, changing tabs, pressing a button,
// selecting text, dragging or panning the canvas all leave it be, and it is
// open again, on the same thread, when they come back from a card's own view.
// On another project it stays open, on that project's threads list (or the
// thread it had open there). It closes on its close button, on Escape, or on
// a dismiss click, a plain click on empty space that does nothing else
// (shared/dismissClick.ts), which puts the bar back at the bottom. The
// bar's threads button, and the panel's "← Threads", open the list of every
// thread (threadsList.tsx), waiting on you first. A person deletes a thread
// from its row; a toast offers to undo it, as on a canvas (canvas/undo.tsx).
// Agents answer over MCP (core/threads.ts); replies arrive with the board.

// Asks the dock to open on a thread, e.g. from the notifications list, the changes feed, a
// notification or a card made from it. Where no dock of its board is there to
// hear it (a card's own view, Home, another board), the board's tab opens
// (`from`), and its dock opens on the thread there.
const docks: string[] = []; // the boards whose docks are on screen
let asked: { id: string; thread?: Thread } | null = null;

export function openThread(threadId: string, thread?: Thread, from?: { boardId: string; href: string }): void {
  if (!from || docks.includes(from.boardId)) {
    askDockToOpen(threadId, thread);
    return;
  }
  asked = { id: threadId, thread };
  location.hash = from.href;
}

// The tab a thread opens on from a card's view: where it was started, else
// the card's own tab.
export function threadTab(board: Board, threadId: string, fallback: BoardViewName): BoardViewName {
  return viewOfDoor(board.threads?.find((t) => t.id === threadId)?.door) ?? fallback;
}

// ---- the dock ----------------------------------------------------------------

// Home's "Ask an agent for the first questions" opens the Board Context with
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
  const [arrival] = useState(() => dockOnArrival(remembered.get(board.id) ?? CLOSED, board.id, left, (id) => threads.some((t) => t.id === id)));
  const [state, setState] = useState<DockState>(() => {
    const kept = arrival.state;
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
  const [busy, setBusy] = useState(false); // a question card on its way
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const { remove, toast } = useUndoDelete(name, report);
  const field = useRef<HTMLInputElement>(null);
  const [listOpen, setListOpen] = useState(() => arrival.list && !askedHere); // the threads list
  const listButton = useRef<HTMLButtonElement>(null); // what opened it, which toggles it

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

  // Home's ask lands with the bar focused, its starter selected: at once, the
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
  useEffect(() => {
    const here = board.id;
    docks.push(here);
    if (asked) {
      showThread(asked.id, asked.thread);
      asked = null;
    }
    const onOpen = (e: Event) => {
      const { id, thread } = (e as CustomEvent<{ id: string; thread?: Thread }>).detail;
      showThread(id, thread);
    };
    window.addEventListener(OPEN_THREAD, onOpen);
    return () => {
      docks.splice(docks.indexOf(here), 1);
      window.removeEventListener(OPEN_THREAD, onOpen);
    };
  }, [showThread, board.id]);
  const thread = page === 'thread' ? (threads.find((t) => t.id === selected) ?? (started?.id === selected ? started : undefined)) : undefined;
  // Docked: a thread, or New thread. One deleted (or not found) while open
  // lets the bar go back to the bottom.
  const docked = open && (page === 'new' || Boolean(thread));
  isDocked.current = docked;
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
  // Leaving the board's tabs, for a card's view, Home or another project: a
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

  // What's on screen is seen, replies arriving while it's open included.
  const lastId = thread?.messages.at(-1)?.id;
  useEffect(() => {
    if (!docked || !thread || isLocal(thread)) return;
    markSeen(thread);
    onSeeItem?.(thread.id);
  }, [docked, thread?.id, lastId, markSeen, onSeeItem]); // once per message seen

  const toggleList = () => {
    setError(null);
    setListOpen((was) => !was);
  };
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
  // thread, and else the tab's own door.
  const through: ThreadDoor | undefined = docked && page === 'thread' ? undefined : docked && page === 'new' ? 'threads' : door;
  const draftKey = through === undefined ? thread!.id : through === 'threads' ? 'new' : 'bar';
  // Floating over a Sketchbook page, the bar asks about it, of its agent if it has one.
  const overPage = !docked && door === 'threads' ? shownPage : undefined;
  // Blocks selected on it go with what's sent, as what the thread it starts is
  // about: agents talk it through there before they make anything.
  const selection = usePageSelection(overPage?.id);
  const pageWords = overPage && pageBar(overPage, selection?.blockIds.length);
  // In Files, with a file open, it asks about the file, of the agent last asked about it, if one was.
  const overFile = !docked && door === 'threads' && !shownPage ? shownFile : undefined;
  const fileAgent = useMemo(() => overFile && agentOnFile(board, overFile.named, boardAgents(board, present.map((a) => a.name))), [board, overFile, present]);
  const fileWords = overFile && fileBar(overFile.path, fileAgent);
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
  const startThread = (text: string, from: ThreadDoor, lens: ThreadLens | null, own?: MessageLens, onPage?: ScratchPage, blockIds?: string[], onFile?: string) => {
    const at = new Date().toISOString();
    const me: Actor = { kind: 'human', name };
    // Over a page, or a file, routed as the server will route it (core/scratchPad.ts pageLens).
    const routed = onPage ? pageLens(onPage, lens) : onFile && fileAgent ? pageLens({ agent: { name: fileAgent } }, lens) : lens;
    const local: Thread = {
      id: `${LOCAL}${Date.now().toString(36)}`,
      title: threadTitle(text, resolveMentions(text, names)),
      door: from,
      ...(onPage && { pageId: onPage.id }),
      ...(onPage && blockIds?.length && { blockIds }),
      startedBy: me,
      startedAt: at,
      updatedAt: at,
      messages: [],
      ...(routed && { lens: routed }),
    };
    let answered: Thread | null = null; // the server's, once it has it
    const post = async (key: string) => {
      const made = await api.startThread(board.id, name, text, lens ?? undefined, from, own, onPage?.id, blockIds, onFile);
      const sent = { id: made.messages[0].id, place: `thread:${made.id}` };
      answered = made;
      outbox.arrived(key, sent); // drawn in the thread the server made under the same key
      markSeen(made);
      setStarted((current) => (current?.id === local.id ? made : current));
      set((current) => (current.selected === local.id ? { selected: made.id } : {}));
      return sent;
    };
    outbox.send(`thread:${local.id}`, text, [], post, own);
    // What was sent leaves the bar as the panel takes it.
    carets.current.delete(from === 'threads' ? 'new' : 'bar');
    dock(true, () => {
      const shown = answered ?? local;
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
  const toLens = docked && page === 'thread' ? thread?.lens : docked && page === 'new' ? (newLens ?? undefined) : undefined;
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
      const known = thread.messages.map((m) => m.id);
      outbox.send(`thread:${thread.id}`, text, known, async () => newestMine((await api.postToThread(thread.id, name, text, own)).messages, known, name, text), own);
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
  const placeholder = through
    ? aboutWords
      ? aboutWords.placeholder
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
  const threadsList = listOpen && (
    <ThreadsList
      groups={groups}
      name={name}
      current={docked ? thread?.id : undefined}
      readOnly={readOnly}
      docked={docked}
      onOpen={openFromList}
      onNew={startNew}
      onDelete={deleteThread}
      onClose={closeList}
      toggle={listButton}
    />
  );

  if (!docked) {
    return (
      <>
        <div className="chat-float">
          {threadsList}
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
    <aside className="thread-dock" ref={panel} aria-label="Threads">
      <header className="dock-head">
        <button
          type="button"
          ref={listButton}
          className="dock-back"
          onClick={toggleList}
          aria-expanded={listOpen}
          aria-haspopup="dialog"
          aria-label={`All threads${othersWaiting ? `, ${othersWaiting} waiting on you` : ''}`}
        >
          <Icon name="arrow-left" /> Threads
          {othersWaiting > 0 && (
            <span className="dock-count" aria-hidden>
              {othersWaiting}
            </span>
          )}
        </button>
        {closeButton}
      </header>
      {threadsList}
      {error && (
        <p className="error threads-error" role="alert">
          {error}
        </p>
      )}
      {page === 'thread' && thread && (
        <>
          <ThreadTitle board={board} thread={thread} readOnly={readOnly || isLocal(thread)} onPick={(lens) => setLens(thread, lens)} />
          <Conversation board={board} thread={thread} name={name} onOpen={noop} onEdit={editUnsent} />
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

// The open thread's title, and under it where it was started, what it made
// (#78, T48, 3 blocks) and when, and its lens, whose chip changes it.
function ThreadTitle(props: { board: Board; thread: Thread; readOnly: boolean; onPick: (lens: ThreadLens | null) => void }) {
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
function Conversation(props: { board: Board; thread: Thread | undefined; name: string; onOpen: () => void; onEdit: (body: string, lens?: MessageLens) => void }) {
  const { board, thread, name, onOpen, onEdit } = props;
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
  const mine = (m: ThreadMessage) => m.author.kind === 'human' && samePerson(m.author.name, name);
  const latest = drawn.findLastIndex((d) => d.item.author.kind === 'human');
  const lineAt = latest >= 0 && mine(drawn[latest].item) ? latest : -1;
  const agentAt = thread ? agentLineAt(board, thread.messages) : -1;
  const agentLine = agentAt >= 0 ? thread!.messages[agentAt].id : undefined;
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
          {drawn.map((d, i) => {
            const message = d.item;
            const way = onItsWay(d);
            const draft = message.id === d.outgoing?.key;
            const reactions = draft || isLocal(thread) ? null : <Reactions item={message} place={{ threadId: thread.id }} name={name} />;
            const arriving = message.author.kind === 'agent' && !opened.current!.ids.has(message.id);
            const state = way === 'sending' ? ' is-sending' : way === 'failed' ? ' is-unsent' : '';
            return (
              <li
                key={d.key}
                id={draft ? undefined : commentAnchor(message.id)}
                className={`thread-message${arriving ? ' is-arriving' : ''}${state}`}
                onAnimationEnd={(e) => e.currentTarget.classList.remove('is-flash')}
              >
                <ActorBadge actor={message.author} showName={false} />
                <div className="thread-message-main">
                  <div className="thread-message-head">
                    <strong>{message.author.name}</strong>
                    <SaidTo board={board} said={message} />
                    {message.lens && <MessageLensChip lens={message.lens} thread={thread} />}
                    <span className="thread-message-time" title={new Date(message.at).toLocaleString()}>
                      {timeAgo(message.at)}
                    </span>
                    <ViaSkill via={message.via} />
                  </div>
                  <CommentText comment={message} />
                  {message.refs?.length ? <WorkCards board={board} refs={message.refs} onOpen={onOpen} /> : null}
                  {way || i === lineAt || message.id === agentLine ? (
                    <MessageFoot
                      board={board}
                      where={{ thread }}
                      said={message}
                      after={drawn.slice(i + 1).map((x) => x.item)}
                      onItsWay={way}
                      outgoing={d.outgoing}
                      onEdit={onEdit}
                      onConnect={onOpen}
                    >
                      {reactions}
                    </MessageFoot>
                  ) : (
                    reactions
                  )}
                </div>
              </li>
            );
          })}
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
    </div>
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
