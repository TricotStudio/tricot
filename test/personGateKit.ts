import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Express, Router } from 'express';
import type { ApprovalRequest } from '../src/core/approvals';
import { SEAT_NEEDED } from '../src/core/seats';
import { Store } from '../src/core/store';
import { HOST_KEY_HEADER, HOST_LET_GO, NEEDS_SEAT, NOT_A_PERSON } from '../src/server/access';
import { AnswerHosts } from '../src/server/answerHosts';
import { createApp } from '../src/server/app';
import { storeOf, type Edition } from '../src/server/start';
import { Connectors } from '../src/server/connectors';
import { letIn, type TestSeat } from './seatHelper';

// What the tests of the person gate (personGate.test.ts, and its counterpart
// for a part's routes) share: an app with every option that adds routes, a call as
// each kind of caller (a plain program, Tricot's page, a registered terminal, one of
// the person's seats), and the check of a route at each tier.

export const sam = { kind: 'human' as const, name: 'Sam' };
export const claude = { kind: 'agent' as const, name: 'Claude' };
export const noNetwork = (async () => {
  throw new TypeError('no network in tests');
}) as unknown as typeof fetch;

// The routes a router serves, with their methods, through the routers it mounts.
export function routesOf(router: Router): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const walk = (stack: unknown[]) => {
    for (const layer of stack as { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } }[]) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) found.push({ method: method.toUpperCase(), path: layer.route.path });
      else if (Array.isArray(layer.handle?.stack)) walk(layer.handle.stack);
    }
  };
  walk((router as unknown as { stack: unknown[] }).stack);
  return found;
}

export const request = (more: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  harness: 'claude',
  tool: 'Bash',
  input: { command: 'echo SECRET-COMMAND-42' },
  session: 's1',
  ...more,
});

export interface Gate<S extends Store = Store> {
  dir: string;
  store: S;
  server: Server;
  base: string;
  hosts: AnswerHosts;
  key: string;
  seat: TestSeat;
  app: Express;
  ids: Record<string, string>; // what a test seeds: the ids a route's parameters are filled from
  plain(): Record<string, string>;
  page(method: string): Record<string, string>;
  terminal(): Record<string, string>;
  call(method: string, route: string, headers: Record<string, string> | 'seat', body?: unknown): Promise<{ status: number; error?: string; code?: string }>;
  filled(route: string): string;
  tierA(method: string, route: string, body?: unknown): Promise<void>;
  terminalOnly(method: string, route: string, body?: unknown): Promise<void>;
  tierB(method: string, route: string, body?: unknown): Promise<void>;
  stop(): Promise<void>;
}

