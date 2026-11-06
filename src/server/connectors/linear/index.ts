// Linear's server half: signing in (connector.ts), reading issues (reader.ts),
// its REST routes (routes.ts) and its MCP tools (tools.ts), put together as the
// connector the registry lists.

import type { Router } from 'express';
import type { ConnectorTool, ServerConnector, ServerConnectorKind } from '../connector';
import { LinearConnector, type LinearOptions } from './connector';
import { LinearReader } from './reader';
import { linearRoutes } from './routes';
import { linearTools } from './tools';

export { BUILT_IN_LINEAR, builtInLinearClientId, LINEAR_ENDPOINTS, type BuiltInLinear, type LinearEndpoints } from './config';
export { LinearConnector, LinearError } from './connector';

// What the app can tell this connector: where Linear's endpoints are (tests and
// scratch servers use fakes), and the app to sign in with in place of the shipped one (null: none).
type LinearSettings = Pick<LinearOptions, 'endpoints' | 'builtIn'>;

class LinearServer extends LinearConnector implements ServerConnector {
  private readonly reader = new LinearReader(this);

  routes(): Router {
    return linearRoutes(this, this.reader);
  }

  tools(): ConnectorTool[] {
    return linearTools(this.reader);
  }
}

export const linearServer: ServerConnectorKind = {
  id: 'linear',
  create: ({ dataDir, pending, fetch, now, options }) => new LinearServer({ dataDir, pending, fetch, now, ...(options as LinearSettings | undefined) }),
};
