// Which run of Tricot answers on this port: GET /api/instance says the
// process id and the instance id this server wrote in its data folder's lock
// (lock.ts). The approval hook (hooks/tricot-approve.mjs) asks it, and
// trusts an answer only when they match the lock and the process listening
// on the port is the lock's. A server that holds no lock for this port (a
// test's, or one still starting) says it has none.
import type { RequestHandler } from 'express';
import { heldLock } from './lock';

export const instanceRoute: RequestHandler = (req, res) => {
  const lock = heldLock(req.socket.localPort);
  if (!lock?.instance) {
    res.status(404).json({ error: 'This Tricot holds no data folder on this port.' });
    return;
  }
  res.json({ app: 'tricot', pid: process.pid, instance: lock.instance });
};
