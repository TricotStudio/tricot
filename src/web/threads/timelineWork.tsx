import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { planProgress } from '../../core/agentWork';
import { clip, samePerson } from '../../core/format';
import { shownTitle } from '../../core/threads';
import type { Board, BoardEvent, Thread } from '../../core/types';
import { AgentWorkOn, phaseOf, StepText, stepWords, useAgents, useSteps, useWork } from '../agents';
import type { WorkGroup, WorkRow, WorkSquare } from '../shared/boardViews';
import { useBoardViews } from '../shared/boardViewsContext';
import { ActorBadge, Icon } from '../shared/components';
import { followPress, useDismiss } from '../shared/hooks';
import { go } from '../shared/pages';
import type { StrandTone } from './yarn';

// Work, beside the conversation on a board's Home (timeline.tsx): the work on
// the board by where it stands. The core's is the threads agents own
// (core/roles.ts), as their status says: waiting on a person, at work, sent on
// but not started yet (its owner is not on the board), and done. A part adds
// its cards and the groups they stand in (shared/boardViews.ts WorkSlot), as
// Studio does its tasks; with none, Work is the threads alone. A row opens its
// thread in the main pane, or its card; pointing at one lights its thread's
// strand. The thread open has its row lit, with its agent's plan under it.
// It folds to a slim rail (its button at the top right, where the panel's own
// is), which keeps what waits on the viewer in sight as a count. Whether it is
// folded is the viewer's, kept in this browser, from its button. Over the
// content, it also goes as the other panels of the board do (shared/hooks.ts
// useDismiss, followPress, dismissClick.ts): a plain click on what does
// nothing else outside it, or Esc inside it, folds it for now, leaving the
// choice kept as it was.

const CORE_GROUPS: WorkGroup[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'to-do', label: 'To do', hint: 'not started yet' },
  { id: 'done', label: 'Done', quiet: true },
];
const QUIET_SHOWN = 3;

const SQUARE_WORDS: Record<WorkSquare, string> = { waiting: 'Waiting on a person', working: 'At work', todo: 'Not started', done: 'Done', later: 'For later' };

// The groups, the core's with a part's placed among them.
function groupsWith(added: readonly WorkGroup[]): WorkGroup[] {
  const groups = [...CORE_GROUPS];
  for (const group of added) {
    const at = group.before ? groups.findIndex((g) => g.id === group.before) : -1;
    if (at >= 0) groups.splice(at, 0, group);
    else groups.push(group);
  }
  return groups;
}

// Whether a thread an agent owns is at work: its owner is on the board. Sent
// on but not started, it waits for its owner to come (Tricot's terminal starts
// it, core/roles.ts launchesOn).
export function threadStarted(thread: Thread, onBoard: readonly { name: string; state: string }[]): boolean {
  return onBoard.some((a) => a.state !== 'away' && samePerson(a.name, thread.owner ?? ''));
}

// Where a thread an agent owns stands, as its strand and its square say it.
export function threadTone(thread: Thread, onBoard: readonly { name: string; state: string }[]): StrandTone {
  if (thread.status === 'needs-you') return 'waiting';
  if (thread.status === 'done') return 'done';
  return threadStarted(thread, onBoard) ? 'working' : 'todo';
}

// What changes Home, for its tab's dot: a thread started, answered, sent on or moved on.
const THREAD_CHANGES = new Set<BoardEvent['type']>(['thread_started', 'thread_replied', 'thread_routed', 'thread_status_changed']);
export const threadsChanged = (events: readonly BoardEvent[]): boolean => events.some((e) => THREAD_CHANGES.has(e.type));

// The threads agents own (core/roles.ts), the work a coordinator handed out.
export const ownedThreads = (board: Board): Thread[] => (board.threads ?? []).filter((t) => t.owner && t.status);

// When something last moved, briefly: the time today, the day this week, else the date.
export function brief(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const days = (now - at.getTime()) / 86_400_000;
  if (new Date(now).toDateString() === at.toDateString()) return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days < 6) return at.toLocaleDateString([], { weekday: 'short' });
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// How long it has been at it, coarsely: "now", "14 min", "3 h", "2 d".
function since(iso: string, now: number): string {
  const minutes = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${Math.floor(minutes)} min`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 60 / 24)} d`;
}

