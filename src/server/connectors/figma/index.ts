// Figma's server half: the pasted token and the saved connection
// (connector.ts), reading frames as the connected account (frames.ts), its REST
// routes (routes.ts) and its MCP tool (tools.ts), put together as the connector
// the registry lists.

import type { Store } from '../../../core/store';
import type { ServerConnectorKind } from '../connector';
import { FigmaConnector, type FigmaOptions } from './connector';
import { FigmaFrames } from './frames';
import { figmaRouter } from './routes';
import { figmaTools } from './tools';

export { FigmaConnector } from './connector';

// What the app can tell this connector: where Figma's API is (tests and scratch servers use a fake).
interface FigmaSettings {
  api?: string;
}

class FigmaServer extends FigmaConnector {
  private readonly frames = new WeakMap<Store, FigmaFrames>();

  constructor(private readonly settings: FigmaOptions) {
    super(settings);
  }

  // The routes and the tool share one set of cards per store, which is what keeps a board of cards to one look at Figma.
  private framesOf(store: Store): FigmaFrames {
    let frames = this.frames.get(store);
    if (!frames) this.frames.set(store, (frames = new FigmaFrames(this, store, this.settings.dataDir, this.settings.now)));
    return frames;
  }

  routes(store: Store) {
    return figmaRouter(this, this.framesOf(store));
  }

  tools(store: Store) {
    return figmaTools(store, this.framesOf(store));
  }
}

export const figmaServer: ServerConnectorKind = {
  id: 'figma',
  create: ({ dataDir, fetch, now, options }) => new FigmaServer({ dataDir, fetch, now, api: (options as FigmaSettings | undefined)?.api }),
};
