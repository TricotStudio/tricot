// GitHub's server half: signing in (connector.ts), reading pull requests,
// issues and files (reader.ts), what a card adds to the canvas (blocks.ts),
// its REST routes (routes.ts) and its MCP tool (tools.ts), put together as the
// connector the registry lists.

import type { Router } from 'express';
import type { Store } from '../../../core/store';
import { ConnectorError } from '../oauth';
import type { ConnectorTool, ServerConnector, ServerConnectorKind } from '../connector';
import { GithubBlocks } from './blocks';
import { GitHubConnector, type GithubOptions } from './connector';
import { githubRouter } from './routes';
import { GithubReader } from './reader';
import { githubTools } from './tools';

export { GITHUB_APP_SLUG, GITHUB_CLIENT_ID, installUrl } from './config';
export { GitHubConnector, GithubError } from './connector';

const NO_REDIRECT = 'GitHub signs in with a code you type on github.com, not a redirect. Use Connect GitHub on the Connectors page.';

// The settings a test or scratch server may give: where GitHub's endpoints are.
type GithubSettings = Pick<GithubOptions, 'endpoints' | 'clientId' | 'appSlug'>;

class GithubServer extends GitHubConnector implements ServerConnector {
  private readonly reader = new GithubReader(this);

  startSignIn(): string {
    throw new ConnectorError(NO_REDIRECT, 400);
  }

  async finishSignIn(): Promise<never> {
    throw new ConnectorError(NO_REDIRECT, 400);
  }

  failed(): void {}

  routes(store: Store): Router {
    return githubRouter(this, this.reader, new GithubBlocks(store, this.reader));
  }

  tools(): ConnectorTool[] {
    return githubTools(this.reader);
  }
}

export const githubServer: ServerConnectorKind = {
  id: 'github',
  create: ({ dataDir, fetch, now, options }) => new GithubServer({ dataDir, fetch, now, ...(options as GithubSettings | undefined) }),
};
