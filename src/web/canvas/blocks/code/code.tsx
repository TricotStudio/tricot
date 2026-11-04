// Code blocks: a source file, or part of one, with line numbers, light
// colours and its highlighted lines in a warm tint. A long one opens on what
// matters (its highlight, else its first lines), the rest folded. People
// click a line to comment on it or pin it to a task, as in a diff, and add
// code by pasting it (Add → Code) or dropping a file on the canvas.

import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  CODE_LONG,
  MAX_CODE,
  checkCodeText,
  codeLanguage,
  codeLines,
  codeSegments,
  languageByPath,
  looksBinary,
  shownText,
  sizeText,
  type CodeSegment,
} from '../../../../core/blocks/code/code';
import { lineQuote } from '../../../../core/blocks/diff/diff';
import type { Block, Pin } from '../../../../core/types';
import { useDismiss } from '../../../hooks';
import { useCanvas } from '../../context';
import { coloursOf, highlightLine, type Token } from '../../highlight';
import { Code, LineThread, useLinePick } from '../../lines';
import { PinStrip, type PlacedPin } from '../../pins';
import './code.css';

type CodeBlock = Extract<Block, { type: 'code' }>;

const number = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;

// ---- what's unfolded: the header's Show all and the body's folds share it ----------

interface Unfolded {
  all: boolean;
  opened: [number, number][]; // folds a person opened
}

const NOTHING_OPEN: Unfolded = { all: false, opened: [] };
const unfolded = new Map<string, Unfolded>();
const unfoldListeners = new Set<() => void>();

function useUnfolded(blockId: string): [Unfolded, (next: Unfolded) => void] {
  const state = useSyncExternalStore(
    (listener) => {
      unfoldListeners.add(listener);
      return () => unfoldListeners.delete(listener);
    },
    () => unfolded.get(blockId) ?? NOTHING_OPEN,
  );
  const set = (next: Unfolded) => {
    unfolded.set(blockId, next);
    for (const listener of unfoldListeners) listener();
  };
  return [state, set];
}

// The block's lines, and which show: pinned lines always do.
function useCodeView(block: CodeBlock, placed: PlacedPin[]) {
  const lines = useMemo(() => codeLines(block.text), [block.text]);
  const [state, setState] = useUnfolded(block.id);
  const pinned = placed.flatMap(({ place }) => (place?.kind === 'line' ? [place.line] : []));
  const keepKey = pinned.join(',');
  const segments = useMemo(
    () => codeSegments(block, { keep: keepKey ? keepKey.split(',').map(Number) : [], opened: state.opened, all: state.all, count: lines.length }),
    [block, keepKey, state, lines.length],
  );
  return { lines, segments, state, setState };
}

// A long hash reads as its first seven characters, as git shows it.
const shortCommit = (commit: string) => (/^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit);

// ---- the header: the file, what's shown of it, Copy and Show all --------------------

export function CodeHead({ block, placed, frozen }: { block: CodeBlock; placed: PlacedPin[]; frozen: boolean }) {
  const { lines, segments, state, setState } = useCodeView(block, placed);
  const language = codeLanguage(block);
  const folded = segments.some((s) => s.kind === 'fold');
  const meta = [language?.name, shownText(block, segments, lines.length), block.commit && `at ${shortCommit(block.commit)}`].filter(Boolean).join(' · ');
  return (
    <>
      <PathField block={block} frozen={frozen} />
      <span className="code-meta" title={block.commit ? `${meta.replace(shortCommit(block.commit), block.commit)}` : meta}>
        {meta}
      </span>
      <span className="code-actions nodrag" onDoubleClick={(e) => e.stopPropagation()}>
        <CopyButton text={block.text} />
        {folded && (
          <button type="button" onClick={() => setState({ all: true, opened: [] })} title={`Show all ${plural(lines.length, 'line')}`}>
            Show all
          </button>
        )}
        {state.all && lines.length > CODE_LONG && (
          <button type="button" onClick={() => setState(NOTHING_OPEN)} title="Fold it back to the lines that matter">
            Fold
          </button>
        )}
      </span>
    </>
  );
}

