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
//   where its work stands. Its name holds the role while any session of its
//   holds it, and a session of its name that starts within a few minutes of
//   the last one ending, as when its client connects again or Tricot restarts,
//   takes it back with the role's tools listed from the start (server/leads.ts).
// - A pairing session is a session whose address says `role=pairing` and the
//   thread it owns: a person pairing on a page (any block's full view on a
//   Sketchbook page or the board context, any file in Files) with a new session
//   rather than an agent already on the board. One serves the whole page: its
//   thread is a thread an agent owns, started by the person, about that page
//   (its `pageId`; none for the board context) and no block of it, which
//   Tricot's terminal starts its owner for, named as pairing names it
//   (`pairingThread`): no field marks it, the shape does, as only pairing
//   starts a thread with a status on a person's behalf, and its owner's name
//   and `launch` keep a thread of older data from reading as one. The person's
//   first request on the page makes it (server/pairing.ts), named after the
//   page ("Claude · Pair Mood board", "Claude · Pair Files"), and Tricot's
//   terminal starts its owner as it starts an orchestrator, with the pairing
//   role and its brief (`pairingMessage`), apart from the orchestrators it runs
//   at once (`PAIRINGS_AT_ONCE`): it acts on a small request itself, right
//   away, and hands a big one (several files, a long build or test run), or one
//   on another piece while it is still on one, to a background agent of its own,
//   so nothing queues; every request and reply passes through it, so it keeps
//   the whole page in mind, and it replies on each request's pin once its work
//   is done. Its steps, its workers' too, go to its thread, as an orchestrator's
//   do (server/steps.ts), and show on the pins of the requests waiting on it
//   (web/canvas/pairing/pinLine.tsx). A person has one on a page for each agent
//   kind, reused each time they pair there with that kind; when the pairing on
//   the page ends it sets its thread done with a summary.
// - The person follows along on the page: the dock moves to the thread their
//   message was sent to, and the chat bar lists the threads at work and those
//   waiting on them (web/threads/workStrip.tsx).
//
// Nothing here is a part's: threads are the core's, so Canvas has the roles too.
import { samePerson } from './format';
import type { Actor, Board, Thread, ThreadStatus } from './types';

export type SessionRole = { kind: 'coordinator' } | { kind: 'orchestrator' | 'pairing'; thread: string };

export const ROLE_PARAM = 'role';
export const THREAD_PARAM = 'thread';
const THREAD_ID = /^[\w-]{1,80}$/;

// An MCP address with the role on it, in place of any it had.
export function roleUrl(url: string, role: SessionRole): string {
  const at = url.indexOf('?');
  const base = at < 0 ? url : url.slice(0, at);
  const kept = at < 0 ? [] : url.slice(at + 1).split('&').filter((pair) => pair && ![ROLE_PARAM, THREAD_PARAM].includes(pair.split('=')[0]));
  const said = [`${ROLE_PARAM}=${role.kind}`, ...(role.kind !== 'coordinator' ? [`${THREAD_PARAM}=${encodeURIComponent(role.thread)}`] : [])];
  return `${base}?${[...kept, ...said].join('&')}`;
}

// The role an MCP address's query gives its session: none for one it doesn't
// name, or an orchestrator's or a pairing session's without a thread.
export function roleOf(query: Record<string, unknown>): SessionRole | undefined {
  const role = query[ROLE_PARAM];
  if (role === 'coordinator') return { kind: 'coordinator' };
  const thread = query[THREAD_PARAM];
  if ((role === 'orchestrator' || role === 'pairing') && typeof thread === 'string' && THREAD_ID.test(thread)) return { kind: role, thread };
  return undefined;
}

// The thread a session owns, as its role says: an orchestrator's or a pairing session's.
export const ownedThreadOf = (role: SessionRole | undefined): string | undefined => (role && role.kind !== 'coordinator' ? role.thread : undefined);

