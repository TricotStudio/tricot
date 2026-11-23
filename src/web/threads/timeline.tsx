import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { splitLensCommand } from '../../core/lensCommand';
import { homeRows, homeSaid, lanesOf, ownedThreads, ownName, seenBy, sentStateWords, strandOf, strandsShown, threadTone, type Said as HomeSaid } from '../../core/homeConversation';
import { askedTag, inConversation, threadGroups } from '../../core/threadList';
import { agentsOf, coordinatorOf, whoAnswers } from '../../core/whoAnswers';
import { shownTitle } from '../../core/threads';
import type { Board, Thread, ThreadLens, ThreadMessage } from '../../core/types';
import { phaseOf, useAgents, useSteps, useWork } from '../agents';
import { onItsWay, outbox, settledKeys, useMentionable, withOutgoing, type Drawn } from '../conversation';
import { useUndoDelete } from '../canvas';
import { planProgress } from '../../core/agentWork';
import { api } from '../shared/api';
import type { Away } from '../shared/boardHost';
import { Icon } from '../shared/components';
import { useReadOnly, useStoredFlag } from '../shared/hooks';
import { go, linkTo, replaceAddress, type BoardRoute } from '../shared/pages';
import { ChatBar, threadsButtonOnScreen } from './chatBar';
import { replyingTo } from './chatDoor';
import { lensChoices, messageLensOf } from './lensChoices';
import { RelayCard, RelayStack, toneOf } from './relayCard';
import { useRelays, type Relay } from './relays';
import { draftMessage, isLocal, replyInThread, startThread, unsentStarts } from './send';
import { Conversation, footsOf, MessageRow, ThreadTitle, useThreadsOpenHere } from './threads';
import { ThreadsList } from './threadsList';
import { useThreadsSeen } from './threadsSeen';
import { WorkPanel } from './timelineWork';
import { moveWork } from './workMotion';
import { gutterOf, Unwound, whenOf, Yarn, YarnBall, type Span, type Strand } from './yarn';
import './timeline.css';

// A board's Home (the core's view 'timeline', at /home: board/coreViews.tsx).
// Its main pane is the board's conversation: what people ask from the chat bar
// and what the coordinator answers (core/roles.ts), gathered from the threads
// of the conversation (core/threadList.ts inConversation) and drawn as a
// thread draws its messages, oldest first, with the day and where the viewer
// was last here between them. Where
// the coordinator sent an ask on, a card under it names the thread it went to
// and where its work stands. Its yarn (yarn.tsx) runs beside it: the
// conversation one plied strand, each thread an agent owns knitting off it
// where it was sent on, and every strand running on past the top unwinding
// from a ball of yarn, which opens the threads list. The bar at its foot asks
// something new, as the chat bar does.
//
// A thread picked (its card, its strand, its row in Work, the threads list,
// or anything that asks the dock to open one) opens in the main pane, at its
// own address (core/pages.ts), with its reply box at the foot and its strand
// beside its messages; "Conversation", or the conversation's strand, goes back. Work (timelineWork.tsx) sits on
// the right. The view holds its own conversation, so the board's page draws no
// chat bar or docked panel over it (shared/boardViews.ts holdsChat), and it
// answers what asks the dock to open a thread.
//
// What the conversation holds (its messages, the cards under the asks, the
// relays, the rows with the days between them, the strands' tones and lanes)
// is core/homeConversation.ts's, which the terminal's chat shows too: here it
// is drawn.

// What is typed in each bar, per board, for as long as the page is open: the
// conversation's ('bar') and each thread's, by its id.
const drafts = new Map<string, string>();
function useDraft(boardId: string, key: string): [string, (value: string) => void] {
  const at = `${boardId}:${key}`;
  const [value, setValue] = useState(() => drafts.get(at) ?? '');
  useEffect(() => setValue(drafts.get(at) ?? ''), [at]);
  const set = useCallback(
    (next: string) => {
      drafts.set(at, next);
      setValue(next);
    },
    [at],
  );
  return [value, set];
}

// Where the conversation was scrolled on each board, for coming back to it
// from a thread: at its foot, it stays at the latest as messages come.
const scrolls = new Map<string, { top: number; foot: boolean }>();

