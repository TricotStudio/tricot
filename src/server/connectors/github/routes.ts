// GitHub's REST routes, under /api/connectors/github: the sign-in by code and
// by personal token, which repositories it can see, the live card of a pull
// request or issue, and the two things a card can add to the canvas. A token
// never leaves this process: what goes out is what GitHub said about a card.

import { Router, type Request } from 'express';
import { z } from 'zod';
import type { GithubProblem } from '../../../core/connectors/github/card';
import { cardTarget } from '../../../core/connectors/github/link';
import type { Actor } from '../../../core/types';
import type { GithubBlocks } from './blocks';
import { GithubError, type GitHubConnector } from './connector';
import type { GithubReader } from './reader';
import { routes } from '../../../core/routes';
import { routesOn } from '../../routing';

const actorBody = z.object({ actor: z.string().trim().min(1).max(60) });
const tokenBody = z.object({ token: z.string().max(300) });

const person = (name: string): Actor => ({ kind: 'human', name });
const param = (req: Request, name: string): string => String(req.params[name]);

export function githubRoutes(github: GitHubConnector, reader: GithubReader, blocks: GithubBlocks): Router {
  const router = Router();
  const on = routesOn(router, '/api/connectors/github');
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Signing in with a code: GitHub's code for the person to type, then checks
  // (the page asks every few seconds; the server decides when GitHub is asked).
  on(routes.githubDevice, (_req, res) => {
    res.json({ device: github.deviceView() });
  });
  on(routes.githubStartDevice, async (_req, res) => {
    res.json({ device: await github.startDevice() });
  });
  on(routes.githubPollDevice, async (_req, res) => {
    res.json(await github.pollDevice());
  });
  on(routes.githubCancelDevice, (_req, res) => {
    github.cancelDevice();
    res.json({ ok: true });
  });

  // A personal token, checked once with GET /user.
  on(routes.githubToken, async (req, res) => {
    const { token } = tokenBody.parse(req.body);
    res.json({ connector: await github.useToken(token) });
  });

  on(routes.githubRepos, async (req, res) => {
    res.json(await github.repos(req.query.fresh === '1'));
  });

  // A card's live details. What can't be shown comes back as a `problem` in
  // words, not as a failure: the card says it (install Tricot on this repo, sign in again…).
  on(routes.githubCard, async (req, res) => {
    const target = cardTarget([param(req, 'owner'), param(req, 'repo'), param(req, 'kind'), param(req, 'number')].join('/'));
    if (!target) {
      res.status(404).json({ error: 'Not a pull request or issue.' });
      return;
    }
    try {
      res.json({ card: await reader.card(target, req.query.fresh === '1') });
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      const problem: GithubProblem = { code: error.code ?? 'error', message: error.message, ...(error.installUrl ? { installUrl: error.installUrl } : {}) };
      res.json({ problem });
    }
  });

  // On a link block's card: the pull request's diff, or the file, as a block beside it.
  on(routes.githubShowChanges, async (req, res) => {
    const { actor } = actorBody.parse(req.body);
    res.status(201).json({ block: await blocks.showChanges(param(req, 'blockId'), person(actor)) });
  });
  on(routes.githubBringInFile, async (req, res) => {
    const { actor } = actorBody.parse(req.body);
    res.status(201).json({ block: await blocks.bringInFile(param(req, 'blockId'), person(actor)) });
  });

  return router;
}