// What every pairing session's name holds, between its agent's and its page's.
const PAIRING_MARK = ' · Pair ';

// Whether a thread is a pairing session's (above): an agent owns its work, a person started it, it is about a page and
// no block of it, Tricot's terminal starts its owner, and its owner is named as pairing names one (`pairingName`). A
// coordinator's threads are started by the coordinator, one a person starts from a chat bar has no status, and one of
// older data that came to have both (a quick question its coordinator marked, before that was refused) has no `launch`.
export const pairingThread = (thread: Pick<Thread, 'owner' | 'status' | 'startedBy' | 'blockIds' | 'launch'>): boolean =>
  Boolean(thread.owner?.includes(PAIRING_MARK) && thread.launch && thread.status && thread.startedBy.kind === 'human' && !thread.blockIds?.length);

// A person's pairing sessions on a page (`pageId`: a Sketchbook page's, the Files canvas's, or none for the board
// context), the latest first: the threads of their own they paired there with before.
export const pairingThreadsOf = (board: Pick<Board, 'threads'>, pageId: string | undefined, person: string): Thread[] =>
  (board.threads ?? []).filter((t) => pairingThread(t) && t.pageId === pageId && samePerson(t.startedBy.name, person)).reverse();

// A person's pairing session on a page: the one of an agent kind (`kind`, its id), or the one an agent owns
// (`owner`), else their latest there.
export function pairingThreadOf(board: Pick<Board, 'threads'>, pageId: string | undefined, person: string, which: { kind?: string; owner?: string } = {}): Thread | undefined {
  const theirs = pairingThreadsOf(board, pageId, person);
  if (which.owner) return theirs.find((t) => samePerson(t.owner!, which.owner!));
  if (which.kind) return theirs.find((t) => t.launch === which.kind);
  return theirs[0];
}

// The agent a person's message in a thread is for when it @-mentions nobody:
// its owner, else the one its lens is routed to.
export const threadAgent = (thread: Pick<Thread, 'owner' | 'lens'>): string | undefined => thread.owner ?? thread.lens?.agent;

// Whether a thread is part of the board's conversation rather than work: what
// a person asked from a chat bar, or an agent asked the board, that no one has
// taken on as work. Work handed out has a status, and nothing else does: a
// coordinator's route_to_thread starts it working, and its owner says where it
// stands. Its status is never set on a thread of the conversation
// (store/threads.ts setThreadStatus): its work goes to a thread of its own, so
// it shows as work. Nothing stored marks a quick question, so every edition and
// every older Tricot reads the same; core/threadList.ts says how the page reads it.
export const inConversation = (thread: Pick<Thread, 'status'>): boolean => !thread.status;

// Whether a thread is a quick question that came to this agent as the board's coordinator: one of the conversation that
// it owns, as a coordinator owns what people ask from a chat bar. What it is told of the thread's aim is then to answer a
// question there and send work on (doors.ts doorNote), never to make the work itself.
export const askedOfCoordinator = (thread: Pick<Thread, 'owner' | 'status'>, viewer: string | undefined): boolean =>
  viewer !== undefined && thread.owner !== undefined && samePerson(thread.owner, viewer) && inConversation(thread);

// What a thread's status reads as, to people and agents.
export const STATUS_WORDS: Record<ThreadStatus, string> = {
  working: 'at work',
  'needs-you': 'waiting on people',
  'in-review': 'waiting for review',
  done: 'done',
};

// ---- a review --------------------------------------------------------------------------
//
// Work an owner finished that waits on a person's OK before it is committed is in review (Thread.status `in-review`):
// its owner sets it so in place of done, with a summary of what changed. The person answers with a verdict, in the
// words of a task's review: it looks good and is to be committed, or it needs changes, with a note. Either one is
// posted in the thread as the person's own message, so it is for the owner and wakes it as any person's message does,
// and sets the thread back to working (store/threads.ts reviewThread); after an OK the owner commits and only then sets
// done, so done always means landed. Nothing else is stored of it: what Home's conversation says of a review
// (homeConversation.ts) is read from the status and the person's message, by its words (`verdictOf`).