// When the viewer came to each board's conversation, as this page opened it:
// what was relayed since they were last here and before it came while they
// were away, and arrives as one card (relayCard.tsx RelayStack).
const cameIn = new Map<string, number>();

// How wide the scroller's own scrollbar is (timeline.css .timeline-scroll): 0
// where scrollbars float over the page, as on a Mac with a trackpad, and as
// wide as the system draws them where they take room, as with a mouse.
function useScrollbar(scroller: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const again = () => setWidth(el.offsetWidth - el.clientWidth);
    again();
    const watch = new ResizeObserver(again); // its content box narrows as a scrollbar comes
    watch.observe(el);
    return () => watch.disconnect();
  }, [scroller]);
  return width;
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

interface Props {
  board: Board;
  name: string;
  route: BoardRoute;
  away: Away;
}

// Work comes over the content from the right: it starts shown where the window has room for it beside the
// conversation's column (timeline.css), and folded where it would cover some of it.
const ROOM_FOR_WORK = 1424;

export function TimelineView({ board, name, route, away }: Props) {
  const [lit, setLit] = useState<string | null>(null);
  const [workShown, showWork] = useStoredFlag('tricot:home-work', () => window.innerWidth >= ROOM_FOR_WORK);
  // Folded for now by a click away or Esc, the kept choice left as it is: the next visit opens it again.
  // Each way it folds or unfolds moves it (workMotion.ts); a visit lands on it as it is.
  const [workAway, setWorkAway] = useState(false);
  const showWorkNow = useCallback(
    (next: boolean) =>
      moveWork(next ? 'open' : 'close', () => {
        setWorkAway(false);
        showWork(next);
      }),
    [showWork],
  );
  const dismissWork = useCallback(() => moveWork('close', () => setWorkAway(true)), []);
  const open = useCallback((id: string) => go.timeline(board.id, id), [board.id]);
  useThreadsOpenHere(board.id, open);
  // The board's own address lands here: it moves to Home's own, in place, so Back skips it.
  const landed = Boolean(route.landing);
  useEffect(() => {
    if (landed) replaceAddress(linkTo.board(board.id, 'timeline'));
  }, [landed, board.id]);
  const agents = useAgents();
  const steps = useSteps();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const thread = route.threadId ? board.threads?.find((t) => t.id === route.threadId) : undefined;
  const work = useWork();
  // A thread's strand (core/homeConversation.ts), with how far its agent's plan is and whether it has a step there now.
  const strandFor = (t: Thread): Strand => {
    const tone = threadTone(t, agents);
    const progress = tone === 'working' ? planProgress(work.find((w) => w.thread === t.id && w.plan)?.plan) : undefined;
    return strandOf(t, tone, progress, steps.some((s) => s.thread === t.id && !s.done && phaseOf(s, now) === 'live'));
  };
  // The same strands while what they say is: an agent's step, or the clock's tick, that changes none of them leaves
  // the conversation as it was drawn, rather than drawing every message again.
  const drawnStrands = ownedThreads(board).map(strandFor);
  const strandsSaid = JSON.stringify(drawnStrands);
  const strands = useMemo(() => drawnStrands, [strandsSaid]);
  const drawnOpen = thread && !inConversation(thread) ? strandFor(thread) : undefined;
  const openSaid = JSON.stringify(drawnOpen ?? null);
  const openStrand = useMemo(() => drawnOpen, [openSaid]);
  return (
    <section className="board-timeline" aria-label="Home">
      <div className="timeline-main">
        {thread ? (
          <ThreadPane key={thread.id} board={board} name={name} thread={thread} strand={openStrand} onSeeItem={away.markSeen} />
        ) : (
          <MainConversation key={board.id} board={board} name={name} today={new Date(now).toDateString()} since={away.visit.sinceAt} seeItem={away.markSeen} strands={strands} lit={lit} onLight={setLit} onOpen={open} />
        )}
      </div>
      <WorkPanel board={board} name={name} current={thread?.id} lit={lit} onLight={setLit} shown={workShown && !workAway} onShow={showWorkNow} onDismiss={dismissWork} />
    </section>
  );
}

// ---- the conversation ------------------------------------------------------------

// Something said in the conversation (core/homeConversation.ts Said), as it is drawn, with what is on its way, and
// whether it shows the line that says what became of it (`foot`).
interface Said extends HomeSaid<Drawn<ThreadMessage>> {
  drawn: Drawn<ThreadMessage>;
  foot: boolean;
}

