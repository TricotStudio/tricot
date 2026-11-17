// What agents are told about a connected Linear. Server-only (see server.ts).

import { saying, type Sayer } from '../../words';
import type { ConnectorStatus } from '../connector';

// A tool group may say more of the tools (`connector.linear.tools`, words.ts) where it has a way to plan work from issues.
export function linearSummary(_status: ConnectorStatus, words?: Sayer): { shows: string; tools: string } {
  return {
    shows: 'the live title, status and assignee of Linear issues',
    tools: saying(words, 'connector.linear.tools', [
      ['issues', 'Linear issues by link, identifier or search, read-only'],
      ['names', ': read_linear_issue, search_linear_issues'],
    ]),
  };
}
