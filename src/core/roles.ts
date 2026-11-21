// The roles a session can take on a board, after Ultimate's: a coordinator,
// which answers the chat bar and hands work out, and an orchestrator for each
// thread it hands work to, which owns that thread and runs its own subagents
// (scouts, workers) to do it.
//
// - A coordinator is a session whose MCP address says `role=coordinator`: each
//   agent Tricot's terminal starts and wakes (`tricot claude`, and both of
//   `tricot claude codex`, cli/severalAgents.ts). While one is on a board, a
//   thread a person starts there from a chat bar is a coordinator's
//   (Thread.owner, store/threads.ts startThread): the one it @-mentions, else
//   the one seen last; one that @-mentions another agent, or is about a page or
//   file an agent made, is not. It answers a quick question in place, and sends
//   work on with route_to_thread: to the thread it belongs to, or to a new one,
//   which an orchestrator of its own kind owns.
// - An orchestrator is a session whose address says `role=orchestrator` and
//   the thread it owns (`thread=<id>`). Tricot's terminal starts it: the
//   board tells each terminal holding a coordinator which threads have an
//   owner no session of that name answers for, of the kinds it coordinates
//   (server/wakes.ts), and the terminal starts each in a tab of its own, so
//   many at once for each coordinator (cli/switcher/host.ts). Its live steps, its subagents' too, go to its
//   thread (server/steps.ts), and it says where its work stands with
//   set_thread_status (Thread.status).
// - An agent connected on its own (`claude` with Tricot's tools, told to listen
//   on a board) has no terminal to start orchestrators in. It takes the
//   coordinator's role on each board it sleeps on by `tricot listen`, as each
//   agent Tricot's terminal starts is one (mcp/session.ts, server/presence.ts
//   lead), so it works the same however it was connected, and
//   owns the threads it sends work to itself: it hands each one's work to a
//   background agent of its own (its harness's subagent), whose steps go to that
//   thread once it names it (server/steps.ts), and which reports there and says
//   where its work stands. It holds the role until its session ends.
// - The person follows along on the page: the dock moves to the thread their
//   message was sent to, and the chat bar lists the threads at work and those
//   waiting on them (web/threads/workStrip.tsx).
//
// Nothing here is a part's: threads are the core's, so Canvas has the roles too.
import { samePerson } from './format';
import type { Board, Thread, ThreadStatus } from './types';

export type SessionRole = { kind: 'coordinator' } | { kind: 'orchestrator'; thread: string };

export const ROLE_PARAM = 'role';
export const THREAD_PARAM = 'thread';
const THREAD_ID = /^[\w-]{1,80}$/;

// An MCP address with the role on it, in place of any it had.
export function roleUrl(url: string, role: SessionRole): string {
  const at = url.indexOf('?');
  const base = at < 0 ? url : url.slice(0, at);
  const kept = at < 0 ? [] : url.slice(at + 1).split('&').filter((pair) => pair && ![ROLE_PARAM, THREAD_PARAM].includes(pair.split('=')[0]));
  const said = [`${ROLE_PARAM}=${role.kind}`, ...(role.kind === 'orchestrator' ? [`${THREAD_PARAM}=${encodeURIComponent(role.thread)}`] : [])];
  return `${base}?${[...kept, ...said].join('&')}`;
}

// The role an MCP address's query gives its session: none for one it doesn't
// name, or an orchestrator's without a thread.
export function roleOf(query: Record<string, unknown>): SessionRole | undefined {
  const role = query[ROLE_PARAM];
  if (role === 'coordinator') return { kind: 'coordinator' };
  const thread = query[THREAD_PARAM];
  if (role === 'orchestrator' && typeof thread === 'string' && THREAD_ID.test(thread)) return { kind: 'orchestrator', thread };
  return undefined;
}