// The conversation's messages, oldest first (core/homeConversation.ts homeSaid): every thread's that is not
// handed-out work, with what is on its way, a coordinator's word that it sent an ask on drawn as the card under the
// ask, and what was asked in the conversation of a thread an agent owns, with the thread as its card.
// Worked out again only when what it reads changes, not as the bar is typed in: the rows drawn from it are kept the same
// while it is (MainConversation).
function useSaid(board: Board, threads: Thread[], owned: Thread[], name: string): Said[] {
  const all = useSyncExternalStore(outbox.subscribe, outbox.get);
  const names = useMentionable(name);
  const namesSaid = names.join('\n');
  return useMemo(() => saidIn(board, threads, owned, name, all, names), [board, threads, owned, name, all, namesSaid]);
}

function saidIn(board: Board, threads: Thread[], owned: Thread[], name: string, all: ReturnType<typeof outbox.get>, names: string[]): Said[] {
  // Each thread of the conversation as drawn, with what is on its way, and the line under it that says what became of it.
  const drawnOf = new Map<string, Drawn<ThreadMessage>[]>();
  const feet = new Map<string, ReturnType<typeof footsOf>>();
  for (const thread of threads) {
    const drawn = withOutgoing(
      thread.messages,
      all.filter((o) => o.place === `thread:${thread.id}`),
      name,
      (o) => draftMessage(o, name, names),
    );
    drawnOf.set(thread.id, drawn);
    feet.set(thread.id, footsOf(board, thread, drawn, name));
  }
  return homeSaid(board, threads, owned, (thread) => drawnOf.get(thread.id) ?? [], (d) => d.item, (message) => ({ item: message, key: message.id })).map((s) => {
    const foot = s.inWork ? undefined : feet.get(s.thread.id);
    return { ...s, drawn: s.item, foot: Boolean(foot && (onItsWay(s.item) || s.index === foot.lineAt || s.item.item.id === foot.agentLine)) };
  });
}

