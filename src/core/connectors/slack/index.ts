// Slack as a connector (core half, browser-safe): who it is, what it may do in
// plain words, and the links it recognises. A person signs in as themselves
// (OAuth with PKCE, which needs no client secret), Tricot reads the threads
// they link, and they can share a decision to a channel. What only the server
// needs is in server.ts, which the web build leaves out (see vite.config.ts);
// signing in, reading, sharing, its routes and its tool are in
// server/connectors/slack/.

import type { ConnectorKind } from '../connector';
import { CHANNELS_HISTORY, CHAT_WRITE, GROUPS_HISTORY, USERS_READ } from './scopes';
import { server } from './server';
import { slackSources } from './sources';

export const slack: ConnectorKind = {
  id: 'slack',
  name: 'Slack',
  scopes: {
    [CHANNELS_HISTORY]: { label: 'Read the messages in the public channels whose threads you link', agent: 'threads in public channels' },
    [GROUPS_HISTORY]: { label: 'Read the messages in the private channels whose threads you link', agent: 'threads in private channels' },
    [USERS_READ]: { label: "See people's names, to say who wrote a message", agent: 'who wrote them' },
    [CHAT_WRITE]: { label: 'Post a message as you, only when you share a decision', agent: 'posting by people only' },
  },
  identity: { scopes: [], email: [] },
  sources: [slackSources],
  agent: server.agent,
};
