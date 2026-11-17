// The wordmark at the top of the Tricot tab: TRICOT, two rows of block
// characters, knitted up a stitch at a time as the switcher opens, and then
// there for good. "Tricot" is French for knitting, so it grows as knitting
// does: from the bottom, the bottom row first, left to right, then the top
// row. A stitch is one character cell of the wordmark (the gaps between
// letters are skipped, as no stitch is made there). The stitch being knitted
// shows dim for a frame before it turns bold.
//
//    ▀█▀ █▀▄ █ █▀▀ █▀█ ▀█▀   Tricot roadmap
//     █  █▀▄ █ █▄▄ █▄█  █    http://127.0.0.1:4545
//
// The knitting takes under a second and plays once; then the wordmark is
// whole, and stays, the board's title and Tricot's address beside it (the
// tab draws those, tabView.ts). Everything here is a pure function of how
// long the knitting has played: the tab decides when it starts, and the host
// only asks when to draw next.
import { BOLD, DIM, type Part } from './tabView';

const TOP = '▀█▀ █▀▄ █ █▀▀ █▀█ ▀█▀';
const BOTTOM = ' █  █▀▄ █ █▄▄ █▄█  █ '; // to the top row's width: the address beside it starts where the title does

const STITCH_MS = 32; // one stitch, and so one frame

// The window it needs: the wordmark, and beside it room for the title and
// an address (24 columns: http://127.0.0.1:4545 whole); and rows enough
// that the tab keeps what matters below it. In less, the tab draws its
// one-line header.
const MIN_COLS = 50;
const MIN_ROWS = 10;

const cellsOf = (glyphs: string): number[] => [...glyphs].flatMap((ch, at) => (ch === ' ' ? [] : [at]));
const BOTTOM_CELLS = cellsOf(BOTTOM);
const TOP_CELLS = cellsOf(TOP);
const STITCHES = BOTTOM_CELLS.length + TOP_CELLS.length;

// How long the knitting plays, in all: from then on the wordmark is whole.
export const KNIT_MS = STITCHES * STITCH_MS;

// Whether this window has room for it.
export const wordmarkFits = (cols: number, rows: number): boolean => cols >= MIN_COLS && rows >= MIN_ROWS;

// One row of the wordmark, a margin at its left, each stitch in the look
// `look` gives it (none: not there yet, a space); always the wordmark's
// full width, so what is drawn beside it never moves.
function row(glyphs: string, stitches: number[], look: (stitch: number) => string | undefined): Part[] {
  const parts: Part[] = [[' ']];
  [...glyphs].forEach((ch, at) => {
    const sgr = stitches.includes(at) ? look(stitches.indexOf(at)) : undefined;
    const text = sgr ? ch : ' ';
    const last = parts[parts.length - 1];
    if (last[1] === sgr) last[0] += text;
    else parts.push([text, sgr]);
  });
  return parts;
}

// The look of a row's stitches with `made` of them knitted, and the next one being knitted when `knitting`.
const knit = (made: number, knitting: boolean) => (stitch: number) => (stitch < made ? BOLD : knitting && stitch === made ? DIM : undefined);

// The two rows of the wordmark, top first, `elapsed` ms into its knitting:
// whole from KNIT_MS on, and when no time is given.
export function wordmarkRows(elapsed = KNIT_MS): [Part[], Part[]] {
  const done = Math.min(STITCHES, Math.max(0, Math.floor(elapsed / STITCH_MS)));
  const knitting = done < STITCHES;
  const bottom = row(BOTTOM, BOTTOM_CELLS, knit(done, knitting && done < BOTTOM_CELLS.length));
  const top = row(TOP, TOP_CELLS, knit(done - BOTTOM_CELLS.length, knitting && done >= BOTTOM_CELLS.length));
  return [top, bottom];
}

// How long until the knitting's next stitch, in ms, `elapsed` after it began; none once it is over.
export function wordmarkNext(elapsed: number): number | undefined {
  if (elapsed >= KNIT_MS) return undefined;
  return Math.max(1, (Math.floor(elapsed / STITCH_MS) + 1) * STITCH_MS - elapsed);
}