// Drawn again only when what it is given changes (memo), not each time the board's page is: a long conversation
// takes a while to draw.
const MainConversation = memo(function MainConversation(props: {
  board: Board;
  name: string;
  today: string; // the day, by the view's clock: Today and Yesterday, between the rows and in the yarn, turn with it
  since: string | null; // when the viewer was last here, for the visit (Away.visit)
  seeItem: (id: string) => void; // Away.markSeen
  strands: Strand[];
  lit: string | null;
  onLight: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const { board, name, today, since, seeItem, strands, lit, onLight, onOpen } = props;
  const readOnly = useReadOnly();
  const agents = useAgents();
  const names = useMentionable(name);
  const { seen, markSeen } = useThreadsSeen(board);
  const [locals, setLocals] = useState<Thread[]>(() => unsentStarts(board.id)); // started here, until the board has them, those a reload brought back not sent included
  const threads = useMemo(
    () => [...(board.threads ?? []).filter(inConversation), ...locals.filter((l) => !board.threads?.some((t) => t.id === l.id))],
    [board.threads, locals],
  );
  // Once the board has one, it is the board's alone: when it goes from the board, moved into the thread it follows up
  // (core/store/threads.ts routeToThread) or deleted, it goes from here too, not back to how it was sent.
  const landed = locals.filter((l) => board.threads?.some((t) => t.id === l.id)).map((l) => l.id).join();
  useEffect(() => {
    if (landed) setLocals((was) => was.filter((l) => !landed.split(',').includes(l.id)));
  }, [landed]);
  const owned = useMemo(() => ownedThreads(board), [board.threads]);
  const shown = useSaid(board, threads, owned, name);
  const relays = useRelays(board, name, agents);
  const [arrived] = useState(() => cameIn.get(board.id) ?? cameIn.set(board.id, Date.now()).get(board.id)!);
  const settled = shown.flatMap((s) => settledKeys([s.drawn])).join();
  useEffect(() => {
    for (const key of settled ? settled.split(',') : []) outbox.remove(key);
  }, [settled]);

  // The strands shown: those not done before the first message shown.
  const firstAt = shown[0]?.drawn.item.at;
  const visible = useMemo(() => strandsShown(strands, firstAt), [strands, firstAt]);
  const lanes = useMemo(() => lanesOf(visible), [visible.map((s) => `${s.id}:${s.from}:${s.to ?? ''}`).join()]);
  const gutter = gutterOf(Math.max(0, ...visible.map((s) => (lanes.get(s.id) ?? 0) + 1)));

  // Kept at the latest as messages come, unless the viewer scrolled up to
  // read, and where it was left when a thread opened over it.
  const scroller = useRef<HTMLDivElement>(null);
  const scrollbar = useScrollbar(scroller);
  const [spans, setSpans] = useState<Span[]>([]); // where the strands' lanes run, for the ball they unwind from
  // What is on screen is seen: a thread of the conversation once its latest
  // message is in view (or the ask its coordinator's word is drawn under, as
  // the card), as its replies come. One scrolled out of sight still waits.
  const latest = threads.map((t) => `${t.id}:${t.messages.at(-1)?.id ?? ''}`).join();
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const seers = new Map<string, Thread>(); // a row's message -> the thread its showing sees (core/homeConversation.ts seenBy)
    for (const thread of threads) {
      const by = seenBy(thread);
      if (!by || isLocal(thread)) continue;
      seers.set(by, thread);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const thread = entry.isIntersecting ? seers.get((entry.target as HTMLElement).dataset.message ?? '') : undefined;
          if (!thread) continue;
          markSeen(thread);
          seeItem(thread.id);
        }
      },
      { root, threshold: 0.5 },
    );
    for (const row of root.querySelectorAll<HTMLElement>('li[data-message]')) if (seers.has(row.dataset.message ?? '')) observer.observe(row);
    return () => observer.disconnect();
  }, [latest, markSeen, seeItem]); // once per message
  const atFoot = useRef(scrolls.get(board.id)?.foot ?? true);
  const restored = useRef(false);
  // The rows as shown, by what each is: what was said, the threads it was sent on to and what it made, and the relays
  // shown with it. It changes as one comes, goes or takes another's place (a thread deleted leaves the coordinator's
  // word where its card was), which a count of them would miss.
  const relayed = relays.map((r) => `${r.key}${r.needsYou ? '!' : ''}`).join();
  const rowsKey = `${shown.map((s) => `${s.drawn.key}>${s.sentOn.map((t) => t.id).join('+')}+${s.drawn.item.refs?.length ?? 0}`).join()}:${relayed}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const kept = restored.current ? undefined : scrolls.get(board.id);
    restored.current = true;
    if (kept && !kept.foot) el.scrollTop = kept.top;
    else if (atFoot.current) el.scrollTop = el.scrollHeight;
  }, [rowsKey, board.id]);

  // The keyboard on the yarn: ← → between strands, Enter opens one's thread in the main pane, Esc leaves the yarn.
  const order = [...visible].sort((a, b) => (lanes.get(a.id) ?? 0) - (lanes.get(b.id) ?? 0) || a.from.localeCompare(b.from)).map((s) => s.id);
  const [ring, setRing] = useState<string | null>(null);
  const keys = useRef<HTMLDivElement>(null);
  const branchOf = (id: string) => scroller.current?.querySelector<HTMLElement>(`[data-yarn-branch="${CSS.escape(id)}"]`);
  const ringOn = (id: string | null) => {
    setRing(id);
    if (id) branchOf(id)?.scrollIntoView({ block: 'nearest' });
  };
  const onYarnKey = (e: ReactKeyboardEvent) => {
    const at = ring ? order.indexOf(ring) : -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!order.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      ringOn(order[at < 0 ? 0 : (at + step + order.length) % order.length]);
    } else if (e.key === 'Enter' && ring) {
      e.preventDefault();
      onOpen(ring);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      keys.current?.blur();
    }
  };

  // The bar: a new ask, as the chat bar's, which the coordinator answers here or sends on. A thread opened (its
  // strand, its card, its row in Work) has the bar aimed at it in the main pane (ThreadPane).
  const field = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useDraft(board.id, 'bar');
  const lenses = useMemo(() => lensChoices(undefined), []);
  // Reply on a relay aims the bar at its thread for one message: sending, Esc or the chip's ✕ lets go, and so
  // does its question being answered anywhere else.
  const [aim, setAim] = useState<string | null>(null); // the relay's key
  const aimed = aim ? relays.find((r) => r.key === aim && r.needsYou && r.thread) : undefined;
  useEffect(() => {
    if (aim && !aimed) setAim(null);
  }, [aim, aimed]);
  const reply = useCallback(
    (relay: Relay) => {
      setAim(aim === relay.key ? null : relay.key);
      field.current?.focus();
    },
    [aim],
  );
  // What it answers stays in sight over the bar, opened in place in the card of what came while the viewer was away.
  useLayoutEffect(() => {
    if (aim) scroller.current?.querySelector('.relay-card.is-aimed, .relay-row.is-aimed')?.scrollIntoView({ block: 'nearest' });
  }, [aim]);
  const send = () => {
    const { body: text, lens: asked } = splitLensCommand(draft.trim(), lenses.map((l) => l.name));
    if (!text) return;
    if (aimed?.thread) {
      replyInThread(aimed.thread, name, text, asked ? messageLensOf(asked, aimed.thread.lens) : undefined);
      setDraft('');
      setAim(null);
      atFoot.current = true;
      return;
    }
    const own = asked ? messageLensOf(asked, undefined) : undefined;
    const sending = startThread({ boardId: board.id, name, names, text, door: 'threads', lens: null, own }, (made) => {
      markSeen(made);
      setLocals((was) => was.map((t) => (t.id === sending.local.id ? made : t)));
    });
    setLocals((was) => [...was, sending.local]);
    setDraft('');
    atFoot.current = true;
  };
  // One not sent goes back into the bar to be changed, its ^Lens with it.
  const editUnsent = useCallback(
    (body: string, lens?: { name: string }) => {
      const sending = new Set(outbox.get().map((o) => o.place));
      setLocals((was) => was.filter((t) => !isLocal(t) || sending.has(`thread:${t.id}`)));
      setDraft(lens ? `^${lens.name} ${body}` : body);
      field.current?.focus();
    },
    [setDraft],
  );
  // The skein at the top of the yarn: the threads list, dropping open under it, each row with its strand's square.
  const groups = useMemo(() => threadGroups(board, name, seen, Date.now()), [board, name, seen]);
  const [listOpen, setListOpen] = useState(false);
  const listButton = useRef<HTMLButtonElement>(null);
  // Made as a view switch takes away a floating bar that showed its threads button, whose ball folds into the bar below
  // as this one fades in at the top of the yarn and the whole yarn draws down from it: the same yarn arriving
  // (timeline.css), once. It draws down through the scroller's window as the scroller is placed (above).
  const [ballArrives, ballLanded] = useState(threadsButtonOnScreen);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!ballArrives || !el?.parentElement) return;
    el.parentElement.style.setProperty('--yarn-from', `${el.scrollTop}px`);
    el.parentElement.style.setProperty('--yarn-window', `${el.clientHeight}px`);
    const done = setTimeout(() => ballLanded(false), 1000);
    return () => clearTimeout(done);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const { remove, toast } = useUndoDelete(name, (e) => setError(e instanceof Error ? e.message : String(e)));

  const coordinator = coordinatorOf(agents);
  // Who the bar asks, by the one rule (core/whoAnswers.ts): the coordinator, else the one agent here; none, "agents".
  const asks = useMemo(() => whoAnswers({ agents: agentsOf(board, agents), coordinator }), [board, agents, coordinator]);
  // The rows, made again only when what they show changes: typing in the bar, an agent's step or the page's own
  // clock leaves every message as it was drawn. The day they are drawn on counts, for Today and Yesterday, and so do
  // the strands: a card under an ask says where its thread's work stands, live or not, as its strand does.
  const rows = useMemo(() => {
    // What was said, with the relays at when they came, those that came while the viewer was away as one card, and the
    // day and where they were last here between them (core/homeConversation.ts homeRows).
    return homeRows(shown, relays, name, { since, arrived }, Date.now()).map((row): ReactNode => {
      if (row.kind === 'day') return <Divider key={`day:${row.at}`} label={row.label} />;
      if (row.kind === 'since') return <Divider key="since" label="Since you were last here" fresh />;
      if (row.kind === 'relay') return <RelayCard key={`relay:${row.relay.key}`} relay={row.relay} name={name} clock={clock} aimed={aim === row.relay.key} onReply={reply} onLight={onLight} />;
      if (row.kind === 'stack') return <RelayStack key="relays:away" relays={row.relays} name={name} clock={clock} aimed={aim} onReply={reply} onLight={onLight} />;
      const s = row.said;
      const tag = s.first ? askedTag(s.thread, board) : undefined;
      return (
        <MessageRow
          key={s.drawn.key}
          board={board}
          thread={s.thread}
          drawn={s.drawn}
          after={s.after}
          name={name}
          foot={s.foot}
          arriving={false}
          onOpen={noop}
          onEdit={editUnsent}
          onThread={onOpen}
          when={clock}
          prev={row.prev}
          next={row.next}
          tag={
            <>
              {tag && <span className="dock-door timeline-tag">{tag}</span>}
              {/* Only a message with a thread of its own, work, opens it: a quick question lives here. */}
              {!isLocal(s.thread) && !inConversation(s.thread) && (
                <button type="button" className="timeline-open" onClick={() => onOpen(s.thread.id)} title={`Open “${shownTitle(s.thread)}” here, to read it on its own and reply in it`}>
                  Open thread <Icon name="arrow-right" />
                </button>
              )}
            </>
          }
        >
          {s.sentOn.map((to) => (
            <SentCard key={to.id} to={to} taken={s.taken} lit={lit === to.id} onOpen={onOpen} onLight={onLight} />
          ))}
        </MessageRow>
      );
    });
  }, [shown, relays, since, arrived, name, board, aim, lit, onLight, onOpen, reply, editUnsent, today, strands]);
  const now = Date.now();

  return (
    <div className={`timeline-conversation${ballArrives ? ' is-ball-arriving' : ''}`} style={{ '--yarn-gutter': `${gutter}px` } as CSSProperties}>
      <header className="timeline-head">
        <h2>Conversation</h2>
        <span className="timeline-with">{coordinator ? `with ${ownName(coordinator)}, the board's coordinator` : "with the board's agents"}</span>
      </header>
      <div className="timeline-scroll-wrap">
        <div
          className="timeline-scroll"
          ref={scroller}
          style={{ '--scrollbar': `${scrollbar}px` } as CSSProperties}
          onScroll={(e) => {
            const el = e.currentTarget;
            atFoot.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            scrolls.set(board.id, { top: el.scrollTop, foot: atFoot.current });
          }}
        >
          <div className="timeline-rows">
            <Yarn strands={visible} lanes={lanes} version={`${rowsKey}:${gutter}`} lit={lit ?? ring} ring={ring} onPick={onOpen} onLight={onLight} onSpans={setSpans} hours />
            {order.length > 0 && (
              <div
                ref={keys}
                className="yarn-keys yarn-part"
                tabIndex={0}
                role="listbox"
                aria-label="Threads in the yarn: ← → move between them, Enter opens one"
                aria-activedescendant={ring ? `strand-${ring}` : undefined}
                onFocus={() => ring ?? ringOn(order.findLast((id) => visible.find((s) => s.id === id)?.tone !== 'done') ?? order[0])}
                onBlur={() => setRing(null)}
                onKeyDown={onYarnKey}
              >
                {visible.map((s) => (
                  <span key={s.id} id={`strand-${s.id}`} role="option" aria-selected={s.id === ring}>
                    {s.title}, {s.status}
                    {whenOf(s, now)}
                  </span>
                ))}
              </div>
            )}
            {rows.length ? (
              <ol className="thread-messages timeline-messages">{rows}</ol>
            ) : (
              <p className="timeline-empty">Nothing asked yet. Ask below: the coordinator answers here, and sends work on to agents of its own, whose threads knit off this one.</p>
            )}
          </div>
        </div>
        {/* The skein: the ball of yarn the strands running on past the top unwind from, and the threads list. */}
        <Unwound spans={spans} scroller={scroller} width={gutter} lit={lit ?? ring} onPick={onOpen} onLight={onLight} />
        <div className="timeline-skein">
          <button
            type="button"
            ref={listButton}
            className="timeline-skein-button"
            aria-expanded={listOpen}
            aria-haspopup="dialog"
            aria-label={groups.waiting.length ? `Threads: ${groups.waiting.length} waiting on you` : 'Threads'}
            title={groups.waiting.length ? `Threads, ${groups.waiting.length} waiting on you` : 'Threads'}
            onClick={() => setListOpen((was) => !was)}
          >
            <YarnBall />
            {groups.waiting.length > 0 && (
              <span className="chat-count" aria-hidden>
                {groups.waiting.length}
              </span>
            )}
          </button>
          {listOpen && (
            <ThreadsList
              groups={groups}
              name={name}
              readOnly={readOnly}
              mark={(t) => (inConversation(t) ? null : <span className={`work-square is-${threadTone(t, agents)}`} aria-hidden />)}
              onOpen={(id) => {
                setListOpen(false);
                onOpen(id);
              }}
              onConversation={() => {
                setListOpen(false);
                atFoot.current = true;
                const el = scroller.current;
                el?.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
              }}
              onNew={() => {
                setListOpen(false);
                field.current?.focus();
              }}
              onDelete={(gone) => remove([gone.id])}
              onClose={(escape) => {
                setListOpen(false);
                if (escape) listButton.current?.focus();
              }}
              toggle={listButton}
            />
          )}
        </div>
        {ring && (
          <p className="yarn-hint" aria-hidden>
            <kbd>←</kbd>
            <kbd>→</kbd> strands <kbd>Enter</kbd> open its thread <kbd>Esc</kbd> back to the conversation
          </p>
        )}
      </div>
      {!readOnly && (
        <div
          className={`timeline-foot${aimed ? ' is-aimed' : ''}`}
          style={aimed ? toneOf(aimed.tone) : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && aimed && !e.defaultPrevented) setAim(null);
          }}
        >
          {/* The bar asks the coordinator, or, after Reply on a relay, answers in its thread for one message. */}
          <ChatBar
            docked={false}
            value={draft}
            onValue={setDraft}
            onSend={send}
            placeholder={aimed ? `Answer ${ownName(aimed.by ?? 'the agent')} in this thread…` : asks ? `Ask ${ownName(asks)}, or give it work…` : 'What do you want to work through?'}
            label={aimed ? `Answer in ${aimed.title}` : "Ask in the board's conversation"}
            sendLabel="Send"
            field={field}
            lenses={lenses}
            context={
              aimed && {
                label: aimed.title,
                title: `Your answer goes to “${aimed.title}”, for this one message`,
                icon: 'reply',
                remove: { label: 'Let go of the thread', title: 'Ask the coordinator instead (Esc)' },
                onRemove: () => setAim(null),
              }
            }
            error={error}
          />
        </div>
      )}
      {toast && <div className="threads-toast">{toast}</div>}
    </div>
  );
});

