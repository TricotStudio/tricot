// What a REST route is (its method and its path, with :name where a piece of
// the path is a value), the helpers a table of them is written with, and how
// an address is built from one. The tables are core/routes.ts (the app's own)
// and each connector's core/connectors/<id>/routes.ts, which the connector
// registry gathers (connectorRoutes).
//
// No imports: the browser takes it too (test/bundle.test.ts), core/routes.ts
// stays as light as this (test/layers.test.ts), and a connector's table is
// loaded from inside the registry's import cycle, so what it calls at load
// must not lead back into it.

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface Route<Path extends string = string, Method extends HttpMethod = HttpMethod> {
  readonly method: Method;
  readonly path: Path;
}

export const get = <Path extends string>(path: Path): Route<Path, 'GET'> => ({ method: 'GET', path });
export const post = <Path extends string>(path: Path): Route<Path, 'POST'> => ({ method: 'POST', path });
export const del = <Path extends string>(path: Path): Route<Path, 'DELETE'> => ({ method: 'DELETE', path });

// The names in a path pattern: '/api/boards/:boardId/tasks' has boardId.
export type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> : Path extends `${string}:${infer Name}` ? Name : never;

export type PathParams<Path extends string> = { [Name in ParamNames<Path>]: string | number };

export type Query = URLSearchParams | Record<string, string>;

// What routeUrl takes after the route: the path's values when it has any, then a query.
export type UrlArgs<Path extends string> = [ParamNames<Path>] extends [never] ? [params?: undefined, query?: Query] : [params: PathParams<Path>, query?: Query];

// A route's address with each value put in, encoded as one piece of the path,
// and the query after it when there is one. The values a path takes are the
// type's to check: one missing is a type error here, not a 404 there.
export function routeUrl<Path extends string>(route: Route<Path>, ...args: UrlArgs<Path>): string {
  const [params, query] = args as [Record<string, string | number> | undefined, Query | undefined];
  const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`${route.method} ${route.path} needs ${name}.`);
    return encodeURIComponent(String(value));
  });
  const search = query === undefined ? '' : new URLSearchParams(query).toString();
  return search ? `${path}?${search}` : path;
}
