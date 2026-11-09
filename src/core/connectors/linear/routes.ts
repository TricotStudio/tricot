// Linear's REST routes, under /api/connectors/linear (browser-safe): a pasted
// personal API key, and the live card of a linked issue. The server serves
// them (server/connectors/linear/routes.ts), the page asks for them
// (web/connectors/linear/api.ts), and the connector registry gathers
// them (registry.ts connectorRoutes).

import { get, post } from '../../route';

export const linearRoutes = {
  key: post('/api/connectors/linear/key'),
  issue: get('/api/connectors/linear/issues/:identifier'),
} as const;
