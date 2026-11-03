// The sources of links, one line each. A new source is a file here
// (core/sources/<name>.ts) and an import and an entry below, plus its mark on
// the web side (web/canvas/sources/registry.ts); everything that reads an
// address asks linkSource, and none names a service. The sources a connector
// recognises come with the connector (core/connectors/<id>/sources.ts).
// Internal: nothing is loaded from outside this repository.

import { connectorKinds } from '../connectors/registry';
import { figma } from './figma';
import { github } from './github';
import { loom } from './loom';
import type { LinkSourceKind } from './types';
import { youtube } from './youtube';

export interface RegisteredSource {
  source: LinkSourceKind;
  connector?: string; // the connector it came with
}

// The connectors' sources come first, then these; a function, so the
// connectors are read once they have all loaded.
const registered = (): RegisteredSource[] => [
  ...connectorKinds().flatMap((c) => (c.sources ?? []).map((source) => ({ source, connector: c.id }))),
  ...[figma, youtube, loom, github].map((source) => ({ source })),
];

let all: RegisteredSource[] | undefined;

export function linkSources(): readonly RegisteredSource[] {
  return (all ??= registered());
}
