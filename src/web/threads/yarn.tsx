import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
// It is a picture: what it shows is said by the rows and by Work, and a strand
// is only a quicker way to the thread it is.

export type StrandTone = 'working' | 'waiting' | 'todo' | 'done';

export interface Strand {
  id: string; // the thread's
  title: string;
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

const TONES: Record<StrandTone, string> = { working: 'var(--strand-work)', waiting: 'var(--open)', todo: 'var(--faint)', done: 'var(--decided)' };
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
// tall what it holds is: its rows, never the yarn itself, which would keep the
// height it had once the rows are fewer.
function measure(el: HTMLElement, yarn: Element): Laid {
  const top = el.getBoundingClientRect().top - el.scrollTop;
  const below = [...el.children].filter((child) => child !== yarn).map((child) => child.getBoundingClientRect().bottom - top);
  const height = Math.max(el.clientHeight, ...below.map((bottom) => bottom + parseFloat(getComputedStyle(el).paddingBottom || '0')));
  const rows = [...el.querySelectorAll<HTMLElement>('li[data-at]')].map((row) => {
    const r = row.getBoundingClientRect();
    const mark = (row.querySelector('.actor-mark') ?? row).getBoundingClientRect();
    return { at: Date.parse(row.dataset.at ?? ''), top: r.top - top, bottom: r.bottom - top, mark: mark.top - top + mark.height / 2 };
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
  lit?: string | null; // the strand pointed at, in Work or here: the others fade
  focus?: Strand | 'trunk'; // a thread open: its strand alone beside its messages, or the conversation's for one of its own
  onPick?: (id: string) => void;
  onLight?: (id: string | null) => void;
}

export function Yarn({ strands, lanes, version, lit, focus, onPick, onLight }: Props) {
  const uid = useId().replace(/[^\w-]/g, '');
  const svg = useRef<SVGSVGElement>(null);
  const [laid, setLaid] = useState<Laid | null>(null);
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
  if (!laid) return <svg ref={svg} className="yarn" width={0} height={0} aria-hidden />;

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
  const hit = (s: Strand, d: string) =>
    onPick && (
      <path
        key={`h${s.id}`}
        className="yarn-hit"
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        onClick={() => onPick(s.id)}
        onPointerEnter={() => onLight?.(s.id)}
        onPointerLeave={() => onLight?.(null)}
      >
        <title>{s.title}</title>
      </path>
    );

  let width: number;
  if (focus === 'trunk') {
    // One of the conversation's own threads open: its messages are stitches on the conversation's strand.
    width = gutterOf(0);
    rows.forEach((row, i) => over.push(stitch(`m${i}`, TRUNK_X, row.mark, 'trunk')));
  } else if (focus) {
    // A thread open: the conversation's strand rests behind, and the thread's runs beside its messages.
    width = gutterOf(1);
    const x = LANE_X;
    under.push(<g key="trunk" opacity={DIM}>{strand('t', `M${TRUNK_X} -80 L ${TRUNK_X} ${height}`, 'trunk', TRUNK_W)}</g>);
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
      if (knitAt !== undefined) knitOff(s.id, knitAt, x, s.tone, opacity);
      if (bottom > top) lines.push(<g key={`l${s.id}`} opacity={opacity}>{strand('s', `M${x} ${top} L ${x} ${bottom}`, s.tone, LANE_W, s.tone === 'todo')}</g>);
      if (tied !== undefined) tieOff(s.id, tied, x, opacity);
      else if (s.live) over.push(liveDot(`v${s.id}`, x, end, opacity));
      hits.push(hit(s, `M${x} ${Math.max(top - KNIT, -80)} L ${x} ${tied ?? height}`));
    }
    rows.forEach((row, i) => over.push(stitch(`m${i}`, TRUNK_X, row.mark, 'trunk')));
  }

  return (
    <svg ref={svg} className={`yarn${lit ? ' is-lit' : ''}`} width={width} height={height} aria-hidden>
      <defs>
        <Ply id={`${uid}-trunk`} a="var(--brand-warp)" b="var(--brand-weft)" pitch={7} angle={34} />
        {(Object.keys(TONES) as StrandTone[]).map((tone) => (
          <Ply key={tone} id={`${uid}-${tone}`} a={TONES[tone]} b={mix(TONES[tone], 50)} pitch={7} angle={34} />
        ))}
        <Ply id={`${uid}-fibre`} a="transparent" b="rgb(255 255 255 / 0.28)" pitch={3.5} angle={-30} />
      </defs>
      {under}
      {(!focus || focus === 'trunk') && strand('trunk', `M${TRUNK_X} -80 L ${TRUNK_X} ${height}`, 'trunk', TRUNK_W)}
      {lines}
      {over}
      {hits}
    </svg>
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
