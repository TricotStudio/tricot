// Which run of Tricot answers on this port: GET /api/instance says the
// process id and the instance id this server wrote in its data folder's lock
// (platform/lock.ts), and, to a request that carries a challenge, proves it
// holds that lock's secret (proof.ts): the approval hook
// (hooks/tricot-approve.mjs) asks first, before it sends anything, and goes
// on only when the proof is right. The pid and instance id are for hooks from
// before T220, which check them against the lock and the process listening.
// A server that holds no lock for this port (a test's, or one still starting)
// says it has none.
import type { RequestHandler } from 'express';
import { heldLock } from '../platform/lock';
import { challengeOf, proofFor, sendProof } from './proof';

export const instanceRoute: RequestHandler = (req, res) => {
  const lock = heldLock(req.socket.localPort);
  if (!lock?.instance) {
    res.status(404).json({ error: 'This Tricot holds no data folder on this port.' });
    return;
  }
  const challenge = challengeOf(req);
  if (challenge) sendProof(res, proofFor(req, 'instance', challenge, []));
  res.json({ app: 'tricot', pid: process.pid, instance: lock.instance });
};
