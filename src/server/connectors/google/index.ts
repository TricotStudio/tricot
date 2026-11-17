// Google's server half: signing in (connector.ts), reading and editing Docs
// and the drafts on link blocks (docs.ts), its REST routes (routes.ts) and
// its MCP tools (tools.ts), put together as the connector the registry lists.

import type { Store } from '../../../core/store';
import type { ServerConnectorKind } from '../connector';
import type { BuiltInGoogle } from './builtIn';
import { GoogleConnector, type GoogleEndpoints, type GoogleOptions } from './connector';
import { DocDrafts, GoogleDocs } from './docs';
import { googleRouter } from './routes';
import { googleTools } from './tools';

export { CLIENT_FILE, GOOGLE_ENDPOINTS, GOOGLE_PERMISSIONS, GOOGLE_SCOPES, GoogleConnector, findGoogleClient, readGoogleClient, resolveGoogleClient } from './connector';
export type { GoogleEndpoints } from './connector';
export { BUILT_IN_GOOGLE, builtInGoogleClient, type BuiltInGoogle } from './builtIn';

// What the app can tell this connector: where Google's endpoints are (tests and
// scratch servers use fakes), and the built-in client to use in place of the
// shipped one (null: none).
interface GoogleSettings {
  endpoints?: Partial<GoogleEndpoints>;
  builtIn?: BuiltInGoogle | null;
}

class GoogleServer extends GoogleConnector {
  private readonly docs: GoogleDocs;
  private readonly drafts = new WeakMap<Store, DocDrafts>();

  constructor(options: GoogleOptions) {
    super(options);
    this.docs = new GoogleDocs(this, options.dataDir, options.now);
  }

  // The routes and the tools share one set of drafts per store, which is what
  // keeps a draft from being edited while it is being saved.
  private draftsOf(store: Store): DocDrafts {
    let drafts = this.drafts.get(store);
    if (!drafts) this.drafts.set(store, (drafts = new DocDrafts(store, this.docs)));
    return drafts;
  }

  routes(store: Store) {
    return googleRouter(this, this.draftsOf(store));
  }

  tools(store: Store) {
    return googleTools(store, this.draftsOf(store));
  }
}

export const googleServer: ServerConnectorKind = {
  id: 'google',
  create: ({ dataDir, pending, fetch, now, options }) => {
    const settings = options as GoogleSettings | undefined;
    return new GoogleServer({ dataDir, pending, fetch, now, endpoints: settings?.endpoints, builtIn: settings?.builtIn });
  },
};
