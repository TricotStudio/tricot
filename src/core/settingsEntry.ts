// One server entry in an agent's settings file, as `tricot connect` adds it
// (cli/connectFile.ts): the text of the file with Tricot's entry named `name`
// under `section` (OMP's mcp.json has it under "mcpServers", OpenCode's
// opencode.json under "mcp", Goose's config.yaml under "extensions", Hermes's
// under "mcp_servers"), and every other character of the file as it was.
//
// Neither format is read and written back whole: that would lose people's
// comments, their order and their spacing. The text is spliced instead, where
// the entry goes, indented as its neighbours are:
//
// - JSON, with the comments and trailing commas JSONC allows (OpenCode reads
//   both): the file is read into a tree that knows where each value starts and
//   ends, the entry is added after the section's last member (or the section
//   after the file's last), and the result is read again and must be the file's
//   value with that one entry set, or nothing is written.
// - YAML: there is no YAML reader here, so only the layout people and the
//   agents themselves write is edited: a mapping at the top, the section a
//   block mapping of its own (or empty), each server a key at one
//   indentation. A file with anything else where the entry goes (tabs, more
//   than one document, the section on one line or as a list, a key Tricot
//   can't read) is refused, with why, and the person adds the entry
//   themselves. Lines are only added after the section's last server, or put
//   in place of Tricot's own entry: every other line stays as it was.
//
// Browser-safe and free of files: it takes text and gives text.

import { yamlText } from './yaml';

export type SettingsFormat = 'json' | 'yaml';

// Where the entry goes, and in what.
export interface EntrySpot {
  format: SettingsFormat;
  section: string;
  name: string;
}

// The file can't be edited safely, and why, in words that follow its name:
// "isn't valid JSON (line 3)".
export class EntryRefused extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'EntryRefused';
  }
}

export interface EntryEdit {
  next: string; // the file's text with the entry
  // The entry named `name` that was there, as written: its value for JSON, its lines for YAML. None: it is added.
  existing?: string;
}

// The text with the entry set to `value`: added where there is none, put in
// place of the one there is. `text` undefined or blank: the file is new.
export function withEntry(text: string | undefined, spot: EntrySpot, value: Record<string, unknown>): EntryEdit {
  if (text === undefined || text.trim() === '') return { next: freshFile(spot, value) };
  return spot.format === 'json' ? jsonWithEntry(text, spot, value) : yamlWithEntry(text, spot, value);
}

// A file holding the entry alone.
export function freshFile(spot: EntrySpot, value: Record<string, unknown>): string {
  const whole = { [spot.section]: { [spot.name]: value } };
  return `${spot.format === 'json' ? JSON.stringify(whole, null, 2) : yamlLines(whole).join('\n')}\n`;
}

// ---- JSON (and JSONC) ----------------------------------------------------------------------------

interface JsonNode {
  start: number; // where the value starts in the text
  end: number; // just after it ends
  value: unknown;
  members?: JsonMember[]; // an object's, in order
}

interface JsonMember {
  key: string;
  keyStart: number;
  node: JsonNode;
  comma?: number; // where the comma after it is, when there is one
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

// A reader of JSON with comments and trailing commas, which keeps where each value is.
function readJson(text: string): JsonNode {
  let at = 0;
  const lineOf = (pos: number) => text.slice(0, pos).split('\n').length;
  const fail = (what: string): never => {
    throw new EntryRefused(`isn't JSON Tricot can read (${what}, line ${lineOf(at)})`);
  };
  const skip = () => {
    for (;;) {
      if (at === 0 && text.charCodeAt(0) === 0xfeff) at = 1;
      while (at < text.length && /\s/.test(text[at])) at++;
      if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at);
        at = end < 0 ? text.length : end;
      } else if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2);
        if (end < 0) fail('a comment that never ends');
        at = end + 2;
      } else return;
    }
  };
  const string = (): string => {
    STRING.lastIndex = at;
    const match = STRING.exec(text);
    if (!match) return fail('a string it cannot read');
    at += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const value = (): JsonNode => {
    skip();
    const start = at;
    const char = text[at];
    if (char === '{') {
      at++;
      const members: JsonMember[] = [];
      const object: Record<string, unknown> = {};
      for (;;) {
        skip();
        if (text[at] === '}') break;
        if (text[at] !== '"') fail('a key that is not a string');
        const keyStart = at;
        const key = string();
        skip();
        if (text[at] !== ':') fail('no colon after a key');
        at++;
        const node = value();
        const member: JsonMember = { key, keyStart, node };
        members.push(member);
        Object.defineProperty(object, key, { value: node.value, enumerable: true, writable: true, configurable: true });
        skip();
        if (text[at] === ',') {
          member.comma = at;
          at++;
          continue;
        }
        if (text[at] !== '}') fail('no comma between two members');
        break;
      }
      at++;
      return { start, end: at, value: object, members };
    }
    if (char === '[') {
      at++;
      const items: unknown[] = [];
      for (;;) {
        skip();
        if (text[at] === ']') break;
        items.push(value().value);
        skip();
        if (text[at] === ',') {
          at++;
          continue;
        }
        if (text[at] !== ']') fail('no comma between two items');
        break;
      }
      at++;
      return { start, end: at, value: items };
    }
    if (char === '"') return { start, value: string(), end: at };
    for (const [word, meant] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return { start, end: at, value: meant };
      }
    }
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(text);
    if (!number) return fail(at >= text.length ? 'it ends too soon' : `"${text.slice(at, at + 12).split('\n')[0]}" where a value goes`);
    at += number[0].length;
    return { start, end: at, value: Number(number[0]) };
  };
  const root = value();
  skip();
  if (at < text.length) fail('more after the end');
  return root;
}

