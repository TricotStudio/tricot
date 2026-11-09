// The connectors Tricot has, one entry each. A new connector is a folder
// (core/connectors/<id>/) and an import and an entry here, with its server
// half (server/connectors/registry.ts) and its web half
// (web/connectors/registry.ts). Everything that handles connectors asks this
// list, and none names a service. Internal: nothing is loaded from outside
// this repository.

import type { Route } from '../route';
import type { ConnectorKind } from './connector';
import { figma } from './figma';
import { github } from './github';
import { google } from './google';
import { linear } from './linear';
import { slack } from './slack';

// A function so the connectors are read once they have all loaded, however the modules happen to be imported.
const registered = (): readonly ConnectorKind[] => [google, figma, github, slack, linear];

let all: readonly ConnectorKind[] | undefined;

export function connectorKinds(): readonly ConnectorKind[] {
  return (all ??= registered());
}

export function findConnector(id: string): ConnectorKind | undefined {
  return connectorKinds().find((kind) => kind.id === id);
}

// The connector whose pins have this kind of anchor ("doc"), if any.
export function connectorPinning(anchorKind: string): ConnectorKind | undefined {
  return connectorKinds().find((kind) => kind.pins?.kind === anchorKind);
}

// Every connector's own REST routes (its routes.ts), named "<id>.<name>"
// ("github.card"), in the registry's order: with the app's own
// (core/routes.ts), every route the server serves.
export function connectorRoutes(): [name: string, route: Route][] {
  return connectorKinds().flatMap((kind) => Object.entries(kind.routes ?? {}).map(([name, route]): [string, Route] => [`${kind.id}.${name}`, route]));
}
