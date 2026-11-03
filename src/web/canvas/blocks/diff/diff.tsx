import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
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
import { useCanvas } from '../../context';
import { highlightLine, languageOf, type Token } from '../../highlight';
import { Code, LineThread, useLinePick } from '../../lines';
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
  const [view, setView] = useDiffView();
  const totals = useMemo(() => diffTotals(block.files), [block.files]);
  return (
    <>
      <span className="diff-stat" title={`${countText(totals.additions, totals.deletions)} in ${plural(totals.files, 'file')}`}>
        <span className="diff-plus">+{totals.additions.toLocaleString('en-US')}</span>{' '}
        <span className="diff-minus">−{totals.deletions.toLocaleString('en-US')}</span>
        <span className="diff-stat-files"> · {plural(totals.files, 'file')}</span>
      </span>
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
    </>
  );
}

// ---- the body: the files, each opening to its changes ---------------------------------

type LinePin = { pin: Pin; place: { file: string; line: number; side: DiffSide } };

// A pinned line's key: its file, side and number.
const spot = (file: string, side: DiffSide, line: number | undefined) => `${file}\n${side}\n${line}`;

export function DiffBody({ block, placed }: { block: DiffBlock; placed: PlacedPin[] }) {
  // A patch with other files starts afresh; a new version of the same files keeps what's open.
  const key = useMemo(() => block.files.map((f) => f.path).join('\n'), [block.files]);
  return (
    <>
      <PinStrip block={block} placed={placed} />
      <DiffFiles key={key} block={block} placed={placed} />
    </>
  );
}

function DiffFiles({ block, placed }: { block: DiffBlock; placed: PlacedPin[] }) {
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

  // A pin shown from a comment about it: its file opens and its line scrolls into view.
  const focused = lines.find((l) => l.pin.id === canvas.focusPin);
  useEffect(() => {
    if (focused && !open.has(focused.place.file)) setOpen((was) => new Set(was).add(focused.place.file));
  }, [focused, open]);
  useLayoutEffect(() => {
    if (!focused || !root.current) return;
    const row = root.current.querySelector(`[data-pin-ids~="${CSS.escape(focused.pin.id)}"]`);
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
}) {
  const { block, file, view, whole, onWhole, bySpot, numbers } = props;
  const canvas = useCanvas();
  // Clicking a line pins it: the prompt opens under it, as for any part.
  const { pinnable, handlers } = useLinePick((cell) => {
    const side = cell.dataset.side as DiffSide;
    const line = Number(cell.dataset.line);
    const text = lineAt(file, side, line) ?? '';
    return { blockId: block.id, part: { kind: 'line', file: file.path, line, side }, quote: lineQuote(text) };
  });
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
  const draft = canvas.draft?.blockId === block.id && canvas.draft.part.kind === 'line' ? canvas.draft.part : null;
  const drafting = (side: DiffSide, line?: number) => Boolean(draft && draft.file === file.path && draft.side === side && draft.line === line);
  const pinsAt = (side: DiffSide, line?: number) => (line === undefined ? [] : (bySpot.get(spot(file.path, side, line)) ?? []));

  const thread = (pins: Pin[], side: DiffSide, line: number) =>
    pins.length > 0 && <LineThread key={`t${side}${line}`} pins={pins} numbers={numbers} where={`${side === 'old' ? 'old line' : 'line'} ${line}`} />;

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
                    unique.some((p) => p.id === canvas.focusPin) && 'is-focus',
                  ];
                  return (
                    <Fragment key={r}>
                      <div
                        className={classes.filter(Boolean).join(' ')}
                        data-side={row.kind === 'note' ? undefined : side}
                        data-line={row.kind === 'note' ? undefined : line}
                        data-pin-draft={drafting(side, line) ? '' : undefined}
                        data-pin-ids={unique.length ? unique.map((p) => p.id).join(' ') : undefined}
                      >
                        <span className="diff-num">{row.old}</span>
                        <span className="diff-num">{row.new}</span>
                        <span className="diff-mark">{MARK[row.kind]}</span>
                        <Code tokens={tokens} note={row.kind === 'note'} />
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
                  const classes = ['diff-row', 'is-pair', pins.length > 0 && 'is-pinned', pins.some((p) => p.id === canvas.focusPin) && 'is-focus'];
                  const anchor = right?.new ?? left?.old;
                  return (
                    <Fragment key={r}>
                      <div className={classes.filter(Boolean).join(' ')} data-pin-ids={pins.length ? pins.map((p) => p.id).join(' ') : undefined}>
                        <Half row={left} side="old" tokens={tokensOf(left)} draft={drafting('old', left?.old)} />
                        <Half row={right} side="new" tokens={tokensOf(right)} draft={drafting('new', right?.new)} />
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

// One side of a split row: its number, mark and text, or nothing.
function Half({ row, side, tokens, draft }: { row?: DiffRow; side: DiffSide; tokens: Token[]; draft: boolean }) {
  if (!row) return <span className="diff-half is-blank" />;
  const line = row.kind === 'note' ? undefined : row[side];
  return (
    <span
      className={`diff-half is-${row.kind}${draft ? ' is-draft' : ''}`}
      data-side={line === undefined ? undefined : side}
      data-line={line}
      data-pin-draft={draft ? '' : undefined}
    >
      <span className="diff-num">{line}</span>
      <span className="diff-mark">{MARK[row.kind]}</span>
      <Code tokens={tokens} note={row.kind === 'note'} />
    </span>
  );
}
