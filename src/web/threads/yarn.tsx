import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { Strand, StrandTone } from '../../core/homeConversation';
import { Icon } from '../shared/components';

// The yarn beside Home's conversation (timeline.tsx): the conversation is one
// strand, plied from the two yarns of Tricot's mark, with a knit stitch at each
// message; each thread an agent owns knits off it where it was sent on, wrapping
// it once over and under, runs down beside it in the colour of where its work
// stands (the same as its square in Work), and is tied off with a knot when it
// is done. With a thread open, its own strand runs in its lane beside its
// messages, wider and on a halo of its colour, and the conversation's rests
// behind it; each other thread still at work, waiting or not started runs
// faded down its own lane, where Home has it (core/homeConversation.ts
// strandsBeside), a way to its thread. Drawn over the gutter of what holds it,
// from where the rows in it are once laid out: the messages (`li[data-at]`, by when
// each was said), the cards that say where a thread was sent on
// (`[data-yarn-branch]`) and the relays of a thread's moments that need the
// viewer (`[data-yarn-relay]`, relayCard.tsx), which its strand stitches into.
// What it shows is said by the rows and by Work too; a strand is a quicker
// way to the thread it is. Pointing at one names it beside the pointer, and a
// click opens its thread in the main pane (timeline.tsx), as a control does,
// so a panel over the board stays open for it (dismissClick.ts); the strand
// the keyboard is on (`ring`) is ringed in focus blue and named. With a thread
// open, the conversation's strand is the way back to it (`onBack`), as
// "Conversation" and Esc are: pointing at it lifts it and says so.
// Time runs down it quietly, in the viewer's own clock, in words of its own
// drawing at the left of the conversation's strand: the hour, by the stitch of
// the first row said in it (`hours`), and each thread's own times, when it
// started beside where it knits off and when its work was done beside its
// knot; a strand's label says when its work ran. They scroll with it, under
// the ball.
// At the top, every strand that runs on past what is in view unwinds from a
// ball of yarn (`Unwound`, `YarnBall`), pinned over the scroller, which opens
// the threads list; the threads' icon is that ball drawn small.

// Where a thread's work stands, and its strand, are Home's conversation's (core/homeConversation.ts), which the terminal
// draws its own yarn from too.
export type { Strand, StrandTone } from '../../core/homeConversation';

const TRUNK_X = 34;
const LANE_X = 64; // the first lane
const LANE_GAP = 20;
const TRUNK_W = 9;
const LANE_W = 6;
const KNIT = 26; // how far down a strand turns from the conversation's into its lane
const DIM = 0.28;

// Each in the status colour of the task status nearest it (styles/base.css), as its square in Work is.
const TONES: Record<StrandTone, string> = { working: 'var(--status-in-progress)', waiting: 'var(--status-in-review)', review: 'var(--status-in-review)', todo: 'var(--status-to-do)', done: 'var(--status-done)' };
const mix = (color: string, pct: number, other = 'var(--bg)') => `color-mix(in srgb, ${color} ${pct}%, ${other})`;
const cleanId = (id: string) => id.replace(/[^\w-]/g, '');

// ---- time along the yarn ----------------------------------------------------

const WORDS_X = TRUNK_X - 11; // where the words at the left of the conversation's strand end: clear of its stitches and knots
const WORDS_REACH = 56; // how far left of the yarn they may reach ("Sat 12:59 PM"), which the scroller hides under the ball too

