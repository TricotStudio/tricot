import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../shared/components';

// The yarn beside Home's conversation (timeline.tsx): the conversation is one
// strand, plied from the two yarns of Tricot's mark, with a knit stitch at each
// message; each thread an agent owns knits off it where it was sent on, wrapping
// it once over and under, runs down beside it in the colour of where its work
// stands (the same as its square in Work), and is tied off with a knot when it
// is done. With a thread open, its own strand runs beside its messages and the
// conversation's rests behind it. Drawn over the gutter of what holds it, from
// where the rows in it are once laid out: the messages (`li[data-at]`, by when
// each was said) and the cards that say where a thread was sent on
// (`[data-yarn-branch]`).
// What it shows is said by the rows and by Work too; a strand is a quicker
// way to the thread it is. Pointing at one names it beside the pointer, and a
// click opens its thread in the main pane (timeline.tsx), as a control does,
// so a panel over the board stays open for it (dismissClick.ts); the strand
// the keyboard is on (`ring`) is ringed in focus blue and named. With a thread
// open, the conversation's strand is the way back to it (`onBack`), as
// "Conversation" and Esc are: pointing at it lifts it and says so.

export type StrandTone = 'working' | 'waiting' | 'todo' | 'done';

export interface Strand {
  id: string; // the thread's
  title: string;
  status: string; // where its work stands, in words: "at work · 2/5", "needs you"
  tone: StrandTone;
  from: string; // when it was started: where it knits off, unless a card in the rows says
  to?: string; // when its work was done: where it is tied off
  live: boolean; // its agent has a step there now: a dot at its end
}

const TRUNK_X = 34;
const LANE_X = 64; // the first lane
const LANE_GAP = 20;
const TRUNK_W = 9;
const LANE_W = 6;
const KNIT = 26; // how far down a strand turns from the conversation's into its lane
const DIM = 0.28;

// Each in the status colour of the task status nearest it (styles/base.css), as its square in Work is.
const TONES: Record<StrandTone, string> = { working: 'var(--status-in-progress)', waiting: 'var(--status-in-review)', todo: 'var(--status-to-do)', done: 'var(--status-done)' };
const mix = (color: string, pct: number, other = 'var(--bg)') => `color-mix(in srgb, ${color} ${pct}%, ${other})`;

