// The connectors Tricot has, one entry each. A new connector is a folder
// (core/connectors/<id>/) and an import and an entry here, with its server
// half (server/connectors/registry.ts) and its web half
// (web/connectors/registry.ts). Everything that handles connectors asks this
// list, and none names a service. Internal: nothing is loaded from outside
// this repository.

import type { ConnectorKind } from './connector';
import { figma } from './figma';
import { github } from './github';
import { google } from './google';

// A function so the connectors are read once they have all loaded, however the modules happen to be imported.
const registered = (): readonly ConnectorKind[] => [google, figma, github];

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
