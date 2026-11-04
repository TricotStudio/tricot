// GET /api/update: the version running, a newer release when there is one,
// and how this Tricot updates (updates.ts). POST /api/update { version }
// updates it to that version, the one the person was shown, which must be the
// latest release; it answers 202 and the handover begins (handoff.ts). POST
// /api/update/check asks GitHub, then npm, now, as the daily check does, and
// answers the state with what it found (Checked, core/update.ts): the menu's
// "Check for updates".
//
// Behind the access rules every route has (access.ts: this server's own
// pages, and the token beyond this machine). Updating is for a person, from
// one of their seats (access.ts asPerson, tier B): a browser they let in, or
// a terminal (`tricot update` asks to be let in for the call). Checking now
// is a person's too (tier A), from Tricot's page or a Tricot terminal; a
// plain program can't.
import { Router, type ErrorRequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { describeIssues } from '../core/schemas';
import { asPerson, personOnly, type PersonGate } from './access';
import type { Updates } from './updates';

const body = z.object({ version: z.string().max(64) });

// `person`: who is a person (access.ts); the app's, with its terminals, unless given.
export function createUpdateRouter(updates: Updates, options: { person?: PersonGate } = {}): Router {
  const router = Router();
  const person: PersonGate = options.person ?? ((req, tier) => asPerson(req, tier));
  const mayUpdate = personOnly(person, 'B');
  const mayCheck = personOnly(person, 'A');

  router.get('/', (_req, res) => {
    res.json(updates.state());
  });

  router.post('/', mayUpdate, async (req, res) => {
    const { version } = body.parse(req.body);
    const result = await updates.handOff(version);
    if (result.ok) res.status(202).json(updates.state());
    else res.status(result.status).json({ error: result.error, ...(result.how && { how: result.how }) });
  });

  router.post('/check', mayCheck, async (_req, res) => {
    const result = await updates.checkNow();
    if (result.ok) res.json(result.state);
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
