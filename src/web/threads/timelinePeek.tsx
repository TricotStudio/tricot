import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { planProgress } from '../../core/agentWork';
import { shownTitle } from '../../core/threads';
import type { Board, MessageLens, Thread } from '../../core/types';
import { phaseOf, StepText, stepWords, useAgents, useSteps, useWork } from '../agents';
import { onItsWay, outbox, settledKeys, useMentionable, useOutgoing, withOutgoing } from '../conversation';
import { ActorBadge, Icon } from '../shared/components';
import { draftMessage } from './send';
import { footsOf, MessageRow } from './threads';
import { threadTone } from './timelineWork';

// A strand picked up on a board's Home (timeline.tsx): a peek beside the yarn at
// its thread, which only reads. Who owns it and where its work stands, what its
// agent is doing now and how far along its plan is, and its latest messages,
// with what is on its way (a message sent from the bar, which is aimed at the
// thread while it is picked up, shows here with the line that says what became
// of it). Open takes the thread into the main pane; ✕ or Esc puts it down.

const SHOWN = 3; // the latest messages
const WORDS = { working: 'at work', waiting: 'needs you', todo: 'not started yet', done: 'done' } as const;

const ownName = (agent: string): string => agent.split(' · ')[0];

// How long it has been at it, coarsely: "for 14 min", "for 2 h".
function since(iso: string, now: number): string {
  const minutes = Math.max(0, (now - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `for ${Math.max(1, Math.floor(minutes))} min`;
  if (minutes < 60 * 24) return `for ${Math.floor(minutes / 60)} h`;
  return `for ${Math.floor(minutes / 60 / 24)} d`;
}

interface Props {
  board: Board;
  name: string;
  thread: Thread;
  place: { top: number }; // its left is the column's (timeline.css)
  onOpen: () => void;
  onClose: () => void;
  onEdit: (body: string, lens?: MessageLens) => void; // a message not sent goes back into the bar
}

export function StrandPeek({ board, name, thread, place, onOpen, onClose, onEdit }: Props) {
  const agents = useAgents();
  const steps = useSteps();
  const work = useWork();
  const names = useMentionable(name);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const tone = threadTone(thread, agents);
  const drawn = withOutgoing(thread.messages, useOutgoing(`thread:${thread.id}`), name, (o) => draftMessage(o, name, names));
  const settled = settledKeys(drawn).join();
  useEffect(() => {
    for (const key of settled ? settled.split(',') : []) outbox.remove(key);
  }, [settled]);
  const { lineAt, agentLine } = footsOf(board, thread, drawn, name);
  const from = Math.max(0, drawn.length - SHOWN);
  const live = steps.filter((s) => s.thread === thread.id && !s.done && phaseOf(s, now) === 'live').at(-1);
  const progress = planProgress(work.find((w) => w.thread === thread.id && w.plan)?.plan);
  const title = shownTitle(thread);
  // Kept at its latest, as what is sent from the bar arrives.
  const list = useRef<HTMLDivElement>(null);
  const count = drawn.length;
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.id, count]);

  return (
    <section className="strand-peek" style={{ top: place.top } as CSSProperties} aria-label={`Picked up: ${title}`}>
      <header className="strand-peek-head">
        <span className={`work-square is-${tone}`} aria-hidden />
        <div className="strand-peek-title">
          <h3>{title}</h3>
          {thread.owner && (
            <p className="strand-peek-who">
              <ActorBadge actor={{ kind: 'agent', name: thread.owner }} showName={false} />
              {ownName(thread.owner)} · {WORDS[tone]}
              {tone === 'working' && ` ${since(thread.startedAt, now)}`}
            </p>
          )}
        </div>
        <button type="button" className="btn btn-small strand-peek-open" onClick={onOpen} title="Open the thread in the main pane (⌘ Enter)">
          <Icon name="expand" /> Open
        </button>
        <button type="button" className="icon-button strand-peek-close" onClick={onClose} aria-label="Put the thread down" title="Put it down (Esc)">
          <Icon name="x" />
        </button>
      </header>
      {(live || progress) && (
        <div className="strand-peek-now">
          {live && <span className="work-dot is-live" aria-hidden />}
          {live ? <StepText text={stepWords(live)} className="strand-peek-step" /> : <span className="strand-peek-step">{progress?.now?.text ?? 'Its plan'}</span>}
          {progress && (
            <span className="work-row-progress strand-peek-progress" aria-label={`${progress.done} of ${progress.total} done`}>
              <span className="work-meter" aria-hidden>
                <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </span>
              {progress.done}/{progress.total}
            </span>
          )}
        </div>
      )}
      <div className="strand-peek-body" ref={list}>
        {from > 0 && (
          <p className="strand-peek-earlier">
            {from} earlier message{from === 1 ? '' : 's'}
          </p>
        )}
        <ol className="thread-messages strand-peek-messages">
          {drawn.slice(from).map((d, at) => {
            const i = from + at;
            return (
              <MessageRow
                key={d.key}
                board={board}
                thread={thread}
                drawn={d}
                after={drawn.slice(i + 1).map((x) => x.item)}
                name={name}
                foot={Boolean(onItsWay(d)) || i === lineAt || d.item.id === agentLine}
                arriving={false}
                prev={drawn[i - 1]?.item}
                onOpen={onClose}
                onEdit={onEdit}
              />
            );
          })}
        </ol>
      </div>
      <footer className="strand-peek-foot">
        <Icon name="arrow-down" />
        <span>The bar below talks to this thread now.</span>
        <kbd>Esc</kbd> puts it down
      </footer>
    </section>
  );
}
