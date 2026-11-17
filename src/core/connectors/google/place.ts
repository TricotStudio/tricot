// Where a pin on a Google Doc's paragraph is. Browser-safe: the canvas asks it too.

import type { PinPlace } from '../../pins';
import type { Block, Pin } from '../../types';

// A doc's paragraph is there while the draft hasn't removed it: one of the
// doc's (pN) until it's removed, one added in the draft (nN) while the draft
// has it. Pins on a version the draft isn't on are followed onto the
// draft's when it moves (see DocDraftStore), so until then they stand.
export function placeDocPin(block: Block, pin: Pin): PinPlace | null | undefined {
  const { anchor } = pin;
  if (anchor.kind !== 'doc' || block.type !== 'link') return undefined;
  if (anchor.gone) return null;
  const draft = block.docDraft?.revision === anchor.revision ? block.docDraft : undefined;
  const edit = draft?.edits.find((e) => e.id === anchor.paragraph);
  if (anchor.paragraph.startsWith('n')) return edit?.op === 'add' ? { kind: 'doc', paragraph: anchor.paragraph } : null;
  return edit?.op === 'delete' ? null : { kind: 'doc', paragraph: anchor.paragraph };
}
