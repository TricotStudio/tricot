import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { stepText, type BusyState } from '../core/delivery';
import { pathParts } from '../core/format';
import type { AgentStep } from './api';

// What agents are doing now, a line at a time, from a hook in their harness
// (server/steps.ts): "Running npm test" on the card the agent works on, as
// it comes, dimming when no step follows and gone a while later. A step is
// never saved; the page holds the latest ones the board's stream sent.
//
// They are kept here, outside the board, so a step (one every few seconds
// while an agent works) re-renders only the lines that show it.

export class StepsStore {
  private steps: AgentStep[] = [];
  private readonly listeners = new Set<() => void>();

  set(steps: AgentStep[]): void {
    this.steps = steps;
    for (const listener of this.listeners) listener();
  }

  get = (): AgentStep[] => this.steps;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

const StepsContext = createContext<StepsStore | null>(null);
export const StepsProvider = StepsContext.Provider;

const none: AgentStep[] = [];
const noStore = { get: () => none, subscribe: () => () => {} };

// Every agent's latest step on the board, for a line that looks past one card
// (the line under a person's message, delivery.tsx).
export function useSteps(): AgentStep[] {
  const store = useContext(StepsContext) ?? noStore;
  return useSyncExternalStore(store.subscribe, store.get);
}

// A step stays as it came while the agent may still be on it (a step that
// says nothing more until it ends, after a quiet stretch), then dims, then
// goes. One the hook says is running (a test run, a subagent) stays live
// until its end comes, for up to RUNNING_LIVE_MS. The end of a turn dims at
// once and goes soon after. Ages are by the hook's clock, which is this
// machine's when Tricot runs here.
export const LIVE_MS = 45_000;
export const GONE_MS = 120_000;
export const DONE_GONE_MS = 15_000;
export const RUNNING_LIVE_MS = 10 * 60_000;
export const RUNNING_GONE_MS = 12 * 60_000; // server/steps.ts RUNNING_KEEP_MS

export type StepPhase = 'live' | 'dim';

function marksOf(step: AgentStep): number[] {
  if (step.done) return [DONE_GONE_MS];
  return step.running ? [RUNNING_LIVE_MS, RUNNING_GONE_MS] : [LIVE_MS, GONE_MS];
}

export function phaseOf(step: AgentStep, now: number): StepPhase | undefined {
  const age = Math.max(0, now - Date.parse(step.at));
  const [live, gone] = marksOf(step);
  if (gone === undefined) return age < live ? 'dim' : undefined; // a turn's end: dim until it goes
  if (age < live) return 'live';
  return age < gone ? 'dim' : undefined;
}

// The "working on it" stitch beside a step (stitch.tsx): moving while the step
// is live, resting once it dims.
export const busyOfPhase = (phase: StepPhase): BusyState => (phase === 'live' ? 'working' : 'resting');

// When a step next changes phase, for the timer that redraws it.
export function nextChange(step: AgentStep, now: number): number {
  const age = Math.max(0, now - Date.parse(step.at));
  const next = marksOf(step).find((mark) => mark > age);
  return next === undefined ? Infinity : next - age;
}

// A step as its line says it: an ended one with how long it took, "Ran npm
// test (42 s)"; what the agent said, quoted (core/delivery.ts).
export const stepWords = (step: AgentStep): string => stepText(step);

// A step's words on one narrow line. A file path in them gives way in its
// middle as the line runs out of room (core/format.ts pathParts): its folders
// first, then what follows it, then the middle of the file's name, whose end
// stays, so "Reading src/web/checkout/ReceiptSummaryPanel.tsx" reads "Reading
// src/web/ch…ReceiptSummaryPanel.tsx", then "Reading ReceiptSu…Panel.tsx". The
// line's tooltip has it whole.
export function StepText({ text, className = '' }: { text: string; className?: string }) {
  const parts = pathParts(text);
  if (!parts) return <span className={className}>{text}</span>;
  return (
    <span className={`${className} step-text`}>
      <span className="step-lead">{parts.lead}</span>
      <span className="step-dirs">{parts.dirs}</span>
      {parts.head && <span className="step-head">{parts.head}</span>}
      <span className="step-tail">{parts.tail}</span>
      {parts.after && <span className="step-after">{parts.after}</span>}
    </span>
  );
}

// Redraws when the step given next changes phase; the time to judge it by.
export function usePhaseClock(step: AgentStep | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const at = Math.max(now, Date.now());
  const wait = step ? nextChange(step, at) : Infinity;
  useEffect(() => {
    if (!Number.isFinite(wait)) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [wait, step]);
  return at;
}

// ---- every board's, for the home page ------------------------------------------
// The home page listens to one stream of every board's steps (server/live.ts
// openStepsStream), each with the card it is on as people name it ("T114").
// Each project's row reads its own board's here, so a step redraws that row's
// agent line, not the list.

export type BoardStep = AgentStep & { on?: string };

export class StepsByBoard {
  private byBoard = new Map<string, BoardStep[]>();
  private readonly listeners = new Set<() => void>();

  set(boardId: string, steps: BoardStep[]): void {
    if (steps.length) this.byBoard.set(boardId, steps);
    else this.byBoard.delete(boardId);
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.byBoard = new Map();
    for (const listener of this.listeners) listener();
  }

  of = (boardId: string): BoardStep[] => this.byBoard.get(boardId) ?? none;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

const ByBoardContext = createContext<StepsByBoard | null>(null);
export const StepsByBoardProvider = ByBoardContext.Provider;

// Listens for every board's steps while the page is open.
export function useStepsEverywhere(): StepsByBoard {
  const [store] = useState(() => new StepsByBoard());
  useEffect(() => {
    const source = new EventSource('/api/steps/stream');
    // Joining again, the stream sends what shows now: what was held may be over.
    source.onopen = () => store.clear();
    source.addEventListener('steps', (event) => {
      const { board, steps } = JSON.parse((event as MessageEvent<string>).data) as { board: string; steps: BoardStep[] };
      store.set(board, steps);
    });
    return () => source.close();
  }, [store]);
  return store;
}

const nowhere = { of: () => none, subscribe: () => () => {} };

// Each agent's latest step that still shows, by name as the step spells it.
export function latestSteps<T extends AgentStep>(steps: T[], now: number): Map<string, T> {
  const latest = new Map<string, T>();
  for (const step of steps) {
    const key = step.agent.toLowerCase();
    const before = latest.get(key);
    if (phaseOf(step, now) && (!before || Date.parse(step.at) > Date.parse(before.at))) latest.set(key, step);
  }
  return latest;
}

// The step a project's row shows: the busiest agent's that has one (`agents`
// busiest first, as presence has them), else the latest of any agent's.
export function rowStep<T extends AgentStep>(agents: string[], steps: T[], now: number): T | undefined {
  const latest = latestSteps(steps, now);
  for (const name of agents) {
    const step = latest.get(name.toLowerCase());
    if (step) return step;
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

export function useBoardSteps(boardId: string): BoardStep[] {
  const store = useContext(ByBoardContext) ?? nowhere;
  return useSyncExternalStore(store.subscribe, () => store.of(boardId));
}

// The latest step on a card, with its phase, while it shows: of the agents
// `shows` keeps, if given.
export function useCardStep(kind: 'task' | 'decision', id: string, shows?: (agent: string) => boolean): { step: AgentStep; phase: StepPhase } | undefined {
  const steps = useSteps();
  const mine = steps.filter((s) => s.card?.kind === kind && s.card.id === id && (!shows || shows(s.agent)));
  const latest = mine.reduce<AgentStep | undefined>((best, s) => (!best || Date.parse(s.at) > Date.parse(best.at) ? s : best), undefined);
  const at = usePhaseClock(latest);
  const phase = latest && phaseOf(latest, at);
  return latest && phase ? { step: latest, phase } : undefined;
}
