// Registering REST routes from the shared table (core/routes.ts). Each router
// is mounted at a base ('/api/seats'), and a route is registered by its table
// entry, at the part of its path after that base, so the path is written once
// and the server can't serve one the page doesn't know. The handlers are
// Express's own, in the order they are given.
import type { RequestHandler } from 'express';
import type { PathParams, Route } from '../core/routes';

// Where each registered Express route came from, for test/routes.test.ts to
// check the app's own routes against the table.
export const tableRouteOf = new WeakMap<object, Route>();

// What a router or the app registers routes with: Express's `get`, `post`
// and `delete`, taking a path and handlers.
interface Registers {
  get(path: string, ...handlers: RequestHandler[]): unknown;
  post(path: string, ...handlers: RequestHandler[]): unknown;
  delete(path: string, ...handlers: RequestHandler[]): unknown;
  stack?: { route?: object }[]; // a router's layers
  router?: { stack: { route?: object }[] }; // the app's router
}

export type RouteHandler<Path extends string> = RequestHandler<Record<keyof PathParams<Path>, string>>;

export function routesOn(router: Registers, base: string) {
  return <Path extends string>(route: Route<Path>, ...handlers: RouteHandler<Path>[]): void => {
    if (!route.path.startsWith(base)) throw new Error(`${route.method} ${route.path} is not under ${base}.`);
    const at = route.path.slice(base.length) || '/';
    const method = route.method === 'GET' ? 'get' : route.method === 'POST' ? 'post' : 'delete';
    router[method](at, ...(handlers as RequestHandler[]));
    const registered = (router.stack ?? router.router?.stack)?.at(-1)?.route;
    if (registered) tableRouteOf.set(registered, route);
  };
}