// Times in the viewer's own clock, as the rows' heads say them: "9:01 PM" where the clock runs to twelve, "21:01"
// elsewhere; and the hour a row was said in, "9 PM" or "21:00".
const clockFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const twelve = clockFormat.formatToParts(0).some((p) => p.type === 'dayPeriod');
const hourFormat = new Intl.DateTimeFormat([], twelve ? { hour: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
const clock = (t: number) => clockFormat.format(t);
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
// A moment's day, where what is around it does not say it: "Sat", or "Nov 14" past a week.
const dayWord = (t: number, now: number) => new Date(t).toLocaleDateString([], now - t < 6 * 86_400_000 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });

// A time drawn in the yarn: its period ("PM") a size smaller, after a thin space, to keep it short.
const clockWords = (format: Intl.DateTimeFormat, t: number): ReactNode[] =>
  format.formatToParts(t).map((p, i) => (p.type === 'dayPeriod' ? <tspan key={i} className="yarn-period">{p.value}</tspan> : p.type === 'literal' && !p.value.trim() ? '\u2009' : p.value));

// How long work ran, for its label after when ("21m", "1h 20m", "2d 3h").
function lasted(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// What a strand's label says after where its work stands, in the viewer's clock, with the day where it is not today:
// when its work ran, and how long ("done · 8:40 – 9:01 PM (21m)"), or when it started ("needs you · started 8:40 PM"),
// or, not started yet, since when it waits ("not started · since 8:40 PM").
export function whenOf(s: Strand, now: number): string {
  const from = Date.parse(s.from);
  if (Number.isNaN(from)) return '';
  const day = (t: number) => (sameDay(t, now) ? '' : `${dayWord(t, now)} `);
  const to = s.to ? Date.parse(s.to) : NaN;
  if (!(to >= from)) return ` · ${s.tone === 'todo' ? 'since' : 'started'} ${day(from)}${clock(from)}`;
  const range = sameDay(from, to) ? `${day(from)}${clockFormat.formatRange(from, to)}` : `${day(from)}${clock(from)} – ${day(to)}${clock(to)}`;
  return ` · ${range} (${lasted(to - from)})`;
}

// The plies each picture of yarn draws its lengths with, under its own `uid`.
function Plies({ uid }: { uid: string }) {
  return (
    <>
      <Ply id={`${uid}-trunk`} a="var(--brand-warp)" b="var(--brand-weft)" pitch={7} angle={34} />
      {(Object.keys(TONES) as StrandTone[]).map((tone) => (
        <Ply key={tone} id={`${uid}-${tone}`} a={TONES[tone]} b={mix(TONES[tone], 50)} pitch={7} angle={34} />
      ))}
      <Ply id={`${uid}-fibre`} a="transparent" b="rgb(255 255 255 / 0.28)" pitch={3.5} angle={-30} />
    </>
  );
}

// A length of yarn along `d`: its edge, its two plies and a light twist of fibre over them; dotted while not started.
// Its ends are rounded: one that runs on into a length drawn elsewhere is cut flush by a clip (Unwound), never
// drawn with square ends, which Safari left without their plies on a straight up-and-down length.
function length(uid: string, key: string, d: string, tone: StrandTone | 'trunk', width: number, dash = false): ReactNode {
  const color = tone === 'trunk' ? 'var(--brand-warp)' : TONES[tone];
  if (dash) return <path key={key} d={d} fill="none" style={{ stroke: color }} strokeWidth={width - 2} strokeLinecap="round" strokeDasharray="2 6" />;
  const edge = tone === 'trunk' ? mix('var(--brand-warp)', 55, 'var(--text)') : mix(color, 70, 'var(--text)');
  return (
    <g key={key}>
      <path d={d} fill="none" style={{ stroke: edge }} strokeWidth={width + 1.6} strokeLinecap="round" />
      <path d={d} fill="none" style={{ stroke: `url(#${uid}-${tone})` }} strokeWidth={width} strokeLinecap="round" />
      <path d={d} fill="none" style={{ stroke: `url(#${uid}-fibre)` }} strokeWidth={width - 2} strokeLinecap="round" />
    </g>
  );
}

// Where a strand's own lane runs, from the top of the rows: what the ball needs to unwind the ones that run on
// past what is in view.
export interface Span {
  id: string;
  x: number;
  knit?: number; // where it knits off the conversation's strand, when that is shown
  top: number;
  bottom: number;
  tone: StrandTone;
}

// Where a knit-off from the conversation's strand at `knit` to the lane at `x`
// crosses the height `y`, and which way it runs there: so a strand unwound
// from the ball while its knit-off is half in view meets what shows of it.
function acrossKnit(knit: number, x: number, y: number): { x: number; dx: number; dy: number } {
  const [x0, x1, x2, x3] = [TRUNK_X, TRUNK_X + 16, x, x];
  const [y0, y1, y2, y3] = [knit, knit, knit + 6, knit + KNIT];
  const at = (t: number, a: number, b: number, c: number, d: number) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
  const slope = (t: number, a: number, b: number, c: number, d: number) => 3 * (1 - t) ** 2 * (b - a) + 6 * (1 - t) * t * (c - b) + 3 * t ** 2 * (d - c);
  let [lo, hi] = [0, 1]; // the curve only goes down: halve to where it is at `y`
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, y0, y1, y2, y3) < y) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  const [dx, dy] = [slope(t, x0, x1, x2, x3), slope(t, y0, y1, y2, y3)];
  const n = Math.hypot(dx, dy) || 1;
  return { x: at(t, x0, x1, x2, x3), dx: dx / n, dy: dy / n };
}

// How wide the yarn is, for the rows' gutter: the conversation's strand and the lanes beside it, with room after the last.
export const gutterOf = (lanes: number): number => (lanes > 0 ? LANE_X + (lanes - 1) * LANE_GAP + 36 : TRUNK_X + 48);

interface Laid {
  height: number;
  rows: { at: number; top: number; bottom: number; mark: number }[];
  branches: Record<string, number>;
  relays: { id: string; y: number; edge: number }[]; // a relay of a thread: the height of its head, and its left edge
}

