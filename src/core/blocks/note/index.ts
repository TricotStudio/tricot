// Note blocks: short prose in Markdown. A task list in it ("- [ ] step") is
// what a checklist was: people tick its boxes in place (#83).

import type { BlockKind } from '../kind';
import { blockIs } from '../../canvas';
import { clip } from '../../format';
import { findWords, noteText } from '../../pins';
import type { TaskInput } from '../../taskList';
import { server } from './server';

export interface NoteTypes {
  type: 'note';
  fields: { text: string };
  snapshot: { text: string };
  input: { text: string };
  // `items` is a checklist's, as agents still send one: it replaces the note's task list.
  patch: { text?: string; items?: TaskInput[] };
}

export const note: BlockKind<NoteTypes> = {
  type: 'note',
  label: 'Note',
  defaultSize: { w: 300, h: 200 },
  untitled: (block) => (block.text.trim() ? `note "${clip(block.text, 40)}"` : undefined),

  fromSnapshot: (version) => ({ text: version.text }),
  pins: {
    anchor: server.anchor,
    part: server.part,
    parts: {
      // Words people select in a note, or an agent names.
      text: {
        name: (pin) => `"${clip(pin.quote, 80)}"`,
        quote: (pin) => `“${pin.quote}”`,
        lost: 'text changed',
        words: true,
        askedTo: "rewrite the note's text",
        missing: (block) => `Words are pinned in notes; ${blockIs(block)}.`,
      },
    },
    place(block, pin) {
      if (pin.anchor.kind !== 'text') return undefined;
      const at = findWords(noteText(block.text), pin.quote, pin.anchor);
      return at && { kind: 'text', ...at };
    },
  },

  ...server,
};
