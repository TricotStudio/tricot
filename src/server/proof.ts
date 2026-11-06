// How the approval hook (hooks/tricot-approve.mjs) knows the answers it gets
// come from the Tricot that started with its data folder, and not from
// another program that listens on Tricot's port while Tricot restarts.
//
// Each start of Tricot writes a random secret in its data folder's lock
// (platform/lock.ts): private to the person's account. The hook sends a fresh
// random challenge with each thing it asks (the header below), and the board
// answers with a proof (the header after it): an HMAC-SHA256, keyed by the
// secret, of the challenge and what the answer is about. A program that has
// no secret can't make one, and a proof taken from an earlier exchange is
// for another challenge. The hook has the same function (it can't import
// this one), and test/approvals.test.ts runs the two against each other.
//
//   purpose   what is proved, so a proof for one thing is none for another
//   instance  GET /api/instance: "a Tricot holding this folder answers here"
//             (asked first, before the hook sends the request, so a program
//             that isn't Tricot never reads what the agent wants to run)
//   ask       POST /api/agents/:name/approvals: the request is on the board
//             as `id`, for the agent `name` as Tricot read it from the path,
//             and what Tricot read was exactly the body the hook sent (its
//             SHA-256): a program in between can't change what the person is
//             shown, or whose card it is on, and pass the answer on
//   wait      POST /api/approvals/:id/wait: `id` is still waiting, or was
//             answered so (the state, the decision, whether it is for the
//             session, the message: all the hook acts on)
//
// A server that holds no lock for its port, or is given no challenge, sends
// no proof, and the hook then lets the terminal ask. The secret is read here
// to make proofs, and never sent, logged or put in an error.
import { createHash, createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { heldSecret } from '../platform/lock';
import { rawBodyOf } from './access';

export const CHALLENGE_HEADER = 'x-tricot-challenge';
export const PROOF_HEADER = 'x-tricot-proof';

const VERSION = 'tricot-approval/1';
const CHALLENGE = /^[A-Za-z0-9_-]{22,128}$/;

type Part = string | number | boolean;

// The challenge this request carries, if it is one the hook would make.
export function challengeOf(req: Request): string | undefined {
  const given = req.header(CHALLENGE_HEADER);
  return given !== undefined && CHALLENGE.test(given) ? given : undefined;
}

// The proof of `purpose` for `challenge` and `parts`, with the secret of the
// lock this server holds for its port; none when it holds none.
export function proofFor(req: Request, purpose: 'instance' | 'ask' | 'wait', challenge: string, parts: Part[]): string | undefined {
  const secret = heldSecret(req.socket.localPort);
  if (!secret) return undefined;
  return createHmac('sha256', secret).update(JSON.stringify([VERSION, purpose, challenge, ...parts])).digest('base64url');
}

// What a wait's answer is, for its proof: all the hook acts on.
export function answerParts(state: string, answer?: { behavior?: unknown; session?: unknown; message?: unknown }): Part[] {
  if (state !== 'answered' || !answer) return [state];
  return [state, String(answer.behavior), answer.session === true, typeof answer.message === 'string' ? answer.message : ''];
}

export const bodyDigest = (req: Request): string => createHash('sha256').update(rawBodyOf(req)).digest('hex');

// Puts the proof on the response, when there is one to give.
export function sendProof(res: Response, proof: string | undefined): void {
  if (proof) res.setHeader(PROOF_HEADER, proof);
}
