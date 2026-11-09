// Slack's server half: signing in as the person with PKCE (connector.ts, its
// Tricot Studio app in config.ts), reading threads (reader.ts), sharing a
// decision to a channel (share.ts), its REST routes (routes.ts) and its MCP
// tool (tools.ts), put together as the connector the registry lists.

import type { Router } from 'express';
import type { ConnectorStatus } from '../../../core/connectors';
import type { Store } from '../../../core/store';
import type { PersonGate } from '../../access';
import type { ConnectorTool, ServerConnector, ServerConnectorKind } from '../connector';
import type { PendingSignIn } from '../oauth';
import { SlackConnector, type SlackOptions } from './connector';
import { SlackReader } from './reader';
import { slackRouter } from './routes';
import { SlackShares } from './share';
import { slackTools } from './tools';

export { BUILT_IN_SLACK, builtInSlackClient, CLIENT_FILE, findSlackClient, resolveSlackClient, SLACK_ENDPOINTS, type BuiltInSlack } from './config';
export { SlackConnector, slackRedirect } from './connector';

// What the app can tell this connector: where Slack's endpoints are (tests and
// scratch servers use fakes), and the built-in app to use in place of the
// shipped one (null: none).
type SlackSettings = Pick<SlackOptions, 'endpoints' | 'builtIn'>;

class SlackServer extends SlackConnector implements ServerConnector {
  private readonly reader = new SlackReader(this);

  // What was read for one sign-in isn't shown for the next, or after signing out.
  override async finishSignIn(pending: PendingSignIn, code: string): Promise<ConnectorStatus> {
    this.reader.forget();
    return super.finishSignIn(pending, code);
  }

  override async disconnect(): Promise<{ revoked: boolean }> {
    this.reader.forget();
    return super.disconnect();
  }

  routes(store: Store, person: PersonGate): Router {
    return slackRouter(this.reader, new SlackShares(this, store), person);
  }

  tools(): ConnectorTool[] {
    return slackTools(this.reader);
  }
}

export const slackServer: ServerConnectorKind = {
  id: 'slack',
  create: ({ dataDir, pending, fetch, now, options }) => new SlackServer({ dataDir, pending, fetch, now, ...(options as SlackSettings | undefined) }),
};
