// The routes behind the Usage section of an agent's panel (web/usage.tsx):
//
// - POST /api/agents/:name/usage, from an agent's harness: its plan usage, as
//   numbers only (core/schemas agentUsage), kept in memory (usage.ts). Its
//   body is small (app.ts holds it to USAGE_BODY_LIMIT), and a post that is
//   rate-limited or older than the one kept is answered all the same: the
//   hook that sent it has nothing to do about it.
// - GET /api/agents/:name/usage, for the page: the latest of it, and with
//   ?board= what the agent did on that board today and this week, counted
//   from the event log (core/agentActivity.ts), with ?day= and ?week= where
//   the person's today and week begin.
//
// They sit behind the same access rules as every route, as steps do
// (access.ts): this server's own pages, programs on this machine, and the
// token beyond it. Agents have no MCP tool for either.

import { Router, type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { countActivity, LONGEST_TASK_MS } from '../core/agentActivity';
import { agentStepName, agentUsage, agentUsageParams, describeIssues } from '../core/schemas';
import { BoardError, type Store } from '../core/store';
import { dayStarts, type AgentBoardActivity, type AgentUsageReport } from '../core/usage';
import type { Usage } from './usage';
import { routes } from '../core/routes';
import { routesOn } from './routing';

const WEEK_MS = 7 * 24 * 60 * 60_000;

export function createUsageRouter(store: Store, usage: Usage, now: () => number = Date.now): Router {
  const router = Router();
  const on = routesOn(router, '/api/agents');

  on(routes.recordUsage, (req, res) => {
    const { name } = agentStepName.parse(req.params);
    const body = agentUsage.parse(req.body);
    const result = usage.record(name, body.usage, body.at);
    res.status(result.kept ? 200 : result.reason === 'limited' ? 429 : 202).json(result);
  });

  on(routes.agentUsage, (req, res) => {
    const { name } = agentStepName.parse(req.params);
    const params = agentUsageParams.parse(req.query);
    const latest = usage.get(name);
    const report: AgentUsageReport = { ...(latest && { usage: latest }) };
    if (params.board) report.activity = activityOn(store, params.board, name, params, now());
    res.json(report);
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) res.status(400).json({ error: describeIssues(error) });
    else if (error instanceof BoardError) res.status({ not_found: 404, conflict: 409, invalid: 400 }[error.code]).json({ error: error.message });
    else {
      console.error(error);
      res.status(500).json({ error: 'Internal error' });
    }
  };
  router.use(errors);
  return router;
}

// What `agent` did on a board today and this week. The day and the week
// start where the person's browser says, within the last week; else where
// this server's clock says.
function activityOn(store: Store, boardId: string, agent: string, params: { day?: number; week?: number }, at: number): AgentBoardActivity {
  const board = store.getBoard(boardId);
  const fallback = dayStarts(at);
  const within = (start: number | undefined, otherwise: number) => (start !== undefined && start <= at && at - start <= WEEK_MS ? start : otherwise);
  const week = within(params.week, fallback.week);
  const day = Math.max(within(params.day, fallback.day), week);
  const events = store.events(board.id, { byAgent: agent, after: new Date(week - LONGEST_TASK_MS).toISOString(), order: 'asc' });
  return {
    board: { id: board.id, title: board.title },
    today: countActivity(events, day, at),
    week: countActivity(events, week, at),
  };
}
