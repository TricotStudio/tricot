// Figma's REST routes, under /api/connectors/figma (browser-safe): pasting the
// token, what a link card shows of a file, bringing a frame onto the canvas and
// refreshing its picture. The server serves them
// (server/connectors/figma/routes.ts), the page asks for them
// (web/connectors/figma/api.ts), and the connector registry gathers
// them (registry.ts connectorRoutes).

import { get, post } from '../../route';

export const figmaRoutes = {
  token: post('/api/connectors/figma/token'),
  file: get('/api/connectors/figma/files/:fileId'),
  bringIn: post('/api/connectors/figma/frames'),
  refresh: post('/api/connectors/figma/images/:blockId/refresh'),
} as const;
