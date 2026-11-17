// Serving Figma's REST routes (core/connectors/figma/routes.ts), under
// /api/connectors/figma: pasting the token, what a link card shows, and the
// two things a frame becomes on the board. The token stays in this process;
// what goes out is names, thumbnails and blocks.

import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Actor } from '../../../core/types';
import { ConnectorError } from '../oauth';
import { FIGMA_CODES } from './client';
import type { FigmaConnector } from './connector';
import type { FigmaFrames } from './frames';
import { figmaRoutes } from '../../../core/connectors/figma/routes';
import { routesOn } from '../../routing';

const actorName = z.string().trim().min(1).max(60);
const bodies = {
  token: z.object({ token: z.string().max(400) }),
  bringIn: z.object({ actor: actorName, blockId: z.string().max(100) }),
  refresh: z.object({ actor: actorName }),
};

const person = (name: string): Actor => ({ kind: 'human', name });

// Reasons a card can't show the file that aren't worth an error on every card: they come back with the answer.
const QUIET = [FIGMA_CODES.notConnected, FIGMA_CODES.needsSignIn, FIGMA_CODES.tokenRefused, FIGMA_CODES.noAccess, FIGMA_CODES.noScope, FIGMA_CODES.rateLimited, FIGMA_CODES.noFrame];

export function figmaRouter(figma: FigmaConnector, frames: FigmaFrames): Router {
  const router = Router();
  const on = routesOn(router, '/api/connectors/figma');
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // A pasted token: checked with Figma, kept, and the connector's new status.
  on(figmaRoutes.token, async (req, res) => {
    const { token } = bodies.token.parse(req.body);
    res.json({ connector: await figma.connect(token) });
  });

  // A link card's file or frame: its name and thumbnail, or why not. Never an
  // error, so a board of cards stays quiet while Figma is not connected.
  on(figmaRoutes.file, async (req: Request, res) => {
    try {
      res.json({ file: await frames.card(String(req.params.fileId)) });
    } catch (error) {
      if (error instanceof ConnectorError && QUIET.includes(error.code as never)) {
        res.json({ file: null, problem: { code: error.code, message: error.message } });
      } else {
        throw error;
      }
    }
  });

  // "Bring in this frame": an image block of the frame a link card points to.
  on(figmaRoutes.bringIn, async (req, res) => {
    const { actor, blockId } = bodies.bringIn.parse(req.body);
    res.status(201).json({ block: await frames.bringIn(blockId, person(actor)) });
  });

  // "Refresh" on an image brought in from Figma.
  on(figmaRoutes.refresh, async (req, res) => {
    const { actor } = bodies.refresh.parse(req.body);
    res.json(await frames.refresh(String(req.params.blockId), person(actor)));
  });

  return router;
}