// Where the rows are in what holds them, from its top as it scrolls, and how
// tall what it holds is: its rows, never the yarn itself (its picture and its
// label), which would keep the height it had once the rows are fewer.
function measure(el: HTMLElement, yarn: SVGSVGElement): Laid {
  const top = el.getBoundingClientRect().top - el.scrollTop;
  const below = [...el.children].filter((child) => !child.classList.contains('yarn-part')).map((child) => child.getBoundingClientRect().bottom - top);
  const height = Math.max(el.clientHeight, ...below.map((bottom) => bottom + parseFloat(getComputedStyle(el).paddingBottom || '0')));
  const rows = [...el.querySelectorAll<HTMLElement>('li[data-at]')].map((row) => {
    const r = row.getBoundingClientRect();
    // The stitch: at the author's mark, or the first line of a bubble of the viewer's own.
    const badge = row.querySelector('.actor-mark');
    const bubble = badge ? null : row.querySelector('.thread-bubble');
    const m = (badge ?? bubble ?? row).getBoundingClientRect();
    return { at: Date.parse(row.dataset.at ?? ''), top: r.top - top, bottom: r.bottom - top, mark: m.top - top + (badge ? m.height / 2 : 18) };
  });
  const branches: Record<string, number> = {};
  for (const card of el.querySelectorAll<HTMLElement>('[data-yarn-branch]')) {
    const r = card.getBoundingClientRect();
    branches[card.dataset.yarnBranch!] ??= r.top - top + r.height / 2; // the first, where it knits off
  }
  const left = yarn.getBoundingClientRect().left;
  const relays = [...el.querySelectorAll<HTMLElement>('[data-yarn-relay]')].map((card) => {
    const r = card.getBoundingClientRect();
    return { id: card.dataset.yarnRelay!, y: Math.round(r.top - top + Math.min(r.height / 2, 20)), edge: Math.round(r.left - left) };
  });
  return { height: Math.round(height), rows, branches, relays };
}

interface Props {
  strands: readonly Strand[];
  lanes: ReadonlyMap<string, number>;
  version: string; // changes when what the rows show does
  lit?: string | null; // the strand pointed at, in Work or here, or the keyboard is on: the others fade
  ring?: string | null; // the strand the keyboard is on
  focus?: Strand | 'trunk'; // a thread open: its strand beside its messages, `strands` the others still running beside it; or the conversation's for one of its own
  onPick?: (id: string) => void;
  onLight?: (id: string | null) => void;
  onBack?: () => void; // a thread open: a click on the conversation's strand goes back to it
  onSpans?: (spans: Span[]) => void; // where each strand's lane runs, as it changes
  hours?: boolean; // the hour where it turns between the rows: Home's conversation, whose dividers say the day
}