// The latest an agent said in a thread, on a line.
const lastWord = (thread: Thread): string | undefined => {
  const said = thread.messages.findLast((m) => m.author.kind === 'agent');
  return said && clip(said.body.split('\n').find((line) => line.trim()) ?? '', 140);
};

interface ThreadRowsInput {
  board: Board;
  now: number;
}

// The threads' rows, from the board, who is on it and their steps and plans.
function useThreadRows({ board, now }: ThreadRowsInput): WorkRow[] {
  const agents = useAgents();
  const steps = useSteps();
  const work = useWork();
  return ownedThreads(board).map((thread) => {
    const owner = thread.owner!;
    const tone = threadTone(thread, agents);
    const open = () => go.timeline(board.id, thread.id);
    const base = { key: `thread:${thread.id}`, title: shownTitle(thread), agent: owner, at: thread.updatedAt, thread: thread.id, open };
    if (tone === 'waiting') return { ...base, group: 'needs-you', square: 'waiting', line: lastWord(thread) };
    if (tone === 'done') return { ...base, group: 'done', square: 'done' };
    if (tone === 'todo') return { ...base, group: 'to-do', square: 'todo', at: thread.startedAt, end: since(thread.startedAt, now), line: thread.launch ? 'Starting in your terminal' : `Waiting for ${owner} to start` };
    const live = steps.filter((s) => s.thread === thread.id && !s.done && phaseOf(s, now) === 'live').at(-1);
    const plan = work.find((w) => w.thread === thread.id && w.plan)?.plan;
    const progress = planProgress(plan);
    const line = live ? <StepText text={stepWords(live)} className="work-row-step" /> : (progress?.now?.text ?? lastWord(thread));
    return { ...base, group: 'in-progress', square: 'working', end: since(thread.startedAt, now), line, live: Boolean(live), progress: progress && { done: progress.done, total: progress.total } };
  });
}

interface Props {
  board: Board;
  name: string;
  current?: string; // the thread open in the main pane
  lit: string | null;
  onLight: (thread: string | null) => void;
  shown: boolean; // unfolded: the panel; folded, the rail
  onShow: (shown: boolean) => void; // from its buttons: the viewer's choice, kept
  onDismiss: () => void; // a click away or Esc: folded for now
}

const WORK_ID = 'board-home-work';

