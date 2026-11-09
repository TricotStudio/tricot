import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { connectorKinds, connectorRoutes } from '../src/core/connectors';
import { githubRoutes } from '../src/core/connectors/github/routes';
import { routes, routeUrl, type Route } from '../src/core/routes';
import { Store } from '../src/core/store';
import { Updates } from '../src/install/updates';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { Leases } from '../src/server/leases';
import { tableRouteOf } from '../src/server/routing';
import { removeScratch } from './platform';

// One table of REST routes is what the server serves and what the page asks
// for: the app's own (src/core/routes.ts) and each connector's
// (src/core/connectors/<id>/routes.ts), which the connector registry gathers
// (connectorRoutes). The server registers each route from its entry
// (server/routing.ts), the page builds each address from one (routeUrl).
// These tests keep it that way: nothing is served that the table doesn't
// hold, each route is served where the table says, and the page writes no
// /api address of its own.

const all: [name: string, route: Route][] = [...(Object.entries(routes) as [string, Route][]), ...connectorRoutes()];
const tabled = new Set(all.map(([, route]) => route));

describe('The route table', () => {
  it("gathers each connector's own routes through the registry, each under /api/connectors/<its id>/", () => {
    const kinds = connectorKinds().filter((kind) => kind.routes);
    assert.ok(kinds.length >= 5, 'reads the connectors with routes');
    const gathered = connectorRoutes();
    for (const kind of kinds) {
      for (const [name, route] of Object.entries(kind.routes!)) {
        assert.ok(route.path.startsWith(`/api/connectors/${kind.id}/`), `${kind.id}.${name}: ${route.path} is not under /api/connectors/${kind.id}/`);
        assert.ok(gathered.some(([named, entry]) => named === `${kind.id}.${name}` && entry === route), `${kind.id}.${name} is in connectorRoutes()`);
      }
    }
    assert.equal(gathered.length, kinds.reduce((sum, kind) => sum + Object.keys(kind.routes!).length, 0), "each connector's, and nothing else");
  });

  it('names no connector in the app\'s own table: each declares its routes in its core folder', () => {
    const code = readFileSync(path.resolve(import.meta.dirname, '../src/core/routes.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const named = connectorKinds().filter((kind) => new RegExp(`\\b${kind.id}\\b`, 'i').test(code)).map((kind) => kind.id);
    assert.deepEqual(named, [], 'move its routes to src/core/connectors/<id>/routes.ts and list them on its ConnectorKind (routes)');
  });

  it('holds each method and path once, under /api, with plain names for its values', () => {
    const seen = new Set<string>();
    for (const [name, route] of all) {
      const key = `${route.method} ${route.path}`;
      assert.ok(!seen.has(key), `${name} repeats ${key}`);
      seen.add(key);
      assert.match(route.path, /^\/api\/(?:[a-z-]+|:[A-Za-z]+)(?:\/(?:[a-z-]+|:[A-Za-z]+))*$/, `${name}: ${route.path}`);
    }
  });

  it('fills in the values a path takes, each encoded as one piece of it, and adds a query', () => {
    assert.equal(routeUrl(routes.boards), '/api/boards');
    assert.equal(routeUrl(routes.board, { boardId: 'retry-options-5m5w' }), '/api/boards/retry-options-5m5w');
    assert.equal(routeUrl(routes.board, { boardId: 'a/b ?#é' }), '/api/boards/a%2Fb%20%3F%23%C3%A9', 'a value never adds to or ends the path');
    assert.equal(routeUrl(routes.blockVersion, { id: 'b1', rev: 3 }), '/api/canvas/blocks/b1/versions/3');
    assert.equal(routeUrl(githubRoutes.card, { owner: 'acme', repo: 'web', kind: 'pull', number: 12 }), '/api/connectors/github/cards/acme/web/pull/12');
    assert.equal(routeUrl(routes.asset, { id: '' }), '/api/assets/', 'an empty value is the prefix of the addresses');
    assert.equal(routeUrl(routes.needs, undefined, { name: 'Sam', seen: '{"a":1}' }), '/api/needs?name=Sam&seen=%7B%22a%22%3A1%7D');
    assert.equal(routeUrl(routes.boardEvents, { boardId: 'b' }, new URLSearchParams()), '/api/boards/b/events', 'no query, no ?');
    assert.throws(() => routeUrl(routes.board, {} as never), /needs boardId/);
  });
});

// The parts of Express's router these tests read (router 2, Express 5).
interface Layer {
  route?: { path: string; methods: Record<string, boolean | undefined> };
  handle: { stack?: Layer[] };
  path?: string;
  match(path: string): boolean;
}

describe('The server', () => {
  let dir: string;
  let stack: Layer[];

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-routes-'));
    const store = new Store(dir);
    store.load();
    // Every option that adds routes: connectors, leases, live steps and updates.
    const app = createApp(store, {
      host: '127.0.0.1',
      mcpUrl: 'unused',
      connectors: new Connectors({ dataDir: dir }),
      leases: new Leases(),
      liveSteps: { target: { home: dir, project: dir, env: {} }, source: dir, url: 'http://127.0.0.1:1' },
      updates: new Updates({ check: false, current: '0.1.0', place: { port: 1, host: '127.0.0.1', dataDir: dir } }),
    });
    stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  });

  after(() => removeScratch(dir));

  // Every route the app and its routers register, but the MCP endpoint.
  const served = (layers: Layer[]): Layer['route'][] =>
    layers.flatMap((layer) => (layer.route ? (layer.route.path === '/mcp' ? [] : [layer.route]) : layer.handle.stack ? served(layer.handle.stack) : []));

  it('serves each route of the table once, and nothing else', () => {
    const routers = served(stack);
    // Registered with routesOn, from an entry of the table: not a path of its own, nor a route that no table lists.
    const untabled = routers.filter((route) => {
      const entry = tableRouteOf.get(route!);
      return !entry || !tabled.has(entry);
    }).map((route) => route!.path);
    assert.deepEqual(untabled, [], "a route registered without the table (server/routing.ts routesOn, from core/routes.ts or the connector's core/connectors/<id>/routes.ts)");
    const times = (route: Route) => routers.filter((registered) => tableRouteOf.get(registered!) === route).length;
    assert.deepEqual(
      all.filter(([, route]) => times(route) !== 1).map(([name, route]) => `${name} is served ${times(route)} times`),
      [],
    );
  });

  // The route Express would run for a request, found as its router does: each
  // mounted router takes the part of the path it is mounted at.
  const handler = (layers: Layer[], method: string, url: string): Route | undefined => {
    for (const layer of layers) {
      if (!layer.match(url)) continue;
      if (layer.route) {
        if (layer.route.methods[method.toLowerCase()]) return tableRouteOf.get(layer.route);
      } else if (layer.handle.stack) {
        const found = handler(layer.handle.stack, method, url.slice(layer.path?.length ?? 0) || '/');
        if (found) return found;
      }
    }
    return undefined;
  };

  it('serves each route at the path the table gives it', () => {
    const wrong = all.flatMap(([name, route]) => {
      const sample = route.path.replace(/:\w+/g, 'sample');
      const found = handler(stack, route.method, sample);
      return found === route ? [] : [`${name}: ${route.method} ${sample} is ${found ? `${found.method} ${found.path}` : 'not served'}`];
    });
    assert.deepEqual(wrong, []);
  });
});

