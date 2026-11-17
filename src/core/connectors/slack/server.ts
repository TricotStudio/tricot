// What only the server uses of Slack in core: what agents are told about it.
// The web build leaves this file out (see vite.config.ts).

import type { ConnectorServerHalf } from '../connector';
import { slackSummary } from './agent';

export const server: ConnectorServerHalf = {
  agent: { summary: slackSummary },
};
