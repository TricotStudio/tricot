// Google's REST routes, under /api/connectors/google (browser-safe): a file's
// name for link cards, what the Picker needs and the docs chosen in it, and a
// Google Doc's draft on the link block pointing to it. The server serves them
// (server/connectors/google/routes.ts), the page asks for them
// (web/connectors/google/api.ts), and the connector registry gathers
// them (registry.ts connectorRoutes).

import { get, post } from '../../route';

export const googleRoutes = {
  file: get('/api/connectors/google/files/:fileId'),
  picker: post('/api/connectors/google/picker'),
  chosen: post('/api/connectors/google/chosen'),
  doc: get('/api/connectors/google/docs/:blockId'),
  docDraft: post('/api/connectors/google/docs/:blockId/draft'),
  docDiscard: post('/api/connectors/google/docs/:blockId/discard'),
  docSave: post('/api/connectors/google/docs/:blockId/save'),
  docPins: post('/api/connectors/google/docs/:blockId/pins'),
  docResolve: post('/api/connectors/google/docs/:blockId/resolve'),
} as const;