// The file's path names the block. The browser only gives a dropped file's
// name, so a click lets a person type its full path.
function PathField({ block, frozen }: { block: CodeBlock; frozen: boolean }) {
  const canvas = useCanvas();
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const shown = block.path || <span className="placeholder">Untitled</span>;
  if (frozen || canvas.readOnly) {
    return (
      <span className="code-path" title={block.path}>
        {shown}
      </span>
    );
  }
  if (!editing) {
    return (
      <button
        type="button"
        className="code-path is-editable nodrag"
        title={block.path ? `${block.path}. Click to change its path` : 'Click to give its path, e.g. src/core/store.ts'}
        onClick={() => {
          cancelled.current = false;
          setEditing(true);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {shown}
      </button>
    );
  }
  const finish = (input: HTMLInputElement) => {
    setEditing(false);
    const path = input.value.trim();
    if (!cancelled.current && path !== block.path) canvas.updateBlock(block, { path });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') {
      cancelled.current = true;
      e.currentTarget.blur();
    }
  };
  return (
    <input
      autoFocus
      className="editable-input code-path-input nodrag"
      defaultValue={block.path}
      placeholder="src/core/store.ts"
      aria-label="The file's path"
      size={Math.max(18, block.path.length + 4)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget)}
      onKeyDown={onKeyDown}
    />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API here (a page served over plain http): the old way.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
  };
  return (
    <button type="button" onClick={() => void copy()} title="Copy the text">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ---- the body: numbered lines, folds, and what was said about a line ---------------

// Where a line's thread says it is: "line 12", or for a range pinned there, "lines 12–18".
function linesWhere(line: number, pins: Pin[], placed: PlacedPin[]): string {
  const last = Math.max(line, ...placed.flatMap(({ pin, place }) => (place?.kind === 'line' && place.last && pins.includes(pin) ? [place.last] : [])));
  return last > line ? `lines ${line}–${last}` : `line ${line}`;
}

export function CodeBody({ block, placed }: { block: CodeBlock; placed: PlacedPin[] }) {
  const canvas = useCanvas();
  const root = useRef<HTMLDivElement>(null);
  const { lines, segments, setState, state } = useCodeView(block, placed);
  const first = block.start ?? 1;
  const last = first + lines.length - 1;

  // Colours, carried line to line (a comment left open), up to the last line shown.
  const upTo = Math.max(...segments.map((s) => (s.kind === 'lines' ? s.to : first)));
  const colours = useMemo(() => coloursOf(codeLanguage(block)), [block]);
  const tokens = useMemo(() => {
    const carried = { inComment: false };
    return lines.slice(0, upTo - first + 1).map((line) => highlightLine(line, colours, carried));
  }, [lines, colours, upTo, first]);

  // Pins by the line they're on, numbered in the order they read.
  // A range of lines (pinned in its full view) is marked on each of them, its thread under the first.
  const { byLine, numbers, spans } = useMemo(() => {
    const byLine = new Map<number, Pin[]>();
    const spans: [number, number][] = [];
    for (const { pin, place } of placed) {
      if (place?.kind !== 'line') continue;
      byLine.set(place.line, [...(byLine.get(place.line) ?? []), pin]);
      if (place.last) spans.push([place.line, place.last]);
    }
    const numbers = new Map<string, number>();
    for (const line of [...byLine.keys()].sort((a, b) => a - b)) for (const pin of byLine.get(line)!) numbers.set(pin.id, numbers.size + 1);
    return { byLine, numbers, spans };
  }, [placed]);

  // A pin shown from a comment about it: its line scrolls into view.
  const focused = placed.find(({ pin, place }) => pin.id === canvas.focusPin && place?.kind === 'line');
  useLayoutEffect(() => {
    if (!focused || !root.current) return;
    const row = root.current.querySelector(`[data-pin-ids~="${CSS.escape(focused.pin.id)}"]`);
    const body = root.current.closest<HTMLElement>('.block-body');
    if (!row || !body) return;
    const scale = body.getBoundingClientRect().height / body.offsetHeight || 1; // the canvas's zoom
    const offset = (row.getBoundingClientRect().top - body.getBoundingClientRect().top) / scale;
    body.scrollTop += offset - body.clientHeight / 3;
  }, [focused]);

  const { pinnable, handlers } = useLinePick((cell) => {
    const line = Number(cell.dataset.line);
    return { blockId: block.id, part: { kind: 'line', file: block.path, line, side: 'new' }, quote: lineQuote(lines[line - first] ?? '') };
  });
  const draft = canvas.draft?.blockId === block.id && canvas.draft.part.kind === 'line' ? canvas.draft.part.line : null;
  const highlighted = (line: number) => Boolean(block.highlight?.some(([from, to]) => line >= from && line <= to));
  const open = (segment: CodeSegment) => setState({ all: false, opened: [...state.opened, [segment.from, segment.to]] });
  const showAll = () => setState({ all: true, opened: [] });

  const rows = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => {
      const line = from + i;
      const pins = byLine.get(line) ?? [];
      const classes = [
        'diff-row',
        'is-code',
        highlighted(line) && 'is-hl',
        (pins.length > 0 || spans.some(([from, to]) => line >= from && line <= to)) && 'is-pinned',
        draft === line && 'is-draft',
        pins.some((p) => p.id === canvas.focusPin) && 'is-focus',
      ];
      return (
        <Fragment key={line}>
          <div
            className={classes.filter(Boolean).join(' ')}
            data-side="new"
            data-line={line}
            data-pin-draft={draft === line ? '' : undefined}
            data-pin-ids={pins.length ? pins.map((p) => p.id).join(' ') : undefined}
          >
            <span className="diff-num">{line}</span>
            <Code tokens={tokens[line - first] ?? ([{ text: lines[line - first] }] as Token[])} />
          </div>
          {pins.length > 0 && <LineThread pins={pins} numbers={numbers} where={linesWhere(line, pins, placed)} />}
        </Fragment>
      );
    });

  return (
    <div className="diff code-view" ref={root}>
      <PinStrip block={block} placed={placed} />
      <div className={`diff-code nodrag${pinnable ? ' is-pinnable' : ''}`} {...handlers}>
        <div className="diff-rows" style={{ '--diff-digits': `${String(Math.max(last, block.total ?? 0)).length}ch` } as CSSProperties}>
          {first > 1 && <p className="code-edge">⋯ {plural(first - 1, 'line')} above, not in this block</p>}
          {segments.map((segment) =>
            segment.kind === 'lines' ? (
              <Fragment key={`l${segment.from}`}>{rows(segment.from, segment.to)}</Fragment>
            ) : (
              <p key={`f${segment.from}`} className="code-fold" data-pin-skip="">
                <button type="button" onClick={() => open(segment)} title={`Show lines ${number(segment.from)}–${number(segment.to)}`}>
                  ⋯ {plural(segment.to - segment.from + 1, 'line')}
                  {segment.from === first ? ' above' : segment.to === last ? ' below' : ''}
                </button>
                <span aria-hidden>·</span>
                <button type="button" onClick={showAll}>
                  Show all
                </button>
              </p>
            ),
          )}
          {block.total !== undefined && block.total > last && (
            <p className="code-edge">⋯ {plural(block.total - last, 'line')} below, not in this block</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- people adding code ---------------------------------------------------------------

export type NewCode = { type: 'code'; path: string; text: string };

// Add → Code: pasted text, and the file's name, which says its language.
// Empty, it closes on a click elsewhere or Escape; once something's in it,
// it stays until Cancel, or Escape in it. `toggle` is its toolbar button.
export function AddCodeForm(props: { toggle: RefObject<HTMLElement | null>; onAdd: (code: NewCode) => void; onCancel: () => void }) {
  const { toggle, onAdd, onCancel } = props;
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLFormElement>(null);
  useDismiss(!text.trim() && !name.trim(), onCancel, root, toggle);
  const language = name.trim() ? languageByPath(name.trim()) : undefined;
  const count = text ? codeLines(text).length : 0;
  const about = [language?.name ?? (name.trim() && 'No colours for this kind of file'), count > 0 && plural(count, 'line')].filter(Boolean).join(' · ');
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    try {
      checkCodeText(text);
    } catch (e) {
      setError((e as Error).message.replace(/ Send the lines that matter.*$/, ' Paste the lines that matter.'));
      return;
    }
    onAdd({ type: 'code', path: name.trim(), text });
  };
  return (
    <form ref={root} className="add-link add-code nodrag nopan nowheel" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <label>
        <span className="field-label">Code</span>
        <textarea
          autoFocus
          value={text}
          spellCheck={false}
          placeholder="Paste a file, or the lines that matter"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submit()}
        />
      </label>
      <label>
        <span className="field-label">
          File name <span className="faint">(optional, for its colours)</span>
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. src/core/store.ts" />
      </label>
      {about && <p className="add-code-about">{about}</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-primary btn-small" disabled={!text.trim()}>
          Add code
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Images dropped on a canvas become image blocks, as ever; other files, code blocks.
export const isImageFile = (type: string) => type.startsWith('image/');

// A dropped file's text, if it is a text file a code block can hold. Throws,
// saying why, for one over 1 MB or one that isn't text.
export async function readCodeFile(file: File): Promise<string> {
  if (file.size > MAX_CODE) throw new Error(`${file.name} is ${sizeText(file.size)}: a Code block holds files up to 1 MB.`);
  const notText = new Error(`${file.name} isn't a text file, so it can't be a Code block. Drop source code or other text.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) throw notText;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw notText;
  }
  if (looksBinary(text)) throw notText;
  if (!text.trim()) throw new Error(`${file.name} is empty.`);
  return text;
}

// What the drop overlay says of a file, once it's read: TypeScript · 2,537 lines.
async function aboutFile(file: File): Promise<string> {
  const language = languageByPath(file.name)?.name;
  try {
    const text = await readCodeFile(file);
    return [language, plural(codeLines(text).length, 'line')].filter(Boolean).join(' · ');
  } catch (error) {
    return (error as Error).message.replace(`${file.name} `, 'It ').replace(/ Drop source code or other text\.$/, '');
  }
}

export interface CodeDrop {
  count: number; // files that will be code blocks
  name?: string; // the file's name, when there's one and the browser says it
  about?: string;
}

// Dragging files over a canvas: what dropping them will make. Browsers give
// a dragged file's name and contents only on drop, except when they don't
// protect them, so the overlay says what it can.
export function useCodeDrop(enabled: boolean) {
  const [drop, setDrop] = useState<CodeDrop | null>(null);
  const described = useRef(new WeakMap<File, Promise<string>>());
  const onDragEnter = (event: DragEvent) => {
    if (!enabled || !event.dataTransfer.types.includes('Files')) return;
    const items = [...event.dataTransfer.items].filter((item) => item.kind === 'file' && !isImageFile(item.type));
    const files = [...event.dataTransfer.files].filter((file) => !isImageFile(file.type));
    const count = Math.max(items.length, files.length);
    if (count === 0) return setDrop(null); // images only: as ever
    const file = count === 1 ? files[0] : undefined;
    setDrop((was) => ({ count, name: file?.name, about: was?.name === file?.name ? was?.about : undefined }));
    if (!file) return;
    let about = described.current.get(file);
    if (!about) described.current.set(file, (about = aboutFile(file)));
    void about.then((text) => setDrop((was) => (was && was.name === file.name ? { ...was, about: text } : was)));
  };
  const onDragLeave = (event: DragEvent) => {
    if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) setDrop(null);
  };
  return { drop, onDragEnter, onDragLeave, clear: () => setDrop(null) };
}

export function CodeDropOverlay({ drop }: { drop: CodeDrop }) {
  const what = drop.name ? <b>{drop.name}</b> : drop.count === 1 ? 'the file' : `${drop.count} files`;
  return (
    <div className="code-drop" aria-hidden>
      <div className="code-drop-card">
        <p className="code-drop-what">
          Drop to add {what} as {drop.count === 1 ? 'a Code block' : 'Code blocks'}
        </p>
        {drop.about && <p className="code-drop-about">{drop.about}</p>}
      </div>
    </div>
  );
}
