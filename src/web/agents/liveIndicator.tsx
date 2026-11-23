import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { presenceRank } from '../../core/delivery';
import { samePerson } from '../../core/format';
import { ownName } from '../../core/homeConversation';
import { liveAgents, liveState, liveWords, PRESENCE_WORDS, type LiveAgents, type LiveThread } from '../../core/liveAgents';
import { shownTitle } from '../../core/threads';
import type { Board } from '../../core/types';
import type { AgentPresence, AgentStep } from '../shared/api';
import { ActorBadge, timeAgo } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { linkTo } from '../shared/pages';
import { AgentWorkNow } from './peek';
import { phaseOf, stepWords, usePhaseClock, useSteps } from './steps';

// What each agent state means for the person waiting on it, most reachable first.
const AGENT_STATES: Record<AgentPresence['state'], { label: string; meaning: (lastSeen: string) => string }> = {
  listening: { label: PRESENCE_WORDS.listening, meaning: () => 'Waiting on the board, so it sees what you do right away.' },
  asleep: {
    label: PRESENCE_WORDS.asleep,
    meaning: () => 'Its turn is over, so it spends nothing while it waits. Tricot wakes it in its terminal as soon as something on the board needs it.',
  },
  working: {
    label: PRESENCE_WORDS.working,
    meaning: (seen) => `Busy with a step; it sees what you do when it next checks the board (last checked ${timeAgo(seen)}).`,
  },
  away: {
    label: PRESENCE_WORDS.away,
    meaning: (seen) => `Last checked the board ${timeAgo(seen)}; nudge it in its session if you're waiting on it.`,
  },
};

// An agent asleep whose wake, typed into its terminal, started no turn.
const STUCK_MEANING = "Tricot typed a wake into its terminal, but its turn didn't start: look at its terminal. Tricot tries again when something new needs it.";

// How long the pointer can be off the live label and its card before the card
// opens or closes, so passing over the label doesn't flash it.
const LIVE_CARD_DELAY_MS = 150;

type BoardThreads = Pick<Board, 'id' | 'threads'>;
type Live = LiveAgents<AgentPresence>;
type LiveRow = LiveThread<AgentPresence>;

