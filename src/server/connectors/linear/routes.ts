// Linear's REST routes, under /api/connectors/linear: a pasted personal API
// key, and the live card of an issue. A token or key never leaves this
// process: what goes out is what Linear said about an issue. Signing in with
// Tricot Studio's app uses the shared connector routes (server/connectors/routes.ts).

import { Router } from 'express';
import { z } from 'zod';
import { normalIdentifier, type LinearProblem } from '../../../core/connectors/linear/issue';
import { routes } from '../../../core/routes';
import { routesOn } from '../../routing';
import { LinearError, type LinearConnector } from './connector';
import type { LinearReader } from './reader';

const keyBody = z.object({ key: z.string().max(300) });

export function linearRoutes(linear: LinearConnector, reader: LinearReader): Router {
  const router = Router();
  const on = routesOn(router, '/api/connectors/linear');
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // A personal API key: checked once with Linear, kept, and the connector's new status.
  on(routes.linearKey, async (req, res) => {
    const { key } = keyBody.parse(req.body);
    res.json({ connector: await linear.useKey(key) });
  });

  // An issue's live card. What can't be shown comes back as a `problem` in
  // words, not as a failure: the card says it (connect Linear, sign in again…).
  on(routes.linearIssue, async (req, res) => {
    const identifier = normalIdentifier(String(req.params.identifier));
    if (!identifier) {
      res.status(404).json({ error: 'Not a Linear issue.' });
      return;
    }
    try {
      res.json({ card: await reader.card(identifier, req.query.fresh === '1') });
    } catch (error) {
      if (!(error instanceof LinearError)) throw error;
      const problem: LinearProblem = { code: error.code ?? 'error', message: error.message };
      res.json({ problem });
    }
  });

  return router;
}
