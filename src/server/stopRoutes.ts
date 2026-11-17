// POST /api/stop: ask this board to stop. It answers 202, then the board
// closes as it does when no agent command needs it (leases.ts `unused`, which
// the command's shell turns into close(): the boards are saved, the data
// folder's lock is let go, and the process ends).
//
// `tricot stop` asks here first, on every system. A signal is the way
// otherwise, and on Windows it is a hard kill: nothing is saved, and the lock
// stays behind.
//
// Stopping the board is a person's to ask, and on a loopback address any
// account on this computer can reach the port, so this is not open to "a
// program on this computer": it needs one of the person's seats (access.ts
// asPerson, tier B), as updating does. A Tricot terminal registered with the
// board is not enough, as anything on this computer could register one
// (answerHosts.ts). `tricot stop` asks to be let in as a terminal for the
// call (cli/terminalKey.ts), as `tricot update` does; the person allows it in
// a browser they have let in. On the network, another device with the token
// counts as the person, as everywhere.
import { Router } from 'express';
import { personOnly, type PersonGate } from './access';
import type { Leases } from './leases';
import { routes } from '../core/routes';
import { routesOn } from './routing';

export function createStopRouter(leases: Leases, person: PersonGate): Router {
  const router = Router();
  const on = routesOn(router, '/api/stop');
  on(routes.stop, personOnly(person, 'B'), (_req, res) => {
    // The board closes its connections as it stops: the answer goes out first.
    res.once('close', () => leases.requestStop());
    res.status(202).json({ stopping: true });
  });
  return router;
}