// The code of each TypeScript file under these folders of src/, by its name
// there, with forward slashes as Windows gives them too. Code only: what a
// comment says about a route is for the reader (a block comment keeps its
// lines, so a line's number is still its own).
function sourcesIn(...folders: string[]): Map<string, string> {
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, '')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sources = new Map<string, string>();
  for (const folder of folders) {
    const root = path.resolve(import.meta.dirname, '../src', folder);
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[]) {
      if (/\.tsx?$/.test(file)) sources.set(`${folder}/${file.split(path.sep).join('/')}`, code(readFileSync(path.join(root, file), 'utf8')));
    }
  }
  return sources;
}

// Each line that writes an /api address itself: one in quotes, or one after a
// value in a template (`${url}/api/boards`).
const ownAddresses = (sources: Map<string, string>): string[] =>
  [...sources].flatMap(([file, code]) => code.split('\n').flatMap((line, at) => (/(?:['"`]|\})\/api\b/.test(line) ? [`${file}:${at + 1}: ${line.trim()}`] : [])));

// The routes the code names that the table doesn't hold.
const unknownRoutes = (sources: Map<string, string>): string[] =>
  [...new Set([...sources.values()].flatMap((code) => [...code.matchAll(/\broutes\.(\w+)/g)].map((m) => m[1])))].filter((name) => !(name in routes));

describe('The page', () => {
  const page = sourcesIn('web');

  it('writes no /api address of its own: each comes from the table', () => {
    assert.ok(page.size > 100 && page.has('web/shared/api.ts'), 'reads the page');
    assert.deepEqual(ownAddresses(page), [], 'build the address with routeUrl(routes.<name>, …), or ask with get(…)/post(…) of shared/api.ts');
  });

  it('asks only for routes the table holds', () => {
    assert.deepEqual(unknownRoutes(page), []);
  });
});

// The `tricot` command, and what it and the server share to find and update a
// running board, ask for the board's routes as the page does.
describe('The command and the platform', () => {
  const node = sourcesIn('cli', 'platform', 'install');

  it('write no /api address of their own: each comes from the table', () => {
    assert.ok(node.has('cli/chooseBoard.ts') && node.has('platform/lock.ts') && node.has('install/updates.ts'), 'reads the command, the platform and updating');
    assert.deepEqual(ownAddresses(node), [], 'build the address with routeUrl(routes.<name>, …), and sign that same address');
  });

  it('ask only for routes the table holds', () => {
    assert.deepEqual(unknownRoutes(node), []);
  });
});
