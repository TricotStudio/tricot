// What an agent is working on, beyond its latest step: the peek (web/agents/peek.tsx). Its hooks send its to-do list
// with the step that writes it, and the files a step changes (hooks/tricot-describe.mjs); the board keeps, for each
// agent session, its plan as it last wrote it, the files it and its helpers changed this turn, and its last few
// steps (server/steps.ts), in memory like the steps themselves, never in a board. Browser-safe: the page draws from here.
import type { PlanChange, PlanItem, PlanStatus } from '../../hooks/tricot-describe.mjs';

export type { PlanChange, PlanItem, PlanStatus };

// A step it took, as the peek's trail says it.
export interface WorkStep {
  text: string;
  at: string;
  role?: string; // a helper's (a subagent's type), when the step is one's
  ms?: number; // how long it took, for a step that lasted
}

// One agent session's work on a board, as the board's stream sends it (the `work` frame).
export interface AgentWork {
  agent: string; // its name on the board
  thread?: string; // the thread it last worked on
  plan?: PlanItem[]; // its to-do list, as it last wrote it
  files: string[]; // the files it and its helpers changed this turn, the latest last
  trail: WorkStep[]; // its last steps and its helpers', oldest first
  since: string; // its first step this turn
  at: string; // its latest step
}

export const MAX_WORK_FILES = 12;
export const MAX_WORK_TRAIL = 6;

// A plan as the board keeps it: each item with the id it was made with (an item-at-a-time tool names items by id).
export type KeptPlan = (PlanItem & { id: string })[];

// The plan after a step changes it: the whole list, an item added after the others, or an item's words or status
// changed, or it gone. An item the plan has no id for is left alone: its list began before the board heard it.
export function applyPlan(kept: KeptPlan | undefined, change: PlanChange): KeptPlan {
  if ('set' in change) return change.set.map((item, at) => ({ ...item, id: String(at + 1) }));
  const items = kept ?? [];
  if ('add' in change) {
    const next = Math.max(0, ...items.map((item) => Number(item.id)).filter(Number.isFinite)) + 1;
    return [...items, { id: String(next), text: change.add, status: 'next' }];
  }
  const { id, status, text } = change.update;
  if (status === 'gone') return items.filter((item) => item.id !== id);
  return items.map((item) => (item.id === id ? { ...item, ...(status && { status }), ...(text && { text }) } : item));
}

// How far along a plan is: its items done, of all, and the one being done now.
export function planProgress(plan: readonly PlanItem[] | undefined): { done: number; total: number; now?: PlanItem } | undefined {
  if (!plan?.length) return undefined;
  return { done: plan.filter((item) => item.status === 'done').length, total: plan.length, now: plan.find((item) => item.status === 'now') };
}
