// Files' search of what is inside the files, as an IDE's Find in Files:
// the lines of the project's files that match, grouped by file, each with its
// number and its match marked; a click opens the file at that line
// (FilesView's Preview). The server does the reading (server/projectSearch.ts);
// this asks it once typing pauses, and drops the answer to a search typed over.
// A line's text is drawn as text, split at its marks, never as HTML.

import { useEffect, useState, type ReactNode } from 'react';
import { MAX_SEARCH_MATCHES, SEARCH_MS, type Mark, type ProjectSearch, type ProjectSearchOptions } from '../../core/projectSearch';
import { MAX_PROJECT_FILES } from '../../core/projectFiles';
import type { Board } from '../../core/types';
import { api } from '../shared/api';
import { linkTo } from '../shared/pages';

const PAUSE_MS = 250; // typing this long still asks for nothing
const plural = (n: number, word: string, words = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : words}`;
const nameOf = (file: string) => file.slice(file.lastIndexOf('/') + 1);

export interface ContentSearch {
  result?: ProjectSearch; // the answer to the search as it is typed now
  searching: boolean;
  failed?: string;
}

// The answer to a search of the board's files, asked when `options` stay the same for a moment, and not at all while there is nothing to find.
export function useContentSearch(boardId: string, options: ProjectSearchOptions, on: boolean): ContentSearch {
  const [state, setState] = useState<ContentSearch>({ searching: false });
  const { q, matchCase, word, regex } = options;
  useEffect(() => {
    if (!on || !q) {
      setState({ searching: false });
      return;
    }
    const stop = new AbortController();
    setState((now) => ({ ...now, searching: true, failed: undefined }));
    const timer = window.setTimeout(() => {
      api.searchProjectFiles(boardId, { q, matchCase, word, regex }, stop.signal).then(
        (result) => !stop.signal.aborted && setState({ result, searching: false }),
        (error: Error) => !stop.signal.aborted && setState({ searching: false, failed: error.message }),
      );
    }, PAUSE_MS);
    return () => {
      window.clearTimeout(timer);
      stop.abort();
    };
  }, [boardId, on, q, matchCase, word, regex]);
  return state;
}

// A line's text with its matches marked.
function Marked({ text, marks }: { text: string; marks: Mark[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  marks.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={i}>{text.slice(start, end)}</mark>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

// What the search found, in the place of the file tree.
export function SearchResults({ board, query, search, file, line }: { board: Board; query: string; search: ContentSearch; file?: string; line?: number }) {
  const { result, searching, failed } = search;
  if (!query) return <p className="files-note">Type to search inside the files, as an editor's Find in Files does. Any case, unless you match it.</p>;
  if (failed) return <p className="files-note is-error">{failed}</p>;
  if (result?.invalid) return <p className="files-note is-error">That isn't a regular expression: {result.invalid}.</p>;
  if (!result) return <p className="files-note">Searching…</p>;
  const found = result.files.length > 0;
  return (
    <div className={`files-found${searching ? ' is-stale' : ''}`}>
      <p className="files-count" role="status" title={`${plural(result.searched, 'file')} searched${result.skipped ? `, ${plural(result.skipped, 'file')} left out as pictures, binary or over 1 MB` : ''}`}>
        {searching ? 'Searching…' : found ? `${plural(result.matches, 'match', 'matches')} in ${plural(result.files.length, 'file')}` : 'No matches'}
      </p>
      {!searching && result.partial === 'matches' && <p className="files-note">Showing the first {MAX_SEARCH_MATCHES.toLocaleString('en-US')} matches. Narrow the search to see the rest.</p>}
      {!searching && result.partial === 'time' && <p className="files-note">The search stopped early (it took over {SEARCH_MS / 1000} seconds, or a regular expression took too long on a file), so these are the matches found so far.</p>}
      {!searching && result.truncated && <p className="files-note">This project has more than {MAX_PROJECT_FILES.toLocaleString('en-US')} files: only the first ones, by path, were searched.</p>}
      {result.files.map((hit) => (
        <section key={hit.path} className="files-hit">
          <a className={`files-hit-file${hit.path === file && !line ? ' is-picked' : ''}`} href={linkTo.files(board.id, hit.path)} title={hit.path}>
            <span className="files-name">{nameOf(hit.path)}</span>
            <span className="files-dir">{hit.path.slice(0, -nameOf(hit.path).length) || './'}</span>
            <span className="files-n">{hit.lines.length}</span>
          </a>
          {hit.lines.map((match) => (
            <a key={match.line} className={`files-hit-line${hit.path === file && match.line === line ? ' is-picked' : ''}`} href={linkTo.files(board.id, hit.path, false, match.line)}>
              <i>{match.line}</i>
              <span>
                <Marked text={match.text} marks={match.marks} />
              </span>
            </a>
          ))}
        </section>
      ))}
    </div>
  );
}
