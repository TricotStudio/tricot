import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { TASK_STATUS_WORDS } from '../../core/pins';
import type { Range, SearchKind, SearchResponse, SearchResult } from '../../core/search';
import type { TaskStatus } from '../../core/types';
import { api } from '../shared/api';
import { Icon } from '../shared/components';
import { focusBlock } from '../canvas';
import { showComments } from '../conversation';
import { useDismiss } from '../shared/hooks';
import { linkTo } from '../shared/pages';

// ---- the palette ----------------------------------------------------------------

const FILTERS: { key: string; label: string; kinds: SearchKind[] }[] = [
  { key: 'all', label: 'All', kinds: [] },
  { key: 'decisions', label: 'Decisions', kinds: ['decision', 'finding'] },
  { key: 'tasks', label: 'Tasks', kinds: ['task'] },
  { key: 'comments', label: 'Comments', kinds: ['comment'] },
  { key: 'canvas', label: 'Canvas', kinds: ['block'] },
];

const GROUP_LABEL: Record<SearchKind, string> = {
  decision: 'Decisions',
  task: 'Tasks',
  comment: 'Comments',
  finding: 'Findings',
  block: 'Canvas',
};

// The last search, offered again the next time the palette opens.
let remembered = { query: '', filter: 'all', allBoards: false, openOnly: false };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? '⌘K' : 'Ctrl K';

// Where a result opens: its card, or the board context, by the same
// addresses the #12 and T5 links in text use.
function hrefOf(result: SearchResult): string {
  const { boardId, target } = result;
  if (target.taskId) return linkTo.task(boardId, target.taskId);
  if (target.decisionId) return linkTo.decision(boardId, target.decisionId);
  return linkTo.board(boardId, 'canvas');
}

function open(result: SearchResult): void {
  const { target } = result;
  if (target.blockId) focusBlock(target.blockId);
  location.hash = hrefOf(result);
  // A comment in a card's discussion is scrolled to and flashed there.
  if (target.commentId && !target.pinId) showComments([target.commentId]);
}

// Text with its matches marked.
function Marked({ text, ranges }: { text: string; ranges: Range[] }) {
  const pieces: (string | { mark: string })[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    if (start > at) pieces.push(text.slice(at, start));
    pieces.push({ mark: text.slice(start, end) });
    at = end;
  }
  if (at < text.length) pieces.push(text.slice(at));
  return <>{pieces.map((piece, i) => (typeof piece === 'string' ? piece : <mark key={i}>{piece.mark}</mark>))}</>;
}

// A closed card is done, dropped, decided or retired; a blocked task waits on something.
function StatusTag({ result }: { result: SearchResult }) {
  if (result.closed === 'retired' || result.closed === 'dropped') return <span className={`tag tag-${result.closed}`}>{result.closed}</span>;
  if (result.closed) {
    return (
      <span className="tag tag-closed">
        <Icon name="check" /> {result.closed}
      </span>
    );
  }
  if (result.target.taskId && result.status === 'blocked') return <span className="tag tag-blocking">blocked</span>;
  return null;
}

function statusWord(result: SearchResult): string | undefined {
  if (!result.status) return undefined;
  return result.target.taskId ? TASK_STATUS_WORDS[result.status as TaskStatus] : result.status;
}

// The ref's status marker, as on the #12 and T5 chips in text.
function markerClass(result: SearchResult): string {
  if (!result.status) return '';
  return result.target.taskId ? `ref-task-${result.status}` : `ref-${result.status}`;
}

interface PaletteProps {
  boardId?: string; // the board on screen; none on Home, where every board is searched
  onClose: () => void;
}

