// The marks links draw for their source, from each source's web half. A new
// source of links is a file here (web/canvas/sources/<name>.tsx) and an import
// and an entry below, with its recogniser (core/sources/registry.ts); a
// connector's links draw the marks its web half brings (web/connectors/<id>/).
// Internal: nothing is loaded from outside this repository.

import { webConnectors } from '../../connectors/registry';
import { figma } from './figma';
import { github } from './github';
import { loom } from './loom';
import type { Mark, WebSource } from './mark';
import { youtube } from './youtube';

// A function so the sources are read once they have all loaded.
const registered = (): readonly WebSource[] => [figma, youtube, loom, github];

let marks: Record<string, Mark> | undefined;

// A plain tile for a link whose mark nobody has drawn.
const PLAIN: Mark = { tile: '#5d5866', glyph: null }; // the light theme's muted ink

export function sourceMark(mark: string): Mark {
  marks ??= Object.assign({}, ...webConnectors().map((c) => c.marks ?? {}), ...registered().map((s) => s.marks));
  return marks![mark] ?? PLAIN;
}
