import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  MAX_PATCH,
  countText,
  diffTotals,
  fileSize,
  focusFirst,
  hunkRows,
  initiallyOpen,
  isGenerated,
  lineAt,
  lineQuote,
  listedFirst,
  splitRows,
  type DiffFile,
  type DiffRow,
  type DiffSide,
} from '../../../../core/blocks/diff/diff';
import type { Block, Pin } from '../../../../core/types';
import { useCanvas, type PinDraft } from '../../context';
import { highlightLine, languageOf, type Token } from '../../highlight';
import { Code, LineThread, useLinePick } from '../../lines';
import { DRAFT_ANCHOR } from '../../pairing/piece';
import { PinStrip, type PlacedPin } from '../../pins';
import '../../diff.css';

type DiffBlock = Extract<Block, { type: 'diff' }>;
type View = 'unified' | 'split';

// A file shows this many lines, then "Show all".
const ROW_LIMIT = 400;

// ---- unified or split: the viewer's choice, for every diff ----------------------

const VIEW_KEY = 'tricot:diff-view';
const viewListeners = new Set<() => void>();
let currentView: View = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
})();

function useDiffView(): [View, (view: View) => void] {
  const view = useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    () => currentView,
  );
  const choose = (next: View) => {
    currentView = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // private window: it holds for this visit
    }
    for (const listener of viewListeners) listener();
  };
  return [view, choose];
}

// ---- the header: what changed, and how to show it ----------------------------------

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export function DiffHead({ block }: { block: DiffBlock }) {
  return (
    <>
      <DiffStat files={block.files} />
      <DiffSwitch />
    </>
  );
}

// Its totals: lines added and taken away, and in how many files.
export function DiffStat({ files }: { files: DiffFile[] }) {
  const totals = useMemo(() => diffTotals(files), [files]);
  return (
    <span className="diff-stat" title={`${countText(totals.additions, totals.deletions)} in ${plural(totals.files, 'file')}`}>
      <span className="diff-plus">+{totals.additions.toLocaleString('en-US')}</span>{' '}
      <span className="diff-minus">−{totals.deletions.toLocaleString('en-US')}</span>
      <span className="diff-stat-files"> · {plural(totals.files, 'file')}</span>
    </span>
  );
}

// Unified or split, for every diff on the page.
export function DiffSwitch() {
  const [view, setView] = useDiffView();
  return (
    <span className="diff-switch nodrag" role="radiogroup" aria-label="Show the diff" onDoubleClick={(e) => e.stopPropagation()}>
      {(['unified', 'split'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={view === value}
          className={view === value ? 'is-on' : undefined}
          onClick={() => setView(value)}
          title={value === 'unified' ? 'Old and new lines in one column' : 'Old lines on the left, new on the right'}
        >
          {value === 'unified' ? 'Unified' : 'Split'}
        </button>
      ))}
    </span>
  );
}

// ---- the body: the files, each opening to its changes ---------------------------------

type LinePin = { pin: Pin; place: { file: string; line: number; side: DiffSide } };

// A pinned line's key: its file, side and number.
const spot = (file: string, side: DiffSide, line: number | undefined) => `${file}\n${side}\n${line}`;

// The full view's hand in its lines (diffView.tsx): pointing at a line asks
// about it in the view's own prompt, and the markers at a pinned line's end
// open its thread there. Without it the lines are the block's on the canvas:
// a click pins one with the canvas's prompt, and what was said about a line
// shows under it.
export interface FullLines {
  pointing: boolean; // a click on a line asks about it
  chosen: PinDraft | null; // the part being asked about
  open: string | null; // the pin whose thread is open
  pick(draft: PinDraft): void;
  chips(pins: Pin[]): ReactNode; // the markers at a pinned line's end
}

export function DiffBody({ block, placed }: { block: DiffBlock; placed: PlacedPin[] }) {
  return (
    <>
      <PinStrip block={block} placed={placed} />
      <DiffFiles block={block} placed={placed} />
    </>
  );
}