// Whether the board is live, and who is on it, in a few words: the coordinator
// by name and state, and how many threads are at work ("Claude · listening · 2
// at work"), or how many agents when none leads (core/liveAgents.ts). The dot
// follows the coordinator, else the most reachable agent. Hovering or focusing
// the label opens a card: the coordinator, the threads at work, those waiting
// on you, those done whose agent is still here, and the other agents, each with
// its state. An agent that owns a thread is that thread's row, not an agent's.
// The card stays open while the pointer or focus is on it, so its links can be
// used; a click outside it or Escape closes it. What an agent is working on, if
// the page says (`work`: the tasks it has in progress, a part's,
// shared/boardViews.ts), is a line under its state; and under that, right away,
// what the board has heard of its work (the peek's body, peek.tsx): its plan and
// how far along it is, what it and its helpers are doing now, the files it
// changed. That is where work an agent does from its own terminal shows, with
// no message on the board to open the peek from. With no coordinator and no
// thread, it is the plain list of the agents.
export function LiveIndicator({ live, agents = [], board, work }: { live: boolean; agents?: AgentPresence[]; board: BoardThreads; work?: (agent: AgentPresence) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = useCallback((escape: boolean) => {
    // Focus goes back to the label before the card closes, so it isn't lost with the card's links.
    if (escape && root.current?.contains(document.activeElement)) label.current?.focus();
    setOpen(false);
  }, []);
  useDismiss(open, close, root);
  if (!live) {
    return (
      <div className="live" title="Reconnecting…">
        <span className="live-label">
          <span className="live-dot" /> Offline
        </span>
      </div>
    );
  }
  const later = (next: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), LIVE_CARD_DELAY_MS);
  };
  const focusedWithin = () => root.current?.contains(document.activeElement) ?? false;
  const group = liveAgents(agents, board);
  const words = liveWords(group);
  return (
    <div
      className="live"
      ref={root}
      onMouseEnter={() => {
        hovered.current = true;
        later(true);
      }}
      onMouseLeave={() => {
        hovered.current = false;
        if (focusedWithin()) clearTimeout(timer.current);
        else later(false);
      }}
      onFocus={() => {
        clearTimeout(timer.current);
        setOpen(true);
      }}
      onBlur={(e) => {
        if (!hovered.current && !root.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button ref={label} type="button" className={`live-label live-on live-${liveState(group)}`} title={words} aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="live-dot" />
        <span className="live-words">{words}</span>
      </button>
      {open && (
        <div className="live-card" role="group" aria-label="Agents on this board">
          <div className="live-scroll">
            {agents.length === 0 && group.atWork.length === 0 ? (
              <p className="live-card-empty">No agent has used this board in the last 5 minutes.</p>
            ) : (
              <LiveGroups group={group} board={board} work={work} onOpen={() => close(false)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The card's body: each group under a small heading with its count. Agents and
// nothing else (no thread, no coordinator to tell from the rest) are one list
// with no heading, as the card always was.
function LiveGroups({ group, board, work, onOpen }: { group: Live; board: BoardThreads; work?: (agent: AgentPresence) => ReactNode; onOpen: () => void }) {
  const titleOf = (id: string) => board.threads?.find((t) => t.id === id)?.title;
  const agentRows = (agents: AgentPresence[]) => agents.map((a) => <AgentRow key={a.name} agent={a} work={work} titleOf={titleOf} />);
  const threadRows = (rows: LiveRow[], tone: (t: LiveRow) => string, line: (t: LiveRow) => ReactNode) =>
    rows.map((t) => (
      <li key={t.thread.id}>
        <a className="live-thread" href={linkTo.thread(board.id, t.thread.id)} onClick={onOpen}>
          <span className={`live-square is-${tone(t)}`} aria-hidden />
          {line(t)}
        </a>
      </li>
    ));
  const others = [...group.others].sort((a, b) => presenceRank(a.state) - presenceRank(b.state));
  const threads = group.atWork.length + group.needsYou.length + group.done.length > 0;
  const headed = threads || Boolean(group.lead && others.length);
  return (
    <>
      {group.lead && (
        <LiveSection title={group.lead.coordinator && headed ? 'Coordinator' : undefined} tone="lead" label="Coordinator">
          {agentRows([group.lead])}
        </LiveSection>
      )}
      {group.atWork.length > 0 && (
        <LiveSection title="At work" count={group.atWork.length} tone="at-work">
          {threadRows(group.atWork, () => 'working', (t) => <ThreadLine row={t} />)}
        </LiveSection>
      )}
      {group.needsYou.length > 0 && (
        <LiveSection title="Needs you" count={group.needsYou.length} tone="needs-you">
          {threadRows(group.needsYou, (t) => (t.thread.status === 'in-review' ? 'review' : 'waiting'), (t) => <ThreadLine row={t} />)}
        </LiveSection>
      )}
      {group.done.length > 0 && (
        <LiveSection title="Done" count={group.done.length} tone="done" foot="Their agents sleep until they close, within the hour.">
          {threadRows(
            group.done,
            () => 'done',
            (t) => (
              <span className="live-thread-body">
                <span className="live-thread-title" title={shownTitle(t.thread)}>
                  {shownTitle(t.thread)}
                </span>
              </span>
            ),
          )}
        </LiveSection>
      )}
      {others.length > 0 && (
        <LiveSection title={headed ? 'Also on the board' : undefined} count={headed ? others.length : undefined} tone="others" label="Agents">
          {agentRows(others)}
        </LiveSection>
      )}
    </>
  );
}

// One group of the card: a labelled list, under its heading when it has one.
function LiveSection({ title, count, tone, label, foot, children }: { title?: string; count?: number; tone: string; label?: string; foot?: string; children: ReactNode }) {
  const heading = useId();
  const threads = tone !== 'lead' && tone !== 'others';
  return (
    <section className={`live-group is-${tone}`} aria-labelledby={title ? heading : undefined}>
      {title && (
        <h3 className="live-group-head" id={heading}>
          {title}
          {count !== undefined && <span className="live-count">{count}</span>}
        </h3>
      )}
      <ul className={threads ? 'live-threads' : 'live-agents'} aria-label={title ? undefined : label}>
        {children}
      </ul>
      {foot && <p className="live-foot">{foot}</p>}
    </section>
  );
}

// An agent's row: its mark and state, what that means for you, what it is
// working on if the page says, and what the board has heard of its work.
function AgentRow({ agent: a, work, titleOf }: { agent: AgentPresence; work?: (agent: AgentPresence) => ReactNode; titleOf: (thread: string) => string | undefined }) {
  return (
    <li className="live-agent">
      <div className="live-agent-head">
        <ActorBadge actor={{ kind: 'agent', name: a.name }} />
        <span className={`live-state live-${a.state}`}>
          <span className="live-dot" />
          {AGENT_STATES[a.state].label}
        </span>
      </div>
      <p className="live-agent-meaning">{a.stuck ? STUCK_MEANING : AGENT_STATES[a.state].meaning(a.lastSeen)}</p>
      {work?.(a)}
      <AgentWorkNow agent={a.name} titleOf={titleOf} />
    </li>
  );
}

// What its owner is doing in a thread now: its latest step there, while it shows live.
function useThreadStep(owner: string | undefined, thread: string): AgentStep | undefined {
  const steps = useSteps();
  const latest = steps
    .filter((s) => owner && samePerson(s.agent, owner) && s.thread === thread && !s.done)
    .reduce<AgentStep | undefined>((a, b) => (!a || Date.parse(b.at) > Date.parse(a.at) ? b : a), undefined);
  const now = usePhaseClock(latest);
  return latest && phaseOf(latest, now) === 'live' ? latest : undefined;
}

// A thread of work: its title, and under it where it stands. At work: its
// owner, in its state, and what it is doing now; one whose owner has not come
// yet is starting. Waiting on you or for your review says so first, then its
// owner, which Tricot wakes when you answer.
function ThreadLine({ row }: { row: LiveRow }) {
  const { thread, owner } = row;
  const step = useThreadStep(owner?.name, thread.id);
  const waiting = thread.status === 'needs-you' || thread.status === 'in-review';
  const state = owner && (owner.stuck ? "didn't wake" : AGENT_STATES[owner.state].label);
  const tone = owner?.stuck ? 'stuck' : (owner?.state ?? 'starting');
  return (
    <span className="live-thread-body">
      <span className="live-thread-title" title={shownTitle(thread)}>
        {shownTitle(thread)}
      </span>
      <span className="live-thread-meta">
        {thread.status === 'needs-you' && <span className="live-status is-needs-you">Needs you</span>}
        {thread.status === 'in-review' && <span className="live-status is-in-review">In review</span>}
        {waiting && ' · '}
        {thread.owner && `${ownName(thread.owner)} `}
        <span className={`live-word live-${tone}`}>{state ?? 'starting'}</span>
        {waiting && owner?.state === 'asleep' && !owner.stuck && ' · wakes when you answer'}
        {step && ` · ${stepWords(step)}`}
      </span>
    </span>
  );
}
