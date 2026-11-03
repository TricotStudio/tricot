// The connectors on this machine, shared by every board, from the registry
// (./registry.ts). Each one signs in with OAuth through the same steps (start,
// the service's consent page, the callback, disconnect), so GitHub and Figma
// can follow Google here.

import type { Router } from 'express';
import { connectorsLine, type ConnectorStatus } from '../../core/connectors';
import type { Store } from '../../core/store';
import type { ConnectorTool, ServerConnector } from './connector';
import { ConnectorError, PendingSignIns, type Fetch } from './oauth';
import { serverConnectors } from './registry';

export interface ConnectorsOptions {
  dataDir: string;
  fetch?: Fetch; // tests and scratch servers point these at fakes
  now?: () => number;
  // Then what each connector is told by its id: google: { endpoints }
  [connector: string]: unknown;
}

export class Connectors {
  readonly pending: PendingSignIns;
  private readonly all: ServerConnector[];

  constructor(options: ConnectorsOptions) {
    this.pending = new PendingSignIns(options.now);
    this.all = serverConnectors.map((kind) =>
      kind.create({ dataDir: options.dataDir, pending: this.pending, fetch: options.fetch, now: options.now, options: options[kind.id] }),
    );
  }

  list(): ConnectorStatus[] {
    return this.all.map((c) => c.status());
  }

  get(id: string): ServerConnector {
    const connector = this.all.find((c) => c.id === id);
    if (!connector) throw new ConnectorError(`No connector called "${id}".`, 404);
    return connector;
  }

  // `permissions` names what to allow on top of what the connector has, e.g.
  // "docs" for Google Docs. The service asks again for all of it at once.
  start(id: string, redirectUri: string, permissions: string[] = []): string {
    const connector = this.get(id);
    const known = connector.permissions ?? {};
    const extra = permissions.map((name) => {
      if (!Object.hasOwn(known, name)) throw new ConnectorError(`${connector.name} has no permission called "${name}".`, 400);
      return known[name];
    });
    return connector.startSignIn(redirectUri, extra);
  }

  // The service sent the person back: check the state (once, within ten
  // minutes, for this connector), then exchange the code.
  async finish(id: string, query: { state?: unknown; code?: unknown; error?: unknown }): Promise<ConnectorStatus> {
    const connector = this.get(id);
    const pending = this.pending.take(typeof query.state === 'string' ? query.state : '', connector.id);
    if (typeof query.error === 'string' || typeof query.code !== 'string' || !query.code) {
      const error = new ConnectorError(
        query.error === 'access_denied'
          ? "You didn't allow access, so nothing was saved."
          : `${connector.name} didn't sign you in${typeof query.error === 'string' ? ` (${query.error.slice(0, 80)})` : ''}.`,
      );
      connector.failed(error);
      throw error;
    }
    return connector.finishSignIn(pending, query.code);
  }

  disconnect(id: string): Promise<{ revoked: boolean }> {
    return this.get(id).disconnect();
  }

  // For agents: which connectors are connected, as whom. Never a token.
  line(): string {
    return connectorsLine(this.list());
  }

  // What the connectors add once the board's store is there: their REST
  // routes (under /api/connectors/<id>) and their MCP tools.
  routes(store: Store): { id: string; router: Router }[] {
    return this.all.flatMap((c) => (c.routes ? [{ id: c.id, router: c.routes(store) }] : []));
  }

  tools(store: Store): ConnectorTool[] {
    return this.all.flatMap((c) => c.tools?.(store) ?? []);
  }
}

export { ConnectorError } from './oauth';