export function Yarn({ strands, lanes, version, lit, ring, focus, onPick, onLight, onBack, onSpans, hours }: Props) {
  const uid = cleanId(useId());
  const svg = useRef<SVGSVGElement>(null);
  const [laid, setLaid] = useState<Laid | null>(null);
  const [pointed, setPointed] = useState<{ id: string; y: number } | null>(null); // the strand under the pointer, and where
  const [backAt, setBackAt] = useState<number | null>(null); // where the pointer is on the conversation's strand, with a thread open
  useLayoutEffect(() => {
    const yarn = svg.current;
    const el = yarn?.parentElement;
    if (!yarn || !el) return;
    const again = () => {
      const next = measure(el, yarn);
      setLaid((was) => (was && JSON.stringify(was) === JSON.stringify(next) ? was : next));
    };
    again();
    const observer = new ResizeObserver(again);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [version]);
  // Where the lanes run, told once drawn and only when it changed.
  const spans = useRef<Span[]>([]);
  const told = useRef('');
  useLayoutEffect(() => {
    const key = JSON.stringify(spans.current);
    if (!onSpans || key === told.current) return;
    told.current = key;
    onSpans(spans.current);
  });
  spans.current = [];
  if (!laid) return <svg ref={svg} className="yarn yarn-part" width={0} height={0} aria-hidden />;

  const { height, rows, branches } = laid;
  const last = rows.length ? Math.max(...rows.map((r) => r.bottom)) : 40;
  const end = last + 18; // just after the latest message: where work at it now is
  // Where a moment falls among the rows: just above the first said at it or after.
  const yAt = (iso: string): number | undefined => {
    const t = Date.parse(iso);
    if (rows.length && t < rows[0].at) return undefined; // before what is shown
    const row = rows.find((r) => r.at >= t);
    return row ? row.top - 6 : end;
  };
  // Where work done at `iso` is tied off: as `yAt`, but in the day it was done, so its time reads under that day's
  // divider: when the next row is of a later day, just after the row before. `dayed` when the rows it follows are of
  // another day, so its time says its day.
  const tieAt = (iso: string): { y: number; dayed: boolean } | undefined => {
    const y = yAt(iso);
    const t = Date.parse(iso);
    const i = rows.findIndex((r) => r.at >= t);
    if (y === undefined || (i >= 0 && sameDay(rows[i].at, t))) return y === undefined ? y : { y, dayed: false };
    const before = i < 0 ? rows.at(-1) : rows[i - 1];
    return before ? { y: i < 0 ? end : before.bottom + 10, dayed: !sameDay(before.at, t) } : { y, dayed: false };
  };

  const under: ReactNode[] = [];
  const over: ReactNode[] = [];
  const lines: ReactNode[] = [];
  const hits: ReactNode[] = [];
  const strand = (key: string, d: string, tone: StrandTone | 'trunk', width: number, dash = false) => length(uid, key, d, tone, width, dash);
  // A knit stitch, a V of two loops, where a message sits on its strand.
  const stitch = (key: string, x: number, y: number, tone: StrandTone | 'trunk') => {
    const ink = tone === 'trunk' ? mix('var(--brand-warp)', 60, 'var(--text)') : mix(TONES[tone], 70, 'var(--text)');
    const fill = tone === 'trunk' ? mix('var(--brand-warp)', 35) : mix(TONES[tone], 45);
    const loop = (side: 1 | -1) =>
      `M${x - 0.2 * side} ${y + 5.5} C ${x - 7 * side} ${y + 1}, ${x - 7 * side} ${y - 6}, ${x - 2.5 * side} ${y - 6.5} C ${x - 0.5 * side} ${y - 3}, ${x} ${y}, ${x - 0.2 * side} ${y + 5.5}Z`;
    return (
      <g key={key}>
        <path d={loop(1)} style={{ fill, stroke: ink }} strokeWidth={1.3} />
        <path d={loop(-1)} style={{ fill, stroke: ink }} strokeWidth={1.3} />
      </g>
    );
  };
  // Where a thread knits off the conversation's strand: it wraps it once, over and under, and curves out to its lane.
  const knitOff = (id: string, y: number, x: number, tone: StrandTone, opacity: number, w = LANE_W) => {
    const color = TONES[tone];
    lines.push(<g key={`k${id}`} opacity={opacity}>{strand('s', `M${TRUNK_X} ${y} C ${TRUNK_X + 16} ${y}, ${x} ${y + 6}, ${x} ${y + KNIT}`, tone, w, tone === 'todo')}</g>);
    if (tone === 'todo') return;
    under.push(<path key={`u${id}`} d={`M${TRUNK_X + 8} ${y - 3} A 9 5 0 0 0 ${TRUNK_X - 8} ${y - 3}`} fill="none" style={{ stroke: mix(color, 70, 'var(--text)') }} strokeWidth={4} opacity={opacity} />);
    over.push(<path key={`o${id}`} d={`M${TRUNK_X - 8} ${y - 3} A 9 5 0 0 0 ${TRUNK_X + 8} ${y + 1}`} fill="none" style={{ stroke: color }} strokeWidth={4} strokeLinecap="round" opacity={opacity} />);
  };
  // Where a thread's work is done: it comes back to the conversation's strand and is tied off with a knot, when it was
  // done beside it (`at`, with its day where the rows around it are of another).
  const doneAt: { id: string; y: number; at: number; dayed: boolean; opacity: number }[] = [];
  // When each thread started, beside where it knits off, in its strand's ink.
  const startAt: { id: string; y: number; at: number; tone: StrandTone; dayed: boolean; opacity: number }[] = [];
  const tieOff = (id: string, y: number, x: number, opacity: number, at?: number, dayed = false) => {
    if (at !== undefined && !Number.isNaN(at)) doneAt.push({ id, y, at, dayed, opacity });
    const color = TONES.done;
    const ink = mix(color, 70, 'var(--text)');
    lines.push(<g key={`t${id}`} opacity={opacity}>{strand('s', `M${x} ${y - KNIT} C ${x} ${y - 6}, ${TRUNK_X + 16} ${y}, ${TRUNK_X} ${y}`, 'done', LANE_W)}</g>);
    over.push(
      <g key={`n${id}`} opacity={opacity}>
        <path d={`M${TRUNK_X + 3} ${y + 4} q 9 5 14 15 M${TRUNK_X + 1} ${y + 5} q 3 8 1 16`} fill="none" style={{ stroke: color }} strokeWidth={3.2} strokeLinecap="round" />
        <circle cx={TRUNK_X} cy={y} r={7.5} style={{ fill: mix(color, 55), stroke: ink }} strokeWidth={2} />
        <path d={`M${TRUNK_X - 4} ${y - 2} q 4 6 8 0`} fill="none" style={{ stroke: ink }} strokeWidth={1.6} strokeLinecap="round" />
      </g>,
    );
  };
  const liveDot = (key: string, x: number, y: number, opacity = 1) => (
    <circle key={key} className="yarn-live" cx={x} cy={y} r={4.5} style={{ fill: 'var(--open)', stroke: 'var(--bg)' }} strokeWidth={2.5} opacity={opacity} />
  );
  const yOf = (event: { clientY: number }) => event.clientY - (svg.current?.getBoundingClientRect().top ?? 0);
  const hit = (s: Strand, d: string) =>
    onPick && (
      <path
        key={`h${s.id}`}
        className="yarn-hit"
        role="button"
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        onClick={() => {
          setPointed(null);
          onPick(s.id);
        }}
        onPointerEnter={(e) => {
          setPointed({ id: s.id, y: yOf(e) });
          onLight?.(s.id);
        }}
        onPointerMove={(e) => setPointed({ id: s.id, y: yOf(e) })}
        onPointerLeave={() => {
          setPointed(null);
          onLight?.(null);
        }}
      />
    );
  // With a thread open, the conversation's strand along `d` goes back to it:
  // pointed at, it is lifted on a halo under it and named.
  const trunkD = `M${TRUNK_X} -80 L ${TRUNK_X} ${height}`;
  const back = () => {
    if (!onBack) return;
    if (backAt !== null) under.push(<path key="halo" d={trunkD} fill="none" style={{ stroke: mix('var(--text)', 12, 'transparent') }} strokeWidth={TRUNK_W + 10} strokeLinecap="round" />);
    hits.push(
      <path
        key="back"
        className="yarn-hit"
        role="button"
        d={trunkD}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onClick={() => {
          setBackAt(null);
          onBack();
        }}
        onPointerEnter={(e) => setBackAt(yOf(e))}
        onPointerMove={(e) => setBackAt(yOf(e))}
        onPointerLeave={() => setBackAt(null)}
      />,
    );
  };
  // The ring round the strand the keyboard is on: its paths, drawn wider in focus blue under it.
  const rings: ReactNode[] = [];
  const ringed = (id: string, d: string) => {
    if (id === ring) rings.push(<path key={`r${rings.length}`} d={d} fill="none" style={{ stroke: 'var(--focus)' }} strokeWidth={LANE_W + 6} strokeLinecap="round" />);
  };
  // Where each strand is, for the label that names it: its lane and where it knits off.
  const placed = new Map<string, { x: number; y: number }>();

  let width: number;
  if (focus === 'trunk') {
    // One of the conversation's own threads open: its messages are stitches on the conversation's strand.
    width = gutterOf(0);
    back();
    rows.forEach((row, i) => over.push(stitch(`m${i}`, TRUNK_X, row.mark, 'trunk')));
  } else if (focus) {
    // A thread open: the conversation's strand rests behind, the thread's runs in its lane beside its messages, wider
    // and on a halo of its colour, and each other still running runs faded down its own, a way to its thread.
    const laneX = (id: string) => LANE_X + (lanes.get(id) ?? 0) * LANE_GAP;
    width = gutterOf(Math.max(...[focus, ...strands].map((s) => (lanes.get(s.id) ?? 0) + 1)));
    const x = laneX(focus.id);
    const own = `M${x} ${KNIT - 30} L ${x} ${height}`;
    back();
    under.push(<g key="trunk" opacity={backAt === null ? DIM : 1}>{strand('t', trunkD, 'trunk', TRUNK_W)}</g>);
    under.push(<path key="glow" d={own} fill="none" style={{ stroke: mix(TONES[focus.tone], 30, 'transparent') }} strokeWidth={LANE_W + 13} strokeLinecap="round" />);
    knitOff(focus.id, -30, x, focus.tone, 1, LANE_W + 3);
    lines.push(<g key="own">{strand('s', own, focus.tone, LANE_W + 3, focus.tone === 'todo')}</g>);
    rows.forEach((row, i) => over.push(stitch(`m${i}`, x, row.mark, focus.tone)));
    if (focus.live) over.push(liveDot('live', x, end));
    for (const s of strands) {
      if (s.id === focus.id || s.tone === 'done') continue;
      const sx = laneX(s.id);
      const d = `M${sx} -80 L ${sx} ${height}`;
      placed.set(s.id, { x: sx, y: 0 });
      lines.push(<g key={`l${s.id}`} opacity={pointed?.id === s.id || lit === s.id ? 1 : DIM}>{strand('s', d, s.tone, LANE_W, s.tone === 'todo')}</g>);
      hits.push(hit(s, d));
    }
  } else {
    width = gutterOf(Math.max(0, ...strands.map((s) => (lanes.get(s.id) ?? 0) + 1)));
    for (const s of strands) {
      const x = LANE_X + (lanes.get(s.id) ?? 0) * LANE_GAP;
      const opacity = lit && lit !== s.id ? DIM : 1;
      const knitAt = branches[s.id] ?? yAt(s.from);
      if (s.to && s.tone === 'done' && yAt(s.to) === undefined) continue; // done before what is shown
      const tie = s.to && s.tone === 'done' ? tieAt(s.to) : undefined;
      let tied = tie?.y;
      if (tied !== undefined && knitAt !== undefined) tied = Math.max(tied, knitAt + 2 * KNIT + 16);
      if (tied !== undefined && tied > end) tied = end;
      const top = knitAt === undefined ? -80 : knitAt + KNIT;
      const bottom = tied === undefined ? height : tied - KNIT;
      placed.set(s.id, { x, y: knitAt ?? Math.max(0, top) });
      if (knitAt !== undefined) {
        knitOff(s.id, knitAt, x, s.tone, opacity);
        ringed(s.id, `M${TRUNK_X} ${knitAt} C ${TRUNK_X + 16} ${knitAt}, ${x} ${knitAt + 6}, ${x} ${knitAt + KNIT}`);
        // Its day too, where the row it knits off in, or above, is of another.
        const from = Date.parse(s.from);
        const among = branches[s.id] !== undefined ? rows.findLast((r) => r.top <= knitAt) : (rows.find((r) => r.at >= from) ?? rows.at(-1));
        if (!Number.isNaN(from)) startAt.push({ id: s.id, y: knitAt, at: from, tone: s.tone, dayed: Boolean(among && !sameDay(among.at, from)), opacity });
      }
      if (bottom > top) {
        spans.current.push({ id: s.id, x, knit: knitAt, top, bottom, tone: s.tone });
        lines.push(<g key={`l${s.id}`} opacity={opacity}>{strand('s', `M${x} ${top} L ${x} ${bottom}`, s.tone, LANE_W, s.tone === 'todo')}</g>);
        ringed(s.id, `M${x} ${top} L ${x} ${bottom}`);
      }
      if (tied !== undefined) {
        tieOff(s.id, tied, x, opacity, Date.parse(s.to!), tie?.dayed);
        ringed(s.id, `M${x} ${tied - KNIT} C ${x} ${tied - 6}, ${TRUNK_X + 16} ${tied}, ${TRUNK_X} ${tied}`);
      }
      else if (s.live) over.push(liveDot(`v${s.id}`, x, end, opacity));
      // Where it is relayed into the conversation: a stitch on its lane, and a short length of it into the card's edge.
      for (const relay of laid.relays) {
        if (relay.id !== s.id || relay.y < top || relay.y > bottom) continue;
        lines.push(<g key={`r${s.id}${relay.y}`} opacity={opacity}>{strand('s', `M${x} ${relay.y} L ${relay.edge - 1} ${relay.y}`, s.tone, LANE_W - 1)}</g>);
        over.push(<g key={`rs${s.id}${relay.y}`} opacity={opacity}>{stitch('s', x, relay.y, s.tone)}</g>);
      }
      hits.push(hit(s, `M${x} ${Math.max(top - KNIT, -80)} L ${x} ${tied ?? height}`));
    }
    rows.forEach((row, i) => over.push(stitch(`m${i}`, TRUNK_X, row.mark, 'trunk')));
  }

  // Time, in the viewer's clock, in words at the left of the conversation's strand, each clear of the last: when each
  // thread's work was done, beside its knot (of two knots tied together, the one drawn over), when each started,
  // beside where it knits off, then the hour where it turns between the rows, by the stitch of the first row said in
  // it, unless a thread's time at that row or just above it already says a time in that hour. Rows hours apart have
  // one, the later hour; a day's first, under its divider, has its own; rows minutes apart, none.
  const times: ReactNode[] = [];
  const taken: { y: number; hour: number }[] = [];
  const hourOf = (t: number) => new Date(t).setMinutes(0, 0, 0);
  const now = Date.now();
  for (const k of doneAt.reverse()) {
    if (taken.some((w) => Math.abs(w.y - k.y) < 14)) continue;
    taken.push({ y: k.y, hour: hourOf(k.at) });
    times.push(
      <text key={`d${k.id}`} className="yarn-done" x={WORDS_X} y={k.y} dy="0.35em" textAnchor="end" opacity={k.opacity}>
        {k.dayed && `${dayWord(k.at, now)} `}
        {clockWords(clockFormat, k.at)}
      </text>,
    );
  }
  for (const k of startAt) {
    if (taken.some((w) => Math.abs(w.y - k.y) < 14)) continue;
    taken.push({ y: k.y, hour: hourOf(k.at) });
    times.push(
      <text key={`s${k.id}`} className={`yarn-start is-${k.tone}`} x={WORDS_X} y={k.y} dy="0.35em" textAnchor="end" opacity={k.opacity}>
        {k.dayed && `${dayWord(k.at, now)} `}
        {clockWords(clockFormat, k.at)}
      </text>,
    );
  }
  if (hours) {
    let hour = NaN;
    let last = -Infinity;
    let prev = -Infinity; // the stitch of the row before
    rows.forEach((row, i) => {
      const at = hourOf(row.at);
      const above = prev;
      const below = rows[i + 1]?.mark ?? Infinity;
      prev = row.mark;
      if (Number.isNaN(at) || at === hour) return;
      hour = at;
      // A thread's time in that hour already says it, at this row or just above it.
      if (taken.some((w) => w.hour === at && w.y > above && w.y < below)) return;
      if (row.mark - last < 28 || taken.some((w) => Math.abs(w.y - row.mark) < 14)) return;
      last = row.mark;
      times.push(
        <text key={`h${at}`} className="yarn-hour" x={WORDS_X} y={row.mark} dy="0.35em" textAnchor="end">
          {clockWords(hourFormat, at)}
        </text>,
      );
    });
  }

  // The label: the strand pointed at, beside the pointer; else the one the keyboard is on, where it knits off.
  const named = pointed ? strands.find((s) => s.id === pointed.id) : ring ? strands.find((s) => s.id === ring) : undefined;
  const at = named && (pointed?.id === named.id ? { x: placed.get(named.id)?.x ?? LANE_X, y: pointed.y } : placed.get(named.id));
  const label = named && at && (
    <span className="yarn-label yarn-part" style={{ left: at.x + 14, top: Math.max(0, at.y - 12) }} aria-hidden>
      <span className={`work-square is-${named.tone}`} />
      <span className="yarn-label-title">{named.title}</span>
      <span className="yarn-label-status">
        {named.status}
        {whenOf(named, now)}
      </span>
    </span>
  );
  const backLabel = onBack && backAt !== null && (
    <span className="yarn-label yarn-part is-back" style={{ left: TRUNK_X + 16, top: Math.max(0, backAt - 12) }} aria-hidden>
      <Icon name="arrow-left" />
      <span className="yarn-label-title">Back to the conversation</span>
    </span>
  );

  return (
    <>
    <svg ref={svg} className={`yarn yarn-part${lit ? ' is-lit' : ''}`} width={width} height={height} aria-hidden>
      <defs>
        <Plies uid={uid} />
      </defs>
      {under}
      {(!focus || focus === 'trunk') && strand('trunk', trunkD, 'trunk', TRUNK_W)}
      {rings}
      {lines}
      {over}
      {times}
      {hits}
    </svg>
    {label}
    {backLabel}
    </>
  );
}

// Two yarns in diagonal bands, as a twisted cord reads.
function Ply({ id, a, b, pitch, angle }: { id: string; a: string; b: string; pitch: number; angle: number }) {
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={pitch} height={pitch} patternTransform={`rotate(${angle})`}>
      <rect width={pitch} height={pitch} style={{ fill: a }} />
      <rect width={pitch / 2} height={pitch} style={{ fill: b }} />
    </pattern>
  );
}

