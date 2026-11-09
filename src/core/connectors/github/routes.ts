// GitHub's REST routes, under /api/connectors/github (browser-safe): the
// sign-in by code and by personal token, which repositories it can see, the
// live card of a pull request or issue, and the two things a card can add to
// the canvas. The server serves them (server/connectors/github/routes.ts), the
// page asks for them (web/connectors/github/api.ts), and the connector
// registry gathers them (registry.ts connectorRoutes).

import { get, post } from '../../route';

export const githubRoutes = {
  device: get('/api/connectors/github/device'),
  startDevice: post('/api/connectors/github/device/start'),
  pollDevice: post('/api/connectors/github/device/poll'),
  cancelDevice: post('/api/connectors/github/device/cancel'),
  token: post('/api/connectors/github/token'),
  repos: get('/api/connectors/github/repos'),
  card: get('/api/connectors/github/cards/:owner/:repo/:kind/:number'),
  showChanges: post('/api/connectors/github/blocks/:blockId/diff'),
  bringInFile: post('/api/connectors/github/blocks/:blockId/file'),
} as const;
