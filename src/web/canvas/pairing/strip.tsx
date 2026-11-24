// The row under a piece's full view (piece.tsx, blockPins.tsx, a website's
// siteView.tsx): the pins it draws no chip for on its part. Those on the
// whole block, those whose part can't be found any more, and, for a kind
// that marks its parts without a chip (a box on a picture, a cell, a node, a
// bar), its parts' own. One row, whatever their number: what still needs
// someone first (the agents' question back to the viewer, a request they are
// on, a note, open work), as many as fit, the rest under "N more" at its end.
// What is settled (a thread resolved, a request the agents answered, work
// done) folds into one "N done" after it, whose list opens each again; it
// carries the new-replies dot while one of them has news, as "N more" does.
//
// A chip opens its thread by it (`onOpen`, from the row or from a list); a
// card's opens the card. The row is laid out again as the view is resized and
// as a chip's width changes: each entry is measured at its whole width in a
// copy no one sees, and rowFit.ts says how many fit.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { pinStanding } from '../../../core/pairing';
import { pinComments, pinTarget } from '../../../core/pins';
import type { Pin } from '../../../core/types';
import { Icon, type IconName } from '../../shared/components';
import { useDismiss } from '../../shared/hooks';
import { OnTop, usePlace } from '../../shared/onTop';
import { ownedBy, useCanvas } from '../context';
import { PinChip } from '../pins';
import { PairPinChip } from './ask';
import { fitInRow, type RowFit } from './rowFit';

export interface StripPin {
  pin: Pin;
  part?: string; // its part, named short on its chip; none for a pin on the whole block
  lost?: string; // what happened to its part, said in the chip's title
}

const LEAST = 96; // px: a chip shown alone in a narrow row keeps this much of itself, or waits under More too
const UNPIN_ROOM = 14; // px: what a chip grows by as its ✕ slides out, on hover or focus (pins.css)
const SETTLED = 9;
const GONE = 10; // work pinned here that is no longer on the board: no chip

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function PinStrip(props: {
  pins: StripPin[];
  open: string | null; // the pin whose thread is open
  label?: string; // before the row: "On this comparison"
  noun?: string; // what unpinning one asks about: "this part"
  onOpen(pin: Pin, from: 'row' | 'list'): void;
}) {
  const { pins, open, label, noun, onOpen } = props;
  const canvas = useCanvas();
  const owner = ownedBy(canvas);

  // What needs someone, first: the agents asking the viewer something, a
  // request with them, a note, open work; what is settled is folded away.
  const rankOf = (pin: Pin): number => {
    if (!pin.discussion) {
      const target = pinTarget(canvas.board, pin);
      return !target ? GONE : target.done ? SETTLED : 3;
    }
    return { waiting: 0, working: 1, note: 2, answered: SETTLED, resolved: SETTLED }[pinStanding(pin, pinComments(pin, owner), canvas.viewer)];
  };
  const ranked = pins.map((entry, i) => ({ entry, i, rank: rankOf(entry.pin) }));
  const row = ranked
    .filter((r) => r.rank < SETTLED)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((r) => r.entry);
  const done = ranked.filter((r) => r.rank === SETTLED).map((r) => r.entry);

  const line = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<RowFit>({ shown: Infinity, squeeze: false });
  const slack = canvas.readOnly ? 0 : UNPIN_ROOM; // a chip's ✕ shows only to those who can unpin
  // The copy holds the button first (at its widest), then each entry.
  const refit = useRef(() => {});
  refit.current = () => {
    const room = line.current;
    const measured = copy.current;
    if (!room || !measured) return;
    const [button, ...drawn] = [...measured.children];
    if (!button) return;
    const width = (el: Element) => el.getBoundingClientRect().width;
    const next = fitInRow(
      drawn.map((el) => ({ width: width(el) })),
      width(room) - slack,
      { gap: parseFloat(getComputedStyle(measured).columnGap) || 0, more: width(button), least: LEAST },
    );
    setFit((was) => (was.shown === next.shown && was.squeeze === next.squeeze ? was : next));
  };
  const signature = row.map((e) => e.pin.id).join('|');
  const drawn = row.length > 0 || done.length > 0;
  useLayoutEffect(() => refit.current(), [signature, slack, drawn]);
  useEffect(() => {
    const observer = new ResizeObserver(() => refit.current());
    if (line.current) observer.observe(line.current);
    if (copy.current) observer.observe(copy.current);
    return () => observer.disconnect();
  }, [drawn]);

  if (!drawn) return null;
  const shown = row.slice(0, fit.shown);
  const hidden = row.slice(fit.shown);
  const fresh = (list: StripPin[]) => list.some((e) => e.pin.id !== open && !e.pin.discussion?.resolved && canvas.newItems.has(e.pin.id));
  const chip = (entry: StripPin, from: 'row' | 'list') =>
    entry.pin.discussion ? (
      <PairPinChip key={entry.pin.id} pin={entry.pin} open={entry.pin.id === open} part={entry.part} lost={entry.lost} noun={noun} onToggle={() => onOpen(entry.pin, from)} />
    ) : (
      <PinChip key={entry.pin.id} pin={entry.pin} part={entry.part} lost={entry.lost} />
    );

  return (
    <div className="pin-strip">
      {label && <span className="pin-strip-label">{label}</span>}
      <div className="pin-strip-row" ref={line}>
        <div className={`pin-strip-chips${fit.squeeze ? ' is-squeezed' : ''}`}>{shown.map((entry) => chip(entry, 'row'))}</div>
        {hidden.length > 0 && (
          <StripMenu
            className="pin-strip-more"
            label={`${hidden.length} more`}
            title={`${plural(hidden.length, 'more pin')}${fresh(hidden) ? ', with new replies' : ''}`}
            holds={hidden}
            open={open}
            fresh={fresh(hidden)}
          >
            {hidden.map((entry) => chip(entry, 'list'))}
          </StripMenu>
        )}
        <div className="pin-strip-copy" aria-hidden inert>
          <div className="pin-strip-copy-line" ref={copy}>
            <span className="pin-strip-button">
              {row.length} more
              <span className="pin-chip-new" />
            </span>
            {row.map((entry) => chip(entry, 'row'))}
          </div>
        </div>
      </div>
      {done.length > 0 && (
        <StripMenu
          className="pin-strip-done"
          icon="check"
          label={`${done.length} done`}
          title={`${plural(done.length, 'settled pin')}: threads resolved, requests answered and work done${fresh(done) ? ', with new replies' : ''}. Open one to see it again.`}
          holds={done}
          open={open}
          fresh={fresh(done)}
        >
          <p className="pin-strip-list-head">Done and resolved</p>
          {done.map((entry) => chip(entry, 'list'))}
        </StripMenu>
      )}
    </div>
  );
}