// ---- the ball the strands unwind from ---------------------------------------

// The ball of yarn at the top of the yarn (timeline.tsx), centred on the
// conversation's strand, and where the strands unwound from it meet the yarn
// as drawn, from the top of what is in view.
const BALL = { x: TRUNK_X, y: 30, r: 17 };
const UNWOUND = 78;

// Where the yarn is drawn, for the page's rules laid out around it
// (timeline.css): where the conversation's strand runs in the gutter (the
// sheet's edge), the sheet's yarn side with three lanes (what the column is
// centred for on a narrow window), how far the times reach left of the
// strand, how far down the scroller the ball sits (the heads are level with
// it) and where its foot is (the head's band ends there), and how tall the
// band is that the unwound strands are drawn over (what the scroller hides
// under them). Set on Home, so its rules read these numbers rather than copy
// them; the gutter, which is each pane's, is set on the pane (--yarn-gutter,
// gutterOf).
export const yarnPlace = {
  '--yarn-trunk': `${TRUNK_X}px`,
  '--yarn-side': `${gutterOf(3) - TRUNK_X}px`,
  '--yarn-words': `${WORDS_REACH}px`,
  '--yarn-ball': `${BALL.y}px`,
  '--yarn-ball-foot': `${BALL.y + BALL.r}px`,
  '--yarn-unwound': `${UNWOUND}px`,
} as CSSProperties;

