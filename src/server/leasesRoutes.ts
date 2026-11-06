// The leases the agent commands hold with the board (leases.ts):
//   POST   /api/leases        take one → { id, beatMs }
//   POST   /api/leases/:id    still there
//   DELETE /api/leases/:id    quitting → { others }: whether another command still needs the board
// A command is a program on this computer, not a page: one that comes from
// another device, or a browser's request (which says where it comes from), is turned away.
import { Router } from 'express';
import { fromThisMachine } from './access';
import type { Leases } from './leases';
import { routes } from '../core/routes';
import { routesOn } from './routing';

export const LEASE_ENDING = 'This Tricot is stopping, as no agent command needs it.';
const NOT_A_LEASE = 'No such lease: it was let go, or this Tricot started again since.';
const NOT_A_PAGE_CALL = "Only a command on this computer takes a lease: a page, or another device, doesn't.";

export function createLeasesRouter(leases: Leases): Router {
  const router = Router();
  const on = routesOn(router, '/api/leases');
  router.use((req, res, next) => {
    if (!fromThisMachine(req) || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      res.status(403).json({ error: NOT_A_PAGE_CALL });
      return;
    }
    next();
  });

  on(routes.takeLease, (_req, res) => {
    const id = leases.acquire();
    if (id) res.status(201).json({ id, beatMs: leases.beatMs });
    else res.status(503).json({ error: LEASE_ENDING });
  });

  on(routes.beatLease, (req, res) => {
    if (leases.beat(req.params.id)) res.json({ held: true });
    else res.status(404).json({ error: NOT_A_LEASE });
  });

  on(routes.releaseLease, (req, res) => {
    res.json(leases.release(req.params.id));
  });

  return router;
}
