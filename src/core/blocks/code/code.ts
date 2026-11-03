// Code blocks: a source file, or part of one, as an agent or a person sent
// it, with the lines that matter highlighted. Shared by the server, which
// checks what's sent and describes it to agents, and the web UI, which draws
// it. The server never reads the repo: the text is what was sent.

import { lineQuote } from '../diff/diff';

export const MAX_CODE = 1024 * 1024; // bytes of text a code block holds
const MAX_PATH = 500;
const MAX_LANGUAGE = 40;
const MAX_RANGES = 50; // highlighted ranges

export class CodeError extends Error {}

// A code block's own fields. Lines are numbered from `start` (1 unless it's
// an excerpt); `total` is the file's line count, when the text is part of it.
// `highlight` is ranges of those numbers, inclusive, in order.
export interface CodeFields {
  path: string;
  text: string;
  language?: string; // as given; otherwise the path's extension says
  start?: number;
  total?: number;
  highlight?: [number, number][];
  commit?: string;
}

// Line ranges as sent: [[123, 130], 140], or "123-130, 140".
export type RangesInput = string | (number | number[])[];

// What's sent to make or change a code block: a change leaves out what stays.
// '' clears language and commit, [] clears highlight, 0 clears total.
export interface CodeInput {
  path?: string;
  text?: string;
  language?: string;
  start?: number;
  total?: number;
  highlight?: RangesInput;
  commit?: string;
}

// ---- languages -------------------------------------------------------------------

export interface CodeLanguage {
  name: string; // as people read it: TypeScript
  colour?: string; // the colouring it gets (web/canvas/highlight.ts), if any
  extensions: string[];
  files?: string[]; // whole file names, for files with no extension: Dockerfile
  aliases?: string[]; // other names it goes by
}

