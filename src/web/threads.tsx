import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { inWindow } from '../core/delivery';
import { barSends, DOOR_NAMES } from '../core/doors';
import { listNames, samePerson } from '../core/format';
import { resolveMentions, splitQuestion } from '../core/mentions';
import { STARTERS } from '../core/requests';
import { threadGroups, threadMade, threadTag } from '../core/threadList';
import { shownTitle, threadTitle, threadWaiting } from '../core/threads';
import type { Actor, Board, Thread, ThreadDoor, ThreadLens, ThreadMessage, ThreadRef } from '../core/types';
import { api } from './api';
import { useUndoDelete } from './canvas/undo';
import { ChatBar } from './chatBar';
import { moveDock } from './dockMotion';
import { lookAtBoard } from './justMade';
import { BAR_PLACEHOLDERS, doorOfView, replyPlaceholder, viewOfDoor } from './chatDoor';
import { agentLineAt, LoopLine, SaidTo } from './agentTalk';
import { ActorBadge, Icon, timeAgo } from './components';
import { MessageFoot } from './delivery';
import { useMentionable } from './discussion';
import { CLOSED, dismissClick, dockOnArrival, interactiveAt, selectedText, type DockState, type Left, type Press } from './dockStays';
import { afterPress, ASK_AGENTS, go, otherPanelOpen, useDismiss, useReadOnly, type BoardViewName } from './hooks';
import { LensLine, LensPicker } from './lenses';
import { useAgents } from './looking';
import { CommentText, ViaSkill } from './mentions';
import { newestMine, onItsWay, outbox, settledKeys, useOutgoing, withOutgoing, type Outgoing } from './outbox';
import { Reactions } from './reactions';
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
  return { id: o.key, author: { kind: 'human', name }, body: o.body, at: o.at, ...(mentions.length && { mentions }) };
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
// (dockStays.ts), which puts the bar back at the bottom. The
// bar's threads button, and the panel's "← Threads", open the list of every
// thread (threadsList.tsx), waiting on you first. A person deletes a thread
// from its row; a toast offers to undo it, as on a canvas (canvas/undo.tsx).
// Agents answer over MCP (core/threads.ts); replies arrive with the board.

// Asks the dock to open on a thread, e.g. from the inbox, the activity log or
// a card made from it. On a card's own view there is no dock to hear it, so
// the board's tab opens (`from`), and its dock opens on the thread there.
const OPEN_THREAD = 'tricot:open-thread';
let docks = 0;
let asked: { id: string; thread?: Thread } | null = null;

export function openThread(threadId: string, thread?: Thread, from?: { boardId: string; view: BoardViewName }): void {
  if (docks > 0 || !from) {
    window.dispatchEvent(new CustomEvent<{ id: string; thread?: Thread }>(OPEN_THREAD, { detail: { id: threadId, thread } }));
    return;
  }
  asked = { id: threadId, thread };
  go[from.view](from.boardId);
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
  view: BoardViewName; // the tab the bar floats on: its door
  onSeeItem?: (id: string) => void; // reading a thread sees its events in the inbox
}