export type ReviewVerdict = 'approve' | 'changes';

// A verdict's words, which lead the person's message.
export const VERDICT_WORDS: Record<ReviewVerdict, string> = {
  approve: 'Looks good, commit it',
  changes: 'Needs changes',
};

// The person's message a verdict posts: its words, then the note, if any, after a blank line.
export function verdictMessage(verdict: ReviewVerdict, note?: string): string {
  const said = note?.trim();
  return `${VERDICT_WORDS[verdict]}.${said ? `\n\n${said}` : ''}`;
}

// The verdict a person's message gives, read from its words: a first line that is a verdict's words, with or without
// its full stop, and the note after it. None for any other message.
export function verdictOf(body: string): { verdict: ReviewVerdict; note?: string } | undefined {
  const [head, ...rest] = body.split('\n');
  const verdict = (Object.keys(VERDICT_WORDS) as ReviewVerdict[]).find((v) => head.trim().replace(/\.$/, '') === VERDICT_WORDS[v]);
  if (!verdict) return undefined;
  const note = rest.join('\n').trim();
  return { verdict, ...(note && { note }) };
}

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

// The name a pairing session has on the board: its agent's, then "Pair" and the page ("Claude · Pair Mood board"),
// numbered when the board has one of that name already (another person's pairing on the same page). The page's name
// keeps its letters, digits and a file name's marks alone, so the name reads as one in an @-mention and in an address,
// and is cut whole characters at a time.
export function pairingName(agent: string, page: string, taken: string[]): string {
  const words = page.replace(/[^\p{L}\p{N}\s.'_-]/gu, ' ').replace(/\s+/g, ' ').trim() || 'piece';
  const base = Array.from(`${agent}${PAIRING_MARK}${words}`).slice(0, 50).join('').trim();
  const free = (name: string) => !taken.some((t) => samePerson(t, name));
  if (free(base)) return base;
  for (let n = 2; ; n++) if (free(`${base} ${n}`)) return `${base} ${n}`;
}

// How long after a thread is deleted its orchestrator is closed: past the undo toast's 10 s countdown (web/canvas/
// undo.css), with room for the pointer resting on it, so an Undo finds its owner still there.
export const CLOSE_AFTER_DELETE_MS = 60_000;

// How long an orchestrator whose thread is done sleeps before it is closed, though its terminal has room: a word in its
// thread later starts it again, on the session it had where its agent can (agents/agent.ts resumes), else a fresh one,
// which reads the thread back.
export const QUIET_CLOSE_MS = 60 * 60_000;

// An orchestrator a terminal holds, and where the work of the thread it owns stands, as the board tells the terminal
// (server/wakes.ts): it counts towards its coordinator's owners at once only while at work, and one done is the first
// to make room when the terminal has none, and is closed once it has slept QUIET_CLOSE_MS. One whose work waits for
// review is kept: it commits once the person says so.
export interface OwnerNow {
  name: string;
  status: ThreadStatus;
}

// How many pairing sessions of their own a Tricot terminal runs at work at once for each agent kind, apart from the
// orchestrators its coordinators run (agentRules.ts atOnce): a long build never holds a pairing back, and a pairing held
// back says so where its person waits (server/wakes.ts HeldLaunch).
export const PAIRINGS_AT_ONCE = 3;

// A pairing session's launch a terminal held back, and why: as many at work as it runs at once (`busy`), or no free tab
// (`full`).
export interface HeldLaunch {
  thread: string;
  why: 'busy' | 'full';
}

// Whether a terminal has room to start an owner now, as those it runs at work stand (their agent kind, and whether each
// is a pairing session): an orchestrator while fewer than its coordinator's at once (`orchestrators`) of its kind are at
// work, a pairing session while fewer than PAIRINGS_AT_ONCE of its kind are, each counting its own alone.
export function launchRoom(launch: Pick<Launch, 'agent' | 'pairing'>, atWork: readonly { kind: string; pairing: boolean }[], orchestrators: number): boolean {
  const alike = atWork.filter((a) => a.kind === launch.agent && a.pairing === Boolean(launch.pairing)).length;
  return alike < (launch.pairing ? PAIRINGS_AT_ONCE : orchestrators);
}

// A thread whose owner Tricot's terminal starts, as the board tells it (server/wakes.ts): an orchestrator, or a pairing
// session (`pairing`: who pairs, and the page they pair on, none for the board context). `asked`: a word there waits
// for it (`askedOwner`), so the terminal starts it before the others, past the owners it runs at once.
export interface Launch {
  thread: string; // its id
  title: string;
  name: string; // the owner's name on the board
  agent: string; // which agent to start, by its id ("claude")
  pairing?: { person: string; page?: string };
  asked?: true;
}

// Whether a word in a thread an agent owns waits for its owner: a message after the owner's own last one that is for
// it, as delivery.ts meantFor reads one (a person's or another agent's, such as a coordinator sending a person's
// follow-up on, that @-mentions nobody or the owner, and that the loop guard didn't hold), once the owner has come to
// the thread: it wrote there, or its work waits on people or for review. New work its owner never came to waits its
// turn instead, as does a pairing session's first request. Done work waits for no one: a person's word sets it back to
// work, so what is left after its owner there is the summary it was closed with.
export function askedOwner(thread: Pick<Thread, 'owner' | 'status' | 'messages'>): boolean {
  const owner = thread.owner;
  if (!owner || !thread.status || thread.status === 'done') return false;
  const isOwner = (author: Actor) => author.kind === 'agent' && samePerson(author.name, owner);
  const last = thread.messages.findLastIndex((m) => isOwner(m.author));
  if (last < 0 && thread.status === 'working') return false;
  return thread.messages.slice(last + 1).some((m) => !isOwner(m.author) && !m.held && (!m.mentions?.length || m.mentions.some((name) => samePerson(name, owner))));
}

// The threads of a board whose owner no one answers for (`answering`: none of its name on the board), with an agent
// to start: those at work, and those where a word waits for their owner (`askedOwner`), whatever their status, so a
// person's plain reply to work in review, which leaves it waiting there, still reaches its owner. Their status stays as
// it is: only a person's reply to work waiting on them or done, or their verdict on a review, sets it back to work.
export function launchesOn(board: Board, answering: (name: string) => boolean): Launch[] {
  return (board.threads ?? []).flatMap((thread) => {
    if (!thread.owner || !thread.launch || answering(thread.owner)) return [];
    const asked = askedOwner(thread);
    if (thread.status !== 'working' && !asked) return [];
    return [
      {
        thread: thread.id,
        title: thread.title,
        name: thread.owner,
        agent: thread.launch,
        ...(pairingThread(thread) && { pairing: { person: thread.startedBy.name, ...(thread.pageId && { page: thread.pageId }) } }),
        ...(asked && { asked: true as const }),
      },
    ];
  });
}

// The first thing an orchestrator Tricot starts reads.
export const orchestratorMessage = (launch: Pick<Launch, 'thread' | 'title'>): string =>
  `You own the Tricot thread "${launch.title}" [thread id: ${launch.thread}]: read it with get_thread, then do the work it asks. Plan it, hand it to your own subagents (scouts to read and find, workers to build, each in its own git worktree, each run in the background, never the foreground, so a person's message reaches you while they work), report in the thread with reply_in_thread, ask people there when you need them, and end with set_thread_status.`;

// The first thing a pairing session Tricot starts reads: who it pairs with, on which page, and how.
export function pairingMessage(launch: Pick<Launch, 'thread' | 'title'> & { pairing: { person: string; page?: string } }): string {
  const { person, page } = launch.pairing;
  const where = page ? `one page of the board [page id: ${page}]` : "the board's own canvas";
  const read = page ? `get_canvas(page_id: ${page})` : 'get_canvas';
  return (
    `${person} is pairing with you on ${where}, and you own its Tricot thread "${launch.title}" [thread id: ${launch.thread}]. ` +
    `Catch up with get_board and ${read}. Requests come as comments that @-mention you on pins on any of its blocks or files: act on a small one yourself, right away; hand a big one (several files, a long build or test run), or one on another piece while you are still on one, to a background agent of your own, so nothing queues. ` +
    `Every request and reply passes through you, so you keep the whole page in mind: reply on each request's pin yourself with comment(pin_id) once its work is done. Keep to that page. When Tricot tells you the pairing ended, set the thread done with a summary of what changed.`
  );
}

// The first thing an owner reads that Tricot starts again on its earlier session (core/agents/agent.ts resumes): it
// knows its thread and its role already, so it is told only that Tricot restarted and to answer what is new, after
// reading its thread again, and a pairing session its page too.
export function resumedMessage(launch: Pick<Launch, 'thread' | 'title' | 'pairing'>): string {
  const owner = `Tricot restarted, and you are still the owner of the Tricot thread "${launch.title}" [thread id: ${launch.thread}]`;
  if (!launch.pairing) return `${owner}: read it with get_thread, and answer what is new there.`;
  const { person, page } = launch.pairing;
  const read = page ? `get_canvas(page_id: ${page})` : 'get_canvas';
  return `${owner}, pairing with ${person}: read it with get_thread, catch up with ${read}, and answer what is new there and on its pins.`;
}

// What Tricot's terminal starts an owner as (cli/severalAgents.ts): its role on its address and the first thing it
// reads, with what its background agents run on (`subagents`, as the person's rule says), for an orchestrator and a
// pairing session alike. One carrying on its earlier session (`resumed`) reads resumedMessage in place of its brief.
export function launchRole(launch: Launch, subagents?: string, resumed = false): { role: SessionRole; message: string } {
  const told = (message: string) => (subagents ? `${message} ${subagents}` : message);
  if (launch.pairing) return { role: { kind: 'pairing', thread: launch.thread }, message: told(resumed ? resumedMessage(launch) : pairingMessage({ ...launch, pairing: launch.pairing })) };
  return { role: { kind: 'orchestrator', thread: launch.thread }, message: told(resumed ? resumedMessage(launch) : orchestratorMessage(launch)) };
}

// The first thing a coordinator Tricot starts reads, after its board.
export const coordinatorMessage = (board?: string): string =>
  `You are the coordinator of the Tricot board ${board ?? 'that fits this folder'}: you answer people in the chat bar and do no work yourself. Read read_guide("coordinating"), catch up with get_board, then call wait_for_updates and do as it says. Tricot wakes you when someone asks.`;

// What an agent connected on its own is told as it takes a board's coordinator role (`lead`, mcp/session.ts): it owns
// the threads it sends work to, and does each one's work through a background agent of its own.
export const LEAD_WORDS =
  "You are now this board's coordinator: the threads people start from its chat bar come to you, and route_to_thread and set_thread_status are now among your tools. Answer a quick question in place, unless it follows up a thread of the board. Send that, and anything that takes work, on with route_to_thread: to the thread it belongs to, where a message alone in its own thread moves, or to a new thread, which you own. Hand each new thread's work to a background agent of your own (your Agent tool), so you stay free for the bar, and tell it the thread id: it reads the thread with get_thread first (its steps then show there), plans with a to-do list, reports there with reply_in_thread, asks people there, and sets where the work stands with set_thread_status, needs-you or done. A person's reply in a thread you own comes to you: take it up, or hand it on with the thread id.";