// Diff blocks colour files by the same table (web/canvas/highlight.ts).
const LANGUAGES: CodeLanguage[] = [
  { name: 'TypeScript', colour: 'js', extensions: ['ts', 'tsx', 'mts', 'cts'] },
  { name: 'JavaScript', colour: 'js', extensions: ['js', 'jsx', 'mjs', 'cjs'], aliases: ['node'] },
  { name: 'JSON', colour: 'json', extensions: ['json', 'jsonc', 'json5'] },
  { name: 'CSS', colour: 'css', extensions: ['css'] },
  { name: 'SCSS', colour: 'scss', extensions: ['scss'], aliases: ['sass'] },
  { name: 'Less', colour: 'scss', extensions: ['less'] },
  { name: 'HTML', colour: 'html', extensions: ['html', 'htm'] },
  { name: 'XML', colour: 'html', extensions: ['xml'] },
  { name: 'SVG', colour: 'html', extensions: ['svg'] },
  { name: 'Vue', colour: 'html', extensions: ['vue'] },
  { name: 'Svelte', colour: 'html', extensions: ['svelte'] },
  { name: 'Python', colour: 'python', extensions: ['py', 'pyi'] },
  { name: 'Go', colour: 'go', extensions: ['go'], aliases: ['golang'] },
  { name: 'Rust', colour: 'rust', extensions: ['rs'] },
  { name: 'Shell', colour: 'shell', extensions: ['sh', 'bash', 'zsh'], aliases: ['bash', 'zsh'] },
  // Named, without colours.
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
  { name: 'YAML', extensions: ['yml', 'yaml'] },
  { name: 'TOML', extensions: ['toml'] },
  { name: 'SQL', extensions: ['sql'] },
  { name: 'Java', extensions: ['java'] },
  { name: 'Kotlin', extensions: ['kt', 'kts'] },
  { name: 'Swift', extensions: ['swift'] },
  { name: 'C', extensions: ['c', 'h'] },
  { name: 'C++', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh'], aliases: ['cplusplus'] },
  { name: 'C#', extensions: ['cs'], aliases: ['csharp'] },
  { name: 'Ruby', extensions: ['rb'], files: ['Gemfile', 'Rakefile'] },
  { name: 'PHP', extensions: ['php'] },
  { name: 'Dockerfile', extensions: ['dockerfile'], files: ['Dockerfile'] },
  { name: 'Makefile', extensions: ['mk'], files: ['Makefile'] },
  { name: 'Plain text', extensions: ['txt', 'log'], aliases: ['text', 'plain'] },
];

// The language a file is, by its name: its extension, or the whole name.
export function languageByPath(path: string): CodeLanguage | undefined {
  const name = path.split(/[\\/]/).pop() ?? '';
  const whole = LANGUAGES.find((l) => l.files?.includes(name));
  if (whole) return whole;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return LANGUAGES.find((l) => l.extensions.includes(extension));
}

// A language by a name it goes by: TypeScript, typescript, ts.
export function languageNamed(name: string): CodeLanguage | undefined {
  const wanted = name.trim().toLowerCase().replace(/^\./, '');
  if (!wanted) return undefined;
  return LANGUAGES.find((l) => l.name.toLowerCase() === wanted || l.aliases?.includes(wanted) || l.extensions.includes(wanted));
}

// What a code block is written in: the language it was given, else what its
// path says. Undefined when neither says.
export function codeLanguage(code: Pick<CodeFields, 'path' | 'language'>): CodeLanguage | undefined {
  if (code.language) return languageNamed(code.language) ?? { name: code.language, extensions: [] };
  return languageByPath(code.path);
}

// ---- reading it ------------------------------------------------------------------

// The text's lines. A final newline ends the last line rather than starting another.
export function codeLines(text: string): string[] {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

// The numbers of the first and last lines it has, and the file's line count when known.
export function codeSpan(code: Pick<CodeFields, 'text' | 'start' | 'total'>, count = codeLines(code.text).length): { first: number; last: number; total?: number } {
  const first = code.start ?? 1;
  const last = first + count - 1;
  return { first, last, total: code.total ?? (first === 1 ? last : undefined) };
}

const number = (n: number) => n.toLocaleString('en-US');

// "126", "123–130"
export function rangeText([from, to]: [number, number]): string {
  return from === to ? String(from) : `${from}–${to}`;
}

// "123–130, 140"
export function rangesText(ranges: [number, number][]): string {
  return ranges.map(rangeText).join(', ');
}

// What a code block holds: "268 lines" for a whole file, "lines 120–131 of
// 268" for part of one ("lines 120–131" when its length isn't known).
export function linesText(code: Pick<CodeFields, 'text' | 'start' | 'total'>, count?: number): string {
  const { first, last, total } = codeSpan(code, count);
  if (first === 1 && total === last) return `${number(last)} line${last === 1 ? '' : 's'}`;
  return `lines ${rangeText([first, last])}${total ? ` of ${number(total)}` : ''}`;
}

// A long path for a label, with its start left out: "…/connectors/oauth.ts".
export function shortPath(path: string, max = 60): string {
  return path.length <= max ? path : `…${path.slice(path.length - max + 1)}`;
}

// The line numbered `line`, if the block has it.
export function codeLineAt(code: Pick<CodeFields, 'text' | 'start'>, line: number, lines = codeLines(code.text)): string | undefined {
  const at = line - (code.start ?? 1);
  return Number.isInteger(at) && at >= 0 && at < lines.length ? lines[at] : undefined;
}

// Where a pinned line is now: the line that reads the same nearest to where
// it was. Null once no line reads like it.
export function findCodeLine(code: Pick<CodeFields, 'text' | 'start'>, line: number, quote: string): number | null {
  const first = code.start ?? 1;
  let best: number | null = null;
  codeLines(code.text).forEach((text, i) => {
    const at = first + i;
    if (lineQuote(text) !== quote) return;
    if (best === null || Math.abs(at - line) < Math.abs(best - line)) best = at;
  });
  return best;
}

// The line some words are on, as an agent quotes them: the `occurrence`-th
// line that has them (from 1), spacing aside. Null when no line does.
export function codeLineOf(code: Pick<CodeFields, 'text' | 'start'>, words: string, occurrence = 1): number | null {
  const wanted = lineQuote(words);
  if (!wanted) return null;
  let seen = 0;
  const lines = codeLines(code.text);
  for (let i = 0; i < lines.length; i++) {
    if (lineQuote(lines[i]).includes(wanted) && ++seen === occurrence) return (code.start ?? 1) + i;
  }
  return null;
}

// Whether two names are the same file: the same path, or one the end of the
// other (store.ts and src/core/store.ts). A block with no path matches any.
export function samePath(path: string, other: string): boolean {
  const clean = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, '');
  const [a, b] = [clean(path), clean(other)];
  return !a || a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// ---- checking what's sent -----------------------------------------------------------

// The text's size in UTF-8, as a file of it would be.
export function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      bytes += 4; // a surrogate pair
      i++;
    } else bytes += 3;
  }
  return bytes;
}

