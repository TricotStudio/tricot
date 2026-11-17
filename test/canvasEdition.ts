import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { Store } from '../src/core/store';
import type { StorePart } from '../src/core/store/storePart';
import { createApp } from '../src/server/app';
import { canvasEdition } from '../src/server/canvasEdition';
import { removeScratch } from './platform';

// A server of Tricot Canvas as the entry builds it (src/server/canvasEdition.ts): a plain Store, which registers nothing of
// a part's, and an app with no part and no group of tools, over a data folder of its own, on a port of its own.
export interface CanvasServer<S extends Store = Store> {
  dir: string;
  store: S;
  app: Express;
  base: string;
  stop(): Promise<void>;
}

// Given a data folder, it is the caller's to remove; otherwise stop() removes the one made here. `make` builds the Store from the
// edition's parts: a plain Store, or a subclass of it for a test of what a Store with more methods does over them.
export async function canvasServer<S extends Store = Store>(
  options: Partial<Parameters<typeof createApp>[1]> = {},
  folder?: string,
  make: (dir: string, parts: readonly StorePart<never>[] | undefined) => S = (dir, parts) => new Store(dir, { parts }) as S,
): Promise<CanvasServer<S>> {
  const dir = folder ?? mkdtempSync(path.join(os.tmpdir(), 'tricot-canvas-'));
  const edition = canvasEdition();
  const store = make(dir, edition.storeParts);
  store.load();
  const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', version: '9.8.7', parts: edition.parts, toolGroups: edition.toolGroups, ...options });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    dir,
    store,
    app,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.flush();
      if (!folder) removeScratch(dir);
    },
  };
}
