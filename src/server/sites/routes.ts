// Tricot's own route about websites on the board, for its pages: where a
// website block is served from, its own origin on the site server, which
// starts listening the first time a page shows one. It is behind Tricot's
// access rules, as every route is; the site server itself never serves it.

import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { BoardError, type Store } from '../../core/store';
import type { Block } from '../../core/types';
import type { SiteServer } from './siteServer';

// `sites`: none when Tricot listens beyond this machine, where no website is served.
export function createSitesRouter(store: Store, sites: SiteServer | undefined): Router {
  const router = Router();
  const site = (id: string): Extract<Block, { type: 'site' }> => {
    const block = store.blockOf(id);
    if (block.type !== 'site') throw new BoardError(`"${id}" is not a website.`);
    return block;
  };

  router.get('/:blockId', async (req, res) => {
    const block = site(req.params.blockId);
    if (!sites) {
      res.status(409).json({ error: 'Websites are shown live only when Tricot runs on this computer alone; it listens on the network now.' });
      return;
    }
    const origin = await sites.ensure(block.id);
    res.set('Cache-Control', 'no-store').json({ origin });
  });

  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof BoardError) res.status(error.code === 'not_found' ? 404 : 400).json({ error: error.message });
    else if (error instanceof z.ZodError) res.status(400).json({ error: 'That is not what this route takes.' });
    else next(error);
  };
  router.use(errors);
  return router;
}
