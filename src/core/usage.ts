// Plan usage, as an agent's panel shows it: how much of its model plan's
// windows the tool an agent runs in has used and when each resets, with
// tokens and cost where the tool says, beside what the agent did on the board.
//
// The numbers come from the agent's own harness on this machine, and only
// numbers: Claude Code's status line (hooks/tricot-usage.mjs), the end of
// Codex's own session file, read by its steps hook at each turn's end, and
// Pi's, OMP's and OpenCode's extensions, which count tokens and cost as they
// go. Tricot never reads a login and never asks a usage API. The server keeps
// the latest per agent, in memory only (server/usage.ts).
//
// Types and words only: the browser imports this.

import { agentKinds, agentOfSource, findAgent } from './agents/registry';

// What each agent's harness says it is, in what it posts: the registry's
// (agents/registry.ts), where each agent names its own.
export const USAGE_SOURCES = agentKinds().flatMap((kind) => kind.usage.source ?? []) as [string, ...string[]];
export type UsageSource = string;

// One of a plan's windows: "5h", "7d", or "7d:<model>" for a model's own
// weekly limit. resetsAt is ms since the epoch; minutes, the window's length
// when the tool says (Codex does).
export interface UsageWindow {
  id: string;
  usedPercent: number;
  resetsAt: number;
  minutes?: number;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

// What a harness sends (POST /api/agents/:name/usage, as { usage, at }).
export interface UsageInput {
  source: UsageSource;
  plan?: string; // Codex's plan: "plus", "pro"
  windows?: UsageWindow[];
  tokens?: UsageTokens; // this session's, so far
  costUsd?: number; // this session's, so far
  context?: { usedPercent: number; window: number }; // Claude Code's context window
}

// What the server keeps of one agent, and the page reads.
export interface AgentUsage extends UsageInput {
  at: number; // when its harness last read these numbers, ms
  windowsAt?: number; // when the windows were read: a post without them keeps the last ones
}

// What an agent did on one board, today or this week.
export interface ActivityCounts {
  tasksFinished: number; // sent for review or marked done
  decisionsPosted: number;
  comments: number; // comments and thread replies
  workingMs: number; // its stretches of work on the board (agentActivity.ts)
}

export interface AgentBoardActivity {
  board: { id: string; title: string };
  today: ActivityCounts;
  week: ActivityCounts;
}

export interface AgentUsageReport {
  usage?: AgentUsage;
  activity?: AgentBoardActivity;
}

// ---- which tools share what ----------------------------------------------------------

// What each tool Tricot has live steps for shares: plan limits (and more),
// tokens and cost, or nothing Tricot can reach. Each agent says which
// (agents/registry.ts).
export type Shares = 'plan' | 'tokens' | 'none';

export const sharesOf = (tool: string | undefined): Shares | undefined => (tool === undefined ? undefined : findAgent(tool)?.usage.shares);

// The tool (a live-steps installer's id) a source comes from.
export const toolOfSource = (source: UsageSource): string => agentOfSource(source)?.id ?? source;

// The quiet line for a tool that doesn't share its plan limits.
export function notSharedLine(tool: string, toolName: string): string | undefined {
  if (sharesOf(tool) === 'none') return findAgent(tool)?.usage.notShared ?? `${toolName} keeps its usage to itself.`;
  if (sharesOf(tool) === 'tokens') return `${toolName} shares tokens and cost, not plan limits.`;
  return undefined;
}

// ---- words and numbers ------------------------------------------------------------------

export const STALE_MS = 5 * 60_000; // numbers older than this say when they are from
export const NEAR_LIMIT = 80; // a bar turns amber from here
export const AT_LIMIT = 95; // and red from here

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A window's name: "5-hour", "Weekly", "Weekly · Opus", from its length when
// the tool says, else from its id.
export function windowName(window: Pick<UsageWindow, 'id' | 'minutes'>): string {
  const model = window.id.startsWith('7d:') ? window.id.slice(3) : undefined;
  const minutes = window.minutes;
  let name: string;
  if (minutes === 7 * 24 * 60) name = 'Weekly';
  else if (minutes !== undefined && minutes % (24 * 60) === 0) name = `${minutes / (24 * 60)}-day`;
  else if (minutes !== undefined && minutes % 60 === 0) name = `${minutes / 60}-hour`;
  else if (minutes !== undefined) name = `${minutes}-minute`;
  else name = window.id === '5h' ? '5-hour' : 'Weekly';
  return model ? `${name} · ${model}` : name;
}

// How long until a time, in a word or two: "1h 26m", "3d 4h", "12m".
export function timeUntil(at: number, now: number): string | undefined {
  const left = at - now;
  if (left <= 0) return undefined;
  if (left < MINUTE) return 'under a minute';
  if (left < HOUR) return `${Math.ceil(left / MINUTE)}m`;
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.floor((left % HOUR) / MINUTE);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export const percentText = (percent: number) => `${percent > 0 && percent < 1 ? '<1' : Math.round(percent)}%`;

// "26% used · resets in 1h 26m"
export function windowLine(window: UsageWindow, now: number): string {
  const until = timeUntil(window.resetsAt, now);
  return `${percentText(window.usedPercent)} used${until ? ` · resets in ${until}` : ''}`;
}

// The windows still running: one whose reset has passed says nothing true any more.
export const liveWindows = (windows: UsageWindow[] | undefined, now: number): UsageWindow[] => (windows ?? []).filter((w) => w.resetsAt > now);

// How close to the limit: a bar is neutral, amber near it, red at it.
export type UsageLevel = 'ok' | 'near' | 'at';
export const usageLevel = (percent: number): UsageLevel => (percent >= AT_LIMIT ? 'at' : percent >= NEAR_LIMIT ? 'near' : 'ok');

// "as of 14:32" (or "as of Mon 14:32", a day or more back) when numbers are
// older than STALE_MS; nothing when they are fresh. In the person's own
// locale and time zone unless told (tests).
export function asOf(at: number, now: number, where: { locale?: string; timeZone?: string } = {}): string | undefined {
  if (now - at < STALE_MS) return undefined;
  const zone = where.timeZone ? { timeZone: where.timeZone } : {};
  const time = new Date(at).toLocaleTimeString(where.locale, { hour: 'numeric', minute: '2-digit', ...zone });
  const day = (ms: number) => new Date(ms).toLocaleDateString(where.locale, zone);
  if (day(at) === day(now)) return `as of ${time}`;
  const weekday = new Date(at).toLocaleDateString(where.locale, { weekday: 'short', ...zone });
  return now - at < 6 * DAY ? `as of ${weekday} ${time}` : `as of ${day(at)}`;
}

// A count of tokens, short: 940, 12.4k, 310k, 1.2M.
export function tokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`;
  return `${trim((n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0))}M`;
}
const trim = (text: string) => text.replace(/\.0$/, '');

export const costText = (usd: number) => (usd > 0 && usd < 0.01 ? 'under $0.01' : `$${usd.toFixed(2)}`);

// A plan's name as people say it: "plus" is the Plus plan.
export const planText = (plan: string) => `${plan.charAt(0).toUpperCase()}${plan.slice(1).replace(/_/g, ' ')} plan`;

// Time working, short: "none", "under a minute", "45m", "2h 10m".
export function workingText(ms: number): string {
  if (ms <= 0) return 'none';
  if (ms < MINUTE) return 'under a minute';
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

// Tokens this session, in a line: "1.2M tokens · 840k in, 30k out, 310k from cache".
export function tokensLine(tokens: UsageTokens): string {
  const parts = [`${tokenCount(tokens.input)} in`, `${tokenCount(tokens.output)} out`];
  if (tokens.cacheRead) parts.push(`${tokenCount(tokens.cacheRead)} from cache`);
  if (tokens.reasoning) parts.push(`${tokenCount(tokens.reasoning)} reasoning`);
  return `${tokenCount(tokens.total)} tokens · ${parts.join(', ')}`;
}

// Where today and this week start, in the browser's own time: midnight, and
// the Monday of this week.
export function dayStarts(now: number): { day: number; week: number } {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  return { day: day.getTime(), week: week.getTime() };
}
