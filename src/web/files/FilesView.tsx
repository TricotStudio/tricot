// The board's project files, behind the folder icon before the
// Overview: the files of the board's project folder (server/projectFiles.ts),
// to search, read and take onto a Sketchbook page, alone or with an agent.
//
// A title line says which folder, its branch and how many files; under it,
// the files at the left (a search, three filters: all, changed this week, on
// the board, and the folders they are in), the file picked in the middle, and
// beside it where the file is on the board, what an agent is doing in it now
// and its last commit. The file picked is in the address
// (#/b/<board>/files?path=src/index.ts), so Back and links work.
//
// The folder icon is on every board, and the project folder is chosen and
// changed here (ProjectFolderDialog.tsx): *Choose project folder…* when the
// board has none, *Change folder…* in the title line when it has. A folder
// that changes, from here or by an agent, starts the view over.
//
// The file's view reads it, edits it: the whole file as text, saved
// over it on this computer, and only over the version opened, so an edit
// never overwrites what an agent saved since; or pairs on it with an agent:
// its code block on the board's Files canvas opens full screen, as
// any code block's does, to point at lines and ask; the agent changes the
// file itself, and the block is brought up to the file while they pair. What
// is saved, the block follows too (server: api.ts).
//
// The search at the top of the list finds a file by its name, or, switched to
// Inside files (⌘⇧F from any view), by what is in the files, as an IDE's Find
// in Files does (search.tsx): the lines that match, by file, in the
// place of the tree; a click opens the file at that line, marked
// (#/b/<board>/files?path=src/index.ts&line=12).
//
// The chat bar floating over it asks about the file open here:
// the file says which it is, once its text is read (`onShown`), and not for
// a picture, which has no text to ask about, nor while the list or nothing
// is picked. What is sent starts a thread on the file's block.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { codeLanguage, codeLines } from '../../core/blocks/code/code';
import type { OpenFile } from '../../core/fileThread';
import { hasText, previewOf, type ProjectFile, type ProjectFileText, type ProjectFiles } from '../../core/projectFiles';
import type { Board } from '../../core/types';
import { phaseOf, busyOfPhase, useSteps, stepWords } from '../agents';
import { CanvasView, Code, coloursOf, highlightLine, type Token } from '../canvas';
import type { ProjectSearchOptions } from '../../core/projectSearch';
import { api, type RequestError } from '../shared/api';
import type { CardKinds } from '../shared/cardKinds';
import { useBoardViews } from '../shared/boardViewsContext';
import { CardAnchor, useCardKinds } from '../shared/cardKindsContext';
import { askToConfirm } from '../shared/confirm';
import { Icon, timeAgo } from '../shared/components';
import { useReadOnly, useStoredFlag } from '../shared/hooks';
import { go, linkTo } from '../shared/pages';
import { Stitch } from '../shared/stitch';
import { ProjectFolderDialog } from './ProjectFolderDialog';
import { FilePreviewBody, PictureFile } from './preview';
import { SearchResults, useContentSearch } from './search';
import { FIND_IN_FILES, FIND_IN_FILES_KEYS, FOLD_PANELS, FOLD_PANELS_KEYS, isFoldPanels, useFindRequest } from './shortcut';
import { bestMatches, filesShown, foldersOf, placesOnBoard, treeOf, type FilePlace, type FilesShow, type Folder } from './tree';
import './files.css';

const MOST_ROWS = 1500; // rows the list draws at once; a search narrows the rest
const MOST_LINES = 4000; // lines the preview draws; the page holds them all
const AROUND_HIT = 300; // a hit past them: this many lines before it and after it are drawn instead
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const nameOf = (file: string) => file.slice(file.lastIndexOf('/') + 1);

// The board's project folder, when it has one.
export const projectFolderOf = (board: Board): string | undefined => (board as Board & { folder?: string }).folder;

const STATUS_MARK: Record<NonNullable<ProjectFile['status']>, { mark: string; words: string }> = {
  modified: { mark: 'M', words: 'Changed since the last commit' },
  added: { mark: 'A', words: 'New, added to the next commit' },
  untracked: { mark: 'U', words: "New, git doesn't track it yet" },
  renamed: { mark: 'R', words: 'Renamed since the last commit' },
};