// "N more" or "N done", and the list it opens over itself, drawn on top. It
// names the pins it holds (data-strip-holds), so a thread opened from its
// list opens by it.
function StripMenu(props: { className: string; label: string; title: string; icon?: IconName; holds: StripPin[]; open: string | null; fresh?: boolean; children: ReactNode }) {
  const { className, label, title, icon, holds, open, fresh, children } = props;
  const [shown, setShown] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = useCallback((escape: boolean) => {
    setShown(false);
    if (escape) button.current?.focus({ preventScroll: true });
  }, []);
  useDismiss(shown, close, list, button);
  const style = usePlace(shown, button, list, { side: 'above', align: 'end', gap: 8 });
  useEffect(() => {
    if (shown) list.current?.querySelector<HTMLElement>('.pin-chip-open')?.focus({ preventScroll: true });
  }, [shown]);
  const holding = holds.some((e) => e.pin.id === open);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`pin-strip-button ${className}${holding ? ' is-open' : ''}`}
        data-strip-holds={holds.map((e) => e.pin.id).join(' ')}
        aria-expanded={shown}
        aria-haspopup="dialog"
        title={title}
        onClick={() => setShown((was) => !was)}
      >
        {icon && <Icon name={icon} />}
        {label}
        {fresh && <span className="pin-chip-new" aria-label="new replies" />}
      </button>
      {shown && (
        <OnTop from={button}>
          <div
            ref={list}
            className="pin-strip-list"
            style={style}
            role="dialog"
            aria-label={label}
            onClickCapture={(e) => {
              // A chip opens its thread or its card: the list has done its work,
              // and closes once the chip has had its click (closed now, before
              // the click reaches the chip, the chip would be gone).
              if ((e.target as Element).closest('.pin-chip-open')) setTimeout(() => setShown(false));
            }}
          >
            {children}
          </div>
        </OnTop>
      )}
    </>
  );
}

// Where a pin's chip is in a strip under `root`, or else the button holding
// it ("N more", "N done"): what a thread opened from there opens by.
export function stripAnchor(root: Element | null | undefined, id: string): Element | null {
  if (!root) return null;
  const at = CSS.escape(id);
  return root.querySelector(`.pin-strip-chips [data-chip-pin="${at}"]`) ?? root.querySelector(`[data-strip-holds~="${at}"]`);
}
