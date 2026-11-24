// The pins on a whole block, under its full view, for a kind whose parts take
// no requests and whose view draws no pins of its own (a shape, a drawing, a
// comparison: core/parts.ts): what was said about it and the work pinned to
// it, in the one row under the piece (strip.tsx), what is settled folded
// under its "N done". A comment's chip opens its thread by the chip, in the
// view's popover (popover.tsx); a card's opens the card. The view opens at a
// pin (`pinId`, again each time `pinAsked` counts one more ask), its thread
// open. An earlier version shows none.
//
// It is also the view's Escape (shell.tsx, useEscapeSteps): the thread open
// first, then the view. A view that draws its parts' pins itself (piece.tsx)
// keeps which thread is open, and its Escape, and its own row.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Block, BlockVersion, Pin } from '../../../core/types';
import { useCanvas } from '../context';
import { PinThread } from '../pins';
import { bodyOf, chipAt, focusBack, wholePart } from './piece';
import { PinPopover } from './popover';
import { useEscapeSteps } from './shell';
import { PinStrip, stripAnchor } from './strip';
import './piece.css';

export function BlockPins(props: {
  block: Block;
  name: string;
  version?: BlockVersion;
  pinId?: string;
  pinAsked?: number;
  label?: string; // before the chips: "On this comparison"
  onClose(): void; // closes the view
}) {
  const { block, name, version, pinId, pinAsked, label, onClose } = props;
  const { pins: boardPins, seeItem } = useCanvas();
  const foot = useRef<HTMLElement>(null);
  const [thread, setThread] = useState<string | null>(pinId ?? null);
  const onBlock = boardPins.get(block.id);
  const pins = useMemo(() => (version ? [] : (onBlock ?? [])), [onBlock, version]);
  const open = pins.find((pin) => pin.id === thread && pin.discussion);

  const toggle = useCallback(
    (pin: Pin, from: 'row' | 'list') => {
      setThread((was) => (was === pin.id && from === 'row' ? null : pin.id));
      seeItem(pin.id);
    },
    [seeItem],
  );
  useEffect(() => {
    if (pinId) setThread(pinId);
  }, [pinId, pinAsked]);

  useEscapeSteps(
    Boolean(open),
    () => {
      if (!open) return false;
      setThread(null);
      return true;
    },
    onClose,
  );

  if (pins.length === 0) return null;
  return (
    <footer className="piece-apart" ref={foot}>
      <PinStrip pins={pins.map((pin) => ({ pin, ...(pin.discussion && !label && { part: wholePart(pin, block) }) }))} open={thread} label={label} onOpen={toggle} />
      {open && (
        <PinPopover
          key={open.id}
          from={foot}
          at={() => chipAt(stripAnchor(foot.current, open.id))}
          within={() => bodyOf(foot.current)}
          opens="over"
          takeFocus
          giveBack={() => focusBack(null, foot.current, open.id, true)}
        >
          <PinThread pin={open} block={block} name={name} onClose={() => setThread(null)} />
        </PinPopover>
      )}
    </footer>
  );
}
