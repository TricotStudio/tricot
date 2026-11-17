// Serving Slack's REST routes (core/connectors/slack/routes.ts), under
// /api/connectors/slack: the live card of a linked thread. A token never
// leaves this process: what goes out is what Slack said about a thread. A
// card is a read, like the others.

import { Router, type Request } from 'express';
import { parseThreadKey } from '../../../core/connectors/slack/link';
import type { SlackProblem } from '../../../core/connectors/slack/thread';
import { slackRoutes } from '../../../core/connectors/slack/routes';
import { routesOn } from '../../routing';
import { ConnectorError } from '../oauth';
import type { SlackReader } from './reader';

const param = (req: Request, name: string): string => String(req.params[name]);

// Reasons a card can't show its thread that aren't worth an error on every card: they come back with the answer.
const QUIET = new Set(['not_connected', 'needs_sign_in', 'not_found', 'missing_scope', 'rate_limited', 'unavailable']);

export function slackRouter(reader: SlackReader): Router {
  const router = Router();
  const on = routesOn(router, '/api/connectors/slack');
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // A thread's card: its first message, who wrote it and the replies, or why not.
  on(slackRoutes.thread, async (req, res) => {
    const thread = parseThreadKey(`${param(req, 'channel')}/${param(req, 'ts')}`);
    if (!thread) {
      res.status(404).json({ error: 'Not a Slack thread.' });
      return;
    }
    try {
      res.json({ thread: await reader.card(thread.channel, thread.ts, req.query.fresh === '1') });
    } catch (error) {
      if (!(error instanceof ConnectorError) || !error.code || !QUIET.has(error.code)) throw error;
      const problem: SlackProblem = { code: error.code, message: error.message };
      res.json({ problem });
    }
  });

  return router;
}