// The agent a person's message in a thread is for when it @-mentions nobody:
// its owner, else the one its lens is routed to.
export const threadAgent = (thread: Pick<Thread, 'owner' | 'lens'>): string | undefined => thread.owner ?? thread.lens?.agent;

// What a thread's status reads as, to people and agents.
export const STATUS_WORDS: Record<ThreadStatus, string> = {
  working: 'at work',
  'needs-you': 'waiting on people',
  done: 'done',
};

// The name an orchestrator has on the board: its agent's, then the first
// words of its thread's title ("Claude · Sign-in flow"), numbered when the
// board has one of that name already.
export function orchestratorName(agent: string, title: string, taken: string[]): string {
  const words = title.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  const base = `${agent} · ${words || 'work'}`.slice(0, 50).trim();
  const free = (name: string) => !taken.some((t) => samePerson(t, name));
  if (free(base)) return base;
  for (let n = 2; ; n++) if (free(`${base} ${n}`)) return `${base} ${n}`;
}

// How long after a thread is deleted its orchestrator is closed: past the undo toast's 10 s countdown (web/canvas/
// undo.css), with room for the pointer resting on it, so an Undo finds its owner still there.
export const CLOSE_AFTER_DELETE_MS = 60_000;

// An orchestrator a terminal holds, and where the work of the thread it owns stands, as the board tells the terminal
// (server/wakes.ts): it counts towards its coordinator's owners at once only while at work, and one done is the first
// to make room when the terminal has none.
export interface OwnerNow {
  name: string;
  status: ThreadStatus;
}

// A thread whose owner Tricot's terminal starts, as the board tells it (server/wakes.ts).
export interface Launch {
  thread: string; // its id
  title: string;
  name: string; // the owner's name on the board
  agent: string; // which agent to start, by its id ("claude")
}

// The threads of a board whose work waits on an owner no one answers for:
// at work, with an agent to start, and none of the owner's name on the board
// (`answering`).
export function launchesOn(board: Board, answering: (name: string) => boolean): Launch[] {
  return (board.threads ?? []).flatMap((thread) =>
    thread.status === 'working' && thread.owner && thread.launch && !answering(thread.owner) ? [{ thread: thread.id, title: thread.title, name: thread.owner, agent: thread.launch }] : [],
  );
}

// The first thing an orchestrator Tricot starts reads.
export const orchestratorMessage = (launch: Pick<Launch, 'thread' | 'title'>): string =>
  `You own the Tricot thread "${launch.title}" [thread id: ${launch.thread}]: read it with get_thread, then do the work it asks. Plan it, hand it to your own subagents (scouts to read and find, workers to build, each in its own git worktree), report in the thread with reply_in_thread, ask people there when you need them, and end with set_thread_status.`;

// The first thing a coordinator Tricot starts reads, after its board.
export const coordinatorMessage = (board?: string): string =>
  `You are the coordinator of the Tricot board ${board ?? 'that fits this folder'}: you answer people in the chat bar and do no work yourself. Read read_guide("coordinating"), catch up with get_board, then call wait_for_updates and do as it says. Tricot wakes you when someone asks.`;

// What an agent connected on its own is told as it takes a board's coordinator role (`lead`, mcp/session.ts): it owns
// the threads it sends work to, and does each one's work through a background agent of its own.
export const LEAD_WORDS =
  "You are now this board's coordinator: the threads people start from its chat bar come to you, and route_to_thread and set_thread_status are now among your tools. Answer a quick question in place, unless it follows up a thread of the board. Send that, and anything that takes work, on with route_to_thread: to the thread it belongs to, where a message alone in its own thread moves, or to a new thread, which you own. Hand each new thread's work to a background agent of your own (your Agent tool), so you stay free for the bar, and tell it the thread id: it reads the thread with get_thread first (its steps then show there), plans with a to-do list, reports there with reply_in_thread, asks people there, and sets where the work stands with set_thread_status, needs-you or done. A person's reply in a thread you own comes to you: take it up, or hand it on with the thread id.";
