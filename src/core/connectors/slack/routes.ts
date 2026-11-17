// Slack's REST routes, under /api/connectors/slack (browser-safe): the live
// card of a linked thread. The server serves them
// (server/connectors/slack/routes.ts), the page asks for them
// (web/connectors/slack/api.ts), and the connector registry gathers
// them (registry.ts connectorRoutes).

import { get } from '../../route';

export const slackRoutes = {
  thread: get('/api/connectors/slack/threads/:channel/:ts'),
} as const;
