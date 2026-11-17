// How a part of Tricot adds REST routes to the core's, without the core naming
// it: a part's cards are served from its API part, and
// the core serves the canvas alone when none is registered. The
// registry of card kinds (core/store/cardKinds.ts) and the page's registry of
// reference kinds are the same idea on their sides: this is the server's.
//
// A part is made of three things, an id, its `routes` and a `mount`. The routes
// are a table of its own, as a connector's are (the full
// edition keeps its own): the core's table (core/routes.ts) holds none of them, so the part
// declares what it serves, and what asks for them (its web features, a command,
// the tests) imports that table. createApiRouter (api.ts) calls
// `mount(api, kit)` once, with the router the core's own handlers are on,
// AFTER the gate that asks a person for every change (peopleChange) and BEFORE
// the 404 and the error handler. That position is the point: a part's routes
// are the gate's, the 404's and the error handler's as the core's are, and a
// separate router mounted at /api would be gated wrongly and out of the error
// handler, while one mounted after the 404 would never be reached.
//
// A part registers each route from an entry of its own table with `kit.on`, as
// the core does with routesOn (routing.ts), so the path and its method are
// written once and test/routes.test.ts still sees every route served. It serves
// the routes it declares and no other, and each of them: a route outside its
// table, or one of its table left unserved, stops the startup, so the table is
// what the part serves and not a second list kept beside the handlers. What the
// part served is recorded as it does, and `mount` hands it back (MountedPart).
//
// Each app builds its own parts (createApp), and nothing registers by loading a
// module: `new ApiParts()` is a server of the canvas alone, which answers a
// route of a part's with the plain 404 of any route it doesn't have.
import type { Request, RequestHandler, Router } from 'express';
import type { Approval, ApprovalAnswer } from '../core/approvals';
import type { BoardsReport, ProjectsOptions } from '../core/projects';
import type { Route } from '../core/routes';
import type { Reacted, ReactionPlace, Store } from '../core/store';
import type { Actor, Board, BoardEvent } from '../core/types';
import type { Tier } from './access';
import type { Connectors } from './connectors';
import type { Presence } from './presence';
import { tableRouteOf, type RouteHandler } from './routing';

// What the core's own handlers use, handed to a part so it needs no import of
// api.ts and the core none of the part's.
export interface ApiKit {
  store: Store;
  presence?: Presence;
  // The connectors on this machine (connectors/index.ts), when the app has them: for a part's route that acts through
  // one as the person who signed in to it. Their own routes are the connectors' (connectors/routes.ts).
  connectors?: Pick<Connectors, 'get'>;
  // Registers a route of a table on the router, as the core's handlers are
  // (routing.ts routesOn). Handlers run in the order they are given.
  on<Path extends string>(route: Route<Path>, ...handlers: RouteHandler<Path>[]): void;
  // Tier B (access.ts): one of the person's seats. The gate before the part
  // already asks a person (tier A) for every change; this asks for more.
  seated: RequestHandler;
  // A route's own tier: a tier, or one told from the request (a body that moves a task).
  personOnly(tier?: Tier | ((req: Request) => Tier)): RequestHandler;
  // The person a request is made as, from the name it comes with.
  human(name: string): Actor;
  // A value of the route's path.
  param(req: Request, name: string): string;
  // A 👍, 👎 or 👀 on a comment, shared with the core's reactions (api.ts).
  react(place: ReactionPlace, req: Request): Reacted['item'];
  // Told of each answer a person gives to an agent waiting for their OK (approvals.ts),
  // with the request, once it is given: a part that keeps what a person answered
  // records it here. Called while the part mounts; a listener that throws is logged
  // and never holds the answer back.
  onApprovalAnswered(listener: (approval: Approval, answer: ApprovalAnswer) => void): void;
}

// What a part adds to the report of /api/needs (the core serves the projects and
// the agents, and answers with nothing waiting on anyone when no part adds
// more): what waits on this person across the boards, and each project's count
// of it. `seen` is the last event they saw on each board, by its key, and
// `unseen` what others changed on a board after it.
export interface NeedsAsk extends ProjectsOptions {
  seen: Record<string, number>;
  unseen(board: Board, since: number): BoardEvent[];
}
export type NeedsSource = (boards: Board[], name: string, ask: NeedsAsk) => BoardsReport<unknown>;

export interface ApiPart {
  // What the registry knows it by. A second part of one id is a mistake in Tricot.
  id: string;
  // The routes it serves, by name: its own table, which
  // the core's does not hold. `mount` registers each of them with `on`, once.
  routes: Record<string, Route>;
  mount(api: Router, kit: ApiKit): void;
  // What it adds to the needs report (above), made once the app is built. At most one part has it.
  needs?(kit: ApiKit): NeedsSource;
}

// What a part served once mounted, from the routes it registered.
export interface MountedPart {
  id: string;
  routes: Route[];
}

export class ApiParts {
  private readonly all: ApiPart[] = [];

  // Adds a part, in the order its routes are mounted. A second part of one id
  // is a mistake in Tricot, not in what a person did: it fails here, at
  // startup, naming it.
  add(part: ApiPart): this {
    if (this.all.some((existing) => existing.id === part.id)) throw new Error(`There are two parts of the REST API named ${part.id}.`);
    if (part.needs && this.all.some((existing) => existing.needs)) throw new Error(`There are two parts of the REST API that add to the needs report: ${part.id} and another.`);
    this.all.push(part);
    return this;
  }

  // What the registered part adds to the needs report, if one does.
  needs(kit: ApiKit): NeedsSource | undefined {
    return this.all.find((part) => part.needs)?.needs?.(kit);
  }

  ids(): string[] {
    return this.all.map((part) => part.id);
  }

  // Mounts each part on the router, giving it the kit with its own `on`, which
  // keeps what it registers. A part that throws while it mounts fails the
  // startup, saying which; so does one that serves a route already served,
  // which would be silently shadowed by the one before it, one that serves a
  // route its table does not hold, and one that leaves a route of its table
  // unserved.
  mount(api: Router, kit: ApiKit): MountedPart[] {
    return this.all.map((part) => {
      const routes: Route[] = [];
      const declared = Object.values(part.routes);
      const on: ApiKit['on'] = (route, ...handlers) => {
        const layers = (api as unknown as { stack: { route?: object }[] }).stack;
        const same = (other?: Route) => other?.method === route.method && other.path === route.path;
        if (!declared.some(same)) throw new Error(`${route.method} ${route.path} is not in the table of routes the part declares.`);
        if (layers.some((layer) => layer.route && same(tableRouteOf.get(layer.route)))) {
          throw new Error(`${route.method} ${route.path} is served already: a part cannot serve a route twice.`);
        }
        kit.on(route, ...handlers);
        routes.push(route);
      };
      try {
        part.mount(api, { ...kit, on });
        const unserved = declared.filter((route) => !routes.some((served) => served.method === route.method && served.path === route.path));
        if (unserved.length > 0) throw new Error(`it declares ${unserved.map((route) => `${route.method} ${route.path}`).join(', ')} and does not serve ${unserved.length === 1 ? 'it' : 'them'}.`);
      } catch (error) {
        throw new Error(`The REST part ${part.id} could not be mounted: ${(error as Error).message}`, { cause: error });
      }
      return { id: part.id, routes };
    });
  }
}
