// Unified diffs, as git diff and git show print them, parsed into files and
// hunks for a diff block, kept to a size a board can hold, and read back line
// by line. Shared by the server, which parses what agents send, and the web
// UI, which draws it.

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';

export interface DiffHunk {
  header: string; // its @@ line, e.g. "@@ -41,7 +41,9 @@ load(): void"
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  // Each line with its mark: ' ' unchanged, '+' added, '-' removed, '\' a
  // note on the line before, such as "\ No newline at end of file".
  lines: string[];
}

export interface DiffFile {
  path: string; // where it is after the change; a deleted file, where it was
  oldPath?: string; // where it was, when renamed or copied
  status: DiffStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  // Its changes were left out to keep the block within MAX_PATCH. Its counts stay.
  omitted?: true;
}

// A patch bigger than this keeps its file list, but the biggest files' changes are left out.
export const MAX_PATCH = 2 * 1024 * 1024;
export const MAX_FILES = 2000;

export class DiffError extends Error {}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Where a file's part of the patch is, by line: its header from `start`, its
// hunks from `body`, up to `end`.
interface Section {
  file: DiffFile;
  start: number;
  body: number;
  end: number;
}

// A C-style quoted path, as git writes one with unusual characters:
// "a/caf\303\251 menu.txt". Returns the path and what follows it.
function readQuoted(text: string): [string, string] {
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  let i = 1;
  for (; i < text.length && text[i] !== '"'; i++) {
    const ch = text[i];
    if (ch !== '\\') {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = text[++i];
    const octal = text.slice(i, i + 3);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return [new TextDecoder().decode(new Uint8Array(bytes)), text.slice(i + 1)];
}

function unquote(text: string): string {
  return text.startsWith('"') ? readQuoted(text)[0] : text;
}

// The two paths on a "diff --git a/x b/x" line. A path with spaces is split
// where both halves name the same file, which is every case but a rename;
// a rename's paths come from its own header lines anyway.
function gitPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const [a, after] = readQuoted(rest);
    return [a, unquote(after.trim())];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const [a, b] = [rest.slice(0, half), rest.slice(half + 1)];
    if (a.replace(/^a\//, '') === b.replace(/^b\//, '')) return [a, b];
  }
  const at = rest.indexOf(' b/');
  return at > 0 ? [rest.slice(0, at), unquote(rest.slice(at + 1))] : null;
}

// A path on a ---/+++ line: unquoted, without a plain diff's timestamp. Null for /dev/null.
function headerPath(text: string): string | null {
  const path = text.startsWith('"') ? readQuoted(text)[0] : text.split('\t')[0].trimEnd();
  return path === '/dev/null' ? null : path;
}

const clipLine = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

// Reads a unified diff, git's or plain diff -u, into its files. Anything
// before the first file (git show's commit message, a --stat) is skipped.
// Throws DiffError, saying what's wrong, for anything that isn't one.
export function parsePatch(patch: string): { files: DiffFile[]; sections: Section[]; lines: string[] } {
  if (!patch.trim()) throw new DiffError('The patch is empty. Send the output of git diff or git show, with its changes.');
  const raw = patch.split('\n');
  const lines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)); // a CRLF patch reads the same
  const n = lines.at(-1) === '' ? lines.length - 1 : lines.length; // a final newline ends the last line
  const sections: Section[] = [];
  // The file being read, and what its header lines said so far.
  type Reading = Section & {
    git: boolean; // a "diff --git" section, not plain diff -u
    names: boolean; // its ---/+++ lines are read
    added?: boolean;
    deleted?: boolean;
    binary?: boolean;
    moved?: 'renamed' | 'copied';
    from?: string;
    to?: string;
  };
  let current = null as Reading | null; // set and cleared by start and close

  const close = (end: number) => {
    const reading: Reading | null = current;
    if (!reading) return;
    const { file } = reading;
    reading.end = end;
    if (reading.body === -1) reading.body = end;
    if (reading.from !== undefined) file.oldPath = reading.from;
    if (reading.to !== undefined) file.path = reading.to;
    if (reading.deleted) [file.path, file.oldPath] = [file.oldPath || file.path, undefined];
    if (reading.added && !reading.moved) file.oldPath = undefined;
    if (file.oldPath === file.path) file.oldPath = undefined;
    if (!file.path) throw new DiffError(`File ${sections.length + 1} of the patch has no path. Send the output of git diff or git show.`);
    file.status = reading.binary
      ? 'binary'
      : reading.added || reading.moved === 'copied'
        ? 'added' // a copy is a new file, which says where it came from
        : reading.deleted
          ? 'deleted'
          : file.oldPath
            ? 'renamed'
            : 'modified';
    sections.push(reading);
    current = null;
  };
  const start = (i: number, git: boolean): Reading => {
    close(i);
    const file: DiffFile = { path: '', status: 'modified', additions: 0, deletions: 0, hunks: [] };
    const reading: Reading = { file, start: i, body: -1, end: n, git, names: false };
    current = reading;
    return reading;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      throw new DiffError('That is a combined diff, from a merge commit. Send a plain one instead: git diff <first parent>..<merge>.');
    }
    if (line.startsWith('diff --git ')) {
      const section = start(i, true);
      const paths = gitPaths(line.slice('diff --git '.length));
      if (paths) {
        const strip = paths[0].startsWith('a/') && paths[1].startsWith('b/');
        section.file.oldPath = strip ? paths[0].slice(2) : paths[0];
        section.file.path = strip ? paths[1].slice(2) : paths[1];
      }
      i++;
      continue;
    }
    // A file's ---/+++ lines: its own in a git section, else a plain diff's next file.
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && i + 1 < n) {
      const section = current && current.git && !current.names && current.body === -1 ? current : start(i, false);
      const before = headerPath(line.slice(4));
      const after = headerPath(lines[i + 1].slice(4));
      const strip = (path: string | null, prefix: string) => (path?.startsWith(prefix) ? path.slice(2) : path);
      const prefixed = (before ?? 'a/').startsWith('a/') && (after ?? 'b/').startsWith('b/');
      const old = prefixed ? strip(before, 'a/') : before;
      const now = prefixed ? strip(after, 'b/') : after;
      if (old === null && now === null) throw new DiffError(`Line ${i + 1} of the patch compares /dev/null with /dev/null.`);
      if (old === null) section.added = true;
      if (now === null) section.deleted = true;
      section.file.oldPath = old ?? now!;
      section.file.path = now ?? old!;
      section.names = true;
      i += 2;
      continue;
    }
    const header: Reading | null = current;
    if (header && header.body === -1 && header.git) {
      // git's extended header lines
      if (line.startsWith('new file mode')) header.added = true;
      else if (line.startsWith('deleted file mode')) header.deleted = true;
      else if (line.startsWith('rename from ')) [header.from, header.moved] = [unquote(line.slice(12)), 'renamed'];
      else if (line.startsWith('rename to ')) [header.to, header.moved] = [unquote(line.slice(10)), 'renamed'];
      else if (line.startsWith('copy from ')) [header.from, header.moved] = [unquote(line.slice(10)), 'copied'];
      else if (line.startsWith('copy to ')) [header.to, header.moved] = [unquote(line.slice(8)), 'copied'];
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') header.binary = true;
    }
    if (line.startsWith('@@')) {
      const match = HUNK.exec(line);
      if (!match) {
        if (line.startsWith('@@@')) throw new DiffError('That is a combined diff, from a merge commit. Send a plain one instead: git diff <first parent>..<merge>.');
        throw new DiffError(`Line ${i + 1} of the patch isn't a hunk header: "${clipLine(line)}". Hunks start like "@@ -12,7 +12,9 @@".`);
      }
      if (!current) {
        throw new DiffError(`The hunk on line ${i + 1} of the patch comes before any file. Each file needs its "diff --git" or "---"/"+++" lines.`);
      }
      const file = current.file;
      if (current.body === -1) current.body = i;
      const hunk: DiffHunk = {
        header: line,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      let [old, now] = [hunk.oldLines, hunk.newLines];
      let j = i + 1;
      const where = () => `Hunk ${file.hunks.length + 1} of ${file.path || 'a file'} (line ${i + 1} of the patch)`;
      while (old > 0 || now > 0) {
        if (j >= n) {
          throw new DiffError(`${where()} ends early: the patch stops ${old} old and ${now} new lines short of what its header says. Was it cut off?`);
        }
        const text = lines[j] === '' ? ' ' : lines[j]; // an unchanged blank line whose space was trimmed
        const mark = text[0];
        if (mark === ' ') [old, now] = [old - 1, now - 1];
        else if (mark === '-') old--;
        else if (mark === '+') now--;
        else if (mark !== '\\') {
          throw new DiffError(
            `${where()} ends early: line ${j + 1} ("${clipLine(text)}") isn't part of it, ${old} old and ${now} new lines short of what its header says.`,
          );
        }
        if (old < 0 || now < 0) {
          throw new DiffError(`${where()} has more ${old < 0 ? 'removed' : 'added'} lines than its header says, by line ${j + 1}.`);
        }
        if (mark === '+') file.additions++;
        if (mark === '-') file.deletions++;
        hunk.lines.push(text);
        j++;
      }
      while (j < n && lines[j].startsWith('\\')) hunk.lines.push(lines[j++]); // "\ No newline at end of file"
      // Changed lines straight after it mean its header undercounts them. ("-- " is format-patch's signature.)
      const after = lines[j] ?? '';
      if (j < n && /^[+-]/.test(after) && after !== '-- ' && !(after.startsWith('--- ') && lines[j + 1]?.startsWith('+++ '))) {
        throw new DiffError(`${where()} has more lines than its header says: line ${j + 1} ("${clipLine(after)}") comes after its last one.`);
      }
      file.hunks.push(hunk);
      i = j;
      continue;
    }
    i++;
  }
  close(n);
  if (sections.length === 0) {
    throw new DiffError(
      'That isn\'t a unified diff: it has no "diff --git" or "---"/"+++" file headers. Send the output of git diff or git show (not --stat or --name-only).',
    );
  }
  if (sections.length > MAX_FILES) throw new DiffError(`The patch changes ${sections.length} files; a diff block holds at most ${MAX_FILES}. Send the files that matter: git diff -- <paths>.`);
  return { files: sections.map((s) => s.file), sections, lines: raw };
}

