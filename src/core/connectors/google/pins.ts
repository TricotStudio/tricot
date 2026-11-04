// Pins on a Google Doc's paragraphs, as the server makes and words them.
// Server-only (see server.ts).

import { blockLabel } from '../../canvas';
import { clip } from '../../format';
import { cleanQuote } from '../../pins';
import { BoardError } from '../../store/errors';
import { LIMITS, limited, required } from '../../store/validate';
import type { Block, Pin } from '../../types';
import type { ConnectorServerHalf } from '../connector';
import { docFileId } from './doc';

// The doc a pin on a Google Doc's paragraph is in, by name: the card's
// title, the doc's own title, or "the Google Doc".
export function docName(block: Block, pin?: Pin): string {
  const title = block.title || (block.type === 'link' ? block.docDraft?.title : undefined) || (pin?.anchor.kind === 'doc' ? pin.anchor.title : undefined);
  return title ? `Google Doc "${clip(title, 60)}"` : 'the Google Doc';
}

export const googlePins: NonNullable<ConnectorServerHalf['pins']> = {
  anchor(block, part) {
    if (part.kind !== 'doc') return undefined;
    if (!docFileId(block.type === 'link' ? block.url : '')) throw new BoardError(`Paragraphs are pinned in Google Docs; ${blockLabel(block)} isn't a link to one.`);
    if (!/^[pn][1-9]\d{0,5}$/.test(part.paragraph)) {
      throw new BoardError(`"${clip(String(part.paragraph), 20)}" isn't a paragraph id: they're p1, p2… in the doc and n1, n2… for paragraphs added in the draft.`);
    }
    const quote = limited(cleanQuote(required(part.quote, 'pinned text')), LIMITS.quote, 'Pinned text');
    const revision = limited(required(part.revision, 'revision'), LIMITS.revision, 'A revision');
    const title = part.title?.trim() ? clip(part.title.trim(), LIMITS.title) : undefined;
    const around = (text?: string) => (text ?? '').slice(0, LIMITS.pinContext);
    return {
      anchor: { kind: 'doc', paragraph: part.paragraph, revision, prefix: around(part.prefix), suffix: around(part.suffix), ...(title ? { title } : {}) },
      quote,
    };
  },
  where: (pin) => (pin.anchor.kind === 'doc' && !pin.anchor.gone ? ` (paragraph ${pin.anchor.paragraph}; read_google_doc)` : ''),
  label: docName,
  seen: 'People see it by the paragraph, in the doc',
  missing: (block) => `Paragraphs are pinned in Google Docs; ${blockLabel(block)} isn't a link to one.`,
  ask: {
    asking: 'asking agents to edit it in the doc',
    doing: 'Edit the draft with edit_google_doc, then reply',
    act: 'change the draft with edit_google_doc, then ',
    request: 'request to edit the paragraph, ',
    what: 'the paragraphs of a Google Doc',
  },
};
