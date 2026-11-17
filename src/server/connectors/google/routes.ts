// Serving Google's REST routes (core/connectors/google/routes.ts), under
// /api/connectors/google: a file's name for link cards, what the Picker needs,
// and a Google Doc's draft on its link block. The service's token stays in
// this process; what goes out is the doc's text and the draft.

import { Router, type ErrorRequestHandler, type Request } from 'express';
import { z } from 'zod';
import { DocError, type DocChange } from '../../../core/connectors/google/doc';
import type { Actor } from '../../../core/types';
import type { GoogleConnector } from './connector';
import type { DocDrafts } from './docs';
import { googleRoutes } from '../../../core/connectors/google/routes';
import { routesOn } from '../../routing';

const actorName = z.string().trim().min(1).max(60);
const listKind = z.enum(['bullet', 'numbered']).nullable().optional();
const docSchemas = {
  actor: z.object({ actor: actorName }),
  draft: z.object({
    actor: actorName,
    revision: z.string().max(200).optional(),
    changes: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), id: z.string(), text: z.string() }),
          z.object({ kind: z.literal('add'), after: z.string(), text: z.string(), style: z.string().optional(), list: listKind }),
          z.object({ kind: z.literal('delete'), id: z.string() }),
          z.object({ kind: z.literal('restore'), id: z.string() }),
          z.object({ kind: z.literal('format'), id: z.string(), style: z.string().optional(), list: listKind }),
        ]),
      )
      .min(1)
      .max(200),
  }),
  chosen: z.object({ fileIds: z.array(z.string().regex(/^[\w-]{10,200}$/)).min(1).max(50) }),
  resolve: z.object({ actor: actorName, conflict: z.string(), keep: z.enum(['mine', 'theirs']) }),
  pin: z.object({
    actor: actorName,
    paragraph: z.string().max(20),
    revision: z.string().max(200),
    quote: z.string().max(2000),
    prefix: z.string().max(200).optional(),
    suffix: z.string().max(200).optional(),
    body: z.string().max(10000),
    ask: z.boolean().optional(),
  }),
};

function person(name: string): Actor {
  return { kind: 'human', name };
}

const param = (req: Request, name: string): string => String(req.params[name]);

export function googleRouter(google: GoogleConnector, drafts: DocDrafts): Router {
  const router = Router();
  const on = routesOn(router, '/api/connectors/google');

  // A Google file's name and last edit, for link cards. Fails quietly: null
  // when Google isn't connected or won't show it.
  on(googleRoutes.file, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ file: await google.driveFile(param(req, 'fileId')) });
  });

  // What the browser's Picker needs to let a person choose docs: a short-lived
  // access token and the public keys. A POST, so the Origin check covers it.
  on(googleRoutes.picker, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await google.pickerConfig());
  });

  // Docs were chosen in the Picker (it talks to Google, not to this server): names looked up before may be wrong now.
  on(googleRoutes.chosen, (req, res) => {
    docSchemas.chosen.parse(req.body);
    google.chosen();
    res.json({ ok: true });
  });

  // A Google Doc's draft, on the link block pointing to it: the doc (pulled
  // through the server, which holds the token) with the draft, changes to the
  // draft, and saving it to Google. Problems with access come back with a
  // code: not_set_up, not_connected, needs_sign_in, no_docs_permission…
  const doc = Router({ mergeParams: true });
  const onDoc = routesOn(doc, '/api/connectors/google/docs/:blockId');
  const block = (req: Request) => param(req, 'blockId');
  onDoc(googleRoutes.doc, async (req, res) => {
    const name = typeof req.query.actor === 'string' && req.query.actor.trim() ? req.query.actor.trim().slice(0, 60) : 'Someone';
    res.json(await drafts.open(block(req), person(name)));
  });
  onDoc(googleRoutes.docDraft, async (req, res) => {
    const { actor, revision, changes } = docSchemas.draft.parse(req.body);
    res.json(await drafts.edit(block(req), revision, changes as DocChange[], person(actor)));
  });
  onDoc(googleRoutes.docDiscard, (req, res) => {
    const { actor } = docSchemas.actor.parse(req.body);
    drafts.discard(block(req), person(actor));
    res.json({ ok: true });
  });
  onDoc(googleRoutes.docSave, async (req, res) => {
    const { actor } = docSchemas.actor.parse(req.body);
    res.json(await drafts.save(block(req), person(actor)));
  });
  // Words in a paragraph, pinned with a request for agents to edit it, or a comment.
  onDoc(googleRoutes.docPins, async (req, res) => {
    const { actor, ask, ...input } = docSchemas.pin.parse(req.body);
    res.status(201).json(await drafts.pin(block(req), { ...input, ask: Boolean(ask) }, person(actor)));
  });
  onDoc(googleRoutes.docResolve, async (req, res) => {
    const { actor, conflict, keep } = docSchemas.resolve.parse(req.body);
    res.json({ draft: (await drafts.resolve(block(req), conflict, keep, person(actor))) ?? null });
  });
  router.use('/docs/:blockId', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, doc);

  // A doc's own problems say what a person or agent can do about them.
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof DocError) res.status(error.status).json({ error: error.message });
    else next(error);
  };
  router.use(errors);

  return router;
}
