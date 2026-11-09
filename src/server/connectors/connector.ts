// A connector's server half (see core/connectors/connector.ts for the whole
// contract): signing in to its service and keeping the sign-in in the data
// folder, reading and writing its documents, its REST routes and its MCP
// tools. The app asks the registry (registry.ts) and none of it names a
// service. Internal: connectors are code in this repository (#67).

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Router } from 'express';
import type { ZodRawShape } from 'zod';
import type { ConnectorStatus } from '../../core/connectors';
import type { Store } from '../../core/store';
import type { Actor } from '../../core/types';
import type { PersonGate } from '../access';
import type { Fetch, PendingSignIn, PendingSignIns } from './oauth';

// Where the service sends the person back after signing in: a GET on this
// server, which the Origin check lets through (a top-level navigation from
// another site carries no Origin; the sign-in's own one-time state protects
// it, see server/access.ts).
export const callbackPath = (id: string): string => `/api/connectors/${id}/callback`;
const AROUND_ID = callbackPath('\0').split('\0');

// Whether a request path is some connector's sign-in callback.
export function isCallbackPath(path: string): boolean {
  const [before, after] = AROUND_ID;
  if (!path.startsWith(before) || !path.endsWith(after)) return false;
  const id = path.slice(before.length, path.length - after.length);
  return id.length > 0 && !id.includes('/');
}

// A tool agents get when the connector is there, registered with the MCP
// server like the board's own: its name, its description and arguments as
// agents read them, and what it does. A refusal comes back as an error result.
export interface ConnectorTool {
  readonly name: string;
  readonly config: { title: string; description: string; inputSchema: ZodRawShape; annotations?: { readOnlyHint?: boolean } };
  run(args: Record<string, unknown>, actor: Actor): Promise<CallToolResult>;
}

export interface ServerConnector {
  readonly id: string;
  readonly name: string;
  status(): ConnectorStatus;
  startSignIn(redirectUri: string, extra?: string[]): string; // the service's consent page, asking for extra scopes too
  finishSignIn(pending: PendingSignIn, code: string): Promise<ConnectorStatus>;
  failed(error: unknown): void; // a sign-in that came back without a code
  disconnect(): Promise<{ revoked: boolean }>;
  // A sentence for the page the person lands on once signed in: what changes now.
  connectedNote?(status: ConnectorStatus): string;
  // What a person can allow on top, by name ("docs"): the scopes that asks for.
  readonly permissions?: Readonly<Record<string, string>>;
  // Its REST routes, under /api/connectors/<id>, once the board's store is there:
  // each registered with routesOn (server/routing.ts) from its core half's table
  // (core/connectors/<id>/routes.ts), never a path of its own. Everything but
  // a GET is already a person's (the router they are mounted in asks `person`,
  // tier B); a route that acts as the person in the service says so again with
  // personOnly(person, 'B').
  routes?(store: Store, person: PersonGate): Router;
  // Its MCP tools, once the board's store is there.
  tools?(store: Store): ConnectorTool[];
}

// What the registry gives a connector to build itself from.
export interface ServerContext {
  dataDir: string;
  pending: PendingSignIns;
  fetch?: Fetch; // tests and scratch servers point these at fakes
  now?: () => number;
  options?: unknown; // what the app was told for this connector: its endpoints, say
}

export interface ServerConnectorKind {
  readonly id: string;
  create(context: ServerContext): ServerConnector;
}