// "1.4 MB", "820 KB"
export function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Whether text reads as a binary file decoded: a NUL, or many control
// characters or undecodable bytes near its start.
export function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) return true;
  const sample = text.slice(0, 8000);
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13 && c !== 27) || c === 0xfffd) odd++;
  }
  return sample.length > 0 && odd / sample.length > 0.1;
}

// Throws unless the text is something a code block holds: text, up to MAX_CODE.
export function checkCodeText(text: string, name = 'The text'): string {
  if (!text.trim()) throw new CodeError(`${name} is empty. A code block needs the file's text, or the lines that matter.`);
  const bytes = byteLength(text);
  if (bytes > MAX_CODE) {
    throw new CodeError(`${name} is ${sizeText(bytes)}; a code block holds at most 1 MB. Send the lines that matter, with start (the first line's number) and total (the file's line count).`);
  }
  if (looksBinary(text)) throw new CodeError(`${name} looks like a binary file, not text. Code blocks hold source and other text files.`);
  return text;
}

// Line ranges as sent, read into [from, to] pairs: "123-130, 140" or [[123, 130], 140].
export function readRanges(input: RangesInput): [number, number][] {
  const bad = (what: string) => new CodeError(`highlight ${what} isn't a line or a range of lines. Send them like [[123, 130], 140] or "123-130, 140".`);
  const parts: (number | number[])[] =
    typeof input === 'string'
      ? input
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const match = /^(\d+)\s*(?:[-–—]|\.\.)\s*(\d+)$/.exec(part) ?? /^(\d+)$/.exec(part);
            if (!match) throw bad(`"${part.slice(0, 30)}"`);
            return match.slice(1).filter(Boolean).map(Number);
          })
      : input;
  return parts.map((part) => {
    const pair = typeof part === 'number' ? [part] : part;
    if (!Array.isArray(pair) || pair.length < 1 || pair.length > 2 || !pair.every((n) => Number.isInteger(n) && n >= 1)) {
      throw bad(String(JSON.stringify(part)).slice(0, 30));
    }
    const [from, to = from] = pair;
    return [Math.min(from, to), Math.max(from, to)] as [number, number];
  });
}

// Ranges in order, overlapping and touching ones joined.
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

const cleanPath = (path: string) => {
  const clean = path.trim();
  if (/[\n\r]/.test(clean)) throw new CodeError('A path is one line, e.g. src/core/store.ts.');
  if (clean.length > MAX_PATH) throw new CodeError(`A path is at most ${MAX_PATH} characters.`);
  return clean;
};

// A code block's fields from what was sent, checked, over what it had (for a
// change). Throws CodeError saying what's wrong. When the text changes and
// the highlight isn't sent, highlighted lines past its end are dropped.
export function codeFields(input: CodeInput, previous?: CodeFields): CodeFields {
  const path = input.path !== undefined ? cleanPath(input.path) : (previous?.path ?? '');
  const text = input.text !== undefined ? checkCodeText(input.text) : previous?.text;
  if (text === undefined) throw new CodeError("A code block needs text: the file's text, or the lines that matter.");
  if (input.start !== undefined && !(Number.isInteger(input.start) && input.start >= 1)) {
    throw new CodeError('start is the line number of the first line of text: 1 or more.');
  }
  const start = input.start ?? previous?.start ?? 1;
  const { last } = codeSpan({ text, start });

  let total = input.total ?? previous?.total;
  if (input.total !== undefined) {
    if (!Number.isInteger(input.total) || input.total < 0) throw new CodeError("total is the file's line count: a whole number.");
    if (input.total > 0 && input.total < last) {
      throw new CodeError(`total (${number(input.total)}) is less than the number of the last line of text (${number(last)}). It is the whole file's line count.`);
    }
  } else if (total !== undefined && total < last) total = undefined; // the text grew past it: no longer known
  if (!total || (start === 1 && total === last)) total = undefined; // the whole file says its own length

  let highlight = previous?.highlight;
  if (input.highlight !== undefined) {
    const ranges = mergeRanges(readRanges(input.highlight));
    if (ranges.length > MAX_RANGES) throw new CodeError(`Highlight at most ${MAX_RANGES} ranges of lines.`);
    const outside = ranges.find(([from, to]) => from < start || to > last);
    if (outside) {
      throw new CodeError(
        `highlight ${rangeText(outside)} is outside the lines of text, which are numbered ${rangeText([start, last])}${start > 1 ? ' (from start)' : ''}. Highlight lines by their numbers in the file.`,
      );
    }
    highlight = ranges;
  } else if (highlight) {
    highlight = highlight.flatMap(([from, to]): [number, number][] => (to < start || from > last ? [] : [[Math.max(from, start), Math.min(to, last)]]));
  }

  let language = input.language !== undefined ? input.language.trim() : previous?.language;
  if (input.language !== undefined && language) {
    if (/[\n\r]/.test(language) || language.length > MAX_LANGUAGE) throw new CodeError(`A language is a name, e.g. TypeScript (at most ${MAX_LANGUAGE} characters).`);
    language = languageNamed(language)?.name ?? language;
  }

  let commit = input.commit !== undefined ? input.commit.trim() : previous?.commit;
  if (input.commit !== undefined && commit && !/^[\w./@~^-]{1,64}$/.test(commit)) {
    throw new CodeError('commit is the commit the text is from, as a hash, e.g. 0be1135.');
  }

  return {
    path,
    text,
    ...(language ? { language } : {}),
    ...(start > 1 ? { start } : {}),
    ...(total ? { total } : {}),
    ...(highlight?.length ? { highlight } : {}),
    ...(commit ? { commit } : {}),
  };
}