const noop = () => {};

function Divider({ label, fresh = false }: { label: string; fresh?: boolean }) {
  return (
    <li className={`timeline-divider${fresh ? ' is-fresh' : ''}`} role="separator" aria-label={label}>
      <span>{label}</span>
    </li>
  );
}

// Where an ask was sent on, or the ask's own thread an agent took on: the thread, its agent and where its work stands.
// It opens the thread here.
// The ask's own thread is named by the ask above it, so its card says who took it on; a thread it was sent on to, by
// its title and its agent. The title gives way to an ellipsis before the agent does.
function SentCard({ to, taken, lit, onOpen, onLight }: { to: Thread; taken?: boolean; lit: boolean; onOpen: (id: string) => void; onLight: (id: string | null) => void }) {
  const agents = useAgents();
  const work = useWork();
  const steps = useSteps();
  const tone = threadTone(to, agents);
  const progress = tone === 'working' ? planProgress(work.find((w) => w.thread === to.id && w.plan)?.plan) : undefined;
  const live = tone === 'working' && steps.some((s) => s.thread === to.id && !s.done && phaseOf(s, Date.now()) === 'live');
  const agent = to.owner ? ownName(to.owner) : undefined;
  return (
    <button
      type="button"
      className={`timeline-sent${lit ? ' is-lit' : ''}`}
      data-yarn-branch={to.id}
      onClick={() => onOpen(to.id)}
      onPointerEnter={() => onLight(to.id)}
      onPointerLeave={() => onLight(null)}
      onFocus={() => onLight(to.id)}
      onBlur={() => onLight(null)}
      title={`Open “${shownTitle(to)}”`}
    >
      <Icon name="thread" />
      <span className="timeline-sent-what">
        {taken && agent ? (
          <span className="timeline-sent-title">Taken on by {agent}</span>
        ) : (
          <>
            <span className="timeline-sent-title">{shownTitle(to)}</span>
            {agent && <span className="timeline-sent-by">sent on to {agent}</span>}
          </>
        )}
      </span>
      <span className={`timeline-sent-state${tone === 'waiting' ? ' is-waiting' : ''}`}>
        {live ? <span className="work-dot is-live" aria-hidden /> : <span className={`work-square is-${tone}`} aria-hidden />}
        {sentStateWords(tone)}
        {progress && ` · ${progress.done}/${progress.total}`}
      </span>
      <Icon name="arrow-right" />
    </button>
  );
}

