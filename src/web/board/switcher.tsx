import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { NeedsReport, Project } from '../../core/needs';
import { Icon, seenAgo, timeAgo } from '../shared/components';
import { agentDoing, whoIsOn } from '../agents';
import { typing, useDismiss } from '../shared/hooks';
import { linkTo, type BoardViewName } from '../shared/pages';
import { useNeeds } from '../inbox';
import { byRecent, matching, readRecent } from './recentBoards';
import './switcher.css';

// Going from one board to another without Home: the board's name in its
// header, chevron and all, or ⌘B (Ctrl B elsewhere) from any view of a board,
// opens the boards in use, the ones opened here last first (recentBoards.ts).
// Typing filters them by title and goal. A board opens on the view on screen,
// so switching from Decisions, or from a decision, opens the other's Decisions.

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? '⌘B' : 'Ctrl B';

// Who is on it, as Home says, and when: "Claude working on T76 · just now"
// (its last call), "Claude, yesterday", or "no agent · 3h ago" (the board's
// last change).
function agentLine(project: Project): string {
  const who = whoIsOn(project);
  if (who && 'now' in who) return `${who.now.name} ${agentDoing(who.now)} · ${timeAgo(who.now.lastSeen)}`;
  if (who) return `${who.last.name}, ${seenAgo(who.last.at)}`;
  return `no agent · ${timeAgo(project.updatedAt)}`;
}

// A name cut short at the end of its line, so the tooltip gives it in full.
const isCut = (text: HTMLElement | null) => Boolean(text && text.scrollWidth > text.clientWidth);

interface Props {
  boardId: string; // the board on screen
  view: BoardViewName; // the view another board opens on
  name: string;
  title: string; // the board's name: the button that opens the list, which drops from under it
  children?: ReactNode; // in the name's place while it's being renamed
}

export function BoardSwitcher({ boardId, view, name, title, children }: Props) {
  const [isOpen, setOpen] = useState(false);
  // The boards and what needs the viewer on each, as Home has them, fetched while it's open.
  const { report, error } = useNeeds(name, isOpen);
  const button = useRef<HTMLButtonElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const opener = useRef<Element | null>(null);

  const open = useCallback((from: Element | null) => {
    opener.current = from;
    setOpen(true);
  }, []);
  // Back where the viewer was, unless a click elsewhere took them on.
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    const before = opener.current;
    if (refocus && before instanceof HTMLElement && before.isConnected) requestAnimationFrame(() => before.focus({ preventScroll: true }));
  }, []);

  // ⌘B, but not while writing: a field may want it for bold. In the
  // switcher's own filter it closes it again.
  useEffect(() => {
    const shortcut = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || e.altKey || e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey)) return;
      const inFilter = e.target instanceof Element && Boolean(e.target.closest('.board-switch-panel'));
      if (typing(e.target) && !inFilter) return;
      e.preventDefault();
      if (isOpen) close(true);
      else open(document.activeElement);
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [isOpen, open, close]);

  return (
    <div className="board-switch">
      {children ?? (
        // The heading is the board's name; the button says what it does in its tooltip.
        <h1>
          <button
            ref={button}
            type="button"
            className="board-switch-button"
            onClick={() => (isOpen ? close(true) : open(button.current))}
            onMouseEnter={() => setCut(isCut(text.current))}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-keyshortcuts={isMac ? 'Meta+B' : 'Control+B'}
            title={`${cut ? `${title}\n` : ''}Switch board (${SHORTCUT})`}
          >
            <span ref={text} className="board-switch-current">
              {title}
            </span>
            <Icon name="chevron-down" className="board-switch-chevron" />
          </button>
        </h1>
      )}
      {isOpen && <SwitchPanel boardId={boardId} view={view} report={report} error={error} button={button} onClose={close} />}
    </div>
  );
}

interface PanelProps {
  boardId: string;
  view: BoardViewName;
  report: NeedsReport | null;
  error: string | null;
  button: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
}

