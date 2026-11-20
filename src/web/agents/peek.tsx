import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { planProgress, type AgentWork } from '../../core/agentWork';
import { samePerson, shortDuration } from '../../core/format';
import { phaseOf } from '../../core/stepPhase';
import type { AgentStep } from '../shared/api';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { StepText, stepWords, useSteps, useWork } from './steps';
import './peek.css';

// The peek (core/agentWork.ts): what an agent is working on, past the one line that says "working". Its plan as it
// last wrote its to-do list, with how far along it is; what it and its helpers are doing now, a line each, or its
// last steps when none is live; and the files it changed this turn. It opens over what was clicked (the pill of a
// thread an agent owns, the line under a message to an agent), closes on a click away or Escape, and changes nothing.
// With none of that heard yet it says so, and why: an agent's steps come from Tricot's hooks in its harness.

const SHOWN_PLAN = 8;
const SHOWN_FILES = 3;
const WIDTH = 380;
const GAP = 8; // between it and what opened it

// A helper's kind as its harness names it ("general-purpose", "Explore"), in words: "General purpose".
// Its own lines' chip: its agent's name, without the work an orchestrator is named after ("Claude · Sign-in flow").
const ownName = (agent: string): string => agent.split(' · ')[0];

const roleWords = (role: string): string => {
  const words = role.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// This agent's work on the board: the session on `thread` if it has one there, else its latest.
export function useAgentWork(agent: string, thread?: string): AgentWork | undefined {
  const mine = useWork().filter((work) => samePerson(work.agent, agent));
  return (thread && mine.find((work) => work.thread === thread)) || mine[0];
}

// How long it has been at it: "12 min", "2 h".
function since(iso: string, now: number): string {
  return shortDuration(Math.max(0, now - Date.parse(iso)));
}

export function Peek(props: { agent: string; title?: string; thread?: string; anchor: RefObject<HTMLElement | null>; onClose: () => void; onOpenThread?: () => void }) {
  const { agent, title, thread, anchor, onClose, onOpenThread } = props;
  const work = useAgentWork(agent, thread);
  const steps = useSteps();
  const root = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  // Over what opened it, or under it where there is more room there, its left edge on the opener's, and all of it on
  // the screen: as tall as it needs, at most the room on its side.
  useLayoutEffect(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - WIDTH - 8));
    const above = box.top - GAP - 8;
    const below = window.innerHeight - box.bottom - GAP - 8;
    const needs = root.current?.scrollHeight ?? 0;
    setPlace(
      needs <= above || above >= below
        ? { left, bottom: window.innerHeight - box.top + GAP, maxHeight: above }
        : { left, top: box.bottom + GAP, maxHeight: below },
    );
  }, [anchor]);
  const dismiss = useCallback(() => onClose(), [onClose]);
  useDismiss(true, dismiss, root, anchor);

  // Its lines now, and its helpers', live first: what it is doing.
  const live = steps
    .filter((step) => samePerson(step.agent, agent) && !step.done && phaseOf(step, now))
    .sort((a, b) => Number(phaseOf(b, now) === 'live') - Number(phaseOf(a, now) === 'live') || Date.parse(b.at) - Date.parse(a.at));
  const lately = live.length ? [] : [...(work?.trail ?? [])].reverse().slice(0, 3);
  const progress = planProgress(work?.plan);
  const busy = live.some((step) => phaseOf(step, now) === 'live');
  const plan = work?.plan ?? [];
  // The plan's window: the item being done in it, those around it first.
  const from = Math.max(0, Math.min(plan.findIndex((item) => item.status === 'now') - 2, plan.length - SHOWN_PLAN));
  const shownPlan = plan.slice(from, from + SHOWN_PLAN);
  const files = work?.files ?? [];
  const nothing = !work && !live.length;

  return createPortal(
    <div
      ref={root}
      className="peek"
      role="dialog"
      aria-label={`What ${agent} is working on`}
      style={{ left: place?.left ?? -9999, top: place?.top, bottom: place?.bottom, maxHeight: place?.maxHeight, width: WIDTH, visibility: place ? undefined : 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="peek-head">
        {title && <h3 className="peek-title">{title}</h3>}
        <div className="peek-who">
          <ActorBadge actor={{ kind: 'agent', name: agent }} showName={false} />
          <span className="peek-name">{agent}</span>
          {work && <span className="peek-faint">· {since(work.since, now)}</span>}
          <span className={`peek-state${busy ? ' is-busy' : ''}`}>
            <span className="peek-dot" aria-hidden />
            {busy ? 'at work' : work && !live.length ? `last step ${timeAgo(work.at)}` : 'quiet'}
          </span>
        </div>
      </header>

      {nothing ? (
        <p className="peek-none">
          No steps from {agent} on this board yet. They come from Tricot's live steps in its harness: with them on, its plan and what it is doing show here.
        </p>
      ) : (
        <>
          {progress && (
            <section className="peek-sec" aria-label="Its plan">
              <div className="peek-sec-head">
                <span>Its plan</span>
                <span className="peek-count">
                  {progress.done} of {progress.total}
                </span>
              </div>
              <div className="peek-bar" aria-hidden>
                <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
              <ul className="peek-plan">
                {from > 0 && <li className="peek-more">{from} done before</li>}
                {shownPlan.map((item, at) => (
                  <li key={`${from + at}:${item.text}`} className={`is-${item.status}`}>
                    <span className="peek-box" aria-label={item.status === 'done' ? 'Done' : item.status === 'now' ? 'Doing now' : 'Next'} />
                    <span className="peek-item">{item.text}</span>
                  </li>
                ))}
                {from + SHOWN_PLAN < plan.length && <li className="peek-more">{plan.length - from - SHOWN_PLAN} more</li>}
              </ul>
            </section>
          )}
          <section className="peek-sec" aria-label={live.length ? 'Right now' : 'Lately'}>
            <div className="peek-sec-head">
              <span>{live.length ? 'Right now' : 'Lately'}</span>
              {live.some((step) => step.role) && <span className="peek-count">{new Set(live.filter((step) => step.role).map((step) => step.role)).size} helpers</span>}
            </div>
            <div className="peek-rows">
              {live.map((step) => (
                <StepRow key={`${step.role ?? ''}:${step.at}:${step.text}`} step={step} live={phaseOf(step, now) === 'live'} agent={agent} />
              ))}
              {lately.map((step) => (
                <div key={`${step.at}:${step.text}`} className="peek-row">
                  <span className="peek-dot" aria-hidden />
                  <span className={`peek-role${step.role ? '' : ' is-own'}`}>{step.role ? roleWords(step.role) : ownName(agent)}</span>
                  <StepText text={step.ms !== undefined ? `${step.text} (${shortDuration(step.ms)})` : step.text} className="peek-what" />
                  <span className="peek-when">{timeAgo(step.at)}</span>
                </div>
              ))}
              {!live.length && !lately.length && <p className="peek-faint">Nothing yet.</p>}
            </div>
          </section>
        </>
      )}

      {(files.length > 0 || onOpenThread) && (
        <footer className="peek-foot">
          <span className="peek-files" title={files.join('\n')}>
            {files.length > 0 && `Changed ${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(-SHOWN_FILES).reverse().join(', ')}${files.length > SHOWN_FILES ? `, +${files.length - SHOWN_FILES}` : ''}`}
          </span>
          {onOpenThread && (
            <button type="button" className="btn btn-small btn-primary" onClick={onOpenThread}>
              Open thread <Icon name="arrow-right" />
            </button>
          )}
        </footer>
      )}
    </div>,
    document.body,
  );
}

function StepRow({ step, live, agent }: { step: AgentStep; live: boolean; agent: string }) {
  return (
    <div className="peek-row">
      <span className={`peek-dot${live ? ' is-live' : ''}`} aria-hidden />
      <span className={`peek-role${step.role ? '' : ' is-own'}`}>{step.role ? roleWords(step.role) : ownName(agent)}</span>
      <StepText text={stepWords(step)} className="peek-what" />
      <span className="peek-when">{timeAgo(step.at)}</span>
    </div>
  );
}
