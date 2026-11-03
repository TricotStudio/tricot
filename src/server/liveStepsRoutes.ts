// The routes behind each agent's "Live steps" switch: its state, what turning
// it on or off would write, and doing it. They change files in the person's
// home folder (an agent's settings), so on top of the access rules every
// route has (access.ts: this server's own pages, and the token beyond this
// machine):
//
// - Changing is for a person in Tricot's page: a preview or an apply must
//   come from the page (a browser sends its Origin, which access.ts has
//   already checked is this server's). Agents and scripts send none and are
//   refused; there is no MCP tool for it either.
// - From the computer Tricot runs on only, as it is that computer's files.
// - Turning steps on or off is for every project, and never touches a
//   project's settings; a project's own hook from earlier is only taken out,
//   by its own preview and apply (scope 'project').
// - Apply takes the fingerprint of the preview the person saw, signed with a
//   key this server keeps in memory, and redoes the plan: when what it would
//   write is no longer what they saw, nothing is written.
//
// The `tricot hooks` command does the same from a terminal (src/cli).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { LiveStepsPreview, LiveStepsReport, LiveStepsResult } from '../core/liveSteps';
import { describeIssues, liveSteps as bodies } from '../core/schemas';
import { applyLiveSteps, liveStepsAgents, LiveStepsError, planLiveSteps, UnreadableSettings, type LiveStepsContext } from './hooks';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The request came from this computer: its connection's own address is a loopback one.
export const fromThisMachine = (req: Request): boolean => LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '');

export interface LiveStepsRoutesOptions extends LiveStepsContext {
  fromThisMachine?: (req: Request) => boolean; // tests stand in for another device
}

export const NOT_FROM_PAGE =
  "Refused: live steps are turned on or off by a person, in an agent's panel in Tricot or with `tricot hooks` in a terminal. Agents can't change them.";
export const NOT_FROM_HERE =
  "Live steps change files on the computer Tricot runs on, so they are turned on or off from that computer: open Tricot there, or run `tricot hooks` in its terminal.";
const CHANGED =
  'What this would write has changed since you saw it (a file changed, or the preview is from before Tricot restarted). Look at it again before saying yes.';

export function createLiveStepsRouter(options: LiveStepsRoutesOptions): Router {
  const router = Router();
  const local = options.fromThisMachine ?? fromThisMachine;
  const context: LiveStepsContext = { target: options.target, source: options.source, url: options.url };
  // Signs each preview's digest, so a fingerprint can only come from a
  // preview this server gave; a new key each time it starts.
  const key = randomBytes(32);
  const sign = (digest: string) => createHmac('sha256', key).update(digest).digest('hex');

  // Only a person, in the page, on this computer, may change it.
  const mayChange = (req: Request, res: Response): boolean => {
    const site = req.headers['sec-fetch-site'];
    if (!req.headers.origin || (site !== undefined && site !== 'same-origin')) {
      res.status(403).json({ error: NOT_FROM_PAGE });
      return false;
    }
    if (!local(req)) {
      res.status(403).json({ error: NOT_FROM_HERE });
      return false;
    }
    return true;
  };

  router.get('/', (req, res) => {
    const canChange = local(req);
    const report: LiveStepsReport = { agents: liveStepsAgents(context), canChange, ...(!canChange && { why: NOT_FROM_HERE }) };
    res.json(report);
  });

  router.post('/:agent/preview', (req, res) => {
    if (!mayChange(req, res)) return;
    const { agent } = bodies.agent.parse(req.params);
    const { action, name, scope } = bodies.preview.parse(req.body);
    const { digest, ...plan } = planLiveSteps(context, agent, action, { name, scope });
    const preview: LiveStepsPreview = { ...plan, fingerprint: sign(digest) };
    res.json(preview);
  });

  router.post('/:agent/apply', (req, res) => {
    if (!mayChange(req, res)) return;
    const { agent } = bodies.agent.parse(req.params);
    const { action, name, scope, fingerprint } = bodies.apply.parse(req.body);
    const plan = planLiveSteps(context, agent, action, { name, scope });
    const expected = Buffer.from(sign(plan.digest), 'hex');
    const given = Buffer.from(fingerprint, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.status(409).json({ error: CHANGED });
      return;
    }
    const applied = applyLiveSteps(context, plan);
    const result: LiveStepsResult = applied;
    res.json(result);
  });

  // A file Tricot couldn't read or write is the person's to know about, in
  // its own words, as the terminal would say it.
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) res.status(400).json({ error: describeIssues(error) });
    else if (error instanceof LiveStepsError) res.status({ unknown: 404, absent: 409, invalid: 400 }[error.code]).json({ error: error.message });
    else if (error instanceof UnreadableSettings) res.status(409).json({ error: error.message });
    else if (typeof error?.status === 'number' && error.status < 500) res.status(error.status).json({ error: error.message });
    else {
      console.error(error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Live steps could not be changed.' });
    }
  };
  router.use(errors);
  return router;
}
