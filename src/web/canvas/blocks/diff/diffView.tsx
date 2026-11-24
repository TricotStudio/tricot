// A diff's full view, in the pairing shell (canvas/pairing/piece.tsx): the
// patch file by file on a sheet, at a reading size, its totals over it, and
// unified or split as on the canvas (diff.tsx draws the files for both). A
// diff's lines take comments, not requests (core/parts.ts), so it has no
// Pair: click a line to comment on it, as on the canvas, in the canvas's
// prompt; select code to copy it. A commented line is marked at its end,
// kept in sight at the sheet's edge while the line runs past it, and the
// marker opens what was said, by the line; a card made from a line (Create
// task, Ask a question) is marked there too, as on the canvas. The pins on
// the whole diff are under it (piece.tsx). When an agent sends a new patch
// the view shows it where it was, and each pin stays on its line while it
// reads the same. An earlier version shows as it was, with no comments.

import { atVersion } from '../../../../core/canvas';
import type { Block, Pin } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { PairPinChip } from '../../pairing/ask';
import { PinChip } from '../../pins';
import { PieceView, type PieceBodyProps } from '../../pairing/piece';
import type { OverlayProps } from '../kind';
import { DiffFiles, DiffStat, DiffSwitch } from './diff';
import './diffView.css';

type DiffBlock = Extract<Block, { type: 'diff' }>;

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function DiffSheet({ block, placed, pointing, chosen, open, pick, openPin }: PieceBodyProps<DiffBlock>) {
  // A comment's marker opens its thread by the line; work pinned there shows where it stands, and opens the card.
  const chips = (pins: Pin[]) => (
    <span className="diff-full-chips" data-pair-reach="">
      {pins.map((pin) =>
        pin.discussion ? <PairPinChip key={pin.id} pin={pin} open={pin.id === open} onToggle={() => openPin(pin.id)} /> : <PinChip key={pin.id} pin={pin} />,
      )}
    </span>
  );
  return (
    <div className="piece-scroll diff-full-scroll">
      <div className="piece-sheet diff-full-sheet">
        <DiffFiles block={block} placed={placed} full={{ pointing, chosen, open, pick, chips }} />
      </div>
    </div>
  );
}

export function DiffView({ block, name, version, pinId, pinAsked, onClose }: OverlayProps<DiffBlock>) {
  const shown = version ? (atVersion(block, version) as DiffBlock) : block;
  const rev = version ? version.rev : block.versionCount ? block.rev : null;
  const title = block.title || `Diff of ${plural(shown.files.length, 'file')}`;
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      pinAsked={pinAsked}
      part="diff"
      asks={false}
      className="diff-full-view"
      label={`Diff ${title}`}
      icon={<Icon name="code" />}
      title={title}
      from={
        <>
          Diff · <DiffStat files={shown.files} />
          {rev !== null && ` · v${rev}`}
        </>
      }
      browse={{ label: 'Read', hint: 'Read it, and select code to copy' }}
      it="the diff"
      point="click a line"
      does="comments on it"
      example="a note on this line"
      controls={<DiffSwitch />}
      body={(props) => <DiffSheet {...props} />}
      onClose={onClose}
    />
  );
}