const isObjectNode = (node: JsonNode): node is JsonNode & { members: JsonMember[] } => Array.isArray(node.members);

const lineStart = (text: string, pos: number) => text.lastIndexOf('\n', pos - 1) + 1;
const indentAt = (text: string, pos: number) => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))![0];
const startsItsLine = (text: string, pos: number) => text.slice(lineStart(text, pos), pos).trim() === '';
const hasNewline = (text: string, from: number, to: number) => text.slice(from, to).includes('\n');

// Where the line that `pos` is on ends, when nothing but spaces and comments
// come between: the place to add a line after it. None when something else does.
function lineEndAfter(text: string, pos: number): number | undefined {
  let at = pos;
  for (;;) {
    while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
    if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      if (end < 0 || hasNewline(text, at, end)) return undefined;
      at = end + 2;
      continue;
    }
    if (at >= text.length) return at;
    if (text[at] === '\n') return at > 0 && text[at - 1] === '\r' ? at - 1 : at;
    if (text[at] === '\r' && text[at + 1] === '\n') return at;
    return undefined;
  }
}

// One indentation step in the file: its first member's, else two spaces.
function indentUnit(text: string, root: JsonNode & { members: JsonMember[] }): string {
  const first = root.members[0];
  if (first && startsItsLine(text, first.keyStart)) {
    const unit = indentAt(text, first.keyStart).slice(indentAt(text, root.start).length);
    if (unit) return unit;
  }
  return '  ';
}

// A value as JSON, its lines after the first indented by `indent`.
const jsonBlock = (value: unknown, unit: string, indent: string, eol: string) => JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);

type Splice = { at: number; remove?: number; insert: string };

// Splices made from the end back, so each place is still where it was read;
// two at one place come out in the order given.
function apply(text: string, splices: Splice[]): string {
  let next = text;
  const order = splices.map((splice, index) => ({ splice, index })).sort((a, b) => b.splice.at - a.splice.at || b.index - a.index);
  for (const { splice: s } of order) next = next.slice(0, s.at) + s.insert + next.slice(s.at + (s.remove ?? 0));
  return next;
}

// The splices that add one member (`"name": value`) at the end of an object.
function addMember(text: string, object: JsonNode & { members: JsonMember[] }, key: string, value: unknown, unit: string, eol: string): Splice[] {
  const close = object.end - 1;
  const ownIndent = indentAt(text, object.start);
  const last = object.members.at(-1);
  const childIndent = object.members[0] && startsItsLine(text, object.members[0].keyStart) ? indentAt(text, object.members[0].keyStart) : ownIndent + unit;
  const member = `${JSON.stringify(key)}: ${jsonBlock(value, unit, childIndent, eol)}`;
  if (!last) {
    if (!hasNewline(text, object.start, close)) return [{ at: close, insert: `${eol}${childIndent}${member}${eol}${ownIndent}` }];
    const closeLine = lineStart(text, close);
    if (startsItsLine(text, close)) return [{ at: closeLine, insert: `${childIndent}${member}${eol}` }];
    return [{ at: close, insert: `${eol}${childIndent}${member}${eol}${ownIndent}` }];
  }
  const trailing = last.comma !== undefined;
  const after = trailing ? last.comma! + 1 : last.node.end;
  const comma: Splice[] = trailing ? [] : [{ at: last.node.end, insert: ',' }];
  if (!hasNewline(text, object.start, close)) {
    // All on one line: the member goes on it too, as the others are.
    return [...comma, { at: after, insert: ` ${JSON.stringify(key)}: ${JSON.stringify(value)}${trailing ? ',' : ''}` }];
  }
  const end = lineEndAfter(text, after);
  if (end !== undefined && end < close) return [...comma, { at: end, insert: `${eol}${childIndent}${member}${trailing ? ',' : ''}` }];
  return [...comma, { at: after, insert: `${eol}${childIndent}${member}${trailing ? ',' : ''}` }];
}