// An app on a scratch folder (under `scratch`, with the repository's hooks as the steps' source) and a port of its own.
export async function startGate<S extends Store = Store>(scratch: string, repo: string, edition: Edition = {}): Promise<Gate<S>> {
  const dir = mkdtempSync(path.join(scratch, 'data-'));
  const store = storeOf(edition, dir) as S;
  store.load();
  const hosts = new AnswerHosts();
  const home = mkdtempSync(path.join(scratch, 'home-'));
  mkdirSync(path.join(home, '.claude'));
  const app = createApp(store, {
    host: '127.0.0.1',
    mcpUrl: 'unused',
    parts: edition.parts,
    toolGroups: edition.toolGroups,
    approvals: { hosts, waitMs: 200 },
    connectors: new Connectors({ dataDir: dir, fetch: noNetwork }),
    liveSteps: { target: { home, env: { PATH: '' } }, source: path.join(repo, 'hooks'), url: 'http://127.0.0.1:4545' },
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registered = hosts.register();
  assert.ok('key' in registered);
  const key = registered.key;
  const seat = letIn(app);
  const ids: Record<string, string> = {};

  // As each one asks: a plain program, Tricot's page (a POST carries its
  // Origin; a read, Sec-Fetch-Site alone), which a program can pass for, a
  // registered terminal, which a program can register, and one of the
  // person's seats, which signs.
  const plain = (): Record<string, string> => ({});
  const page = (method: string): Record<string, string> => (method === 'GET' ? { 'Sec-Fetch-Site': 'same-origin' } : { Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  const terminal = (): Record<string, string> => ({ [HOST_KEY_HEADER]: key });
  const call = async (method: string, route: string, headers: Record<string, string> | 'seat', body: unknown = { actor: 'Sam' }) => {
    const text = method === 'GET' ? undefined : JSON.stringify(body);
    const sent = headers === 'seat' ? { ...page(method), ...seat.sign(method, route, text ?? '') } : headers;
    const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...sent }, ...(text !== undefined && { body: text }) });
    const raw = await res.text();
    let json: { error?: string; code?: string } = {};
    try {
      json = JSON.parse(raw) as { error?: string; code?: string };
    } catch {
      // a stream or a page
    }
    return { status: res.status, error: json.error, code: json.code };
  };
  const filled = (route: string) =>
    route.replace(/:(\w+)/g, (_m, name: string) => ids[name] ?? (name === 'agent' ? 'claude' : name === 'rev' ? '1' : name === 'id' ? 'connector' : 'nope'));
  const gateWords = [NOT_A_PERSON, HOST_LET_GO, NEEDS_SEAT];
  const passed = (result: { status: number; error?: string }) => result.status !== 403 && !gateWords.includes(result.error ?? '');

  // Tier A: refused as a plain call; past the gate (whatever the route then
  // says) from the page, a terminal and a seat.
  const tierA = async (method: string, route: string, body?: unknown) => {
    const refused = await call(method, route, plain(), body);
    assert.deepEqual([refused.status, refused.error], [403, NOT_A_PERSON], `${method} ${route}, a plain call`);
    for (const [who, headers] of [['the page', page(method)], ['a terminal', terminal()], ['a seat', 'seat']] as const) {
      const result = await call(method, route, headers, body);
      assert.ok(passed(result), `${method} ${route}, tier A from ${who}: ${result.status} ${result.error}`);
    }
  };
  // A terminal's alone: refused as a plain call, and from the page or a seat;
  // past the gate from a terminal.
  const terminalOnly = async (method: string, route: string, body?: unknown) => {
    const refused = await call(method, route, plain(), body);
    assert.deepEqual([refused.status, refused.error], [403, NOT_A_PERSON], `${method} ${route}, a plain call`);
    for (const [who, headers] of [['the page', page(method)], ['a seat', 'seat']] as const) assert.equal((await call(method, route, headers, body)).status, 403, `${method} ${route} from ${who}`);
    const result = await call(method, route, terminal(), body);
    assert.ok(passed(result), `${method} ${route} from a terminal: ${result.status} ${result.error}`);
  };
  // Tier B: refused as a plain call; the page and a terminal told to be let
  // in (seat_needed), and nothing done; past the gate from a seat alone.
  const tierB = async (method: string, route: string, body?: unknown) => {
    const refused = await call(method, route, plain(), body);
    assert.deepEqual([refused.status, refused.error], [403, NOT_A_PERSON], `${method} ${route}, a plain call`);
    for (const [who, headers] of [['the page', page(method)], ['a terminal', terminal()]] as const) {
      const result = await call(method, route, headers, body);
      assert.deepEqual([result.status, result.error, result.code], [403, NEEDS_SEAT, SEAT_NEEDED], `${method} ${route}, tier B from ${who}`);
    }
    const result = await call(method, route, 'seat', body);
    assert.ok(passed(result), `${method} ${route}, tier B from a seat: ${result.status} ${result.error}`);
  };

  return {
    dir,
    store,
    server,
    base,
    hosts,
    key,
    seat,
    app,
    ids,
    plain,
    page,
    terminal,
    call,
    filled,
    tierA,
    terminalOnly,
    tierB,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.flush();
    },
  };
}