// A patch as a diff block keeps it: parsed, and within MAX_PATCH. Past it,
// the biggest files' changes are left out, biggest first, until the rest
// fits; they stay listed with their counts. The patch kept loses the same.
export function readPatch(patch: string, max = MAX_PATCH): { patch: string; files: DiffFile[] } {
  const { files, sections, lines } = parsePatch(patch);
  if (patch.length <= max) return { patch, files };
  const length = (from: number, to: number) => lines.slice(from, to).reduce((sum, line) => sum + line.length + 1, 0);
  let total = patch.length;
  for (const section of [...sections].sort((a, b) => length(b.body, b.end) - length(a.body, a.end))) {
    if (total <= max) break;
    total -= length(section.body, section.end);
    section.file.hunks = [];
    section.file.omitted = true;
  }
  if (total > max) throw new DiffError(`The patch is too big for a diff block even without its changes. Send the files that matter: git diff -- <paths>.`);
  const kept = [lines.slice(0, sections[0].start), ...sections.map((s) => lines.slice(s.start, s.file.omitted ? s.body : s.end))];
  return { patch: kept.flat().join('\n'), files };
}

// ---- for agents ------------------------------------------------------------------

const DIGEST_FILES = 25; // files get_canvas lists; get_block lists them all

// A diff as an agent reads it: its files with their counts, compactly, and
// in full (get_block) the patch itself.
export function diffDigest(diff: { patch: string; files: DiffFile[]; focus?: string[] }, full = false): string {
  const { files, focus = [] } = diff;
  const totals = diffTotals(files);
  const head = [`${totals.files} file${totals.files === 1 ? '' : 's'}, ${countText(totals.additions, totals.deletions)}.`];
  if (focus.length) head.push(`In focus: ${focus.join(', ')}.`);
  const omitted = files.filter((f) => f.omitted).length;
  if (omitted) head.push(`The changes in ${omitted} of the biggest files were left out to fit (${Math.round(MAX_PATCH / 1024 / 1024)} MB); they're listed with their counts.`);
  const listed = full ? files : files.slice(0, DIGEST_FILES);
  const lines = listed.map((f) => {
    const name = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    const notes = [
      f.status !== 'modified' && f.status,
      isGenerated(f.path) && 'generated, starts folded',
      f.omitted && 'changes left out',
    ].filter(Boolean);
    const counts = f.status === 'binary' ? '' : ` ${countText(f.additions, f.deletions)}`;
    return `- ${name}${counts}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  });
  if (listed.length < files.length) lines.push(`… ${files.length - listed.length} more files (get_block lists them all, with the patch)`);
  const out = [head.join(' '), ...lines];
  if (full) {
    const fence = '`'.repeat(Math.max(3, ...[...diff.patch.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    out.push('', 'Patch:', `${fence}diff`, diff.patch.replace(/\n$/, ''), fence);
  } else out.push('(get_block for the patch)');
  return out.join('\n');
}

// What an agent should know about a diff it just sent: focus paths that named
// no file, and files whose changes were left out to fit.
export function diffAdvice(files: DiffFile[], focus: string[] | undefined): string[] {
  const advice: string[] = [];
  const { unmatched } = matchFocus(files, focus ?? []);
  if (unmatched.length) {
    const some = files.slice(0, 8).map((f) => f.path).join(', ');
    advice.push(`focus ${unmatched.map((f) => `"${f}"`).join(', ')} named no file in the patch, so it was left out. Its files include: ${some}.`);
  }
  const omitted = files.filter((f) => f.omitted).map((f) => f.path);
  if (omitted.length) {
    advice.push(
      `The patch is over ${Math.round(MAX_PATCH / 1024 / 1024)} MB, so the changes in ${omitted.length} of its biggest files were left out (they're listed with their counts): ${omitted.slice(0, 8).join(', ')}${omitted.length > 8 ? '…' : ''}. If people need to read them, send them in a diff block of their own (git diff -- <path>).`,
    );
  }
  return advice;
}

// ---- reading it -----------------------------------------------------------------

export interface DiffTotals {
  files: number;
  additions: number;
  deletions: number;
}

export function diffTotals(files: DiffFile[]): DiffTotals {
  return files.reduce((t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), {
    files: 0,
    additions: 0,
    deletions: 0,
  });
}

// "+1,204 −12"
export function countText(additions: number, deletions: number): string {
  return `+${additions.toLocaleString('en-US')} −${deletions.toLocaleString('en-US')}`;
}

// Files people rarely read in a review, which start folded: lockfiles,
// build output, minified code, source maps and test snapshots.
const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum)$/,
  /\.lock$/,
  /(^|\/)dist\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
];