export function FilesView({ board, name, file: asked, pair, line, onShown }: { board: Board; name: string; file?: string; pair?: boolean; line?: number; onShown?: (file: OpenFile | undefined) => void }) {
  const folder = projectFolderOf(board);
  const [listing, setListing] = useState<ProjectFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<FilesShow>('all');
  // What the search looks for: a file's name, or text inside the files, with its three switches.
  const [inside, setInside] = useState(false);
  const [text, setText] = useState('');
  const [exact, setExact] = useState<Pick<ProjectSearchOptions, 'matchCase' | 'word' | 'regex'>>({});
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // The project folder is chosen and changed here, where it is used: its dialog,
  // from the empty state or the title line (an archived board keeps its folder).
  const readOnly = useReadOnly();
  const [choosing, setChoosing] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  // ⌘P or ⌘⇧F, from here or any view (shortcut.ts): the search, for a name or inside the files, focused, what was typed selected.
  // Its panels: the file tree and On the board fold away, one at a
  // time or both at once (⌘\), for the file to take the whole width, to
  // read, edit or pair on; remembered on this computer. A ⌘P search shows
  // the tree while it is folded, until a file is opened.
  const [treeShown, showTree] = useStoredFlag('tricot:files-tree', () => true);
  const [sideShown, showSide] = useStoredFlag('tricot:files-side', () => true);
  const [peek, setPeek] = useState(false);
  const treeOn = treeShown || peek;
  useFindRequest(
    useCallback((kind: 'file' | 'text') => {
      setInside(kind === 'text');
      setPeek(true);
      requestAnimationFrame(() => requestAnimationFrame(() => find.current?.select())); // once the tree is drawn
    }, []),
  );
  useEffect(() => {
    const fold = (e: KeyboardEvent) => {
      if (!isFoldPanels(e)) return;
      e.preventDefault();
      const open = !(treeShown || sideShown); // both folded: both back; else both away
      showTree(open);
      showSide(open);
      setPeek(false);
    };
    document.addEventListener('keydown', fold);
    return () => document.removeEventListener('keydown', fold);
  }, [treeShown, sideShown, showTree, showSide]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .projectFiles(board.id)
      .then(setListing, (failed: Error) => setError(failed.message))
      .finally(() => setLoading(false));
  }, [board.id]);
  useEffect(() => {
    if (folder) load();
    else setListing(null);
  }, [folder, load]);
  // A folder changed under the view, here or by an agent: what was searched,
  // filtered, opened and picked was the old folder's, so the view starts over.
  const shownFolder = useRef(folder);
  useEffect(() => {
    if (shownFolder.current === folder) return;
    shownFolder.current = folder;
    setListing(null);
    setQuery('');
    setText('');
    setShow('all');
    setOpened(new Set());
    if (asked) go.files(board.id);
  }, [folder, asked, board.id]);

  // A pin's link names the file as its code block does, from the repository's
  // top: inside a repository whose top is above the folder, that comes off.
  const prefix = listing?.git?.prefix ?? '';
  const file = asked && prefix && asked.startsWith(prefix) && !listing?.files.some((f) => f.path === asked) ? asked.slice(prefix.length) : asked;
  const places = useMemo(() => placesOnBoard(board, listing?.git?.prefix ?? ''), [board, listing]);
  useEffect(() => {
    if (file) setPeek(false); // a file opened from the search: the tree folds again
  }, [file]);
  // The file picked, in view in the list, once the list is drawn (a link, or Back, can pick one far down).
  useEffect(() => {
    rows.current?.querySelector('.is-picked')?.scrollIntoView({ block: 'nearest' });
  }, [file, listing]);
  const files = listing?.files ?? [];
  const found = useContentSearch(board.id, { q: text, ...exact }, Boolean(folder) && inside);
  const shown = useMemo(() => filesShown(files, query, show, places), [files, query, show, places]);
  const tree = useMemo(() => treeOf(shown), [shown]);
  const counts = useMemo(() => ({ all: files.length, week: files.filter((f) => f.week).length, board: files.filter((f) => places.has(f.path)).length }), [files, places]);
  // The folders shown open: every one, while a search or a filter narrows
  // the list; else those the person opened, and the picked file's.
  const narrowed = query.trim() !== '' || show !== 'all';
  const isOpen = (path: string) => narrowed || opened.has(path) || (file !== undefined && foldersOf(file).includes(path));
  const toggle = (path: string) => setOpened((now) => {
    const next = new Set(now);
    if (isOpen(path) && !narrowed) {
      next.delete(path);
      // a folder the picked file is in stays open unless closed on its own
      if (file && foldersOf(file).includes(path)) go.files(board.id);
    } else next.add(path);
    return next;
  });

  // The dialog goes back to the button that opened it, when that is still there.
  const folderDialog = choosing && (
    <ProjectFolderDialog
      board={board}
      name={name}
      onClose={() => {
        setChoosing(false);
        opener.current?.focus();
      }}
    />
  );

  if (!folder) {
    return (
      <section className="files" aria-label="Project files">
        <div className="files-empty">
          <Icon name="folder" />
          <h2>This board has no project folder yet</h2>
          {readOnly ? (
            <p>This board is archived, so a folder can't be chosen until it is unarchived. Its files then show here, to read and to open on a Sketchbook page.</p>
          ) : (
            <>
              <p>Choose the folder this board is about, or start Tricot inside the project's folder: a board made there takes it. Its files then show here, to read and to open on a Sketchbook page.</p>
              <button className="btn btn-primary" ref={opener} onClick={() => setChoosing(true)}>
                Choose project folder…
              </button>
            </>
          )}
        </div>
        {folderDialog}
      </section>
    );
  }

  const picked = file ? files.find((f) => f.path === file) : undefined;
  return (
    <section className="files" aria-label="Project files">
      <header className="files-title">
        <h2>Files</h2>
        <span className="files-where" title={listing?.folder ?? folder}>
          {listing?.folder ?? folder}
          {listing?.git?.branch && <> · {listing.git.branch}</>}
          {listing?.git && <> · {listing.git.clean ? 'clean' : 'changes not committed'}</>}
          {listing && <> · {plural(listing.files.length, 'file')}{listing.truncated ? ' (the first ones)' : ''}</>}
        </span>
        <button className="btn btn-quiet btn-small files-reload" onClick={load} disabled={loading} title="Read the folder again">
          <Icon name="sync" />
          {loading ? 'Reading…' : 'Reload'}
        </button>
        {!readOnly && (
          <button className="btn btn-quiet btn-small files-change" ref={opener} onClick={() => setChoosing(true)} title="Choose another project folder for this board, or remove it">
            <Icon name="folder" />
            Change folder…
          </button>
        )}
        <span className="files-panels" role="group" aria-label="Panels">
          <button
            type="button"
            className={`icon-button${treeOn ? ' is-on' : ''}`}
            aria-pressed={treeOn}
            aria-keyshortcuts={FOLD_PANELS_KEYS}
            onClick={() => {
              showTree(!treeOn);
              setPeek(false);
            }}
            title={`${treeOn ? 'Hide' : 'Show'} the files (${FOLD_PANELS} for both panels)`}
            aria-label={treeOn ? 'Hide the files' : 'Show the files'}
          >
            <Icon name="panel-left" />
          </button>
          <button
            type="button"
            className={`icon-button${sideShown ? ' is-on' : ''}`}
            aria-pressed={sideShown}
            aria-keyshortcuts={FOLD_PANELS_KEYS}
            onClick={() => showSide(!sideShown)}
            title={`${sideShown ? 'Hide' : 'Show'} On the board (${FOLD_PANELS} for both panels)`}
            aria-label={sideShown ? 'Hide On the board' : 'Show On the board'}
          >
            <Icon name="panel-right" />
          </button>
        </span>
      </header>

      <div className={`files-body${picked || file ? ' has-file' : ''}${treeOn ? '' : ' no-tree'}${sideShown ? '' : ' no-side'}`}>
        <aside className="files-list" aria-label="The project's files">
          <div className="pair-modes files-scope" role="group" aria-label="Search">
            <button type="button" className={`pair-mode${inside ? '' : ' is-on'}`} aria-pressed={!inside} onClick={() => setInside(false)} title="Find a file by its name">
              File names
            </button>
            <button type="button" className={`pair-mode${inside ? ' is-on' : ''}`} aria-pressed={inside} aria-keyshortcuts={FIND_IN_FILES_KEYS} onClick={() => setInside(true)} title={`Find text inside the files (${FIND_IN_FILES})`}>
              Inside files
            </button>
          </div>
          <label className="files-find">
            <Icon name="search" />
            <input
              type="search"
              value={inside ? text : query}
              placeholder={inside ? 'Search inside the files…' : 'Find a file…'}
              aria-label={inside ? 'Search inside the files' : 'Find a file'}
              data-files-find
              ref={find}
              onChange={(event) => (inside ? setText : setQuery)(event.target.value)}
              onKeyDown={(event) => {
                const typed = inside ? text : query;
                if (event.key === 'Escape' && typed) {
                  event.preventDefault();
                  (inside ? setText : setQuery)('');
                } else if (event.key === 'Enter' && inside) {
                  const first = found.result?.files[0];
                  if (first && !found.searching) go.files(board.id, first.path, first.lines[0].line); // the first match
                } else if (event.key === 'Enter' && shown.length) go.files(board.id, (query.trim() ? bestMatches(shown, query, 1)[0] : shown[0]).path); // the best match
              }}
            />
          </label>
          {inside ? (
            <div className="files-filters" role="group" aria-label="Match">
              {(
                [
                  ['matchCase', 'Match case', 'Only text in the same case'],
                  ['word', 'Whole word', 'Only whole words'],
                  ['regex', 'Regex', 'Read it as a regular expression'],
                ] as const
              ).map(([flag, label, title]) => (
                <button key={flag} className={`files-filter${exact[flag] ? ' is-on' : ''}`} aria-pressed={Boolean(exact[flag])} title={title} onClick={() => setExact({ ...exact, [flag]: !exact[flag] })}>
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <div className="files-filters" role="group" aria-label="Show">
              {(
                [
                  ['all', 'All', counts.all],
                  ['week', 'This week', counts.week],
                  ['board', 'On the board', counts.board],
                ] as const
              ).map(([value, label, count]) => (
                <button key={value} className={`files-filter${show === value ? ' is-on' : ''}`} aria-pressed={show === value} onClick={() => setShow(value)}>
                  {label} <b>{count.toLocaleString('en-US')}</b>
                </button>
              ))}
            </div>
          )}
          {!inside && narrowed && listing && <p className="files-count">{shown.length ? `${plural(shown.length, 'file')} ${query.trim() ? `match “${query.trim()}”` : 'shown'}` : 'No file matches'}</p>}
          <div className="files-rows" role={inside ? 'region' : 'tree'} aria-label={inside ? 'What was found' : 'Folders and files'} ref={rows}>
            {inside ? (
              <SearchResults board={board} query={text} search={found} file={file} line={line} />
            ) : error ? (
              <div className="files-note is-error">
                <p>{error}</p>
                <button className="btn btn-small" onClick={load}>Try again</button>
              </div>
            ) : !listing ? (
              <p className="files-note">Reading {folder}…</p>
            ) : (
              <Rows folder={tree} depth={0} board={board} picked={file} places={places} isOpen={isOpen} toggle={toggle} budget={{ left: MOST_ROWS }} />
            )}
          </div>
        </aside>

        {file ? (
          <Preview key={file} board={board} name={name} file={file} line={line} listed={picked} places={places.get(file) ?? []} onSaved={load} pairNow={Boolean(pair)} onShown={onShown} />
        ) : (
          <Lately board={board} files={files} listed={Boolean(listing)} />
        )}
      </div>
      {folderDialog}
    </section>
  );
}

// A folder's folders and files, as rows, the open folders' within them.
function Rows(props: {
  folder: Folder;
  depth: number;
  board: Board;
  picked?: string;
  places: ReadonlyMap<string, FilePlace[]>;
  isOpen: (path: string) => boolean;
  toggle: (path: string) => void;
  budget: { left: number };
}) {
  const { folder, depth, board, picked, places, isOpen, toggle, budget } = props;
  const indent = { paddingLeft: 10 + depth * 16 };
  const rows = [];
  for (const inner of folder.folders) {
    if (budget.left-- <= 0) break;
    const open = isOpen(inner.path);
    rows.push(
      <div key={`d:${inner.path}`} role="treeitem" aria-expanded={open}>
        <button className="files-row is-folder" style={indent} onClick={() => toggle(inner.path)}>
          <Icon name="chevron-down" className={open ? 'files-twist is-open' : 'files-twist'} />
          <Icon name="folder" className="files-folder" />
          <span className="files-name">{inner.name}</span>
          <span className="files-n">{inner.count.toLocaleString('en-US')}</span>
        </button>
        {open && (
          <div role="group">
            <Rows {...props} folder={inner} depth={depth + 1} />
          </div>
        )}
      </div>,
    );
  }
  for (const file of folder.files) {
    if (budget.left-- <= 0) break;
    const mark = file.status && STATUS_MARK[file.status];
    rows.push(
      <a
        key={`f:${file.path}`}
        role="treeitem"
        aria-selected={file.path === picked}
        className={`files-row${file.path === picked ? ' is-picked' : ''}`}
        style={{ paddingLeft: 10 + depth * 16 + 15 }}
        href={linkTo.files(board.id, file.path)}
      >
        <Icon name="note" className="files-file" />
        <span className="files-name">{nameOf(file.path)}</span>
        <span className="files-marks">
          {mark && (
            <span className={`files-status is-${file.status}`} title={mark.words}>
              {mark.mark}
            </span>
          )}
          {places.has(file.path) && <span className="files-onboard" title="On the board" />}
        </span>
      </a>,
    );
  }
  if (depth === 0 && budget.left <= 0) rows.push(<p key="more" className="files-note">More files than fit here: find one by name.</p>);
  return <>{rows}</>;
}

// With no file picked: what changed lately, to start from.
function Lately({ board, files, listed }: { board: Board; files: ProjectFile[]; listed: boolean }) {
  const lately = useMemo(
    () =>
      files
        .filter((f) => f.week)
        .sort((a, b) => Number(Boolean(b.status)) - Number(Boolean(a.status)) || Date.parse(b.last?.at ?? '0') - Date.parse(a.last?.at ?? '0'))
        .slice(0, 10),
    [files],
  );
  return (
    <div className="files-lately">
      <h3>{listed ? 'Changed lately' : ' '}</h3>
      {listed && !lately.length && <p className="files-note">Nothing changed this week. Pick a file at the left to read it here.</p>}
      <ul>
        {lately.map((file) => (
          <li key={file.path}>
            <a href={linkTo.files(board.id, file.path)}>
              <span className="files-name">{nameOf(file.path)}</span>
              <span className="files-dir">{file.path.slice(0, -nameOf(file.path).length) || './'}</span>
              <span className="files-when">{file.status ? STATUS_MARK[file.status].words : file.last ? `${file.last.by} · ${timeAgo(file.last.at)}` : ''}</span>
            </a>
          </li>
        ))}
      </ul>
      {listed && <p className="files-hint">Pick a file to read it, then open it on a Sketchbook page to work on it, alone or with an agent.</p>}
    </div>
  );
}

// The file picked: its text, what to do with it, and where it is on the board.
function Preview({ board, name, file, line, listed, places, onSaved, pairNow, onShown }: { board: Board; name: string; file: string; line?: number; listed?: ProjectFile; places: FilePlace[]; onSaved: () => void; pairNow: boolean; onShown?: (file: OpenFile | undefined) => void }) {
  const cards = useCardKinds();
  const context = useBoardViews().boardContext()?.name.toLowerCase() ?? 'board';
  const [text, setText] = useState<ProjectFileText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'edit' | 'pair'>('read');
  const [paired, setPaired] = useState<{ pageId: string; blockId: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // A file the board can draw opens drawn so, its text a switch away;
  // a picture that isn't text (all but an SVG) has only its picture.
  const kind = previewOf(file);
  const textual = hasText(file);
  // Opened at a line (from a search inside the files), it shows its text, with the line in view.
  const [shown, setShown] = useState<'preview' | 'source'>(kind && !line ? 'preview' : 'source');
  const code = useRef<HTMLDivElement>(null);
  const scrolled = useRef<string | undefined>(undefined);
  const read = useCallback(
    () =>
      (textual ? api.projectFile(board.id, file) : Promise.resolve(null)).then(
        (now) => {
          setText(now);
          setError(null);
          return now;
        },
        (failed: Error) => {
          setError(failed.message);
          return null;
        },
      ),
    [board.id, file, textual],
  );
  useEffect(() => {
    void read();
  }, [read]);
  // Its text read, the file is the one open: what the chat bar asks about.
  const named = text?.named;
  useEffect(() => {
    if (!named) return;
    onShown?.({ path: file, named });
    return () => onShown?.(undefined);
  }, [file, named, onShown]);

  const lines = useMemo(() => (text ? codeLines(text.text) : []), [text]);
  // The lines drawn: the first MOST_LINES, or, for a hit past them, a window around it (not all of a lockfile).
  const hitAt = line ? line - (text?.start ?? 1) : -1;
  const first = hitAt >= MOST_LINES ? hitAt - AROUND_HIT : 0;
  const tokens = useMemo(() => {
    const colours = coloursOf(codeLanguage({ path: file }));
    const carried = { inComment: false };
    const to = hitAt >= MOST_LINES ? hitAt + AROUND_HIT + 1 : MOST_LINES;
    return lines.slice(first, to).map((row) => highlightLine(row, colours, carried));
  }, [lines, file, hitAt, first]);
  // A line asked for: the text, not the drawing, with that line in the middle of the view, once its text is drawn.
  useEffect(() => {
    if (line) setShown('source');
  }, [line]);
  useEffect(() => {
    if (!line || !text || mode !== 'read' || shown !== 'source' || scrolled.current === `${file}:${line}`) return;
    const row = code.current?.querySelector(`[data-line="${line}"]`);
    if (!row) return;
    scrolled.current = `${file}:${line}`;
    row.scrollIntoView({ block: 'center' });
  }, [line, text, mode, shown, file]);
  const steps = useSteps();
  const now = Date.now();
  const inIt = steps.filter((step) => step.text.includes(nameOf(file)) && phaseOf(step, now));

  // Edit: the whole file as text, saved over it with ⌘S or Save, and only
  // over the version opened: if an agent saved it since, nothing is
  // written, and the band says so, with the way on.
  const editing = mode === 'edit';
  const changed = editing && text !== null && draft !== text.text;
  const edit = () => {
    if (!text) return;
    setDraft(text.text);
    setConflict(null);
    setMode('edit');
  };
  const leave = async (): Promise<boolean> => {
    if (changed && !(await askToConfirm({ title: `Drop your changes to ${nameOf(file)}?`, detail: "They aren't saved to the file.", confirmLabel: 'Drop them', cancelLabel: 'Keep editing', danger: true }))) return false;
    setMode('read');
    setConflict(null);
    return true;
  };
  const look = async (view: 'preview' | 'source') => {
    if (editing && !(await leave())) return;
    setShown(view);
  };
  const reading = (view: 'preview' | 'source') => mode === 'read' && shown === view;
  const save = async () => {
    if (!text || busy || !changed) return;
    setBusy(true);
    setConflict(null);
    try {
      const { file: written } = await api.writeProjectFile(board.id, name, file, draft, text.hash);
      setText(written);
      setMode('read');
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      onSaved();
    } catch (failed) {
      if ((failed as RequestError).status === 409) setConflict((failed as Error).message);
      else setError((failed as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Pair: the file's block on the Files canvas (made the first time, else
  // brought up to the file), opened full screen as any code block is, to
  // point at lines and ask the agent; closing it comes back here, the file
  // read again. While they pair, the block is brought up to the file every
  // few seconds, as the agent changes the file itself.
  const pair = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { block, pageId } = await api.projectFileBlock(board.id, name, file);
      setPaired({ pageId, blockId: block.id });
      setMode('pair');
    } catch (failed) {
      setError((failed as Error).message);
    } finally {
      setBusy(false);
    }
  }, [board.id, name, file]);
  const unpair = useCallback(() => {
    setMode('read');
    setPaired(null);
    void read();
  }, [read]);
  const asked = useRef(pairNow);
  useEffect(() => {
    if (!asked.current || !text) return;
    asked.current = false; // a pin's link: once
    void pair();
  }, [text, pair]);
  useEffect(() => {
    if (mode !== 'pair') return;
    const timer = window.setInterval(() => void api.projectFileBlock(board.id, name, file).catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [mode, board.id, name, file]);
  const filesPage = paired ? board.pages?.find((p) => p.id === paired.pageId) : undefined;

  // The newer version, read again: the edit is dropped, or first copied to type in again.
  const takeTheirs = async (copy: boolean) => {
    if (copy) await navigator.clipboard?.writeText(draft).catch(() => undefined);
    const fresh = await read();
    if (fresh) setDraft(fresh.text);
    setConflict(null);
  };

  const parts = file.split('/');
  return (
    <>
      <div className="files-preview">
        {mode !== 'pair' && (
        <div className="files-head">
          <span className="files-crumbs" title={file}>
            {parts.slice(0, -1).map((part, i) => (
              <span key={i}>{part} / </span>
            ))}
            <b>{parts[parts.length - 1]}</b>
          </span>
          {saved && <span className="files-saved">Saved</span>}
          {editing && (
            <span className="files-actions">
              <button className="btn btn-small" onClick={() => void leave()} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-small btn-primary" onClick={() => void save()} disabled={busy || !changed} title="Save it over the file (⌘S)">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </span>
          )}
          {textual && (
          <div className="pair-modes files-modes" role="group" aria-label="Mode">
            {kind ? (
              <>
                <button type="button" className={`pair-mode${reading('preview') ? ' is-on' : ''}`} aria-pressed={reading('preview')} onClick={() => void look('preview')} title={PREVIEW_TITLES[kind]}>
                  Preview
                </button>
                <button type="button" className={`pair-mode${reading('source') ? ' is-on' : ''}`} aria-pressed={reading('source')} onClick={() => void look('source')} title="Its text, line by line">
                  Source
                </button>
              </>
            ) : (
              <button type="button" className={`pair-mode${mode === 'read' ? ' is-on' : ''}`} aria-pressed={mode === 'read'} onClick={() => editing && void leave()} title="Read the file">
                Read
              </button>
            )}
            <button type="button" className={`pair-mode${editing ? ' is-on' : ''}`} aria-pressed={editing} onClick={() => !editing && edit()} disabled={!text} title="Edit the file itself, and save it over it">
              Edit
            </button>
            <button type="button" className="pair-mode" aria-pressed={false} onClick={() => void pair()} disabled={!text || busy || editing} title="Pair with an agent on it: point at lines and ask; the agent changes the file">
              Pair
            </button>
          </div>
          )}
        </div>
        )}
        {conflict && (
          <div className="files-band is-conflict" role="alert">
            <span>{conflict}</span>
            <button className="btn btn-small" onClick={() => void takeTheirs(true)}>
              Copy my edit, then reload
            </button>
            <button className="btn btn-small" onClick={() => void takeTheirs(false)}>
              Reload
            </button>
          </div>
        )}
        {mode === 'pair' ? (
          <div className="files-pair">
            {paired && filesPage ? (
              <CanvasView board={board} page={filesPage} name={name} opens={paired.blockId} onClosed={unpair} />
            ) : (
              <p className="files-note">Opening {nameOf(file)} to pair on…</p>
            )}
          </div>
        ) : editing ? (
          <FileEditor value={draft} onChange={setDraft} onSave={() => void save()} label={`Edit ${file}`} />
        ) : (
          <div ref={code} className={`files-code${kind && shown === 'preview' ? ` is-preview is-${kind}` : ''}`} tabIndex={0} aria-label={kind && shown === 'preview' ? `${file}, drawn` : `The text of ${file}`}>
            {error ? (
              <p className="files-note is-error">{error}</p>
            ) : kind === 'image' && shown === 'preview' ? (
              <PictureFile board={board} file={file} stamp={`${listed?.size ?? ''}-${text?.hash.slice(0, 8) ?? ''}`} />
            ) : !text ? (
              <p className="files-note">Reading {nameOf(file)}…</p>
            ) : kind && kind !== 'image' && shown === 'preview' ? (
              <FilePreviewBody board={board} file={file} kind={kind} text={text.text} />
            ) : (
              <pre>
                {first > 0 && <span className="files-line is-more">{plural(first, 'line')} before these.</span>}
                {tokens.map((parts, k) => {
                  const i = first + k;
                  return (
                    <span key={i} className={`files-line${text.start + i === line ? ' is-hit' : ''}`} data-line={text.start + i}>
                      <i>{text.start + i}</i>
                      <Code tokens={parts.length ? parts : ([{ text: lines[i] }] as Token[])} />
                      {'\n'}
                    </span>
                  );
                })}
                {lines.length > first + tokens.length && <span className="files-line is-more">{plural(lines.length - first - tokens.length, 'more line')} after these.</span>}
              </pre>
            )}
          </div>
        )}
      </div>

      <aside className="files-side" aria-label={`${nameOf(file)} on the board`}>
        <h4>On the board</h4>
        {places.length ? (
          places.map((place) => (
            <CardAnchor key={place.blockId} className="files-place" href={placeLink(cards, board, place, file)}>
              <Icon name={place.kind === 'code' ? 'code' : 'details'} />
              <span>
                {place.title}
                <small>{placeWhere(place, context)}</small>
              </span>
            </CardAnchor>
          ))
        ) : (
          <p className="files-note">Not on the board yet.</p>
        )}
        {inIt.length > 0 && (
          <>
            <h4>Now</h4>
            {inIt.map((step) => (
              <p key={step.agent} className="files-now">
                <span className="files-agent">{step.agent[0]}</span>
                <span>
                  {step.agent} · {stepWords(step)}
                </span>
                <Stitch state={busyOfPhase(phaseOf(step, now) ?? 'dim')} />
              </p>
            ))}
          </>
        )}
        <h4>Lately</h4>
        {listed?.status && <p className="files-note">{STATUS_MARK[listed.status].words}.</p>}
        {listed?.last ? (
          <p className="files-note">
            <b>{listed.last.subject}</b>
            <br />
            {listed.last.by} · {timeAgo(listed.last.at)} · {listed.last.commit}
          </p>
        ) : (
          !listed?.status && <p className="files-note">No recent commit changed it.</p>
        )}
        {text?.total || lines.length ? <p className="files-note">{plural(text?.total ?? lines.length, 'line')}</p> : null}
      </aside>
    </>
  );
}

// The file's text to edit: a plain field in the code's own type, its lines
// numbered beside it. Tab puts in two spaces rather than leaving the field;
// ⌘S (Ctrl S elsewhere) saves.
function FileEditor({ value, onChange, onSave, label }: { value: string; onChange: (next: string) => void; onSave: () => void; label: string }) {
  const gutter = useRef<HTMLPreElement>(null);
  const count = useMemo(() => value.split('\n').length, [value]);
  const numbers = useMemo(() => Array.from({ length: count }, (_, i) => i + 1).join('\n'), [count]);
  return (
    <div className="files-editor">
      <pre className="files-gutter" ref={gutter} aria-hidden>
        {numbers}
      </pre>
      <textarea
        autoFocus
        spellCheck={false}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onKeyDown={(event) => {
          if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSave();
          } else if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            const field = event.currentTarget;
            const { selectionStart: from, selectionEnd: to } = field;
            onChange(value.slice(0, from) + '  ' + value.slice(to));
            requestAnimationFrame(() => field.setSelectionRange(from + 2, from + 2));
          }
        }}
      />
    </div>
  );
}

// What Preview draws a file as, by its kind.
const PREVIEW_TITLES = {
  markdown: 'As it reads, as a note does',
  mermaid: 'The diagram, as a diagram block draws it',
  table: 'As a table',
  image: 'The picture',
};

// Where a block that shows the file is, as a link to it: the Files canvas's is this file, to pair on.
// A card's canvas is where the kind of card registered for it says (none, no link).
function placeLink(cards: CardKinds, board: Board, place: FilePlace, file: string): string | undefined {
  const on = place.on;
  if ('files' in on) return linkTo.files(board.id, file, true);
  if ('pageId' in on) return linkTo.page(board.id, on.pageId);
  if ('taskId' in on) return cards.byId('task', board.id, on.taskId)?.href;
  if ('decisionId' in on) return cards.byId('decision', board.id, on.decisionId)?.href;
  return linkTo.context(board.id);
}
// `context` is what the board's own canvas is called, in running words.
function placeWhere(place: FilePlace, context: string): string {
  const on = place.on;
  const what = place.kind === 'code' ? 'Code block' : 'Diff';
  if ('files' in on) return 'Where you pair on it, in Files';
  if ('pageId' in on) return `${what} on “${on.title}”`;
  if ('taskId' in on) return `${what} on T${on.number} ${on.title}`;
  if ('decisionId' in on) return `${what} on #${on.number} ${on.title}`;
  return `${what} on the ${context}`;
}