const memberNamed = (object: JsonNode & { members: JsonMember[] }, key: string, shown: string): JsonMember | undefined => {
  const found = object.members.filter((member) => member.key === key);
  if (found.length > 1) throw new EntryRefused(`has "${key}" twice${shown}`);
  return found[0];
};

function jsonWithEntry(text: string, { section, name }: EntrySpot, value: Record<string, unknown>): EntryEdit {
  const root = readJson(text);
  if (!isObjectNode(root)) throw new EntryRefused("isn't a JSON object");
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentUnit(text, root);
  const sectionMember = memberNamed(root, section, '');
  let splices: Splice[];
  let existing: JsonMember | undefined;
  if (!sectionMember) {
    splices = addMember(text, root, section, { [name]: value }, unit, eol);
  } else {
    const servers = sectionMember.node;
    if (!isObjectNode(servers)) throw new EntryRefused(`has "${section}" that isn't an object`);
    existing = memberNamed(servers, name, ` in "${section}"`);
    splices = existing
      ? [{ at: existing.node.start, remove: existing.node.end - existing.node.start, insert: jsonBlock(value, unit, indentAt(text, existing.keyStart), eol) }]
      : addMember(text, servers, name, value, unit, eol);
  }
  const next = apply(text, splices);
  // Read again, it must be the file's own value with the entry set, and nothing else changed.
  const before = root.value as Record<string, unknown>;
  const servers = (before[section] ?? {}) as Record<string, unknown>;
  const expected = { ...before, [section]: { ...servers, [name]: value } };
  let after: unknown;
  try {
    after = readJson(next).value;
  } catch {
    after = undefined;
  }
  if (JSON.stringify(after) !== JSON.stringify(expected)) throw new EntryRefused('is laid out in a way Tricot could not add to without changing more than its entry');
  return { next, ...(existing && { existing: text.slice(existing.node.start, existing.node.end) }) };
}

// ---- YAML -----------------------------------------------------------------------------------------

// A value as YAML lines, block style, two spaces deep (core/yaml.ts).
const yamlLines = (value: Record<string, unknown>): string[] => yamlText(value as Parameters<typeof yamlText>[0]).split('\n');

const DOCUMENT = /^(---|\.\.\.)(\s|$)/;
const DIRECTIVE = /^%/;
// A key at the start of a line: plain, or in double or single quotes, then a colon that ends it.
const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"{[\]},&*!|>%@`?-][^#]*?|-[^\s#][^#]*?))[ \t]*:(?=\s|$)/;

const blank = (line: string) => line.trim() === '';
const comment = (line: string) => line.trimStart().startsWith('#');
const content = (line: string) => !blank(line) && !comment(line);
const indentOf = (line: string) => /^ */.exec(line)![0].length;

// The key a line starts with, read as YAML reads it; none when it starts with none.
function keyOf(line: string): { key: string; rest: string } | undefined {
  const match = KEY.exec(line);
  if (!match) return undefined;
  const [whole, double, single, plain] = match;
  const key = double !== undefined ? (JSON.parse(`"${double}"`) as string) : single !== undefined ? single.replaceAll("''", "'") : plain.trimEnd();
  return { key, rest: line.slice(whole.length) };
}