// ---- a thread, open in the main pane --------------------------------------------

function ThreadPane({ board, name, thread, strand, onSeeItem }: { board: Board; name: string; thread: Thread; strand?: Strand; onSeeItem: (id: string) => void }) {
  const readOnly = useReadOnly();
  const agents = useAgents();
  const listening = agents.filter((a) => a.state !== 'away').map((a) => a.name);
  const agent = replyingTo(thread, listening);
  const { markSeen } = useThreadsSeen(board);
  const lastId = thread.messages.at(-1)?.id;
  useEffect(() => {
    markSeen(thread);
    onSeeItem(thread.id);
  }, [thread.id, lastId, markSeen, onSeeItem]); // once per message seen
  const field = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useDraft(board.id, thread.id);
  const lenses = useMemo(() => lensChoices(thread.lens), [thread.lens]);
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    const { body: text, lens: asked } = splitLensCommand(draft.trim(), lenses.map((l) => l.name));
    if (!text) return;
    setError(null);
    replyInThread(thread, name, text, asked ? messageLensOf(asked, thread.lens) : undefined);
    setDraft('');
  };
  const setLens = (lens: ThreadLens | null) => {
    setError(null);
    api.setThreadLens(thread.id, name, lens).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  // Back to the conversation; Escape too, unless something over the pane takes it first.
  const back = useCallback(() => go.timeline(board.id), [board.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"], .popover[open], .threads-pop')) return;
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]') && (e.target as HTMLInputElement).value) return;
      back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);
  const count = thread.messages.length + (thread.pending?.length ?? 0);
  const tone = strand?.tone; // its strand's, for the square of the line over the bar
  // What the thread's messages are drawn with stays the same as the bar is typed in, so they are not drawn again
  // (Conversation): only the bar is.
  const edit = useCallback(
    (body: string, lens?: { name: string }) => {
      setDraft(lens ? `^${lens.name} ${body}` : body);
      field.current?.focus();
    },
    [setDraft],
  );
  const openThread = useCallback((id: string) => go.timeline(board.id, id), [board.id]);
  const yarn = useMemo(() => <Yarn strands={[]} lanes={EMPTY} version={`${thread.id}:${count}`} focus={strand ?? 'trunk'} onBack={back} />, [thread.id, count, strand, back]);

  return (
    <div className="timeline-thread" style={{ '--yarn-gutter': `${gutterOf(1)}px` } as CSSProperties}>
      <header className="timeline-thread-head">
        <button type="button" className="timeline-back" onClick={back} title="Back to the conversation (Esc)">
          <Icon name="arrow-left" /> Conversation
        </button>
        <ThreadTitle board={board} thread={thread} readOnly={readOnly} onPick={setLens} />
      </header>
      <Conversation board={board} thread={thread} name={name} onOpen={noop} onEdit={edit} onThread={openThread}>
        {yarn}
      </Conversation>
      {!readOnly && (
        <div className="timeline-foot">
          {/* The one bar, aimed at the thread open, which the line over it names: Conversation, its strand or Esc goes back. */}
          <p className="timeline-replying">
            {tone && <span className={`work-square is-${tone}`} aria-hidden />}
            Replying in <b>{shownTitle(thread)}</b>
          </p>
          <ChatBar
            docked={false}
            value={draft}
            onValue={setDraft}
            onSend={send}
            placeholder={agent ? `Reply to ${ownName(agent)} in this thread…` : 'Reply in this thread…'}
            label={`Reply in ${thread.title}`}
            sendLabel="Send"
            field={field}
            lenses={lenses}
            error={error}
          />
        </div>
      )}
    </div>
  );
}

const EMPTY = new Map<string, number>();
