// Code blocks: a source file, or part of one, as it was sent (code.ts), with
// the lines that matter highlighted. It is named by its path, so it has no
// title. People comment on its lines.

import { type CodeFields, type CodeInput, codeBlockSize, findCodeLine, shortPath } from './code';
import type { BlockKind } from '../kind';
import { server } from './server';

export interface CodeTypes {
  type: 'code';
  // Lines are numbered from `start` (1 unless it's an excerpt) out of `total`;
  // `highlight` is ranges of those numbers.
  fields: CodeFields;
  snapshot: CodeFields;
  input: CodeInput; // a source file, or part of one, as sent
  patch: CodeInput; // what changes it, as code.ts reads it; its title is its path
}

export const code: BlockKind<CodeTypes> = {
  type: 'code',
  label: 'Code',
  defaultSize: { w: 640, h: 420 }, // new ones are sized to their lines (codeBlockSize)
  titled: false,
  named: (block) => (block.path ? `code "${shortPath(block.path)}"` : 'untitled code'),
  sizeFor: (fields) => codeBlockSize(fields),

  fromSnapshot: (version) => {
    const { path, text, language, start, total, highlight, commit } = version;
    return { path, text, language, start, total, highlight, commit };
  },
  pins: {
    anchor: server.anchor,
    place(block, pin) {
      if (pin.anchor.kind !== 'line') return undefined;
      const line = findCodeLine(block, pin.anchor.line, pin.quote);
      return line === null ? null : { kind: 'line', file: block.path, line, side: 'new' };
    },
  },

  ...server,
};