// ---- how it's shown ----------------------------------------------------------------

export const CODE_LONG = 60; // lines; a longer block starts folded
export const CODE_FIRST = 40; // lines shown of a long block with nothing highlighted
export const CODE_CONTEXT = 3; // lines shown either side of a highlight
const MIN_FOLD = 4; // fewer lines than this are shown rather than folded

export type CodeSegment = { kind: 'lines'; from: number; to: number } | { kind: 'fold'; from: number; to: number };

// The lines a block shows and those it folds away, in order. A long block
// shows its highlighted lines with a few either side, or its first lines when
// nothing is highlighted; `keep` are lines that show whatever (pinned ones),
// and `opened` ranges a person unfolded. `all` shows every line.
export function codeSegments(
  code: Pick<CodeFields, 'text' | 'start' | 'highlight'>,
  options: { keep?: number[]; opened?: [number, number][]; all?: boolean; count?: number } = {},
): CodeSegment[] {
  const { first, last } = codeSpan(code, options.count);
  const count = last - first + 1;
  if (options.all || count <= CODE_LONG) return [{ kind: 'lines', from: first, to: last }];
  const wanted: [number, number][] = [
    ...(code.highlight?.length ? code.highlight.map(([from, to]): [number, number] => [from - CODE_CONTEXT, to + CODE_CONTEXT]) : [[first, first + CODE_FIRST - 1] as [number, number]]),
    ...(options.keep ?? []).map((line): [number, number] => [line - 1, line + 1]),
    ...(options.opened ?? []),
  ];
  const clipped = wanted.flatMap(([from, to]): [number, number][] => (to < first || from > last ? [] : [[Math.max(from, first), Math.min(to, last)]]));
  // Gaps too small to be worth folding are shown, at the edges too.
  const shown: [number, number][] = [];
  for (const [from, to] of mergeRanges(clipped)) {
    const prior = shown.at(-1);
    if (prior && from - prior[1] - 1 < MIN_FOLD) prior[1] = to;
    else shown.push([from, to]);
  }
  if (shown.length && shown[0][0] - first < MIN_FOLD) shown[0][0] = first;
  if (shown.length && last - shown[shown.length - 1][1] < MIN_FOLD) shown[shown.length - 1][1] = last;
  const segments: CodeSegment[] = [];
  let next = first;
  for (const [from, to] of shown) {
    if (from > next) segments.push({ kind: 'fold', from: next, to: from - 1 });
    segments.push({ kind: 'lines', from, to });
    next = to + 1;
  }
  if (next <= last) segments.push({ kind: 'fold', from: next, to: last });
  return segments;
}

// What the header says it shows: the one range shown out of the file, or
// else what the block holds ("268 lines", "lines 120–131 of 268").
export function shownText(code: Pick<CodeFields, 'text' | 'start' | 'total'>, segments: CodeSegment[], count?: number): string {
  const shown = segments.filter((s) => s.kind === 'lines');
  const { first, last, total } = codeSpan(code, count);
  if (shown.length !== 1 || (shown[0].from === first && shown[0].to === last)) return linesText(code, count);
  return `lines ${rangeText([shown[0].from, shown[0].to])}${total ? ` of ${number(total)}` : ''}`;
}