// Its files, each opening to its changes: on the canvas, or in the full view (`full`).
export function DiffFiles({ block, placed, full }: { block: DiffBlock; placed: PlacedPin[]; full?: FullLines }) {
  // A patch with other files starts afresh; a new version of the same files keeps what's open.
  const key = useMemo(() => block.files.map((f) => f.path).join('\n'), [block.files]);
  return <Files key={key} block={block} placed={placed} full={full} />;
}

function Files({ block, placed, full }: { block: DiffBlock; placed: PlacedPin[]; full?: FullLines }) {
  const canvas = useCanvas();
  const [view] = useDiffView();
  const root = useRef<HTMLDivElement>(null);
  const lines = useMemo(
    () => placed.flatMap(({ pin, place }) => (place?.kind === 'line' ? [{ pin, place } as LinePin] : [])),
    [placed],
  );
  const pinnedFiles = useMemo(() => new Set(lines.map((l) => l.place.file)), [lines]);
  const [open, setOpen] = useState(() => new Set([...initiallyOpen(block.files, block.focus), ...pinnedFiles]));
  const [allFiles, setAllFiles] = useState(false);
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());

  const files = useMemo(() => focusFirst(block.files, block.focus), [block.files, block.focus]);

  // Pins by the line they're on, numbered in the order they read.
  const { bySpot, numbers } = useMemo(() => {
    const bySpot = new Map<string, Pin[]>();
    for (const { pin, place } of lines) {
      const at = spot(place.file, place.side, place.line);
      bySpot.set(at, [...(bySpot.get(at) ?? []), pin]);
    }
    const numbers = new Map<string, number>();
    for (const file of files) {
      if (!lines.some((l) => l.place.file === file.path)) continue;
      for (const hunk of file.hunks) {
        for (const row of hunkRows(hunk)) {
          for (const at of [spot(file.path, 'old', row.old), spot(file.path, 'new', row.new)]) {
            for (const pin of bySpot.get(at) ?? []) if (!numbers.has(pin.id)) numbers.set(pin.id, numbers.size + 1);
          }
        }
      }
    }
    return { bySpot, numbers };
  }, [lines, files]);

  // A pin shown from a comment about it (in the full view, its thread opened):
  // its file opens and its line scrolls into view. In the full view, a line
  // already drawn is brought into view by the view itself.
  const focused = lines.find((l) => l.pin.id === (full ? full.open : canvas.focusPin));
  const revealing = useRef<string | null>(null);
  useEffect(() => {
    if (!focused || open.has(focused.place.file)) return;
    revealing.current = focused.pin.id;
    setOpen((was) => new Set(was).add(focused.place.file));
  }, [focused, open]);
  useLayoutEffect(() => {
    if (!focused || !root.current) return;
    const row = root.current.querySelector(`[data-pin-ids~="${CSS.escape(focused.pin.id)}"]`);
    if (full) {
      if (row && revealing.current === focused.pin.id) row.scrollIntoView({ block: 'center' });
      if (row) revealing.current = null;
      return;
    }
    const body = root.current.closest<HTMLElement>('.block-body');
    if (!row || !body) return;
    const scale = body.getBoundingClientRect().height / body.offsetHeight || 1; // the canvas's zoom
    const offset = (row.getBoundingClientRect().top - body.getBoundingClientRect().top) / scale;
    body.scrollTop += offset - body.clientHeight / 3;
  }, [focused, open]);

  const keep = useMemo(() => new Set([...open, ...(block.focus ?? []), ...pinnedFiles]), [open, block.focus, pinnedFiles]);
  const listed = allFiles ? files : listedFirst(files, keep);
  const biggest = Math.max(1, ...block.files.map((f) => f.additions + f.deletions));
  const omitted = block.files.filter((f) => f.omitted).length;
  const toggle = (path: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className={`diff is-${view}`} ref={root}>
      {omitted > 0 && (
        <p className="diff-note">
          The patch is over {Math.round(MAX_PATCH / 1024 / 1024)} MB, so {omitted === 1 ? 'one big file is' : `${omitted} of its biggest files are`} listed
          without {omitted === 1 ? 'its' : 'their'} changes.
        </p>
      )}
      {listed.map((file) => (
        <FileSection
          key={file.path}
          block={block}
          file={file}
          open={open.has(file.path)}
          onToggle={() => toggle(file.path)}
          biggest={biggest}
          view={view}
          whole={whole.has(file.path) || pinnedFiles.has(file.path)}
          onWhole={() => setWhole((was) => new Set(was).add(file.path))}
          bySpot={bySpot}
          numbers={numbers}
          full={full}
        />
      ))}
      {listed.length < block.files.length && (
        <button type="button" className="diff-more nodrag" onClick={() => setAllFiles(true)}>
          {plural(block.files.length - listed.length, 'more file')} · Show all
        </button>
      )}
    </div>
  );
}

