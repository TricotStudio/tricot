// The pins on a whole block, under its full view, for a kind whose parts take
// no requests and whose view draws no pins of its own (a shape, a drawing, a
// comparison: core/parts.ts): what was said about it and the work pinned to
// it, as chips in a row under the piece. A comment's chip opens its thread
// there, under the chips; a card's opens the card. A resolved thread shows
// only while it is open. The view opens at a pin (`pinId`, again each time
// `pinAsked` counts one more ask), its thread open and its chip in sight. An
// earlier version shows none.
//
// It is also the view's Escape (shell.tsx, useEscapeSteps): the thread open
// first, then the view. A view that draws its parts' pins itself (piece.tsx)
// keeps which thread is open, and its Escape, and draws its whole block's
// chips with PinChips.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pinLost, pinPart, placePin } from '../../../core/pins';
import type { Block, BlockVersion, Pin } from '../../../core/types';
import { useCanvas } from '../context';
import { PinChip, PinThread } from '../pins';
import { PairPinChip } from './ask';
import { useEscapeSteps } from './shell';
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
  const pins = useMemo(() => (version ? [] : (onBlock ?? []).filter((pin) => !pin.discussion?.resolved || pin.id === thread)), [onBlock, version, thread]);
  const open = pins.find((pin) => pin.id === thread && pin.discussion);

  const toggle = useCallback(
    (id: string) => {
      setThread((was) => (was === id ? null : id));
      seeItem(id);
    },
    [seeItem],
  );
  useEffect(() => {
    if (!pinId) return;
    setThread(pinId);
    requestAnimationFrame(() => foot.current?.querySelector(`[data-chip-pin="${CSS.escape(pinId)}"]`)?.scrollIntoView({ block: 'nearest' }));
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
      <PinChips block={block} pins={pins} open={thread} label={label} onToggle={toggle} />
      {open && <PinThread key={open.id} inline pin={open} block={block} name={name} onClose={() => setThread(null)} />}
    </footer>
  );
}

// A row of pins' chips under a piece, after `label`: a comment's chip opens
// its thread (`onToggle`), a card's opens the card. The view is of the whole
// block, so a chip names a part only for a pin on one, and says so when that
// part can't be found any more.
export function PinChips(props: { block: Block; pins: Pin[]; open: string | null; label?: string; onToggle(id: string): void }) {
  const { block, pins, open, label, onToggle } = props;
  const chip = (pin: Pin) => {
    const part = pin.anchor.kind === 'block' ? undefined : pinPart(pin, block);
    const lost = part && !placePin(block, pin) ? pinLost(pin, block) : undefined;
    return pin.discussion ? (
      <PairPinChip key={pin.id} pin={pin} open={pin.id === open} part={part} lost={lost} onToggle={() => onToggle(pin.id)} />
    ) : (
      <PinChip key={pin.id} pin={pin} part={part} lost={lost} />
    );
  };
  return (
    <div className="piece-apart-chips">
      {label && <span className="faint small">{label}</span>}
      {pins.map(chip)}
    </div>
  );
}