const ROW = 19.2; // px: 12px code at line-height 1.6
const HEAD = 40; // its header
const FOLD = 24;
const CHAR = 7.3; // px per character of 12px monospace, about

// A size that fits a new code block: the lines it shows first, up to a
// comfortable height, and its longest line up to a comfortable width.
export function codeBlockSize(code: Pick<CodeFields, 'text' | 'start' | 'total' | 'highlight'>): { w: number; h: number } {
  const lines = codeLines(code.text);
  const segments = codeSegments(code, { count: lines.length });
  const first = code.start ?? 1;
  let rows = 0;
  let longest = 0;
  for (const segment of segments) {
    if (segment.kind === 'fold') continue;
    rows += segment.to - segment.from + 1;
    for (let at = segment.from; at <= segment.to; at++) longest = Math.max(longest, lines[at - first].replace(/\t/g, '  ').length);
  }
  const last = first + lines.length - 1;
  // Folds, and the file's lines either side that it wasn't given.
  const folds = segments.length - segments.filter((s) => s.kind === 'lines').length + (first > 1 ? 1 : 0) + ((code.total ?? 0) > last ? 1 : 0);
  const digits = String(Math.max(last, code.total ?? 0)).length;
  const h = Math.round(HEAD + rows * ROW + folds * FOLD + 8);
  const w = Math.round(digits * CHAR + 30 + longest * CHAR + 24);
  return { w: Math.min(820, Math.max(460, w)), h: Math.min(560, Math.max(120, h)) };
}

// ---- for agents ----------------------------------------------------------------------

// A code block as an agent reads it: what file, which lines, what's
// highlighted, and in full (get_block) the text itself.
export function codeDigest(code: CodeFields, full = false): string {
  const language = codeLanguage(code);
  const head = [code.path || '(no path)', language?.name, linesText(code), code.commit && `at ${code.commit}`].filter(Boolean).join(' · ');
  const out = [head];
  if (code.highlight?.length) out.push(`Highlighted: lines ${rangesText(code.highlight)}.`);
  if (full) {
    const { first } = codeSpan(code);
    const fence = '`'.repeat(Math.max(3, ...[...code.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const tag = language?.extensions[0] ?? '';
    out.push('', `Text${first > 1 ? ` (its first line is line ${number(first)})` : ''}:`, `${fence}${tag}`, code.text.replace(/\n$/, ''), fence);
  } else out.push('(get_block for the text)');
  return out.join('\n');
}

// What an agent should know about a code block it just sent.
export function codeAdvice(code: CodeFields, sent: { title?: string; highlight?: unknown }): string[] {
  const advice: string[] = [];
  if (sent.title !== undefined && sent.title.trim() !== code.path) {
    advice.push(`A code block is named by its path ("${shortPath(code.path)}"), so title was left out.`);
  }
  const count = codeLines(code.text).length;
  if (!code.highlight?.length && sent.highlight === undefined && count > CODE_LONG) {
    advice.push(
      `People see its first ${CODE_FIRST} of ${number(count)} lines until they unfold it. Highlight the lines that matter (update_block with highlight) so it opens on them.`,
    );
  }
  return advice;
}

// What changed in a code block, for its versions and the activity.
export function codeChanges(before: CodeFields, after: CodeFields): string[] {
  const parts: string[] = [];
  if (before.path !== after.path) parts.push(after.path ? `changed the path to ${shortPath(after.path, 120)}` : 'removed the path');
  if (before.text !== after.text) parts.push(`replaced the text: now ${linesText(after)}`);
  else if (before.start !== after.start || before.total !== after.total) parts.push(`now ${linesText(after)}`);
  const highlight = (code: CodeFields) => rangesText(code.highlight ?? []);
  if (highlight(before) !== highlight(after)) parts.push(after.highlight?.length ? `highlighted lines ${highlight(after)}` : 'cleared the highlight');
  if ((before.language ?? '') !== (after.language ?? '')) parts.push(after.language ? `set the language to ${after.language}` : 'cleared the language');
  if ((before.commit ?? '') !== (after.commit ?? '')) parts.push(after.commit ? `now at ${after.commit}` : 'cleared the commit');
  return parts;
}