export function isGenerated(path: string): boolean {
  return GENERATED.some((pattern) => pattern.test(path));
}

// The files a focus list names: each path as the patch has it, or the end of
// one ("oauth.ts", "connectors/oauth.ts"). Returns them as the patch has them,
// and the paths that named none.
export function matchFocus(files: DiffFile[], focus: string[]): { paths: string[]; unmatched: string[] } {
  const paths: string[] = [];
  const unmatched: string[] = [];
  for (const wanted of focus) {
    const name = wanted.trim().replace(/^\.\//, '').replace(/^[ab]\//, '');
    if (!name) continue;
    const file = files.find((f) => f.path === name) ?? files.find((f) => f.path.endsWith(`/${name}`) || f.oldPath === name);
    if (!file) unmatched.push(wanted);
    else if (!paths.includes(file.path)) paths.push(file.path);
  }
  return { paths, unmatched };
}

// How many changed lines a file shows: its hunks' lines.
export function fileSize(file: DiffFile): number {
  return file.hunks.reduce((sum, h) => sum + h.lines.length, 0);
}

export const OPEN_FIRST = 3; // files open to begin with, focus files aside
export const SMALL_FILE = 150; // lines; a bigger file starts closed unless it's in focus
export const LIST_FIRST = 12; // files listed before "Show all"

// The files open when a diff is first drawn: those in focus, then the first
// few small ones that are worth reading, up to OPEN_FIRST in all.
export function initiallyOpen(files: DiffFile[], focus: readonly string[] = []): Set<string> {
  const open = new Set(focus.filter((path) => files.some((f) => f.path === path)));
  for (const file of files) {
    if (open.size >= OPEN_FIRST) break;
    if (file.hunks.length && !isGenerated(file.path) && fileSize(file) <= SMALL_FILE) open.add(file.path);
  }
  return open;
}

// The files as people read them: those in focus first, in focus order, then
// the rest in the patch's order.
export function focusFirst(files: DiffFile[], focus: readonly string[] = []): DiffFile[] {
  if (focus.length === 0) return files;
  const first = focus.flatMap((path) => files.filter((f) => f.path === path));
  return [...first, ...files.filter((f) => !focus.includes(f.path))];
}

// The files listed before "Show all": those to keep (in focus, open, pinned)
// and the first others, up to LIST_FIRST, in the patch's order.
export function listedFirst(files: DiffFile[], keep: ReadonlySet<string>, limit = LIST_FIRST): DiffFile[] {
  if (files.length <= limit) return files;
  let room = Math.max(0, limit - files.filter((f) => keep.has(f.path)).length);
  return files.filter((f) => keep.has(f.path) || room-- > 0);
}

export interface DiffRow {
  kind: 'context' | 'add' | 'del' | 'note';
  text: string; // without its mark
  old?: number; // its line number before the change
  new?: number; // and after
}

// A hunk's lines with their numbers on each side.
export function hunkRows(hunk: DiffHunk): DiffRow[] {
  let [old, now] = [hunk.oldStart, hunk.newStart];
  return hunk.lines.map((line) => {
    const text = line.slice(1);
    switch (line[0]) {
      case '+':
        return { kind: 'add', text, new: now++ };
      case '-':
        return { kind: 'del', text, old: old++ };
      case '\\':
        return { kind: 'note', text: line.slice(1).trim() };
      default:
        return { kind: 'context', text, old: old++, new: now++ };
    }
  });
}

// A hunk's rows side by side: unchanged lines on both sides, and each run of
// removed lines beside the added lines that replace it.
export function splitRows(rows: DiffRow[]): { left?: DiffRow; right?: DiffRow }[] {
  const pairs: { left?: DiffRow; right?: DiffRow }[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'context') {
      pairs.push({ left: row, right: row });
      i++;
    } else if (row.kind === 'note') {
      const before = rows[i - 1];
      pairs.push({ left: before?.kind !== 'add' ? row : undefined, right: before?.kind !== 'del' ? row : undefined });
      i++;
    } else {
      const dels: DiffRow[] = [];
      const adds: DiffRow[] = [];
      while (rows[i]?.kind === 'del') dels.push(rows[i++]);
      // A note on the last removed line stays with it.
      const delNote = rows[i]?.kind === 'note' && dels.length ? rows[i++] : undefined;
      while (rows[i]?.kind === 'add') adds.push(rows[i++]);
      const left = delNote ? [...dels, delNote] : dels;
      for (let k = 0; k < Math.max(left.length, adds.length); k++) pairs.push({ left: left[k], right: adds[k] });
    }
  }
  return pairs;
}

