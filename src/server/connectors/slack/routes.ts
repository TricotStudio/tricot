// Serving Slack's REST routes (core/connectors/slack/routes.ts), under
// /api/connectors/slack: the live card of a linked thread, and sharing a
// decision to a channel. A token never leaves this process: what goes out is
// what Slack said about a thread.
//
// Sharing posts to Slack as the person who signed in, so it is the one route
// that asks the person check itself (personOnly, tier B: only one of their
// seats, never an agent or a script) on top of the connectors router's, and
// there is no tool for it (tools.ts). A card is a read, like the others.

import { Router, type Request } from 'express';
import { z } from 'zod';
import { parseThreadKey } from '../../../core/connectors/slack/link';
import type { SlackProblem } from '../../../core/connectors/slack/thread';
import { slackRoutes } from '../../../core/connectors/slack/routes';
import { personOnly, type PersonGate } from '../../access';
import { routesOn } from '../../routing';
import { ConnectorError } from '../oauth';
import type { SlackReader } from './reader';
import type { SlackShares } from './share';

const shareBody = z.object({ channel: z.string().trim().min(1).max(300) });

const param = (req: Request, name: string): string => String(req.params[name]);

// Where the board is, as the page was opened: http://127.0.0.1:4545. Read through URL, so nothing but a host and port gets into a message.
function boardOrigin(req: Request): string {
  try {
    return new URL(`${req.protocol}://${req.get('host') ?? ''}`).origin;
  } catch {
    throw new ConnectorError("Couldn't tell where the board is open.", 400);
  }
}

// Reasons a card can't show its thread that aren't worth an error on every card: they come back with the answer.
const QUIET = new Set(['not_connected', 'needs_sign_in', 'not_found', 'missing_scope', 'rate_limited', 'unavailable']);

export function slackRouter(reader: SlackReader, shares: SlackShares, person: PersonGate): Router {
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

  // "Share to Slack" on a decision: the question, the options and a link back,
  // posted to a channel as the person.
  on(slackRoutes.shareDecision, personOnly(person, 'B'), async (req, res) => {
    const { channel } = shareBody.parse(req.body);
    res.status(201).json({ shared: await shares.shareDecision(param(req, 'decisionId'), channel, boardOrigin(req)) });
  });

  return router;
}