function SwitchPanel({ boardId, view, report, error, button, onClose }: PanelProps) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recent] = useState(readRecent);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();
  const rowId = (i: number) => `${listId}-${i}`;
  const hrefOf = (id: string) => linkTo.board(id, view);

  // Archived boards aren't in the report's projects, so they're left out here too.
  const boards = useMemo(() => (report ? matching(byRecent(report.projects, recent), query) : []), [report, recent, query]);
  // The highlight starts on the board opened before this one, so ⌘B then
  // Enter goes back to it, and on the first match once filtered.
  const active = boards.find((b) => b.id === activeId) ?? boards.find((b) => b.id !== boardId) ?? boards[0];
  const activeIndex = active ? boards.indexOf(active) : -1;

  // Escape goes back to where the viewer was; a click elsewhere leaves them there.
  useDismiss(true, onClose, panel, button);

  useEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [listId, activeIndex]);

  const choose = (id: string) => {
    onClose(false);
    location.hash = hrefOf(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (boards.length) setActiveId(boards[(activeIndex + (e.key === 'ArrowDown' ? 1 : boards.length - 1)) % boards.length].id);
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      choose(active.id);
    }
  };

  // A plain click opens the board here; with a modifier, the browser opens the link as it would.
  const onRowClick = (e: MouseEvent, id: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    choose(id);
  };

  const trimmed = query.trim();
  return (
    <div
      className="board-switch-panel"
      ref={panel}
      role="dialog"
      aria-label="Switch board"
      // Tabbing past its last link closes it, as a click elsewhere does.
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (next && !panel.current?.contains(next) && !button.current?.contains(next)) onClose(false);
      }}
    >
      <div className="board-switch-field">
        <Icon name="search" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Switch board…"
          aria-label="Find a board"
          role="combobox"
          aria-expanded={boards.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? rowId(activeIndex) : undefined}
          aria-autocomplete="list"
          spellCheck={false}
        />
        <kbd className="board-switch-key" aria-hidden>
          {SHORTCUT}
        </kbd>
      </div>

      <div className="board-switch-list" id={listId} role="listbox" aria-label={trimmed ? 'Matching boards' : 'Recent boards'}>
        {report === null ? (
          <p className={`board-switch-empty${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
            {error ? `Couldn't load your boards: ${error}` : 'Loading your boards…'}
          </p>
        ) : boards.length === 0 ? (
          <p className="board-switch-empty">{trimmed ? `No board matches “${trimmed}”.` : 'No boards in use.'}</p>
        ) : (
          <>
            {!trimmed && (
              <p className="board-switch-label" aria-hidden>
                Recent
              </p>
            )}
            {boards.map((board, i) => {
              const current = board.id === boardId;
              return (
                <a
                  key={board.id}
                  id={rowId(i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  aria-current={current ? 'page' : undefined}
                  className={`board-switch-row${i === activeIndex ? ' is-active' : ''}`}
                  href={hrefOf(board.id)}
                  onMouseMove={() => i !== activeIndex && setActiveId(board.id)}
                  onClick={(e) => onRowClick(e, board.id)}
                  title={board.goal}
                >
                  <span className="board-switch-text">
                    <span className="board-switch-title">
                      <span className="board-switch-name">{board.title}</span>
                      {board.needs > 0 && (
                        <span className="tag tag-needs">
                          {board.needs} {board.needs === 1 ? 'needs' : 'need'} you
                        </span>
                      )}
                    </span>
                    <span className="board-switch-agent">{agentLine(board)}</span>
                  </span>
                  {current && <Icon name="check" className="board-switch-check" />}
                </a>
              );
            })}
          </>
        )}
      </div>

      <footer className="board-switch-foot">
        <a className="board-switch-link" href={linkTo.newBoard()}>
          <Icon name="plus" /> New board
        </a>
        <a className="board-switch-link" href={linkTo.home()}>
          All boards
        </a>
      </footer>
    </div>
  );
}
