import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type Express } from 'express';
import { Store } from '../src/core/store';
import { HOST_KEY_HEADER } from '../src/server/access';
import { AnswerHosts } from '../src/server/answerHosts';
import type { ApiParts } from '../src/server/apiParts';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { Leases } from '../src/server/leases';
import { Updates } from '../src/install/updates';
import { removeScratch } from './platform';
import { letIn, seatFetch, type TestSeat } from './seatHelper';

// What the tests of the REST parts (apiParts.test.ts) share: an app on a scratch folder with every option that adds
// routes, a request as each kind of caller, and what the app's router serves.

export interface Running<S extends Store = Store> {
  app: Express;
  store: S;
  base: string;
  key: string;
  seat: TestSeat;
  stop(): Promise<void>;
}

// An app on a scratch folder and a port of its own, with every option that adds routes (as routes.test.ts has them).
export async function serve<S extends Store = Store>(parts?: ApiParts, make: (dir: string) => S = (dir) => new Store(dir) as S): Promise<Running<S>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-api-parts-'));
  const store = make(dir);
  store.load();
  const hosts = new AnswerHosts();
  const terminal = hosts.register();
  if ('refused' in terminal) throw new Error('A terminal could not register.');
  const app = createApp(store, {
    host: '127.0.0.1',
    mcpUrl: 'unused',
    connectors: new Connectors({ dataDir: dir, google: { builtIn: null } }),
    leases: new Leases(),
    liveSteps: { target: { home: dir, project: dir, env: {} }, source: dir, url: 'http://127.0.0.1:1' },
    updates: new Updates({ check: false, current: '0.1.0', place: { port: 1, host: '127.0.0.1', dataDir: dir } }),
    approvals: { hosts },
    ...(parts && { parts }),
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    app,
    store,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    key: terminal.key,
    seat: letIn(app),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.flush();
      removeScratch(dir);
    },
  };
}

// A request as a plain program, as a Tricot terminal (a person, tier A) or as one of the person's seats (tier B).
export type Caller = 'program' | 'terminal' | 'seat';
export async function ask(on: Running, caller: Caller, method: string, route: string, body: unknown = { actor: 'Sam' }): Promise<{ status: number; body: { error?: string; code?: string } & Record<string, unknown> }> {
  const sending = method === 'GET' ? undefined : body;
  const response =
    caller === 'seat'
      ? await seatFetch(on.seat, on.base, method, route, sending)
      : await fetch(`${on.base}${route}`, {
          method,
          headers: { ...(sending !== undefined && { 'Content-Type': 'application/json' }), ...(caller === 'terminal' && { [HOST_KEY_HEADER]: on.key }) },
          ...(sending !== undefined && { body: JSON.stringify(sending) }),
        });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as never };
}
