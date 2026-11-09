// How much of a row of entries fits on one line, with a "N more" button at
// its end for the rest (apart.tsx). Entries keep their order; each is a
// heading (a section's name) or an item, at the width it is drawn at.

export interface RowEntry {
  width: number;
  heading?: boolean;
}

export interface RowFit {
  shown: number; // how many entries, from the first, the row shows
  squeeze: boolean; // whether the last of them is drawn narrower than its width, into the room left
}

// `room`: the row's width. `gap`: between two entries, and before the
// button. `more`: the button's width. `least`: the narrowest an item is
// drawn at when none fits whole: the first is then squeezed into what is
// left, so the row shows one at least, when there is that much room.
//
// Everything is shown when it all fits, with no button. Otherwise as many
// as fit before the button, but a heading isn't left at the end with none
// of its items after it: it goes with them.
export function fitInRow(entries: readonly RowEntry[], room: number, { gap, more, least }: { gap: number; more: number; least: number }): RowFit {
  const all = entries.reduce((sum, e, i) => sum + (i ? gap : 0) + e.width, 0);
  if (all <= room) return { shown: entries.length, squeeze: false };

  let used = 0;
  let shown = 0;
  for (const [i, entry] of entries.entries()) {
    const next = used + (i ? gap : 0) + entry.width;
    if (next + gap + more > room) break;
    used = next;
    shown = i + 1;
  }
  while (shown > 0 && entries[shown - 1].heading) shown--;
  if (entries.slice(0, shown).some((e) => !e.heading)) return { shown, squeeze: false };

  const first = entries.findIndex((e) => !e.heading);
  if (first < 0) return { shown: 0, squeeze: false };
  const before = entries.slice(0, first).reduce((sum, e) => sum + e.width + gap, 0);
  const button = entries.slice(first + 1).some((e) => !e.heading) ? gap + more : 0;
  if (before + least + button <= room) return { shown: first + 1, squeeze: true };
  return { shown: 0, squeeze: false };
}