// The chat bar, floating at the foot of the tab, and the conversation it
// opens, docked on the right as a column of the board's layout (BoardView).
// One of them holds the bar at any time.
export function ThreadDock({ board, name, view, onSeeItem }: Props) {
  const readOnly = useReadOnly();
  const threads = board.threads ?? [];
  const { seen, markSeen } = useThreadsSeen(board);
  const groups = useMemo(() => threadGroups(board, name, seen, Date.now()), [board, name, seen]);
  const listening = useAgents()
    .filter((a) => a.state !== 'away')
    .map((a) => a.name);
  const names = useMentionable(name);
  const door = doorOfView(view);
  const [askedHere] = useState(() => view === 'canvas' && ASK_AGENTS.test(location.hash));
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
  // opens in the panel (a thread, from the activity log) stays open.
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

  useEffect(() => {
    if (!askedHere) return;
    if (ASK_AGENTS.test(location.hash)) history.replaceState(history.state, '', `${location.pathname}${location.search}${location.hash.replace(ASK_AGENTS, '')}`);
    focusBar(true);
  }, [askedHere, focusBar]);

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
  // The inbox, the activity log or a card asks for a thread: this dock opens
  // on it, and one asked for from a card's view before this dock was here.
  useEffect(() => {
    docks += 1;
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
      docks -= 1;
      window.removeEventListener(OPEN_THREAD, onOpen);
    };
  }, [showThread]);

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
  // Escape closes it, and so does a dismiss click (dockStays.ts): a plain
  // click on empty space outside it that does nothing else, such as the
  // page's background, an empty part of a list or the empty canvas. A press
  // on something that does something (a card, a link or T6 chip, a tab, a
  // button, a field, a canvas block or link) goes through and leaves it open;
  // so do a drag, a selection, the canvas panning, and a right-click or a
  // modified click. Something over it takes Escape and a press first, and
  // closes alone: the threads list, a menu, a dialog, or a popover, such as
  // the Connect panel from "Connect one". A dismiss click is known once the
  // press is over (afterPress), and then the panel goes: the click has done
  // what it would have, on the board as it was. The focus stays where the
  // click put it; the bar keeps what's typed and its caret.
  const panel = useRef<HTMLElement>(null);
  const dismiss = useCallback(
    (escape: boolean, event: MouseEvent | KeyboardEvent) => {
      const over = Boolean(document.querySelector('[aria-modal="true"]')) || otherPanelOpen(panel);
      if (escape) {
        if (!event.defaultPrevented && !over) close();
        return;
      }
      const down = event as MouseEvent;
      const target = down.target as Element;
      const pressed: Press = {
        button: down.button,
        metaKey: down.metaKey,
        ctrlKey: down.ctrlKey,
        shiftKey: down.shiftKey,
        altKey: down.altKey,
        interactive: interactiveAt(target, { x: down.clientX, y: down.clientY }),
        taken: over || Boolean(target.closest?.('.popover[open]')),
      };
      if (!dismissClick(pressed)) return;
      const caret = caretNow(); // before the press moves the focus
      const selection = selectedText();
      leaving.current = true;
      press.current?.();
      press.current = afterPress((end) => {
        press.current = null;
        const moved = end.type === 'mouseup' ? Math.hypot(end.clientX - down.clientX, end.clientY - down.clientY) : Infinity;
        const selected = selectedText();
        if (isDocked.current && dismissClick(pressed, { moved, selected: selected !== '' && selected !== selection })) {
          if (caret) carets.current.set(fieldKey.current, caret);
          dock(false, () => set({ open: false }), false);
        } else leaving.current = false;
      });
    },
    [close, caretNow, dock, set],
  );
  useDismiss(docked && !listOpen, dismiss, panel);
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
  fieldKey.current = draftKey;
  const draft = drafts[draftKey] ?? '';
  const setDraft = (key: string, body: string) => set((current) => ({ drafts: { ...current.drafts, [key]: body } }));
  const sends = through ? barSends(through, listening.length) : 'reply';

  // A new thread shows the moment it's sent, then becomes the one the server
  // made, unless the person has moved on to another meanwhile. The panel
  // opens through the dock's motion, which runs its change a frame or more
  // later (dockMotion.ts): the server may answer first, and then the panel
  // opens on the server's thread rather than an empty stand-in.
  const startThread = (text: string, from: ThreadDoor, lens: ThreadLens | null) => {
    const at = new Date().toISOString();
    const me: Actor = { kind: 'human', name };
    const local: Thread = {
      id: `${LOCAL}${Date.now().toString(36)}`,
      title: threadTitle(text, resolveMentions(text, names)),
      door: from,
      startedBy: me,
      startedAt: at,
      updatedAt: at,
      messages: [],
      ...(lens && { lens }),
    };
    let answered: Thread | null = null; // the server's, once it has it
    outbox.send(`thread:${local.id}`, text, [], async (key) => {
      const made = await api.startThread(board.id, name, text, lens ?? undefined, from);
      const sent = { id: made.messages[0].id, place: `thread:${made.id}` };
      answered = made;
      outbox.arrived(key, sent); // drawn in the thread the server made under the same key
      markSeen(made);
      setStarted((current) => (current?.id === local.id ? made : current));
      set((current) => (current.selected === local.id ? { selected: made.id } : {}));
      return sent;
    });
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
  const postQuestion = async (text: string) => {
    const { question, comment } = splitQuestion(text, names.filter((n) => !samePerson(n, name)));
    if (!question) return;
    setBusy(true);
    try {
      const decision = await api.postDecision(board.id, name, { question });
      setDraft('bar', ''); // it's on the board now: sending again would post it twice
      if (comment) {
        try {
          await api.comment(decision.id, name, comment);
        } catch (e) {
          setError(`#${decision.number} is on the board, but “${comment}” didn't post: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    if (!through) {
      if (!thread || isLocal(thread)) return; // nothing goes to a thread the server hasn't made yet
      const known = thread.messages.map((m) => m.id);
      outbox.send(`thread:${thread.id}`, text, known, async () => newestMine((await api.postToThread(thread.id, name, text)).messages, known, name, text));
      setDraft(thread.id, '');
      return;
    }
    if (sends === 'question') return void postQuestion(text);
    startThread(text, through, through === 'threads' ? newLens : null);
  };

  // One not sent goes back where it was typed: a thread just started back to
  // its bar, a reply back to its thread's.
  const editUnsent = (body: string) => {
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
  const placeholder = through
    ? through === 'threads' && newLens
      ? `What do you want to work through in ${newLens.name}?`
      : BAR_PLACEHOLDERS[through]
    : replyPlaceholder(thread!, listening);
  const bar = readOnly ? null : (
    <ChatBar
      docked={docked}
      value={draft}
      onValue={(body) => setDraft(draftKey, body)}
      onSend={send}
      placeholder={placeholder}
      label={through ? (through === 'threads' ? 'Start a new thread' : `Talk to agents from ${DOOR_NAMES[through]}`) : `Reply in ${thread!.title}`}
      sendLabel={sends === 'reply' ? 'Send' : sends === 'question' ? 'Post as a question' : 'Start a thread'}
      busy={busy || isLocal(thread)}
      field={field}
      threads={docked ? undefined : { count: waitingCount, open: listOpen, onOpen: toggleList, button: listButton }}
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
  const tag = threadTag(thread);
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
          note={thread.general ? "What people asked from the Board Context's Ask agents bar; agents answer as they see fit." : undefined}
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
function Conversation(props: { board: Board; thread: Thread | undefined; name: string; onOpen: () => void; onEdit: (body: string) => void }) {
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
              <li key={d.key} className={`thread-message${arriving ? ' is-arriving' : ''}${state}`}>
                <ActorBadge actor={message.author} showName={false} />
                <div className="thread-message-main">
                  <div className="thread-message-head">
                    <strong>{message.author.name}</strong>
                    <SaidTo board={board} said={message} />
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