export function WorkPanel({ board, name, current, lit, onLight, shown, onShow, onDismiss }: Props) {
  const slot = useBoardViews().work();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set()); // quiet groups shown whole
  const rows: WorkRow[] = [...useThreadRows({ board, now }), ...(slot?.rows({ board, name }) ?? [])];
  const groups = groupsWith(slot?.groups ?? []);
  const open = rows.filter((r) => r.group !== 'done').length;
  const waiting = rows.filter((r) => r.square === 'waiting').length; // on a person: needs you, in review
  // Folding or unfolding from its button, the focus goes to the button in its place.
  const toggle = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (moved.current) toggle.current?.focus();
    moved.current = false;
  }, [shown]);
  const show = (next: boolean) => {
    moved.current = true;
    onLight(null); // a row pointed at goes with the panel
    onShow(next);
  };
  // A click away: a press outside it that does nothing else, once it is over, as for the docked conversation
  // and the changes feed. The focus stays where the click put it. Below 900px Work is in the page's flow, not over it.
  const panel = useRef<HTMLElement>(null);
  const press = useRef<(() => void) | null>(null); // a click away under way: calls it off
  const away = useCallback(
    (escape: boolean, event: MouseEvent | KeyboardEvent) => {
      if (escape || window.matchMedia('(max-width: 900px)').matches) return; // Esc is its own, from inside it (below)
      const follow = followPress(event as MouseEvent, (dismissed) => {
        press.current = null;
        if (!dismissed) return;
        onLight(null);
        onDismiss();
      });
      if (!follow) return;
      press.current?.();
      press.current = follow;
    },
    [onDismiss, onLight],
  );
  useDismiss(shown, away, panel, undefined, true);
  const counts = [waiting ? `${waiting} waiting on you` : '', open ? `${open} open` : 'nothing open'].filter(Boolean).join(', ');

  if (!shown) {
    return (
      <aside className="work is-folded" id={WORK_ID} aria-label="Work">
        <button
          type="button"
          ref={toggle}
          className="work-rail"
          aria-expanded={false}
          aria-controls={WORK_ID}
          aria-label={`Show Work: ${counts}`}
          title={`Show Work: ${counts}`}
          onClick={() => show(true)}
        >
          <Icon name="panel-right" />
          {waiting > 0 && (
            <span className="work-rail-count" aria-hidden>
              {waiting}
            </span>
          )}
          <span className="work-rail-label" aria-hidden>
            Work
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={panel}
      className="work"
      id={WORK_ID}
      aria-label="Work"
      onKeyDown={(e) => {
        // Esc, from anywhere in it, folds it for now, and the focus goes to the rail.
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        moved.current = true;
        onLight(null);
        onDismiss();
      }}
    >
      <header className="work-head">
        <h2>Work</h2>
        <span className="work-open">{open ? `${open} open` : 'Nothing open'}</span>
        <button type="button" ref={toggle} className="icon-button work-toggle" aria-expanded aria-controls={WORK_ID} onClick={() => show(false)} title="Hide Work" aria-label="Hide Work">
          <Icon name="panel-right" />
        </button>
      </header>
      <div className="work-body">
        {rows.length === 0 && (
          <p className="work-empty">
            Nothing handed out yet. When the coordinator sends an ask on to an agent, its work shows here with where it stands, and its strand knits off the
            conversation.
          </p>
        )}
        {groups.map((group) => {
          const mine = rows.filter((r) => r.group === group.id).sort((a, b) => b.at.localeCompare(a.at));
          if (!mine.length) return null;
          const whole = !group.quiet || opened.has(group.id);
          const shown = whole ? mine : mine.slice(0, QUIET_SHOWN);
          return (
            <section key={group.id} className={`work-group is-${group.id}`} aria-label={group.label}>
              <h3 className="work-group-head">
                {group.label} <span className="work-count">{mine.length}</span>
                {group.hint && <span className="work-hint">{group.hint}</span>}
              </h3>
              <ul className="work-rows">
                {shown.map((row) => {
                  const here = Boolean(current && row.thread === current && row.key === `thread:${current}`);
                  return (
                    <li key={row.key} className={`work-row${group.quiet ? ' is-quiet' : ''}${here ? ' is-current' : ''}${lit && row.thread === lit ? ' is-lit' : ''}`}>
                      <button
                        type="button"
                        className="work-row-open"
                        onClick={row.open}
                        onPointerEnter={() => onLight(row.thread ?? null)}
                        onPointerLeave={() => onLight(null)}
                        onFocus={() => onLight(row.thread ?? null)}
                        onBlur={() => onLight(null)}
                        aria-current={here ? 'true' : undefined}
                      >
                        <span className={`work-square is-${row.square}`} role="img" aria-label={SQUARE_WORDS[row.square]} />
                        <span className="work-row-title">
                          {row.label && <span className="work-row-label">{row.label}</span>}
                          {row.title}
                        </span>
                        <span className="work-row-end">{row.end ?? brief(row.at, now)}</span>
                        {row.line && !group.quiet && (
                          <span className="work-row-line">
                            {row.agent && <ActorBadge actor={{ kind: 'agent', name: row.agent }} showName={false} />}
                            {row.live && <span className="work-dot is-live" aria-hidden />}
                            <span className="work-row-text">{row.line}</span>
                          </span>
                        )}
                        {row.progress && !group.quiet && (
                          <span className="work-row-progress" aria-label={`${row.progress.done} of ${row.progress.total} done`}>
                            <span className="work-meter" aria-hidden>
                              <i style={{ width: `${(row.progress.done / row.progress.total) * 100}%` }} />
                            </span>
                            {row.progress.done}/{row.progress.total}
                          </span>
                        )}
                      </button>
                      {here && row.agent && row.thread && <AgentWorkOn agent={row.agent} thread={row.thread} />}
                    </li>
                  );
                })}
              </ul>
              {group.quiet && mine.length > QUIET_SHOWN && (
                <button
                  type="button"
                  className="work-more"
                  onClick={() => setOpened((was) => (whole ? new Set([...was].filter((id) => id !== group.id)) : new Set(was).add(group.id)))}
                >
                  {whole ? 'Fewer' : `${mine.length - QUIET_SHOWN} more`}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