export type DiffSide = 'new' | 'old';

// A line as a pin quotes it and finds it again: its text on one line, trimmed.
export function lineQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

// The text of a file's line on one side, if the patch shows it.
export function lineAt(file: DiffFile, side: DiffSide, line: number): string | undefined {
  for (const hunk of file.hunks) {
    for (const row of hunkRows(hunk)) if (row[side] === line) return row.text;
  }
  return undefined;
}

// The lines of a file the patch shows on one side, as ranges: "41–49, 88–101".
export function shownLines(file: DiffFile, side: DiffSide): string {
  return file.hunks
    .map((h) => (side === 'new' ? [h.newStart, h.newLines] : [h.oldStart, h.oldLines]))
    .filter(([, count]) => count > 0)
    .map(([start, count]) => (count === 1 ? `${start}` : `${start}–${start + count - 1}`))
    .join(', ');
}

// A file by its path now, or failing that, the path it had: a pinned file renamed since.
export function findFile(files: DiffFile[], path: string): DiffFile | undefined {
  return files.find((f) => f.path === path) ?? files.find((f) => f.oldPath === path);
}

// Where a pinned line is now: the line on that side of the file that reads
// the same, nearest to where it was. Null once the patch no longer shows it.
export function findLine(files: DiffFile[], path: string, side: DiffSide, line: number, quote: string): { file: string; line: number } | null {
  const file = findFile(files, path);
  if (!file) return null;
  let best: number | null = null;
  for (const hunk of file.hunks) {
    for (const row of hunkRows(hunk)) {
      const at = row[side];
      if (at === undefined || lineQuote(row.text) !== quote) continue;
      if (best === null || Math.abs(at - line) < Math.abs(best - line)) best = at;
    }
  }
  return best === null ? null : { file: file.path, line: best };
}
