// Figma as a connector (core half, browser-safe): who it is, what its token
// may do in plain words, the links it reads and its REST routes (routes.ts).
// People paste a personal access token once: there is no sign-in page, so no
// OAuth client. What only the server needs of it is in server.ts, which the
// web build leaves out (see vite.config.ts). Reading frames, serving its
// routes and its tool are in server/connectors/figma/.

import type { ConnectorKind } from '../connector';
import { figmaRoutes } from './routes';
import { FILE_COMMENTS, FILE_CONTENT } from './scopes';
import { server } from './server';
import { figmaSources } from './sources';

export const figma: ConnectorKind = {
  id: 'figma',
  name: 'Figma',
  scopes: {
    [FILE_CONTENT]: { label: 'See the Figma files your token can open, and their frames as pictures', agent: 'Figma frames' },
    [FILE_COMMENTS]: { label: 'Read the comments on those files', agent: 'Figma comments' },
  },
  identity: { scopes: [], email: [] },
  sources: [figmaSources],
  routes: figmaRoutes,
  agent: server.agent,
};
