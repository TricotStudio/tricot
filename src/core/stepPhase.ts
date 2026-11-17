// How long an agent's step shows, wherever it shows: on a card and Home's
// rows (web/steps.tsx), and in the strip under agents run together in one
// terminal (cli/switcher/strip.ts).
//
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

interface Timed {
  at: string;
  done?: boolean;
  running?: boolean;
}

function marksOf(step: Timed): number[] {
  if (step.done) return [DONE_GONE_MS];
  return step.running ? [RUNNING_LIVE_MS, RUNNING_GONE_MS] : [LIVE_MS, GONE_MS];
}

export function phaseOf(step: Timed, now: number): StepPhase | undefined {
  const age = Math.max(0, now - Date.parse(step.at));
  const [live, gone] = marksOf(step);
  if (gone === undefined) return age < live ? 'dim' : undefined; // a turn's end: dim until it goes
  if (age < live) return 'live';
  return age < gone ? 'dim' : undefined;
}

// When a step next changes phase, for the timer that redraws it.
export function nextChange(step: Timed, now: number): number {
  const age = Math.max(0, now - Date.parse(step.at));
  const next = marksOf(step).find((mark) => mark > age);
  return next === undefined ? Infinity : next - age;
}