// Each strand's lane, by when it ran: the lowest lane free since the strand
// before it there was tied off.
export function lanesOf(strands: readonly Strand[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const freeAt: number[] = []; // by lane, when its last strand ended (Infinity while one runs)
  for (const strand of [...strands].sort((a, b) => a.from.localeCompare(b.from))) {
    const from = Date.parse(strand.from);
    let lane = freeAt.findIndex((end) => end < from);
    if (lane < 0) lane = freeAt.length;
    freeAt[lane] = strand.to ? Date.parse(strand.to) : Infinity;
    lanes.set(strand.id, lane);
  }
  return lanes;
}

// How wide the yarn is, for the rows' gutter: the conversation's strand and the lanes beside it, with room after the last.
export const gutterOf = (lanes: number): number => (lanes > 0 ? LANE_X + (lanes - 1) * LANE_GAP + 36 : TRUNK_X + 48);

interface Laid {
  height: number;
  rows: { at: number; top: number; bottom: number; mark: number }[];
  branches: Record<string, number>;
}

// Where the rows are in what holds them, from its top as it scrolls, and how
// tall what it holds is: its rows, never the yarn itself (its picture and its
// label), which would keep the height it had once the rows are fewer.
function measure(el: HTMLElement): Laid {
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
  return { height: Math.round(height), rows, branches };
}

interface Props {
  strands: readonly Strand[];
  lanes: ReadonlyMap<string, number>;
  version: string; // changes when what the rows show does
  lit?: string | null; // the strand pointed at, in Work or here, or the keyboard is on: the others fade
  ring?: string | null; // the strand the keyboard is on
  focus?: Strand | 'trunk'; // a thread open: its strand alone beside its messages, or the conversation's for one of its own
  onPick?: (id: string) => void;
  onLight?: (id: string | null) => void;
  onBack?: () => void; // a thread open: a click on the conversation's strand goes back to it
}

export function Yarn({ strands, lanes, version, lit, ring, focus, onPick, onLight, onBack }: Props) {
  const uid = useId().replace(/[^\w-]/g, '');
  const svg = useRef<SVGSVGElement>(null);
  const [laid, setLaid] = useState<Laid | null>(null);
  const [pointed, setPointed] = useState<{ id: string; y: number } | null>(null); // the strand under the pointer, and where
  const [backAt, setBackAt] = useState<number | null>(null); // where the pointer is on the conversation's strand, with a thread open
  useLayoutEffect(() => {
    const yarn = svg.current;
    const el = yarn?.parentElement;
    if (!yarn || !el) return;
    const again = () => {
      const next = measure(el);
      setLaid((was) => (was && JSON.stringify(was) === JSON.stringify(next) ? was : next));
    };
    again();
    const observer = new ResizeObserver(again);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [version]);
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

  const under: ReactNode[] = [];
  const over: ReactNode[] = [];
  const lines: ReactNode[] = [];
  const hits: ReactNode[] = [];
  const ply = (tone: StrandTone | 'trunk') => `url(#${uid}-${tone})`;

  // A length of yarn along `d`: its edge, its two plies and a light twist of fibre over them; dotted while not started.
  const strand = (key: string, d: string, tone: StrandTone | 'trunk', width: number, dash = false) => {
    const color = tone === 'trunk' ? 'var(--brand-warp)' : TONES[tone];
    if (dash) return <path key={key} d={d} fill="none" style={{ stroke: color }} strokeWidth={width - 2} strokeLinecap="round" strokeDasharray="2 6" />;
    const edge = tone === 'trunk' ? mix('var(--brand-warp)', 55, 'var(--text)') : mix(color, 70, 'var(--text)');
    return (
      <g key={key}>
        <path d={d} fill="none" style={{ stroke: edge }} strokeWidth={width + 1.6} strokeLinecap="round" />
        <path d={d} fill="none" style={{ stroke: ply(tone) }} strokeWidth={width} strokeLinecap="round" />
        <path d={d} fill="none" style={{ stroke: `url(#${uid}-fibre)` }} strokeWidth={width - 2} strokeLinecap="round" />
      </g>
    );
  };
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
  const knitOff = (id: string, y: number, x: number, tone: StrandTone, opacity: number) => {
    const color = TONES[tone];
    lines.push(<g key={`k${id}`} opacity={opacity}>{strand('s', `M${TRUNK_X} ${y} C ${TRUNK_X + 16} ${y}, ${x} ${y + 6}, ${x} ${y + KNIT}`, tone, LANE_W, tone === 'todo')}</g>);
    if (tone === 'todo') return;
    under.push(<path key={`u${id}`} d={`M${TRUNK_X + 8} ${y - 3} A 9 5 0 0 0 ${TRUNK_X - 8} ${y - 3}`} fill="none" style={{ stroke: mix(color, 70, 'var(--text)') }} strokeWidth={4} opacity={opacity} />);
    over.push(<path key={`o${id}`} d={`M${TRUNK_X - 8} ${y - 3} A 9 5 0 0 0 ${TRUNK_X + 8} ${y + 1}`} fill="none" style={{ stroke: color }} strokeWidth={4} strokeLinecap="round" opacity={opacity} />);
  };
  // Where a thread's work is done: it comes back to the conversation's strand and is tied off with a knot.
  const tieOff = (id: string, y: number, x: number, opacity: number) => {
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
    // A thread open: the conversation's strand rests behind, and the thread's runs beside its messages.
    width = gutterOf(1);
    const x = LANE_X;
    back();
    under.push(<g key="trunk" opacity={backAt === null ? DIM : 1}>{strand('t', trunkD, 'trunk', TRUNK_W)}</g>);
    knitOff(focus.id, -30, x, focus.tone, 1);
    lines.push(<g key="own">{strand('s', `M${x} ${KNIT - 30} L ${x} ${height}`, focus.tone, LANE_W, focus.tone === 'todo')}</g>);
    rows.forEach((row, i) => over.push(stitch(`m${i}`, x, row.mark, focus.tone)));
    if (focus.live) over.push(liveDot('live', x, end));
  } else {
    width = gutterOf(Math.max(0, ...strands.map((s) => (lanes.get(s.id) ?? 0) + 1)));
    for (const s of strands) {
      const x = LANE_X + (lanes.get(s.id) ?? 0) * LANE_GAP;
      const opacity = lit && lit !== s.id ? DIM : 1;
      const knitAt = branches[s.id] ?? yAt(s.from);
      if (s.to && s.tone === 'done' && yAt(s.to) === undefined) continue; // done before what is shown
      let tied = s.to && s.tone === 'done' ? yAt(s.to) : undefined;
      if (tied !== undefined && knitAt !== undefined) tied = Math.max(tied, knitAt + 2 * KNIT + 16);
      if (tied !== undefined && tied > end) tied = end;
      const top = knitAt === undefined ? -80 : knitAt + KNIT;
      const bottom = tied === undefined ? height : tied - KNIT;
      placed.set(s.id, { x, y: knitAt ?? Math.max(0, top) });
      if (knitAt !== undefined) {
        knitOff(s.id, knitAt, x, s.tone, opacity);
        ringed(s.id, `M${TRUNK_X} ${knitAt} C ${TRUNK_X + 16} ${knitAt}, ${x} ${knitAt + 6}, ${x} ${knitAt + KNIT}`);
      }
      if (bottom > top) {
        lines.push(<g key={`l${s.id}`} opacity={opacity}>{strand('s', `M${x} ${top} L ${x} ${bottom}`, s.tone, LANE_W, s.tone === 'todo')}</g>);
        ringed(s.id, `M${x} ${top} L ${x} ${bottom}`);
      }
      if (tied !== undefined) {
        tieOff(s.id, tied, x, opacity);
        ringed(s.id, `M${x} ${tied - KNIT} C ${x} ${tied - 6}, ${TRUNK_X + 16} ${tied}, ${TRUNK_X} ${tied}`);
      }
      else if (s.live) over.push(liveDot(`v${s.id}`, x, end, opacity));
      hits.push(hit(s, `M${x} ${Math.max(top - KNIT, -80)} L ${x} ${tied ?? height}`));
    }
    rows.forEach((row, i) => over.push(stitch(`m${i}`, TRUNK_X, row.mark, 'trunk')));
  }

  // The label: the strand pointed at, beside the pointer; else the one the keyboard is on, where it knits off.
  const named = pointed ? strands.find((s) => s.id === pointed.id) : ring ? strands.find((s) => s.id === ring) : undefined;
  const at = named && (pointed?.id === named.id ? { x: placed.get(named.id)?.x ?? LANE_X, y: pointed.y } : placed.get(named.id));
  const label = named && at && (
    <span className="yarn-label yarn-part" style={{ left: at.x + 14, top: Math.max(0, at.y - 12) }} aria-hidden>
      <span className={`work-square is-${named.tone}`} />
      <span className="yarn-label-title">{named.title}</span>
      <span className="yarn-label-status">{named.status}</span>
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
        <Ply id={`${uid}-trunk`} a="var(--brand-warp)" b="var(--brand-weft)" pitch={7} angle={34} />
        {(Object.keys(TONES) as StrandTone[]).map((tone) => (
          <Ply key={tone} id={`${uid}-${tone}`} a={TONES[tone]} b={mix(TONES[tone], 50)} pitch={7} angle={34} />
        ))}
        <Ply id={`${uid}-fibre`} a="transparent" b="rgb(255 255 255 / 0.28)" pitch={3.5} angle={-30} />
      </defs>
      {under}
      {(!focus || focus === 'trunk') && strand('trunk', trunkD, 'trunk', TRUNK_W)}
      {rings}
      {lines}
      {over}
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
