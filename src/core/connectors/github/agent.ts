// What agents are told about a connected GitHub. Server-only (see server.ts).

import type { ConnectorStatus } from '../connector';

export function githubSummary(_status: ConnectorStatus): { shows: string; tools: string } {
  return {
    shows: 'the live title, state and checks of GitHub pull requests and issues',
    tools: 'GitHub pull requests, issues and files of the repos Tricot is installed on: read_github',
  };
}
