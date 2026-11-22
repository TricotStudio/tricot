import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Range, SearchKind, SearchResponse, SearchResult } from '../../core/search';
import { api } from '../shared/api';
import { Icon } from '../shared/components';
import { focusBlock } from '../canvas';
import { showComments } from '../conversation';
import type { CardKinds } from '../shared/cardKinds';
import { useBoardViews } from '../shared/boardViewsContext';
import { useCardKinds } from '../shared/cardKindsContext';
import { useDismiss } from '../shared/hooks';
import { linkTo } from '../shared/pages';
import { openConversation } from '../threads';

// ---- the palette ----------------------------------------------------------------

interface Filter {
  key: string;
  label: string;
  kinds: SearchKind[];
}

// The canvas's own: comments, the threads' messages and canvases. The page's registered search (shared/boardViews.ts
// SearchSlot, a part's) adds its chips between All and Comments, the kinds it heads
// results with, and its wording; with none, All asks for the canvas's kinds alone.
const CANVAS_KINDS: SearchKind[] = ['comment', 'message', 'block'];

const GROUP_LABEL: Partial<Record<SearchKind, string>> = {
  comment: 'Comments',
  message: 'Threads',
  block: 'Canvas',
};

const PLAIN_WORDS = {
  placeholder: 'Search threads, comments and canvases',
  hint: 'Find what was asked and answered, past comments and canvas notes.',
};

// The last search, offered again the next time the palette opens.
let remembered = { query: '', filter: 'all', allBoards: false, openOnly: false };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? '⌘K' : 'Ctrl K';

// The card a result's target names, by the `<kind>Id` of a kind the page registered.
function cardIn(target: SearchResult['target'], kinds: CardKinds): { kind: string; id: string } | undefined {
  const keyed = target as Record<string, unknown>;
  for (const { id: kind } of kinds.kinds()) {
    const id = keyed[`${kind}Id`];
    if (typeof id === 'string' && id) return { kind, id };
  }
  return undefined;
}

// Where a result opens: its card, where the page's kinds of card say where it
// is (the same addresses the #12 and T5 links in text use), a message's place
// (the board's conversation on its Home, or its thread of work there), or the
// board context.
function hrefOf(result: SearchResult, kinds: CardKinds): string {
  const { boardId, target } = result;
  if (target.threadId) return target.conversation ? linkTo.board(boardId, 'timeline') : linkTo.thread(boardId, target.threadId);
  const card = cardIn(target, kinds);
  if (card) return kinds.byId(card.kind, boardId, card.id)?.href ?? linkTo.board(boardId);
  if (target.pageId) return linkTo.page(boardId, target.pageId);
  return linkTo.context(boardId);
}

function open(result: SearchResult, kinds: CardKinds): void {
  const { target } = result;
  // A message is scrolled to and flashed where it is.
  if (target.conversation) return openConversation(result.boardId, target.messageId);
  if (target.blockId) focusBlock(target.blockId);
  location.hash = hrefOf(result, kinds);
  // A comment in a card's discussion is scrolled to and flashed there, and so is a message in its thread.
  if (target.commentId && !target.pinId) showComments([target.commentId]);
  if (target.messageId) showComments([target.messageId]);
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

interface PaletteProps {
  boardId?: string; // the board on screen; none on Home, where every board is searched
  onClose: () => void;
}

function Palette({ boardId, onClose }: PaletteProps) {
  const kinds = useCardKinds();
  const views = useBoardViews();
  const slot = views.search();
  const contextName = views.boardContext()?.name;
  const filters: Filter[] = useMemo(
    () => [
      { key: 'all', label: 'All', kinds: slot ? [] : CANVAS_KINDS },
      ...(slot?.filters ?? []),
      { key: 'threads', label: 'Threads', kinds: ['message'] },
      { key: 'comments', label: 'Comments', kinds: ['comment'] },
      { key: 'canvas', label: 'Canvas', kinds: ['block'] },
    ],
    [slot],
  );
  const words = slot ?? PLAIN_WORDS;
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
    const kinds = filters.find((f) => f.key === filter)?.kinds;
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
  }, [boardId, trimmed, searchable, filter, everyBoard, openOnly, filters]);

  // Results come best first; each kind's group goes where its best one is.
  const groups = useMemo(() => {
    const byKind = new Map<SearchKind, SearchResult[]>();
    for (const result of found?.results ?? []) byKind.set(result.kind, [...(byKind.get(result.kind) ?? []), result]);
    return [...byKind].map(([kind, results]) => ({ kind, label: slot?.groups[kind] ?? GROUP_LABEL[kind] ?? kind, results }));
  }, [found, slot]);
  const rows = groups.flatMap((group) => group.results);

  useEffect(() => {
    document.getElementById(`search-row-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (result: SearchResult) => {
    onClose();
    open(result, kinds);
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
            placeholder={words.placeholder}
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
            {filters.map((f) => (
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
            {slot && (
              <button type="button" className="search-chip" aria-pressed={openOnly} title={slot.openOnly.title} onClick={() => setOpenOnly(!openOnly)}>
                {openOnly && <Icon name="check" />} Open only
              </button>
            )}
          </div>
        </div>

        <div className="search-results" id="search-results" role="listbox" aria-label="Results">
          {!searchable ? (
            <p className="search-empty">
              {trimmed ? 'Type at least two characters.' : words.hint}
            </p>
          ) : error ? (
            <p className="search-empty error">{error}</p>
          ) : found && found.total === 0 ? (
            <div className="search-empty">
              <p>
                Nothing matches “{trimmed}” on {scope}
                {filter === 'all' ? '' : ` in ${filters.find((f) => f.key === filter)?.label.toLowerCase()}`}
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
                  const onContext = result.target.canvas === 'board' || result.target.canvas === 'page';
                  const said = Boolean(result.target.threadId); // a thread's message: where, the conversation or its thread
                  const look = slot?.result(result);
                  const where = [onContext && (result.target.pageId ? result.ref : contextName), said && result.ref, result.snippet?.where].filter(Boolean).join(' · ');
                  return (
                    <a
                      key={`${result.kind}:${result.target.messageId ?? result.target.commentId ?? result.target.blockId ?? cardIn(result.target, kinds)?.id}:${i}`}
                      id={`search-row-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={`search-row${i === active ? ' is-active' : ''}`}
                      href={hrefOf(result, kinds)}
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={(e) => onRowClick(e, result)}
                      title={look?.status ? `${result.ref} · ${look.status}` : result.ref}
                    >
                      <span className={`search-ref ${look?.marker ?? ''}`}>
                        {onContext ? <Icon name="canvas" /> : said ? <Icon name="thread" /> : result.ref}
                      </span>
                      <span className="search-text">
                        <span className="search-title">
                          <Marked text={result.title} ranges={result.titleRanges} />
                        </span>
                        {(result.snippet || where) && (
                          <span className="search-snippet">
                            {where && <span className="search-where">{where}</span>}
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
                        {look?.tag}
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
