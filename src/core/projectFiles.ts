// A board's project files: what the server lists from the
// board's project folder for the Files view, one file's text for its
// preview, and the rule for which files are kept out of both. No Node here:
// the page takes the shapes, and the server (server/projectFiles.ts) does
// the reading.
//
// Kept out, wherever they are and whether git tracks them or not: git's own
// folder, and files whose names hold keys and credentials (.env, a private
// key). Kept out unless git tracks them: hidden files and folders (.claude/,
// .vscode/), which hold settings and keys more often than the project's
// code. A project's own hidden folders that git tracks (.github/) are in.
// Outside git, nothing tracks anything, so no hidden file is in, as code
// blocks read files outside a repository (blocks/code/file.ts).

// One file, from the project folder.
export interface ProjectFile {
  path: string; // from the project folder, with / between its parts
  size: number; // in bytes
  status?: FileStatus; // against the last commit, when the folder is in git
  last?: FileChange; // the last commit that changed it, among the recent ones read
  week?: boolean; // changed in the last seven days: in a commit, or now, not yet committed
}

// How a file differs from the last commit: changed, new and staged, new and
// not added (git doesn't track it yet), or renamed.
export type FileStatus = 'modified' | 'added' | 'untracked' | 'renamed';

// A commit that changed a file.
export interface FileChange {
  commit: string; // its short hash
  at: string; // when it was written, ISO 8601
  by: string; // its author, as git has them
  subject: string; // its first line
}

// The project's files, by path.
export interface ProjectFiles {
  folder: string; // as people read it, ~/code/app
  git?: ProjectGit; // when the folder is in a git repository
  files: ProjectFile[];
  truncated?: boolean; // more than MAX_PROJECT_FILES: these are the first, by path
}

export interface ProjectGit {
  prefix: string; // the folder's place in its repository, "apps/web/"; "" at its top. A
  // code block or a diff names its file from the repository's top: this before a listed path.
  branch?: string; // none on a detached head, or before the first commit
  head?: string; // the last commit's short hash
  clean: boolean; // nothing changed, added or new since it
}

// One file's text, for its preview: as a code block reads it (lines from
// `start`; `total` when it is some of them; the commit when it is as committed).
export interface ProjectFileText {
  path: string; // from the project folder
  named: string; // as a code block names it: from its repository's top, or ~/… outside one
  hash: string; // the whole file as read, a SHA-256: a save says which version it changes
  text: string;
  start: number;
  total?: number;
  commit?: string;
}

// At most this many files are listed: a project past it is cut to its first ones, by path.
export const MAX_PROJECT_FILES = 20_000;
// How far back "this week" goes.
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Names that hold keys and credentials: environment files (an example or a
// template of one is in), private keys and certificates, key stores, and
// the package managers' and machines' credential files.
const KEY_NAME = /^(?:\.env(?:\.(?!(?:example|sample|template|dist)$)[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore)|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i;

export const isKeyName = (name: string): boolean => KEY_NAME.test(name);

// Why a path from the project folder is kept out, or undefined when it is
// in. `tracked`: git tracks it (always false outside git).
export function keptOut(file: string, tracked: boolean): string | undefined {
  const parts = file.split('/');
  if (parts.includes('.git')) return "it is in git's own folder";
  if (isKeyName(parts[parts.length - 1])) return 'its name says it holds keys or credentials';
  if (!tracked && parts.some((part) => part.startsWith('.'))) return 'it is hidden, or in a hidden folder, and git doesn\'t track it';
  return undefined;
}

// How Files draws a file it can show as more than its text, as the
// board draws that kind: Markdown as a note, Mermaid as a diagram, a picture
// as an image, CSV and TSV as a table. Anything else reads as its text.
export type FilePreview = 'markdown' | 'mermaid' | 'image' | 'table';

// The pictures Files shows, by extension, and the type they are served as.
// The server sends their bytes, and nothing else's (projectImage).
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};
const extensionOf = (file: string): string => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
export const imageTypeOf = (file: string): string | undefined => IMAGE_TYPES[extensionOf(file)];

export function previewOf(file: string): FilePreview | undefined {
  const extension = extensionOf(file);
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'mmd' || extension === 'mermaid') return 'mermaid';
  if (extension === 'csv' || extension === 'tsv') return 'table';
  if (IMAGE_TYPES[extension]) return 'image';
  return undefined;
}

// Whether the file is text as well (its source, to edit or pair on): all but
// a picture, which is bytes, except an SVG.
export const hasText = (file: string): boolean => previewOf(file) !== 'image' || extensionOf(file) === 'svg';

// A CSV or TSV file's rows, as RFC 4180 reads them: a field in quotes may hold
// the separator, a line break, or a quote written twice. A last empty line
// isn't a row.
export function delimitedRows(text: string, separator = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === separator) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// A path as the page and the server pass it: from the project folder, with
// / between its parts, none of them empty, . or .., and no backslash or NUL.
export function projectPath(value: string): string | undefined {
  if (!value || value.length > 1024 || /[\\\0]/.test(value) || value.startsWith('/')) return undefined;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') ? value : undefined;
}
