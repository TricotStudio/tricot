// The boards in use at a glance, for Home and the board switcher: one project
// per board, with its work counted and the agents on it, and each agent once,
// where it is busiest. It is the core's: what a board's work looks like is told
// by the part that keeps its cards (`ProjectWork` below, which the one that asks
// gives as `work`), and what waits on a person
// (a part's needs) is added to a project's count by the one that asks
// (`needs` below), so a server with none reports its projects with no `work` and
// no `needs`, as a Canvas server does.

import { cardOf } from './cards';
import { presenceRank, type PresenceState } from './delivery';
import type { Board } from './types';

// ---- agents ------------------------------------------------------------------------

// An agent on a board now, as the server's presence has it (server/presence.ts).
export interface PresentAgent {
  name: string;
  lastSeen: string;
  state: PresenceState;
  focus?: { kind: string; id: string };
}

// The same, with the card it's working on by its ref (T65), if it's working.
export interface AgentHere {
  name: string;
  lastSeen: string;
  state: PresentAgent['state'];
  on?: string;
  onTitle?: string;
}

// Busiest first: one working, then by how reachable (core/delivery.ts presenceRank).
const busiest = (state: PresentAgent['state']) => (state === 'working' ? -1 : presenceRank(state));

// What a working agent is on: the card its calls are about, else the card the
// part that keeps cards says it has claimed (a task in progress).
function agentHere(board: Board, agent: PresentAgent, work?: ProjectWork): AgentHere {
  const here: AgentHere = { name: agent.name, lastSeen: agent.lastSeen, state: agent.state };
  if (agent.state !== 'working') return here;
  const focus = agent.focus && cardOf(board, agent.focus.kind, agent.focus.id);
  const on = focus ? { on: focus.label, onTitle: focus.title } : work?.claimed?.(board, agent);
  return on ? { ...here, ...on } : here;
}

// The last agent to change the board, and when: who was here, once nobody is.
export function lastAgent(board: Board): { name: string; at: string } | undefined {
  const seen = board.activity.actors.find((s) => s.actor.kind === 'agent');
  return seen && { name: seen.actor.name, at: seen.at };
}

// ---- projects -------------------------------------------------------------------------

export interface WorkSquare {
  square: string; // the status the part names it by, which the page's square is classed with
  label: string; // "#3 open, blocking: Should non-idempotent POSTs ever be retried?"
}

// A board's work at a glance: one square per item still in play, and how much
// is settled. Dropped tasks are no longer work, so they count for neither.
export interface BoardWork {
  squares: WorkSquare[];
  decisions: number;
  tasks: number;
  decided: number;
  done: number;
}

// What the part that keeps cards on its boards says of their work: a board's work at
// a glance, and the card an agent has claimed, for a working agent whose calls name none. It is the app's, given to
// `projectsAcross` by the one that builds the report (the needs source of the part that keeps the cards), as the
// reading's and the search's are a Store's (searchCards.ts, cardReading.ts): nothing is set for the process. A report
// built with none has no `work` on its projects and no agent on a card but the one it named.
export interface ProjectWork {
  work(board: Board): BoardWork;
  claimed?(board: Board, agent: PresentAgent): { on: string; onTitle: string } | undefined;
}

export interface Project {
  id: string;
  title: string;
  goal?: string;
  updatedAt: string;
  needs?: number; // items waiting on the viewer: told only by a server that knows what waits on a person
  agents: AgentHere[]; // on it now, the busiest first
  lastAgent?: { name: string; at: string };
  work?: BoardWork; // told only where the part that keeps cards says it (ProjectsOptions.work)
}

// An agent somewhere, where it's busiest: for "Claude is working on T65 in
// Tricot roadmap". No board: it is connected, but on no project in use (a
// session just started, before there is one).
export interface AgentAround extends AgentHere {
  boardId?: string;
  board?: string;
}

// The report GET /api/needs answers: the projects and the agents, which the core
// serves, and the rows and the total that wait on the person, which a part adds
// (the row type is its own).
export interface BoardsReport<Row = never> {
  total: number; // items waiting on the viewer
  rows: Row[];
  projects: Project[]; // boards in use: those that need the viewer first, then the latest activity
  agents: AgentAround[]; // each agent once, the busiest first
}

export interface ProjectsOptions {
  present?: (board: Board) => PresentAgent[];
  connected?: PresentAgent[]; // agents connected but on no board in use (server/presence.ts)
  needs?: (board: Board) => number; // items waiting on the viewer on a board; none: the projects carry no `needs`
  work?: ProjectWork; // what tells a board's work and the card an agent has claimed; none: the projects carry no `work`
}

export function projectsAcross(boards: Board[], options: ProjectsOptions = {}): Pick<BoardsReport, 'projects' | 'agents'> {
  const inUse = boards.filter((b) => !b.archived);
  const projects: Project[] = [];
  const around = new Map<string, AgentAround>();
  for (const board of inUse) {
    const agents = (options.present?.(board) ?? [])
      .map((a) => agentHere(board, a, options.work))
      .sort((a, b) => busiest(a.state) - busiest(b.state) || b.lastSeen.localeCompare(a.lastSeen));
    for (const agent of agents) {
      const key = agent.name.trim().toLowerCase();
      const known = around.get(key);
      const busier =
        !known ||
        busiest(agent.state) < busiest(known.state) ||
        (busiest(agent.state) === busiest(known.state) && agent.lastSeen > known.lastSeen);
      if (busier) around.set(key, { ...agent, boardId: board.id, board: board.title });
    }
    projects.push({
      id: board.id,
      title: board.title,
      ...(board.goal ? { goal: board.goal } : {}),
      updatedAt: board.updatedAt,
      ...(options.needs && { needs: options.needs(board) }),
      agents,
      ...(lastAgent(board) ? { lastAgent: lastAgent(board) } : {}),
      ...(options.work && { work: options.work.work(board) }),
    });
  }
  projects.sort((a, b) => Number((b.needs ?? 0) > 0) - Number((a.needs ?? 0) > 0) || b.updatedAt.localeCompare(a.updatedAt));
  for (const agent of options.connected ?? []) {
    const key = agent.name.trim().toLowerCase();
    if (!around.has(key)) around.set(key, { name: agent.name, lastSeen: agent.lastSeen, state: agent.state });
  }
  const agents = [...around.values()].sort((a, b) => busiest(a.state) - busiest(b.state) || b.lastSeen.localeCompare(a.lastSeen));
  return { projects, agents };
}

// The report with nothing waiting on anyone: what the core answers alone.
export const withoutNeeds = (found: Pick<BoardsReport, 'projects' | 'agents'>): BoardsReport => ({ total: 0, rows: [], ...found });
