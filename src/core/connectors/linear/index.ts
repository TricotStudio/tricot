// Linear as a connector (core half, browser-safe): who it is, what it may
// read in plain words, and the links it recognises. Signing in (Tricot Studio's
// Linear app, or a personal API key), reading issues, its routes and its tools
// are in server/connectors/linear/. Read-only: nothing is written back to Linear.

import type { ConnectorKind } from '../connector';
import { READ } from './scopes';
import { server } from './server';
import { linearSources } from './sources';

export const linear: ConnectorKind = {
  id: 'linear',
  name: 'Linear',
  scopes: {
    [READ]: { label: 'See the issues, projects and teams your Linear account can see', agent: 'issues' },
  },
  identity: { scopes: [], email: [] },
  sources: [linearSources],
  agent: server.agent,
};
