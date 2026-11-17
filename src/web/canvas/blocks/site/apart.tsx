// The strip under a website's full view (siteView.tsx): the threads not drawn
// on an element, lost from this page or on another page, each section after
// its name, in one row however many there are. As many as fit are shown, in
// order; the rest wait under "N more" at the row's end, whose popover lists
// them, each opening its thread as it does from the row. The row is laid out
// again as the view is resized and as a chip's width changes (a comment
// more, resolved): each entry is measured at its whole width in a copy no
// one sees, and rowFit.ts says how many fit.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Pin } from '../../../../core/types';
import { Popover } from '../../../shared/components';
import { useCanvas } from '../../context';
import { SitePinChip } from './pins';
import { fitInRow, type RowFit } from './rowFit';

export interface ApartPin {
  pin: Pin;
  part: string; // the element, named on its chip
  lost?: string; // what happened to it
  onToggle: () => void; // opens its thread, or closes it
}
export interface ApartGroup {
  label: string;
  pins: ApartPin[];
}

const LEAST = 96; // px: a chip shown alone in a narrow row keeps this much of itself, or waits under More too
const UNPIN_ROOM = 14; // px: what a chip grows by as its ✕ slides out, on hover or focus (pins.css)

type Entry = { heading: string } | ApartPin;
const isPin = (entry: Entry): entry is ApartPin => 'pin' in entry;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ApartStrip({ groups, open }: { groups: ApartGroup[]; open: string | null }) {
  const canvas = useCanvas();
  const row = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<RowFit>({ shown: Infinity, squeeze: false });
  const entries: Entry[] = groups.flatMap((g) => [{ heading: g.label }, ...g.pins]);
  const total = entries.filter(isPin).length;
  // A chip's ✕ shows only to those who can unpin.
  const slack = canvas.readOnly ? 0 : UNPIN_ROOM;

  // The copy holds the button first (at its widest), then each entry.
  const refit = useRef(() => {});
  refit.current = () => {
    const line = row.current;
    const measured = copy.current;
    if (!line || !measured) return;
    const [button, ...drawn] = [...measured.children];
    if (!button) return;
    const width = (el: Element) => el.getBoundingClientRect().width;
    const next = fitInRow(
      drawn.map((el) => ({ width: width(el), heading: el.classList.contains('site-view-apart-heading') })),
      width(line) - slack,
      { gap: parseFloat(getComputedStyle(measured).columnGap) || 0, more: width(button), least: LEAST },
    );
    setFit((was) => (was.shown === next.shown && was.squeeze === next.squeeze ? was : next));
  };
  const signature = entries.map((e) => (isPin(e) ? e.pin.id : `#${e.heading}`)).join('|');
  useLayoutEffect(() => refit.current(), [signature, slack]);
  useEffect(() => {
    const observer = new ResizeObserver(() => refit.current());
    if (row.current) observer.observe(row.current);
    if (copy.current) observer.observe(copy.current);
    return () => observer.disconnect();
  }, []);

  const shown = entries.slice(0, fit.shown);
  const hidden = entries.slice(fit.shown).filter(isPin);
  const under = groups.map((g) => ({ label: g.label, pins: g.pins.filter((p) => hidden.includes(p)) })).filter((g) => g.pins.length > 0);
  const openUnder = hidden.some((p) => p.pin.id === open);
  const freshUnder = hidden.some((p) => p.pin.id !== open && !p.pin.discussion?.resolved && canvas.newItems.has(p.pin.id));

  const draw = (entry: Entry, onToggle?: (p: ApartPin) => void) =>
    isPin(entry) ? (
      <SitePinChip key={entry.pin.id} pin={entry.pin} open={entry.pin.id === open} part={entry.part} lost={entry.lost} onToggle={() => (onToggle ?? ((p) => p.onToggle()))(entry)} />
    ) : (
      <span key={`#${entry.heading}`} className="faint small site-view-apart-heading">
        {entry.heading}
      </span>
    );

  return (
    <div className="site-view-apart-row" ref={row}>
      <div className={`site-view-apart-chips${fit.squeeze ? ' is-squeezed' : ''}`}>{shown.map((entry) => draw(entry))}</div>
      {hidden.length > 0 && (
        <Popover className="site-view-apart-more">
          {(close) => (
            <>
              <summary className={`site-view-apart-more-button${openUnder ? ' is-open' : ''}`} title={`${plural(hidden.length, 'more pinned element')}${freshUnder ? ', with new replies' : ''}`}>
                {hidden.length} more
                {freshUnder && <span className="pin-chip-new" aria-label="new replies" />}
              </summary>
              <div className="popover-body site-view-apart-list">
                {under.map((g) => (
                  <section key={g.label} aria-label={g.label}>
                    <h3 className="faint small site-view-apart-heading">{g.label}</h3>
                    <ul>
                      {g.pins.map((p) => (
                        <li key={p.pin.id}>
                          {draw(p, (picked) => {
                            close();
                            picked.onToggle();
                          })}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </Popover>
      )}
      <div className="site-view-apart-copy" aria-hidden inert>
        <div className="site-view-apart-copy-line" ref={copy}>
          <span className="site-view-apart-more-button">
            {total} more
            <span className="pin-chip-new" />
          </span>
          {entries.map((entry) => draw(entry))}
        </div>
      </div>
    </div>
  );
}
