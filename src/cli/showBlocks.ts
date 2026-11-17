// What `tricot show` puts on a page (showCommand.ts): one block for each file
// named, in the order named, the kind of block told by the file's extension,
// as a person would tell it: .md and .txt a note, .mmd and .mermaid a Mermaid
// diagram, .csv and .tsv a table, a picture an image, and any other file
// code. `-` is one block read from stdin, a note unless --as says which kind;
// --text is a short note in the words given. Each block goes to the board as
// add_block's fields for its type, which the agent's tools take
// (core/blocks/<kind>/server.ts): this file reads files and makes those
// fields, and decides nothing else about a kind.
//
// Files, not a flag for each kind: a file is what an agent has already, or
// writes in one step; its extension says the kind without a flag; several
// blocks are several names, in order, where the parser keeps one value per
// flag; and stdin takes the one block an agent pipes in.
import path from 'node:path';

// The kinds a file becomes, as add_block names their types.
export const SHOW_KINDS = ['note', 'diagram', 'table', 'code', 'image'] as const;
export type ShowKind = (typeof SHOW_KINDS)[number];

const BY_EXTENSION: Record<string, ShowKind> = {
  '.md': 'note',
  '.markdown': 'note',
  '.txt': 'note',
  '.mmd': 'diagram',
  '.mermaid': 'diagram',
  '.csv': 'table',
  '.tsv': 'table',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
};

// The other words --as takes for a kind: what a person would call it.
const AS_WORDS: Record<string, ShowKind> = { markdown: 'note', md: 'note', text: 'note', mermaid: 'diagram', csv: 'table', tsv: 'table' };

// What stdin can hold: text, so not an image.
export const STDIN_KINDS = SHOW_KINDS.filter((kind) => kind !== 'image');

export const kindOfFile = (name: string): ShowKind => BY_EXTENSION[path.extname(name).toLowerCase()] ?? 'code';

// The kind --as names, or none when it names none stdin can hold.
export function kindNamed(word: string): ShowKind | undefined {
  const said = word.trim().toLowerCase();
  const kind = (SHOW_KINDS as readonly string[]).includes(said) ? (said as ShowKind) : AS_WORDS[said];
  return kind && kind !== 'image' ? kind : undefined;
}

// add_block's fields for one block, as the agent sends them.
export type BlockFields = { type: ShowKind } & Record<string, unknown>;

// A file as `tricot show` read it: what it is called (the path as shown on
// the board, for code; none for stdin), and what it holds.
export interface ShownFile {
  name?: string;
  bytes: Buffer;
}

// A diagram's or a table's title, from its file's name: "sign-in_flow.mmd" is "Sign in flow".
export function titleFrom(name: string): string | undefined {
  const words = path.basename(name, path.extname(name)).replace(/[-_.\s]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : undefined;
}

// The block a file becomes, or what is wrong with it.
export function blockOf(kind: ShowKind, file: ShownFile): { block: BlockFields } | { problem: string } {
  const called = file.name ?? 'What was piped in';
  if (kind === 'image') return { block: { type: 'image', image_base64: file.bytes.toString('base64'), ...(file.name && { caption: path.basename(file.name) }) } };
  const text = file.bytes.toString('utf8');
  if (!text.trim()) return { problem: `${called} is empty.` };
  const title = file.name ? titleFrom(file.name) : undefined;
  switch (kind) {
    case 'note':
      return { block: { type: 'note', text } };
    case 'diagram':
      return { block: { type: 'diagram', source: text.trim(), ...(title && { title }) } };
    case 'code':
      return { block: { type: 'code', path: file.name ?? 'stdin', text } };
    case 'table': {
      const [columns, ...rows] = parseTable(text);
      if (!columns?.length) return { problem: `${called} has no rows.` };
      return { block: { type: 'table', columns, rows, ...(title && { title }) } };
    }
  }
}

// A CSV or TSV table's rows, the header first: tab-separated when its first
// line has a tab, else comma-separated. Quoted fields may hold the separator,
// line breaks and "" for a quote (RFC 4180). Blank lines are left out.
export function parseTable(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const separator = firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[at + 1] === '"') {
        field += '"';
        at++;
      } else quoted = false;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === separator) endField();
    else if (char === '\n') endRow();
    else if (char !== '\r' || text[at + 1] !== '\n') field += char;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}