// A file's size as five squares: green for added lines, red for removed,
// grey for how much smaller it is than the biggest file in the diff.
function SizeBar({ file, biggest }: { file: DiffFile; biggest: number }) {
  const total = file.additions + file.deletions;
  const filled = total === 0 ? 0 : Math.max(1, Math.round((5 * total) / biggest));
  const added = total === 0 ? 0 : Math.round((filled * file.additions) / total);
  return (
    <span className="diff-bar" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < added ? 'is-add' : i < filled ? 'is-del' : undefined} />
      ))}
    </span>
  );
}

const STATUS_WORD: Record<DiffFile['status'], string | null> = {
  added: 'new',
  deleted: 'deleted',
  renamed: 'renamed',
  binary: 'binary',
  modified: null,
};

function FileSection(props: {
  block: DiffBlock;
  file: DiffFile;
  open: boolean;
  onToggle: () => void;
  biggest: number;
  view: View;
  whole: boolean;
  onWhole: () => void;
  bySpot: ReadonlyMap<string, Pin[]>;
  numbers: ReadonlyMap<string, number>;
  full?: FullLines;
}) {
  const { file, open, onToggle, biggest } = props;
  const generated = isGenerated(file.path);
  const tags = [STATUS_WORD[file.status], generated && 'generated', file.omitted && 'too big to show'].filter(Boolean) as string[];
  const name = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <section className={`diff-file${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="diff-file-head"
        onClick={onToggle}
        onDoubleClick={(e) => e.stopPropagation()}
        aria-expanded={open}
        title={open ? `Close ${file.path}` : `Open ${file.path}`}
      >
        <span className="diff-chevron" aria-hidden>
          ›
        </span>
        <span className="diff-path">{name}</span>
        {tags.map((tag) => (
          <span key={tag} className={`diff-tag is-${tag.split(' ')[0]}`}>
            {tag}
          </span>
        ))}
        <span className="diff-file-count">
          {file.status === 'binary' ? (
            ''
          ) : (
            <>
              {file.additions > 0 && <span className="diff-plus">+{file.additions.toLocaleString('en-US')}</span>}
              {file.deletions > 0 && <span className="diff-minus"> −{file.deletions.toLocaleString('en-US')}</span>}
            </>
          )}
        </span>
        <SizeBar file={file} biggest={biggest} />
      </button>
      {open && <FileChanges {...props} />}
    </section>
  );
}

// Why a file shows no lines, when it has none to show.
function emptyReason(file: DiffFile): string {
  if (file.omitted) return `Its changes were left out to keep this diff under ${Math.round(MAX_PATCH / 1024 / 1024)} MB.`;
  if (file.status === 'binary') return 'A binary file: its changes aren’t shown.';
  if (file.status === 'renamed') return 'Renamed, with nothing changed inside.';
  return 'Nothing changed in its text (only its mode).';
}

// A hunk as drawn: its rows coloured, and paired side by side for the split view.
type Shown = {
  hunk: string;
  rows: { row: DiffRow; tokens: Token[] }[];
  pairs: { left?: DiffRow; right?: DiffRow }[];
  tokensOfRow: ReadonlyMap<DiffRow, Token[]>;
};

function FileChanges(props: {
  block: DiffBlock;
  file: DiffFile;
  view: View;
  whole: boolean;
  onWhole: () => void;
  bySpot: ReadonlyMap<string, Pin[]>;
  numbers: ReadonlyMap<string, number>;
  full?: FullLines;
}) {
  const { block, file, view, whole, onWhole, bySpot, numbers, full } = props;
  const canvas = useCanvas();
  // Clicking a line pins it: the prompt opens under it, as for any part (in the full view, the view's).
  const { pinnable, handlers } = useLinePick(
    (cell) => {
      const side = cell.dataset.side as DiffSide;
      const line = Number(cell.dataset.line);
      const text = lineAt(file, side, line) ?? '';
      return { blockId: block.id, part: { kind: 'line', file: file.path, line, side }, quote: lineQuote(text) };
    },
    full && { pinnable: full.pointing, start: full.pick },
  );
  const size = fileSize(file);

  // Each hunk's rows, coloured once, up to the limit unless all are asked for.
  const hunks: Shown[] = useMemo(() => {
    const lang = languageOf(file.path);
    let room = whole ? Infinity : ROW_LIMIT;
    const shown: Shown[] = [];
    for (const hunk of file.hunks) {
      if (room <= 0) break;
      const state = { inComment: false };
      const rows = hunkRows(hunk)
        .slice(0, room)
        .map((row) => ({ row, tokens: row.kind === 'note' ? [{ text: row.text }] : highlightLine(row.text, lang, state) }));
      room -= rows.length;
      const tokensOfRow = new Map(rows.map(({ row, tokens }) => [row, tokens]));
      shown.push({ hunk: hunk.header, rows, pairs: splitRows(rows.map((r) => r.row)), tokensOfRow });
    }
    return shown;
  }, [file, whole]);

  if (file.hunks.length === 0) return <p className="diff-empty">{emptyReason(file)}</p>;

  const digits = String(Math.max(...file.hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)))).length;
  const asked = full ? full.chosen : canvas.draft;
  const draft = asked?.blockId === block.id && asked.part.kind === 'line' ? asked.part : null;
  const drafting = (side: DiffSide, line?: number) => Boolean(draft && draft.file === file.path && draft.side === side && draft.line === line);
  const pinsAt = (side: DiffSide, line?: number) => (line === undefined ? [] : (bySpot.get(spot(file.path, side, line)) ?? []));
  const isFocus = (pins: Pin[]) => !full && pins.some((p) => p.id === canvas.focusPin);
  const isOpen = (pins: Pin[]) => Boolean(full && pins.some((p) => p.id === full.open));
  // In the full view: what the view's prompt and threads open by (piece.tsx), and the markers at the line's end.
  const anchors = (pins: Pin[], drafted: boolean) => (full && [...pins.map((p) => p.id), ...(drafted ? [DRAFT_ANCHOR] : [])].join(' ')) || undefined;
  const chips = (pins: Pin[]) => full && pins.length > 0 && full.chips(pins);

  // On the canvas, what was said about a line shows under it.
  const thread = (pins: Pin[], side: DiffSide, line: number) =>
    !full && pins.length > 0 && <LineThread key={`t${side}${line}`} pins={pins} numbers={numbers} where={`${side === 'old' ? 'old line' : 'line'} ${line}`} />;

  const shownRows = hunks.reduce((sum, h) => sum + h.rows.length, 0);
  return (
    <div className={`diff-code nodrag${pinnable ? ' is-pinnable' : ''}`} {...handlers}>
      <div className="diff-rows" style={{ '--diff-digits': `${digits}ch` } as CSSProperties}>
        {hunks.map(({ hunk, rows, pairs, tokensOfRow }, h) => (
          <Fragment key={h}>
            <div className="diff-hunk">{hunk}</div>
            {view === 'unified'
              ? rows.map(({ row, tokens }, r) => {
                  const side: DiffSide = row.kind === 'del' ? 'old' : 'new';
                  const line = row[side];
                  const pins = [...pinsAt('old', row.old), ...(row.kind === 'context' ? pinsAt('new', row.new) : pinsAt(side, line))];
                  const unique = [...new Set(pins)];
                  const classes = [
                    'diff-row',
                    `is-${row.kind}`,
                    unique.length > 0 && 'is-pinned',
                    drafting(side, line) && 'is-draft',
                    isFocus(unique) && 'is-focus',
                    isOpen(unique) && 'is-open',
                  ];
                  return (
                    <Fragment key={r}>
                      <div
                        className={classes.filter(Boolean).join(' ')}
                        data-side={row.kind === 'note' ? undefined : side}
                        data-line={row.kind === 'note' ? undefined : line}
                        data-pin-draft={drafting(side, line) ? '' : undefined}
                        data-pin-ids={unique.length ? unique.map((p) => p.id).join(' ') : undefined}
                        data-pair-anchor={anchors(unique, drafting(side, line))}
                      >
                        <span className="diff-num">{row.old}</span>
                        <span className="diff-num">{row.new}</span>
                        <span className="diff-mark">{MARK[row.kind]}</span>
                        <Code tokens={tokens} note={row.kind === 'note'} />
                        {chips(unique)}
                      </div>
                      {line !== undefined && thread(unique, side, line)}
                    </Fragment>
                  );
                })
              : pairs.map(({ left, right }, r) => {
                  const tokensOf = (row?: DiffRow) => (row && tokensOfRow.get(row)) || [];
                  const leftPins = left && left.kind !== 'note' ? pinsAt('old', left.old) : [];
                  const rightPins = right && right.kind !== 'note' ? pinsAt('new', right.new) : [];
                  const pins = [...new Set([...leftPins, ...rightPins])];
                  const classes = ['diff-row', 'is-pair', pins.length > 0 && 'is-pinned', isFocus(pins) && 'is-focus'];
                  const anchor = right?.new ?? left?.old;
                  const half = (row: DiffRow | undefined, side: DiffSide, on: Pin[]) => {
                    const drafted = drafting(side, row?.[side]);
                    return (
                      <Half row={row} side={side} tokens={tokensOf(row)} draft={drafted} open={isOpen(on)} anchors={anchors(on, drafted)}>
                        {chips(on)}
                      </Half>
                    );
                  };
                  return (
                    <Fragment key={r}>
                      <div className={classes.filter(Boolean).join(' ')} data-pin-ids={pins.length ? pins.map((p) => p.id).join(' ') : undefined}>
                        {half(left, 'old', leftPins)}
                        {half(right, 'new', rightPins)}
                      </div>
                      {anchor !== undefined && thread(pins, right?.new !== undefined ? 'new' : 'old', anchor)}
                    </Fragment>
                  );
                })}
          </Fragment>
        ))}
      </div>
      {shownRows < size && (
        <button type="button" className="diff-more" onClick={onWhole}>
          Show all {size.toLocaleString('en-US')} lines
        </button>
      )}
    </div>
  );
}

const MARK: Record<DiffRow['kind'], string> = { add: '+', del: '−', context: '', note: '' };

// One side of a split row: its number, mark and text, or nothing. In the
// full view, the markers of its pins at its end (`children`).
function Half(props: { row?: DiffRow; side: DiffSide; tokens: Token[]; draft: boolean; open: boolean; anchors?: string; children?: ReactNode }) {
  const { row, side, tokens, draft, open, anchors, children } = props;
  if (!row) return <span className="diff-half is-blank" />;
  const line = row.kind === 'note' ? undefined : row[side];
  return (
    <span
      className={`diff-half is-${row.kind}${draft ? ' is-draft' : ''}${open ? ' is-open' : ''}`}
      data-side={line === undefined ? undefined : side}
      data-line={line}
      data-pin-draft={draft ? '' : undefined}
      data-pair-anchor={anchors}
    >
      <span className="diff-num">{line}</span>
      <span className="diff-mark">{MARK[row.kind]}</span>
      <Code tokens={tokens} note={row.kind === 'note'} />
      {children}
    </span>
  );
}