function Palette({ boardId, onClose }: PaletteProps) {
  const [query, setQuery] = useState(remembered.query);
  const [filter, setFilter] = useState(remembered.filter);
  const [allBoards, setAllBoards] = useState(remembered.allBoards);
  const [openOnly, setOpenOnly] = useState(remembered.openOnly);
  const [found, setFound] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const everyBoard = allBoards || !boardId;
  const trimmed = query.trim();
  const searchable = trimmed.length >= 2;

  useEffect(() => {
    remembered = { query, filter, allBoards, openOnly };
  }, [query, filter, allBoards, openOnly]);

  useEffect(() => {
    input.current?.select();
  }, []);

  useDismiss(true, onClose, panel);

  // Searches a moment after typing stops; the last results stay up meanwhile.
  useEffect(() => {
    if (!searchable) {
      setFound(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const kinds = FILTERS.find((f) => f.key === filter)?.kinds;
    const timer = setTimeout(() => {
      api.search(boardId, trimmed, { kinds, all: everyBoard, open: openOnly }).then(
        (response) => {
          if (cancelled) return;
          setFound(response);
          setError(null);
          setActive(0);
        },
        (e: Error) => !cancelled && setError(e.message),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [boardId, trimmed, searchable, filter, everyBoard, openOnly]);

  // Results come best first; each kind's group goes where its best one is.
  const groups = useMemo(() => {
    const byKind = new Map<SearchKind, SearchResult[]>();
    for (const result of found?.results ?? []) byKind.set(result.kind, [...(byKind.get(result.kind) ?? []), result]);
    return [...byKind].map(([kind, results]) => ({ kind, label: GROUP_LABEL[kind], results }));
  }, [found]);
  const rows = groups.flatMap((group) => group.results);

  useEffect(() => {
    document.getElementById(`search-row-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (result: SearchResult) => {
    onClose();
    open(result);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter' && rows[active]) {
      e.preventDefault();
      choose(rows[active]);
    }
  };

  // A plain click opens the result here; with a modifier, the browser opens the link as it would.
  const onRowClick = (e: MouseEvent, result: SearchResult) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    choose(result);
  };

  const scope = everyBoard ? 'all boards' : 'this board';
  const count = !searchable
    ? scope
    : found
      ? `${found.results.length < found.total ? `${found.results.length} of ${found.total}` : found.total} result${found.total === 1 ? '' : 's'} · ${scope}`
      : `Searching ${scope}…`;

  let index = -1;
  return createPortal(
    <div className="search-scrim">
      <div className="search-panel" ref={panel} role="dialog" aria-modal="true" aria-label="Search">
        <div className="search-field">
          <Icon name="search" />
          <input
            ref={input}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search decisions, tasks, comments and canvases"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="search-results"
            aria-activedescendant={rows.length ? `search-row-${active}` : undefined}
            aria-autocomplete="list"
            spellCheck={false}
          />
          <span className="search-count" aria-live="polite">
            {count}
          </span>
        </div>
        <div className="search-filters">
          <div className="search-chips" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className="search-chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="search-chips">
            <button
              type="button"
              className="search-chip"
              aria-pressed={everyBoard}
              disabled={!boardId}
              title={boardId ? 'Search every board, archived ones included' : 'Every board is searched from here'}
              onClick={() => setAllBoards(!allBoards)}
            >
              {everyBoard && <Icon name="check" />} All boards
            </button>
            <button
              type="button"
              className="search-chip"
              aria-pressed={openOnly}
              title="Leave out decided, retired, done and dropped cards"
              onClick={() => setOpenOnly(!openOnly)}
            >
              {openOnly && <Icon name="check" />} Open only
            </button>
          </div>
        </div>

        <div className="search-results" id="search-results" role="listbox" aria-label="Results">
          {!searchable ? (
            <p className="search-empty">
              {trimmed ? 'Type at least two characters.' : 'Find past decisions, tasks, comments and canvas notes. Closed cards are included.'}
            </p>
          ) : error ? (
            <p className="search-empty error">{error}</p>
          ) : found && found.total === 0 ? (
            <div className="search-empty">
              <p>
                Nothing matches “{trimmed}” on {scope}
                {filter === 'all' ? '' : ` in ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()}`}
                {openOnly ? ' among open cards' : ''}.
              </p>
              {!everyBoard && (
                <button type="button" className="link-button" onClick={() => setAllBoards(true)}>
                  Search all boards
                </button>
              )}
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.kind} className="search-group" aria-label={group.label}>
                <h3 className="search-group-head">
                  {group.label} <span className="tab-count">{group.results.length}</span>
                </h3>
                {group.results.map((result) => {
                  index += 1;
                  const i = index;
                  const onContext = result.target.canvas === 'board';
                  const status = statusWord(result);
                  return (
                    <a
                      key={`${result.kind}:${result.target.commentId ?? result.target.blockId ?? result.target.taskId ?? result.target.decisionId}:${i}`}
                      id={`search-row-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={`search-row${i === active ? ' is-active' : ''}`}
                      href={hrefOf(result)}
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={(e) => onRowClick(e, result)}
                      title={status ? `${result.ref} · ${status}` : result.ref}
                    >
                      <span className={`search-ref ${markerClass(result)}`}>
                        {onContext ? <Icon name="canvas" /> : result.ref}
                      </span>
                      <span className="search-text">
                        <span className="search-title">
                          <Marked text={result.title} ranges={result.titleRanges} />
                        </span>
                        {(result.snippet || onContext) && (
                          <span className="search-snippet">
                            {(onContext || result.snippet?.where) && (
                              <span className="search-where">
                                {[onContext && 'Board Context', result.snippet?.where].filter(Boolean).join(' · ')}
                              </span>
                            )}
                            {result.snippet && <Marked text={result.snippet.text} ranges={result.snippet.ranges} />}
                          </span>
                        )}
                      </span>
                      <span className="search-side">
                        {everyBoard && (
                          <span className="search-board" title={result.boardTitle}>
                            {result.boardTitle}
                            {result.boardArchived && ' · archived'}
                          </span>
                        )}
                        <StatusTag result={result} />
                      </span>
                    </a>
                  );
                })}
              </section>
            ))
          )}
        </div>

        <footer className="search-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>Esc</kbd>
          </span>
          <span className="faint">{SHORTCUT} from anywhere</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// The header's search button, and ⌘K (Ctrl K elsewhere) from any view.
export function Search({ boardId }: { boardId?: string }) {
  const [isOpen, setOpen] = useState(false);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const shortcut = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey)) return;
      e.preventDefault();
      setOpen((was) => {
        if (!was) opener.current = document.activeElement;
        return !was;
      });
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Back where the viewer was, unless the result moved them on.
    const before = opener.current;
    if (before instanceof HTMLElement && before.isConnected) requestAnimationFrame(() => before.focus({ preventScroll: true }));
  }, []);

  return (
    <>
      <button
        className="search-button"
        onClick={() => {
          opener.current = document.activeElement;
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title={`Search (${SHORTCUT})`}
        aria-label="Search"
      >
        <Icon name="search" />
      </button>
      {isOpen && <Palette boardId={boardId} onClose={close} />}
    </>
  );
}
