// GET /api/update: the version running, a newer release when there is one,
// and how this Tricot updates (updates.ts). POST /api/update { version }
// updates it to that version, the one the person was shown, which must be the
// latest release; it answers 202 and the handover begins (handoff.ts).
//
// Behind the access rules every route has (access.ts: this server's own
// pages, and the token beyond this machine). Updating is for a person in
// Tricot's page, which sends its Origin, or for `tricot update` in a
// terminal on the computer Tricot runs on; a program elsewhere can't.
import { Router, type ErrorRequestHandler, type Request } from 'express';
import { z, ZodError } from 'zod';
import { describeIssues } from '../core/schemas';
import { fromThisMachine } from './liveStepsRoutes';
import type { Updates } from './updates';

export const NOT_HERE = 'Tricot is updated from its page, or with `tricot update` on the computer it runs on.';

const body = z.object({ version: z.string().max(64) });

export function createUpdateRouter(updates: Updates, options: { fromThisMachine?: (req: Request) => boolean } = {}): Router {
  const router = Router();
  const local = options.fromThisMachine ?? fromThisMachine;

  router.get('/', (_req, res) => {
    res.json(updates.state());
  });

  router.post('/', async (req, res) => {
    if (!req.headers.origin && !local(req)) {
      res.status(403).json({ error: NOT_HERE });
      return;
    }
    const { version } = body.parse(req.body);
    const result = await updates.handOff(version);
    if (result.ok) res.status(202).json(updates.state());
    else res.status(result.status).json({ error: result.error, ...(result.how && { how: result.how }) });
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) res.status(400).json({ error: describeIssues(error) });
    else if (typeof error?.status === 'number' && error.status < 500) res.status(error.status).json({ error: error.message });
    else {
      console.error(error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Tricot could not be updated.' });
    }
  };
  router.use(errors);
  return router;
}
