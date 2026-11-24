// Notes and requests on a website's elements, on its card: the chip that
// counts its open threads. In its full view (siteView.tsx), the prompt by an
// element picked and the chip on an element people asked or commented about
// are the pairing view's own (canvas/pairing/ask.tsx), as on every piece.

import { pinComments } from '../../../../core/pins';
import { Icon } from '../../../shared/components';
import { ownedBy, useCanvas } from '../../context';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// On a website's card: its open threads, marked when one has news. It opens
// the full view at that one (or the first).
export function SiteThreadsChip({ blockId }: { blockId: string }) {
  const canvas = useCanvas();
  const open = (canvas.pins.get(blockId) ?? []).filter((p) => p.anchor.kind === 'site' && p.discussion && !p.discussion.resolved);
  if (open.length === 0) return null;
  const fresh = open.filter((p) => canvas.newItems.has(p.id));
  const asks = open.filter((p) => pinComments(p, ownedBy(canvas)).some((c) => c.ask)).length;
  const what = [asks && `${plural(asks, 'request')} to agents`, open.length - asks && plural(open.length - asks, 'note')].filter(Boolean).join(' and ');
  return (
    <button
      type="button"
      className={`block-link-threads nodrag${fresh.length ? ' is-new' : ''}`}
      onClick={() => canvas.openOverlay(blockId, { pinId: (fresh[0] ?? open[0]).id })}
      onDoubleClick={(e) => e.stopPropagation()}
      title={`${what} on this website${fresh.length ? ', with new replies' : ''}. Open it there.`}
    >
      <Icon name={asks ? 'edit' : 'comment'} />
      {open.length}
      {fresh.length > 0 && <span className="pin-chip-new" aria-label="new replies" />}
    </button>
  );
}
