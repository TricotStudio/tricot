// GitHub as a connector (core half, browser-safe): who it is, what it may
// read in plain words, and the links it recognises. Signing in (a code typed
// on github.com, or a personal token), reading pull requests, issues and
// files, its routes and its tool are in server/connectors/github/.

import type { ConnectorKind } from '../connector';
import { CHECKS, CONTENTS, ISSUES, PULL_REQUESTS } from './scopes';
import { server } from './server';
import { githubSources } from './sources';

export const github: ConnectorKind = {
  id: 'github',
  name: 'GitHub',
  scopes: {
    [CONTENTS]: { label: 'See the files in the repositories Tricot is installed on', agent: 'files' },
    [PULL_REQUESTS]: { label: 'See pull requests and what they change', agent: 'pull requests' },
    [ISSUES]: { label: 'See issues', agent: 'issues' },
    [CHECKS]: { label: 'See check results and commit statuses', agent: 'checks' },
  },
  identity: { scopes: [], email: [] },
  sources: [githubSources],
  agent: server.agent,
};
