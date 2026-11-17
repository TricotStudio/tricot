// What only the server uses of GitHub in core: what agents are told about it.
// The web build leaves this file out (see vite.config.ts).

import type { ConnectorServerHalf } from '../connector';
import { githubSummary } from './agent';

export const server: ConnectorServerHalf = {
  agent: { summary: githubSummary },
};
