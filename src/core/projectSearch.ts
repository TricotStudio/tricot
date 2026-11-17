// Searching inside a board's project files, as an IDE's Find in Files does:
// what is asked, what comes back, and how one line is matched and
// shortened around its match. No Node here: the page takes the shapes, and
// the server (server/projectSearch.ts) reads the files. Which files are
// searched is the list's (core/projectFiles.ts), nothing more.

export const MAX_SEARCH_QUERY = 200; // characters of what is searched for
export const MAX_SEARCH_MATCHES = 200; // matching lines answered; the search stops there
export const MAX_SEARCH_FILE = 1024 * 1024; // bytes: a bigger file is left out
export const SEARCH_MS = 4000; // the time a search takes, at most
const SNIPPET = 160; // characters of a line kept, at most
const LEAD = 20; // of them, before the first match when the line is cut to show it (Files' list is narrow)
const FAR = 30; // a first match this far into the line (past its indent) cuts the start
const MARKS = 5; // matches marked in one line

// What is searched for. A flag off or missing: any case, any part of a word, the text as typed.
export interface ProjectSearchOptions {
  q: string;
  matchCase?: boolean;
  word?: boolean; // whole words only
  regex?: boolean; // q is a regular expression (JavaScript's), a line at a time
}

// A match in a line's text, as the offsets it starts and ends at.
export type Mark = [start: number, end: number];

// A line that matches: its number in the file (the first is 1), its text
// without the indent and cut short around the match (with … where it is cut),
// and where the matches are in that text.
export interface SearchLine {
  line: number;
  text: string;
  marks: Mark[];
}

export interface SearchFile {
  path: string; // from the project folder, as the list has it
  lines: SearchLine[]; // the matching lines kept, in order
}

export interface ProjectSearch {
  files: SearchFile[]; // the files with a match, by path
  matches: number; // matching lines in all of them
  searched: number; // files read
  skipped: number; // files left out: a picture, binary, or over MAX_SEARCH_FILE
  truncated?: true; // the project has more files than the list holds (MAX_PROJECT_FILES): only the first were searched
  partial?: 'matches' | 'time'; // stopped early, at MAX_SEARCH_MATCHES, at SEARCH_MS, or when a regular expression took too long on a file: the rest is not searched
  invalid?: string; // q is not a regular expression: why. Nothing was searched
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWord = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

// What matches the query in a line, or why it is no pattern. Global, so every match in a line is found.
// Unicode-aware (the u flag), so whole words and \p{L} treat a letter of any script as a letter. A
// regular expression that is valid only without that flag (`\-` outside a class) is read without it.
export function searchPattern({ q, matchCase, word, regex }: ProjectSearchOptions): RegExp | { invalid: string } {
  const base = matchCase ? 'g' : 'gi';
  let flags = `${base}u`;
  if (regex) {
    try {
      new RegExp(q, flags); // as typed, before it is wrapped: `a)(b` is no pattern, but a group's wrapping would make it one
    } catch (error) {
      try {
        new RegExp(q, base);
        flags = base;
      } catch {
        const why = (error as Error).message; // "Invalid regular expression: /(/giu: Unterminated group"
        return { invalid: why.slice(why.lastIndexOf(': ') + 2) };
      }
    }
  }
  let source = regex ? q : escaped(q);
  if (word) {
    const wordChar = flags.endsWith('u') ? '[\\p{L}\\p{N}_]' : '\\w';
    // A literal begins or ends a word only if its edge is a word character; a pattern always does.
    const before = regex || isWord(q[0]) ? `(?<!${wordChar})` : '';
    const after = regex || isWord(q.at(-1)) ? `(?!${wordChar})` : '';
    source = `${before}(?:${source})${after}`;
  }
  try {
    return new RegExp(source, flags);
  } catch (error) {
    return { invalid: (error as Error).message };
  }
}

// A line's matches, or undefined when it has none.
// Empty matches (a* on a line with no a) are not matches.
export function lineMatches(line: string, pattern: RegExp): { text: string; marks: Mark[] } | undefined {
  const found: Mark[] = [];
  for (const match of line.matchAll(pattern)) {
    if (!match[0]) continue;
    found.push([match.index, match.index + match[0].length]);
    if (found.length === MARKS) break;
  }
  if (!found.length) return undefined;
  // The line without its indent and trailing space, unless a match is in them.
  let from = Math.min(line.length - line.trimStart().length, found[0][0]);
  let to = Math.max(line.trimEnd().length, found[found.length - 1][1]);
  // Cut the start for a match far into the line to show, and the end of a long one.
  const cutBefore = found[0][0] - from > FAR;
  if (cutBefore) from = found[0][0] - LEAD;
  const cutAfter = to - from > SNIPPET;
  if (cutAfter) to = from + SNIPPET;
  const lead = cutBefore ? '…' : '';
  const marks = found
    .filter(([start]) => start < to)
    .map(([start, end]): Mark => [Math.max(start, from) - from + lead.length, Math.min(end, to) - from + lead.length]);
  return { text: `${lead}${line.slice(from, to)}${cutAfter ? '…' : ''}`, marks };
}
