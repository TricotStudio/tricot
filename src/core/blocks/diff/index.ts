// Diff blocks: code changes, a unified diff as an agent sent it and its files
// parsed (diff.ts). People see it file by file and comment on its lines.

import { type DiffFile, findLine } from './diff';
import { lineParts } from './lines';
import type { BlockKind } from '../kind';
import { blockIs } from '../../canvas';
import { server } from './server';

export interface DiffTypes {
  type: 'diff';
  // The patch as an agent sent it, and its files parsed; `focus` names the
  // files to open first. People's copy leaves the patch out: they're drawn
  // from the files.
  fields: { patch: string; files: DiffFile[]; focus?: string[] };
  snapshot: { patch: string; files: DiffFile[]; focus?: string[] };
  input: { patch: string; focus?: string[] }; // a unified diff, parsed into files on the way in
  patch: { patch?: string; focus?: string[] }; // a new patch, replacing the one shown; the files to open first
}

export const diff: BlockKind<DiffTypes> = {
  type: 'diff',
  label: 'Diff',
  defaultSize: { w: 760, h: 560 },
  untitled: (block) => `diff of ${block.files.length} file${block.files.length === 1 ? '' : 's'}`,

  fromSnapshot: (version) => ({ patch: version.patch, files: version.files, focus: version.focus }),
  pins: {
    anchor: server.anchor,
    // Its lines, on either side of the change (lines.ts); they take no requests.
    parts: { line: { ...lineParts, missing: (block) => `Lines are pinned in diffs and code blocks; ${blockIs(block)}.` } },
    place(block, pin) {
      if (pin.anchor.kind !== 'line') return undefined;
      const at = findLine(block.files, pin.anchor.file, pin.anchor.side, pin.anchor.line, pin.quote);
      return at && { kind: 'line', ...at, side: pin.anchor.side };
    },
  },

  ...server,
};