// What follows a key on its line, without a comment after it.
const valueAfter = (rest: string) => rest.replace(/(^|\s)#.*$/, '').trim();

function yamlWithEntry(text: string, { section, name }: EntrySpot, value: Record<string, unknown>): EntryEdit {
  // Each line as it is (a CR kept at its end); what is read is the line without it.
  const raw = text.split('\n');
  const crlf = raw.length > 1 && raw.slice(0, -1).every((line) => line.endsWith('\r'));
  const lines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const own = (line: string) => (crlf ? `${line}\r` : line);

  // The file as a whole: a mapping at the top, one document, indented with spaces.
  let started = false;
  let marked = false; // the --- that may open the one document
  lines.forEach((line, i) => {
    if (/^ *\t/.test(line) && !blank(line)) throw new EntryRefused(`is indented with tabs (line ${i + 1})`);
    if (!content(line)) return;
    if (!started && !marked && DIRECTIVE.test(line)) return;
    if (!started && !marked && /^---\s*(#.*)?$/.test(line)) {
      marked = true;
      return;
    }
    if (DOCUMENT.test(line)) throw new EntryRefused(`holds more than one YAML document (line ${i + 1})`);
    started = true;
    if (indentOf(line) === 0 && !keyOf(line)) throw new EntryRefused(`has a line at the top Tricot can't read as a key (line ${i + 1})`);
  });

  const at = lines.flatMap((line, i) => (indentOf(line) === 0 && keyOf(line)?.key === section ? [i] : []));
  if (at.length > 1) throw new EntryRefused(`has "${section}:" twice`);
  const entryLines = (indent: number) => yamlLines({ [name]: value }).map((line) => own(' '.repeat(indent) + line));

  if (at.length === 0) {
    // No section yet: it goes at the end, after a blank line.
    const kept = raw.at(-1) === '' ? raw.slice(0, -1) : raw;
    const spacer = kept.length && !blank(kept.at(-1)!) ? [own('')] : [];
    return { next: [...kept, ...spacer, ...yamlLines({ [section]: { [name]: value } }).map(own), ''].join('\n') };
  }

  const s = at[0];
  const head = keyOf(lines[s])!;
  const inline = valueAfter(head.rest);
  // Where the section ends: the next line at the top that holds something, or the file's end.
  let end = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    if (content(lines[i]) && indentOf(lines[i]) === 0) {
      end = i;
      break;
    }
  }
  const inside = Array.from({ length: end - s - 1 }, (_, k) => s + 1 + k);
  const held = inside.filter((i) => content(lines[i]));

  const step = Math.min(...lines.filter((line) => content(line) && indentOf(line) > 0).map(indentOf), Infinity);
  const unit = Number.isFinite(step) ? step : 2;

  if (inline !== '') {
    if (!['{}', 'null', '~'].includes(inline)) throw new EntryRefused(`has "${section}:" written on one line (${inline.length > 24 ? `${inline.slice(0, 23)}…` : inline}), which Tricot doesn't edit`);
    if (held.length) throw new EntryRefused(`has "${section}:" both empty and with lines under it`);
    // Empty: the line says so no longer, and the entry goes under it.
    const after = head.rest.match(/\s#.*$/)?.[0] ?? '';
    const line = own(`${lines[s].slice(0, lines[s].length - head.rest.length)}${after}`);
    return { next: [...raw.slice(0, s), line, ...entryLines(unit), ...raw.slice(s + 1)].join('\n') };
  }

  if (!held.length) return { next: [...raw.slice(0, s + 1), ...entryLines(unit), ...raw.slice(s + 1)].join('\n') };

  const indent = indentOf(lines[held[0]]);
  if (lines[held[0]].trimStart().startsWith('-')) throw new EntryRefused(`has "${section}:" as a list, not one entry per name`);
  const keys: { line: number; key: string }[] = [];
  for (const i of held) {
    const depth = indentOf(lines[i]);
    if (depth < indent) throw new EntryRefused(`has a line under "${section}:" Tricot can't place (line ${i + 1})`);
    if (depth > indent) continue;
    const key = keyOf(lines[i].slice(indent));
    if (!key) throw new EntryRefused(`has a line under "${section}:" Tricot can't read as a name (line ${i + 1})`);
    keys.push({ line: i, key: key.key });
  }
  // The last line that belongs to a server's entry: one that holds something, or one indented under it.
  const lastOf = (from: number, to: number) => {
    let last = from;
    for (let i = from + 1; i < to; i++) if (!blank(lines[i]) && (content(lines[i]) || indentOf(lines[i]) > indent)) last = i;
    return last;
  };
  const named = keys.filter((k) => k.key === name);
  if (named.length > 1) throw new EntryRefused(`has "${name}:" twice under "${section}:"`);
  if (!named.length) {
    const tail = keys.at(-1)!;
    const after = lastOf(tail.line, end);
    return { next: [...raw.slice(0, after + 1), ...entryLines(indent), ...raw.slice(after + 1)].join('\n') };
  }
  const mine = named[0];
  const next = keys.find((k) => k.line > mine.line)?.line ?? end;
  const last = lastOf(mine.line, next);
  return {
    next: [...raw.slice(0, mine.line), ...entryLines(indent), ...raw.slice(last + 1)].join('\n'),
    existing: lines.slice(mine.line, last + 1).join('\n'),
  };
}
