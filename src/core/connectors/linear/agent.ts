// What agents are told about a connected Linear. Server-only (see server.ts).

import type { ConnectorStatus } from '../connector';

export function linearSummary(_status: ConnectorStatus): { shows: string; tools: string } {
  return {
    shows: 'the live title, status and assignee of Linear issues',
    tools: 'Linear issues by link, identifier or search, read-only (plan tasks from them with plan_tasks): read_linear_issue, search_linear_issues',
  };
}
