// What agents are told about a connected Slack. Server-only (see server.ts).

import type { ConnectorStatus } from '../connector';

export function slackSummary(_status: ConnectorStatus): { shows: string; tools: string } {
  return {
    shows: "the author, words and reply count of the Slack threads people link",
    tools: "Slack threads people link (read-only; agents can't post to Slack): read_slack",
  };
}