// Every strand that runs on past the top of what is in view, and the
// conversation's own, unwound from the ball around its lower right to where
// it goes on: its lane, or what shows of its knit-off while that is half
// under. Drawn over the scroller, not in it, whose mask hides the yarn under
// them (timeline.css: as tall as UNWOUND, from where the times reach to the
// gutter's end), so they stay as the conversation scrolls; where the strands
// run past is read as it scrolls. A click on one opens its thread, and
// pointing at one lights it, as on the yarn.
export function Unwound({ spans, scroller, width, lit, onPick, onLight }: {
  spans: readonly Span[];
  scroller: RefObject<HTMLElement | null>;
  width: number; // the yarn's gutter
  lit?: string | null;
  onPick?: (id: string) => void;
  onLight?: (id: string | null) => void;
}) {
  const uid = cleanId(useId());
  const [scrolled, setScrolled] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const again = () => setScrolled(el.scrollTop);
    again();
    el.addEventListener('scroll', again, { passive: true });
    return () => el.removeEventListener('scroll', again);
  }, [scroller]);
  // Each strand running past the top, where it goes on and which way: down its lane, or along its knit-off.
  const cut = scrolled + UNWOUND;
  const shown = spans
    .filter((s) => (s.knit ?? s.top) < cut && s.bottom > cut)
    .map((s) => ({ ...s, on: s.knit !== undefined && s.top > cut ? acrossKnit(s.knit, s.x, cut) : { x: s.x, dx: 0, dy: 1 } }))
    .sort((a, b) => a.x - b.x);
  const { x: bx, y: by, r } = BALL;
  return (
    <svg className="yarn-unwound" width={width} height={UNWOUND} aria-hidden>
      <defs>
        <Plies uid={uid} />
        {/* Where they stop: flush, a pixel into the yarn the cover's foot shows, so they meet it without a seam. */}
        <clipPath id={`${uid}-cut`}>
          <rect x={-8} y={-8} width={width + 16} height={UNWOUND + 9} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${uid}-cut)`}>
        {shown.map((s, i) => {
          const a = ((12 + i * (70 / Math.max(1, shown.length - 1))) * Math.PI) / 180;
          const sx = +(bx + r * 0.8 * Math.sin(a)).toFixed(1);
          const sy = +(by + r * 0.8 * Math.cos(a)).toFixed(1);
          const [ex, cx, cy] = [s.on.x, s.on.x - s.on.dx * 26, UNWOUND - s.on.dy * 26].map((n) => +n.toFixed(1));
          // On past the cover's foot, the way it goes there, and cut flush a pixel under it (`cut`): it runs on into
          // the yarn under the cover without a seam. Its other end is under the ball.
          const d = `M${sx} ${sy} C ${sx + 6} ${sy + 14}, ${cx} ${cy}, ${ex} ${UNWOUND} l ${+(s.on.dx * 6).toFixed(2)} ${+(s.on.dy * 6).toFixed(2)}`;
          return (
            <g key={s.id} opacity={lit && lit !== s.id ? DIM : 1}>
              {length(uid, 's', d, s.tone, LANE_W, s.tone === 'todo')}
              {onPick && (
                <path
                  className="yarn-hit"
                  role="button"
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  onClick={() => onPick(s.id)}
                  onPointerEnter={() => onLight?.(s.id)}
                  onPointerLeave={() => onLight?.(null)}
                />
              )}
            </g>
          );
        })}
        {length(uid, 'trunk', `M${bx} ${by + 10} L ${bx} ${UNWOUND + 6}`, 'trunk', TRUNK_W)}
      </g>
    </svg>
  );
}

// The ball itself: a light core wound over with the mark's two yarns, in
// passes at two angles, under a ring. The threads' icon (shared/components.tsx
// `thread`) is it drawn at icon size, its end running off along the foot.
export function YarnBall() {
  const uid = cleanId(useId());
  const { r } = BALL;
  const c = r + 3; // the ball's centre in its own box, with room for the button's ring
  const winds: ReactNode[] = [];
  const pass = (angle: number, offsets: number[], yarn: 'warp' | 'weft', bend: number) =>
    offsets.forEach((off) => {
      const rad = (angle * Math.PI) / 180;
      const [dx, dy, nx, ny, l] = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), r + 4];
      const at = (along: number, across: number) => `${(c + nx * across + dx * along).toFixed(1)} ${(c + ny * across + dy * along).toFixed(1)}`;
      winds.push(<path key={`${yarn}${off}`} d={`M${at(-l, off)} Q ${at(0, off + bend)} ${at(l, off)}`} fill="none" style={{ stroke: `var(--brand-${yarn})` }} strokeWidth={2} strokeLinecap="round" />);
    });
  pass(28, [-13, -8.5, -4, 0.5, 5, 9.5, 14], 'warp', 5);
  pass(118, [-2, 2.5, 7, 11.5], 'weft', 4);
  const ring = mix('var(--brand-warp)', 60, 'var(--text)');
  return (
    <svg className="yarn-ball" width={2 * c} height={2 * c} viewBox={`0 0 ${2 * c} ${2 * c}`} aria-hidden>
      <defs>
        <clipPath id={`${uid}-ball`}>
          <circle cx={c} cy={c} r={r - 0.6} />
        </clipPath>
      </defs>
      <circle cx={c} cy={c} r={r} style={{ fill: mix('var(--brand-warp)', 24) }} />
      <g clipPath={`url(#${uid}-ball)`}>{winds}</g>
      <circle cx={c} cy={c} r={r} fill="none" style={{ stroke: ring }} strokeWidth={1.4} />
    </svg>
  );
}
