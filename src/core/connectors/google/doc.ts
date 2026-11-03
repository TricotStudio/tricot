// Google Docs, edited in Tricot as paragraphs (#34: save only what changed).
// A doc is pulled from Google and read as a list of paragraphs, each with its
// text, its paragraph style and its place in the doc. Edits are a draft kept
// with the link block (DocDraft): the doc's revision and the paragraphs that
// changed. Saving turns the draft into one batchUpdate that touches only those
// paragraphs, from the end of the doc backwards so every index stays valid,
// and tells Google which revision it applies to. If someone changed the doc in
// Google meanwhile, the draft is moved onto the newer version and anything both
// sides changed waits for a person to choose. Tables, images and other parts
// Tricot can't edit as text are read-only and never touched.

import { clip } from '../../format';
import { findQuote } from '../../pins';
import { googleLink } from './sources';
import type { Actor, DocConflict, DocDraft, DocEdit } from '../../types';

export { DOCS_SCOPE } from './scopes';

// The paragraph styles Tricot shows and sets, as Google names them.
export const PARAGRAPH_STYLES = [
  'NORMAL_TEXT',
  'TITLE',
  'SUBTITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
] as const;

export const STYLE_LABEL: Record<string, string> = {
  NORMAL_TEXT: 'Text',
  TITLE: 'Title',
  SUBTITLE: 'Subtitle',
  HEADING_1: 'Heading 1',
  HEADING_2: 'Heading 2',
  HEADING_3: 'Heading 3',
  HEADING_4: 'Heading 4',
  HEADING_5: 'Heading 5',
  HEADING_6: 'Heading 6',
};

export type ListKind = 'bullet' | 'numbered';

// One element of the doc's body, in order: a paragraph, or a part Tricot
// can't edit as text, which is `locked` with what it is ("Table").
export interface DocParagraph {
  id: string; // p1, p2… in the doc's order at this revision
  start: number; // Google's startIndex and endIndex, in UTF-16 code units;
  end: number; // a paragraph's end is past its newline
  text: string; // without the newline; a line break inside it (Shift+Enter) is \n
  style: string; // namedStyleType: NORMAL_TEXT, TITLE, SUBTITLE, HEADING_1…
  list?: { id: string; level: number; ordered: boolean };
  locked?: string; // read-only: "Table", "Image", "Smart chip", "Suggested edits"…
  detail?: string; // more about a locked part: "3 rows × 2 columns"
  block?: true; // not a paragraph at all (a table, a table of contents, a section break): text can't go in it
}

export interface PulledDoc {
  fileId: string;
  revision: string;
  title: string;
  paragraphs: DocParagraph[];
  pulledAt: string;
}

// A change asked for by a person or an agent, before it is checked against the doc.
export type DocChange =
  | { kind: 'text'; id: string; text: string } // reword a paragraph (of the doc, or added in the draft)
  | { kind: 'add'; after: string; text: string; style?: string; list?: ListKind | null } // after a paragraph id, or '' for the start
  | { kind: 'delete'; id: string }
  | { kind: 'restore'; id: string } // undo the draft's change to a paragraph of the doc
  | { kind: 'format'; id: string; style?: string; list?: ListKind | null }; // an added paragraph's style

// An error whose message is for the person or agent who asked.
export class DocError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const MAX_TEXT = 20_000; // per paragraph
const MAX_EDITS = 1_000;

// The Drive id of the Google Doc a link points to, or undefined for any other link.
export function docFileId(url: string): string | undefined {
  const source = googleLink(url);
  return source?.mark === 'google-docs' ? source.fileId : undefined;
}

// ---- reading a doc ------------------------------------------------------------

// The parts of Google's documents.get answer read here.
interface GTextRun {
  content?: string;
  suggestedInsertionIds?: string[];
  suggestedDeletionIds?: string[];
}
interface GElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: GTextRun;
  [kind: string]: unknown;
}
interface GParagraph {
  elements?: GElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
  positionedObjectIds?: string[];
  suggestedParagraphStyleChanges?: Record<string, unknown>;
  suggestedBulletChanges?: Record<string, unknown>;
  suggestedPositionedObjectIds?: Record<string, unknown>;
}
interface GStructural {
  startIndex?: number;
  endIndex?: number;
  paragraph?: GParagraph;
  table?: { rows?: number; columns?: number; tableRows?: { tableCells?: { content?: GStructural[] }[] }[] };
  tableOfContents?: unknown;
  sectionBreak?: unknown;
}
export interface GoogleDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: GStructural[] };
  lists?: Record<string, { listProperties?: { nestingLevels?: { glyphType?: string; glyphSymbol?: string }[] } }>;
}

// What a paragraph element other than text is, said plainly.
const ELEMENT_LABEL: Record<string, string> = {
  inlineObjectElement: 'Image',
  person: 'Smart chip',
  richLink: 'Smart chip',
  dateElement: 'Smart chip',
  dropdown: 'Smart chip',
  equation: 'Equation',
  footnoteReference: 'Footnote',
  pageBreak: 'Page break',
  columnBreak: 'Column break',
  horizontalRule: 'Horizontal line',
  autoText: 'Page number',
};

function elementKind(element: GElement): string {
  return Object.keys(element).find((key) => key !== 'startIndex' && key !== 'endIndex') ?? 'unknown';
}

function suggested(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function runsText(paragraph: GParagraph | undefined): string {
  return (paragraph?.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A doc's body as paragraphs, from Google's documents.get answer (the first
// tab, as documents.get gives it by default). The section break every body
// starts with is left out.
export function readDocument(doc: GoogleDocument): { revision?: string; title: string; paragraphs: DocParagraph[] } {
  const paragraphs: DocParagraph[] = [];
  const add = (p: Omit<DocParagraph, 'id'>) => paragraphs.push({ id: `p${paragraphs.length + 1}`, ...p });
  for (const element of doc.body?.content ?? []) {
    const start = element.startIndex ?? 0;
    const end = element.endIndex ?? start;
    if (element.paragraph) {
      const p = element.paragraph;
      const elements = p.elements ?? [];
      const raw = runsText(p);
      const text = raw.replace(/\n$/, '').replace(/\u000b/g, '\n');
      const other = elements.find((e) => !e.textRun);
      let locked: string | undefined;
      if (
        elements.some((e) => suggested(e.textRun?.suggestedInsertionIds) || suggested(e.textRun?.suggestedDeletionIds)) ||
        elements.some((e) => !e.textRun && suggested((e[elementKind(e)] as GTextRun | undefined)?.suggestedInsertionIds)) ||
        suggested(p.suggestedParagraphStyleChanges) ||
        suggested(p.suggestedBulletChanges) ||
        suggested(p.suggestedPositionedObjectIds)
      ) {
        locked = 'Suggested edits';
      } else if (other) {
        locked = ELEMENT_LABEL[elementKind(other)] ?? 'Something Tricot can’t edit';
      } else if (p.positionedObjectIds?.length) {
        locked = 'Image';
      } else if (raw.length !== end - start || !raw.endsWith('\n')) {
        locked = 'Something Tricot can’t edit'; // the text doesn't add up to the paragraph: leave it be
      }
      const bullet = p.bullet;
      const level = bullet?.nestingLevel ?? 0;
      const glyph = bullet?.listId ? doc.lists?.[bullet.listId]?.listProperties?.nestingLevels?.[level] : undefined;
      add({
        start,
        end,
        text,
        style: p.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT',
        ...(bullet?.listId
          ? { list: { id: bullet.listId, level, ordered: Boolean(glyph?.glyphType && !['GLYPH_TYPE_UNSPECIFIED', 'NONE'].includes(glyph.glyphType)) } }
          : {}),
        ...(locked ? { locked } : {}),
      });
    } else if (element.table) {
      const { rows = 0, columns = 0, tableRows = [] } = element.table;
      const first = (tableRows[0]?.tableCells ?? []).map((cell) => (cell.content ?? []).map((c) => runsText(c.paragraph)).join(' ').trim());
      add({
        start,
        end,
        text: clip(first.filter(Boolean).join(' · '), 120),
        style: 'NORMAL_TEXT',
        locked: 'Table',
        detail: `${plural(rows, 'row')} × ${plural(columns, 'column')}`,
        block: true,
      });
    } else if (element.tableOfContents) {
      add({ start, end, text: '', style: 'NORMAL_TEXT', locked: 'Table of contents', block: true });
    } else if (element.sectionBreak && start > 0) {
      add({ start, end, text: '', style: 'NORMAL_TEXT', locked: 'Section break', block: true });
    }
  }
  return { revision: doc.revisionId, title: doc.title ?? '', paragraphs };
}

// ---- the draft ---------------------------------------------------------------

export function newDraft(doc: PulledDoc): DocDraft {
  return { fileId: doc.fileId, revision: doc.revision, ...(doc.title ? { title: doc.title } : {}), edits: [] };
}

type AddEdit = Extract<DocEdit, { op: 'add' }>;

function cleanText(text: string): string {
  const clean = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u000b/g, '\n')
    // Control characters other than tab and line break don't belong in a doc.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000c\u000e-\u001f\u007f]/g, '');
  if (clean.length > MAX_TEXT) throw new DocError(`A paragraph is too long (max ${MAX_TEXT} characters).`);
  return clean;
}

// A paragraph style as Google names it, from its name or a short form
// ("heading1", "Heading 1", "normal").
export function paragraphStyle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const named = key === 'NORMAL' || key === 'TEXT' ? 'NORMAL_TEXT' : key.replace(/^HEADING(\d)$/, 'HEADING_$1');
  if (!(PARAGRAPH_STYLES as readonly string[]).includes(named)) {
    throw new DocError(`"${value}" isn't a paragraph style. Use normal, title, subtitle or heading1 to heading6.`);
  }
  return named;
}

function listKind(value: ListKind | null | undefined): ListKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== 'bullet' && value !== 'numbered') throw new DocError(`"${value}" isn't a list: use bullet or numbered.`);
  return value;
}

// Whether new paragraphs can go right after base[index] (-1: at the start):
// into a paragraph there, or else into the one after a table.
function insertableAfter(base: DocParagraph[], index: number): boolean {
  if (index >= 0 && !base[index].block) return true;
  const next = base[index + 1];
  return Boolean(next && !next.block);
}

// Applies people's and agents' changes to a draft of `base`, the doc at the
// draft's revision. A paragraph changed back to how the doc has it is no
// longer a change. Returns the new draft and the ids of paragraphs it added.
export function applyChanges(
  base: DocParagraph[],
  draft: DocDraft,
  changes: DocChange[],
  actor: Actor,
  now = new Date().toISOString(),
): { draft: DocDraft; added: string[] } {
  const byId = new Map(base.map((p) => [p.id, p]));
  let edits: DocEdit[] = draft.edits.map((e) => ({ ...e }));
  let conflicts = draft.conflicts?.map((c) => ({ ...c }));
  const added: string[] = [];
  const chained = new Map<string, string>(); // a place asked for twice in one call: the last paragraph added there
  let next = Math.max(0, ...edits.map((e) => (e.op === 'add' ? Number(e.id.slice(1)) || 0 : 0))) + 1;
  const own = (id: string) => edits.find((e) => e.id === id);
  const drop = (id: string) => (edits = edits.filter((e) => e.id !== id));
  const paragraph = (id: string) => {
    const found = byId.get(id);
    if (!found) throw new DocError(`This doc has no paragraph "${id}". Read it again: ids are p1, p2… in the doc and n1, n2… for paragraphs added in the draft.`);
    if (found.locked) throw new DocError(`${id} is ${lockedLabel(found)}: Tricot can't change it. Edit it in Google.`);
    return found;
  };

  for (const change of changes) {
    switch (change.kind) {
      case 'text': {
        const text = cleanText(change.text);
        const mine = own(change.id);
        if (mine?.op === 'add') {
          Object.assign(mine, { text, by: actor, at: now });
          break;
        }
        const p = paragraph(change.id);
        drop(change.id);
        if (text !== p.text) edits.push({ op: 'edit', id: p.id, was: p.text, text, by: actor, at: now });
        break;
      }
      case 'add': {
        const given = change.after === 'start' ? '' : change.after;
        const after = chained.get(given) ?? given;
        if (after !== '' && !byId.has(after) && own(after)?.op !== 'add') {
          throw new DocError(`There's no paragraph "${after}" to add after. Pass a paragraph id, or "start".`);
        }
        const anchor = after === '' ? -1 : base.findIndex((p) => p.id === after);
        if ((after === '' || anchor >= 0) && !insertableAfter(base, anchor)) {
          throw new DocError(`A paragraph can't go ${after ? `right after ${after}` : 'at the start'}: there's no paragraph there to add it to (two tables meet). Add it in Google.`);
        }
        const id = `n${next++}`;
        const style = paragraphStyle(change.style) ?? 'NORMAL_TEXT';
        const list = listKind(change.list);
        const following = edits.find((e): e is AddEdit => e.op === 'add' && e.after === after);
        if (following) following.after = id;
        edits.push({ op: 'add', id, after, text: cleanText(change.text), style, ...(list ? { list } : {}), by: actor, at: now });
        chained.set(given, id);
        added.push(id);
        break;
      }
      case 'delete': {
        const mine = own(change.id);
        if (mine?.op === 'add') {
          drop(mine.id);
          for (const e of edits) if (e.op === 'add' && e.after === mine.id) e.after = mine.after;
          for (const c of conflicts ?? []) if (c.after === mine.id) c.after = mine.after;
          break;
        }
        const p = paragraph(change.id);
        drop(p.id);
        edits.push({ op: 'delete', id: p.id, was: p.text, by: actor, at: now });
        break;
      }
      case 'restore': {
        if (own(change.id)?.op === 'add') throw new DocError(`${change.id} was added in the draft: remove it instead.`);
        drop(change.id);
        break;
      }
      case 'format': {
        const mine = own(change.id);
        if (mine?.op !== 'add') throw new DocError(`Only paragraphs added in the draft can change style here; ${change.id} isn't one.`);
        if (change.style !== undefined) mine.style = paragraphStyle(change.style);
        if (change.list !== undefined) {
          const list = listKind(change.list);
          if (list) mine.list = list;
          else delete mine.list;
        }
        Object.assign(mine, { by: actor, at: now });
        break;
      }
    }
  }
  if (edits.length > MAX_EDITS) throw new DocError(`A draft can hold at most ${MAX_EDITS} changes. Save it, then go on.`);
  if (conflicts && conflicts.length === 0) conflicts = undefined;
  const result: DocDraft = { ...draft, edits };
  if (conflicts) result.conflicts = conflicts;
  else delete result.conflicts;
  return { draft: result, added };
}

export function lockedLabel(p: Pick<DocParagraph, 'locked'>): string {
  const what = (p.locked ?? '').toLowerCase();
  if (what.startsWith('suggested')) return 'a paragraph with suggested edits';
  if (what === 'table' || what === 'table of contents' || what === 'section break') return `a ${what}`;
  return `a paragraph with ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}`;
}

// A row of the draft as people and agents see it, in the doc's order.
export interface DraftRow {
  id: string;
  text: string;
  style: string;
  list?: { ordered: boolean; level: number; id?: string };
  state: 'same' | 'changed' | 'added' | 'removed';
  was?: string; // a changed or removed paragraph, as the doc has it
  by?: Actor;
  at?: string;
  locked?: string;
  detail?: string;
  block?: true;
}

// The doc with the draft's changes, in order: added paragraphs where they
// were added, removed ones still listed (as removed).
export function draftRows(base: DocParagraph[], draft: DocDraft | undefined): DraftRow[] {
  const edits = new Map((draft?.edits ?? []).filter((e) => e.op !== 'add').map((e) => [e.id, e]));
  const adds = (draft?.edits ?? []).filter((e): e is AddEdit => e.op === 'add');
  const after = new Map(adds.map((a) => [a.after, a]));
  const rows: DraftRow[] = [];
  const reached = new Set<string>();
  const chain = (anchor: string) => {
    for (let a = after.get(anchor); a && !reached.has(a.id); a = after.get(a.id)) {
      reached.add(a.id);
      rows.push({
        id: a.id,
        text: a.text,
        style: a.style ?? 'NORMAL_TEXT',
        ...(a.list ? { list: { ordered: a.list === 'numbered', level: 0 } } : {}),
        state: 'added',
        by: a.by,
        at: a.at,
      });
    }
  };
  chain('');
  for (const p of base) {
    const edit = edits.get(p.id);
    const { start: _start, end: _end, ...shown } = p;
    if (!edit) rows.push({ ...shown, state: 'same' });
    else if (edit.op === 'edit') rows.push({ ...shown, text: edit.text, state: 'changed', was: p.text, by: edit.by, at: edit.at });
    else rows.push({ ...shown, state: 'removed', was: p.text, by: edit.by, at: edit.at });
    chain(p.id);
  }
  // Added after something no longer there: kept, at the end.
  for (const a of adds) if (!reached.has(a.id)) chain(a.after);
  return rows;
}

// Who changed what in a draft: each actor and how many paragraphs.
export function draftAuthors(draft: DocDraft | undefined): { by: Actor; count: number }[] {
  const counts = new Map<string, { by: Actor; count: number }>();
  for (const edit of draft?.edits ?? []) {
    const key = `${edit.by.kind}:${edit.by.name}`;
    const entry = counts.get(key) ?? { by: edit.by, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

// ---- saving: one batchUpdate ---------------------------------------------------

export type DocRequest = Record<string, unknown>;

const BULLETS: Record<ListKind, string> = { bullet: 'BULLET_DISC_CIRCLE_SQUARE', numbered: 'NUMBERED_DECIMAL_ALPHA_ROMAN' };
const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex });
const googleText = (text: string) => text.replace(/\n/g, '\u000b'); // a line break inside a paragraph
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// The smallest replacement that turns one text into the other: what's the same
// at both ends stays, with its formatting. Never splits a surrogate pair.
export function textChange(before: string, after: string): { from: number; to: number; insert: string } {
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (suf < before.length - pre && suf < after.length - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  if (pre > 0 && isHigh(before.charCodeAt(pre - 1))) pre--;
  if (suf > 0 && isLow(before.charCodeAt(before.length - suf))) suf--;
  return { from: pre, to: before.length - suf, insert: after.slice(pre, after.length - suf) };
}

interface Op {
  pos: number; // where in the doc it acts; ops run from the end of the doc backwards
  rank: number; // at the same place: paragraphs added after one (3), then its own text (2), then paragraphs added before it (1)
  requests: DocRequest[];
}

// The requests for paragraphs added in one place, inserted at `at`: either
// just before a paragraph's newline (`lead`: "\nA\nB", as if pressing Enter
// at its end), or at the start of the paragraph that follows ("A\nB\n").
// New paragraphs copy the style of the paragraph they're typed into, so each
// gets its own named style, plain text, and its list, explicitly.
function insertRun(at: number, lead: boolean, run: AddEdit[], donor: DocParagraph['list']): DocRequest[] {
  const text = run.map((a) => googleText(a.text)).join('\n');
  const requests: DocRequest[] = [{ insertText: { location: { index: at }, text: lead ? `\n${text}` : `${text}\n` } }];
  let start = lead ? at + 1 : at;
  const spans = run.map((a) => {
    const span = { add: a, start, end: start + a.text.length + 1 };
    start = span.end;
    return span;
  });
  for (const { add, start: from, end } of spans) {
    requests.push({ updateParagraphStyle: { range: range(from, end), paragraphStyle: { namedStyleType: add.style ?? 'NORMAL_TEXT' }, fields: 'namedStyleType' } });
  }
  const textEnd = spans.at(-1)!.end - 1;
  if (textEnd > spans[0].start) requests.push({ updateTextStyle: { range: range(spans[0].start, textEnd), textStyle: {}, fields: '*' } });
  // Lists: keep the list the new paragraph was typed into when it's the kind
  // wanted; otherwise take it out, and start the kind wanted.
  const kindOf = (list: DocParagraph['list']): ListKind | undefined => (list ? (list.ordered ? 'numbered' : 'bullet') : undefined);
  const groups = (pick: (a: AddEdit) => string | undefined) => {
    const out: { key: string; from: number; to: number }[] = [];
    for (const span of spans) {
      const key = pick(span.add);
      const last = out.at(-1);
      if (key && last?.key === key && last.to === span.start) last.to = span.end;
      else if (key) out.push({ key, from: span.start, to: span.end });
    }
    return out;
  };
  const donorKind = kindOf(donor);
  for (const g of groups((a) => (donorKind && a.list !== donorKind ? 'out' : undefined))) {
    requests.push({ deleteParagraphBullets: { range: range(g.from, g.to) } });
  }
  for (const g of groups((a) => (a.list && a.list !== donorKind ? BULLETS[a.list] : undefined)).reverse()) {
    requests.push({ createParagraphBullets: { range: range(g.from, g.to), bulletPreset: g.key } });
  }
  return requests;
}

// What saving does to each paragraph of `base`: kept, deleted with its
// newline, or emptied when what follows couldn't take its place (the end of
// the doc, a table).
function removals(base: DocParagraph[], draft: DocDraft): ('keep' | 'delete' | 'clear')[] {
  const removed = new Set(draft.edits.filter((e) => e.op === 'delete').map((e) => e.id));
  const fate: ('keep' | 'delete' | 'clear')[] = [];
  let following: DocParagraph | undefined; // what will follow, once later removals are done
  for (let i = base.length - 1; i >= 0; i--) {
    const p = base[i];
    if (removed.has(p.id) && p.locked) throw new DocError(`${p.id} is ${lockedLabel(p)} and can't be removed here.`);
    if (removed.has(p.id) && following && !following.block) fate[i] = 'delete';
    else {
      fate[i] = removed.has(p.id) ? 'clear' : 'keep';
      following = p;
    }
  }
  return fate;
}

// The ids paragraphs have in the doc once a draft of `base` is saved: each
// paragraph of the doc or the draft still there (pN, nN) by its new pN. A
// removed one isn't there, even when saving only empties it.
export function savedIds(base: DocParagraph[], draft: DocDraft): Map<string, string> {
  const fate = removals(base, draft);
  const index = new Map(base.map((p, i) => [p.id, i]));
  const ids = new Map<string, string>();
  let n = 0;
  for (const row of draftRows(base, draft)) {
    if (row.state !== 'removed') ids.set(row.id, `p${++n}`);
    else if (fate[index.get(row.id)!] === 'clear') n++;
  }
  return ids;
}

// One batchUpdate's requests for a draft of `base`. For a changed paragraph,
// only the changed part of its text is replaced (its newline, and so its
// paragraph style, stays); a removed one is deleted with its newline, or
// emptied when what follows couldn't take its place (the end of the doc, a
// table); added ones are inserted where they go. Read-only parts are never in
// a range. Ops run from the end of the doc backwards, so each one's indexes
// are as the doc was pulled.
export function buildRequests(base: DocParagraph[], draft: DocDraft): DocRequest[] {
  const edits = new Map(draft.edits.filter((e) => e.op !== 'add').map((e) => [e.id, e]));
  const index = new Map(base.map((p, i) => [p.id, i]));
  // Added paragraphs, by the place in the doc they go: after base[slot], -1 for the start.
  const runs = new Map<number, AddEdit[]>();
  let slot = -1;
  const adds = new Map(draft.edits.filter((e): e is AddEdit => e.op === 'add').map((a) => [a.id, a]));
  for (const row of draftRows(base, draft)) {
    if (row.state !== 'added') slot = index.get(row.id)!;
    else runs.set(slot, [...(runs.get(slot) ?? []), adds.get(row.id)!]);
  }
  const fate = removals(base, draft);

  const ops: Op[] = [];
  base.forEach((p, i) => {
    const edit = edits.get(p.id);
    if (edit?.op === 'edit') {
      if (p.locked) throw new DocError(`${p.id} is ${lockedLabel(p)} and can't be changed here.`);
      const { from, to, insert } = textChange(p.text, edit.text);
      const requests: DocRequest[] = [];
      if (to > from) requests.push({ deleteContentRange: { range: range(p.start + from, p.start + to) } });
      if (insert) requests.push({ insertText: { location: { index: p.start + from }, text: googleText(insert) } });
      if (requests.length) ops.push({ pos: p.start + from, rank: 2, requests });
    } else if (fate[i] === 'delete') {
      ops.push({ pos: p.start, rank: 2, requests: [{ deleteContentRange: { range: range(p.start, p.end) } }] });
    } else if (fate[i] === 'clear' && p.text) {
      ops.push({ pos: p.start, rank: 2, requests: [{ deleteContentRange: { range: range(p.start, p.end - 1) } }] });
    }
  });
  for (const [at, run] of runs) {
    // The paragraph before the place, with nothing kept in between: new
    // paragraphs go in at its end. Else the one after, at its start.
    let before: DocParagraph | undefined;
    for (let j = at; j >= 0; j--) if (fate[j] !== 'delete') {
      before = base[j];
      break;
    }
    let after: DocParagraph | undefined;
    for (let j = at + 1; j < base.length; j++) if (fate[j] !== 'delete') {
      after = base[j];
      break;
    }
    const usable = (p: DocParagraph | undefined, plain: boolean) => p && !p.block && (!plain || !p.locked);
    if (usable(before, true) || (!usable(after, true) && usable(before, false))) {
      ops.push({ pos: before!.end - 1, rank: 3, requests: insertRun(before!.end - 1, true, run, before!.list) });
    } else if (usable(after, false)) {
      ops.push({ pos: after!.start, rank: 1, requests: insertRun(after!.start, false, run, after!.list) });
    } else {
      throw new DocError("New paragraphs can't go between two tables. Add them in Google.");
    }
  }
  return ops.sort((a, b) => b.pos - a.pos || b.rank - a.rank).flatMap((op) => op.requests);
}

// ---- when the doc changed in Google meanwhile ---------------------------------

const alignKey = (p: DocParagraph) => `${p.block ? 'block' : 'p'}\u0000${p.locked ?? ''}\u0000${p.text}`;

// Which paragraph of `after` each paragraph of `before` became: the same
// text where it can be matched in order, and between matches, paragraphs
// paired off in order (changed ones). Unpaired ones were removed or added.
export function alignParagraphs(before: DocParagraph[], after: DocParagraph[]): Map<string, string> {
  const pairs = new Map<string, string>();
  let head = 0;
  while (head < before.length && head < after.length && alignKey(before[head]) === alignKey(after[head])) {
    pairs.set(before[head].id, after[head].id);
    head++;
  }
  let endA = before.length;
  let endB = after.length;
  while (endA > head && endB > head && alignKey(before[endA - 1]) === alignKey(after[endB - 1])) {
    endA--;
    endB--;
    pairs.set(before[endA].id, after[endB].id);
  }
  const a = before.slice(head, endA);
  const b = after.slice(head, endB);
  const pairGap = (gapA: DocParagraph[], gapB: DocParagraph[]) => {
    for (let k = 0; k < Math.min(gapA.length, gapB.length); k++) {
      if (Boolean(gapA[k].block) === Boolean(gapB[k].block)) pairs.set(gapA[k].id, gapB[k].id);
    }
  };
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > 4_000_000) {
    pairGap(a, b);
    return pairs;
  }
  // Longest common run of paragraphs, from the end.
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        alignKey(a[i]) === alignKey(b[j]) ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let gapA: DocParagraph[] = [];
  let gapB: DocParagraph[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (alignKey(a[i]) === alignKey(b[j])) {
      pairGap(gapA, gapB);
      gapA = [];
      gapB = [];
      pairs.set(a[i].id, b[j].id);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) gapA.push(a[i++]);
    else gapB.push(b[j++]);
  }
  pairGap([...gapA, ...a.slice(i)], [...gapB, ...b.slice(j)]);
  return pairs;
}

// Moves a draft onto a newer version of the doc. A change to a paragraph
// nobody else touched carries over; one someone also changed (or removed) in
// Google becomes a conflict for a person to settle, and saving waits until
// none are left. Without the version the draft started from (`base` null),
// paragraphs are found again by their text.
export function rebaseDraft(base: DocParagraph[] | null, latest: PulledDoc, draft: DocDraft, now = new Date().toISOString()): DocDraft {
  if (draft.conflicts?.length) throw new DocError('Settle the open conflicts in this draft first.', 409);
  const latestById = new Map(latest.paragraphs.map((p) => [p.id, p]));
  let counterpart: (id: string, was?: string) => DocParagraph | undefined;
  let rows: DraftRow[];
  let theirs = 0;
  if (base) {
    const pairs = alignParagraphs(base, latest.paragraphs);
    counterpart = (id) => latestById.get(pairs.get(id) ?? '');
    rows = draftRows(base, draft);
    const paired = new Set(pairs.values());
    for (const p of base) {
      const q = counterpart(p.id);
      if (!q || q.text !== p.text) theirs++;
    }
    theirs += latest.paragraphs.filter((q) => !paired.has(q.id)).length;
  } else {
    // Each changed paragraph found again by its text as the draft found it;
    // paragraphs added in the draft go at the end of the doc.
    const used = new Set<string>();
    counterpart = (_id, was) => {
      const q = latest.paragraphs.find((p) => !used.has(p.id) && p.text === was);
      if (q) used.add(q.id);
      return q;
    };
    const changed = draft.edits.filter((e) => e.op !== 'add');
    const added = draft.edits.filter((e) => e.op === 'add');
    rows = [...changed, ...added].map((e): DraftRow => ({
      id: e.id,
      text: '',
      style: e.op === 'add' ? (e.style ?? 'NORMAL_TEXT') : 'NORMAL_TEXT',
      state: e.op === 'add' ? 'added' : 'changed',
    }));
  }

  const editOf = new Map(draft.edits.map((e) => [e.id, e]));
  const edits: DocEdit[] = [];
  const conflicts: DocConflict[] = [];
  let current = '';
  const end = base ? undefined : (latest.paragraphs.findLast((p) => !p.block)?.id ?? '');
  for (const row of rows) {
    const edit = editOf.get(row.id);
    if (row.state === 'added' && edit?.op === 'add') {
      edits.push({ ...edit, after: end !== undefined && !current.startsWith('n') ? end : current });
      current = edit.id;
      continue;
    }
    const q = counterpart(row.id, edit && edit.op !== 'add' ? edit.was : undefined);
    if (!edit || edit.op === 'add') {
      if (q) current = q.id;
      continue;
    }
    const conflict = (mine: string | undefined) =>
      conflicts.push({
        id: `c${conflicts.length + 1}`,
        ...(q ? { paragraph: q.id } : {}),
        after: current,
        was: edit.was,
        ...(q ? { theirs: q.text } : {}),
        ...(mine !== undefined ? { mine } : {}),
        by: edit.by,
        ...(row.style !== 'NORMAL_TEXT' ? { style: row.style } : {}),
      });
    if (edit.op === 'edit') {
      if (q && !q.locked && q.text === edit.was) edits.push({ ...edit, id: q.id });
      else if (!(q && q.text === edit.text)) conflict(edit.text);
    } else if (q) {
      if (!q.locked && q.text === edit.was) edits.push({ ...edit, id: q.id });
      else conflict(undefined);
    }
    if (q) current = q.id;
  }
  // One added paragraph per place, in the order they came.
  const seen = new Map<string, AddEdit>();
  for (const e of edits) {
    if (e.op !== 'add') continue;
    const before = seen.get(e.after);
    if (before) e.after = before.id;
    seen.set(e.after, e);
  }
  return {
    fileId: draft.fileId,
    revision: latest.revision,
    ...(latest.title ? { title: latest.title } : draft.title ? { title: draft.title } : {}),
    edits,
    ...(conflicts.length ? { conflicts } : {}),
    rebased: { at: now, theirs: Math.max(theirs, 0) },
  };
}

// Where a paragraph of one version of a doc is in a newer one (`after`):
// paired by alignParagraphs when the older version is at hand, or else the
// paragraph that has the words pinned in it, nearest the same place. Null
// when it isn't there any more.
export function followParagraph(
  before: DocParagraph[] | null,
  after: DocParagraph[],
): (id: string, words: { quote: string; prefix?: string; suffix?: string }) => string | null {
  const pairs = before && alignParagraphs(before, after);
  return (id, words) => {
    if (pairs) return pairs.get(id) ?? null;
    const was = Number(id.slice(1)) || 0;
    const found = after.filter((p) => !p.block && findQuote(p.text, words.quote, words));
    found.sort((a, b) => Math.abs(Number(a.id.slice(1)) - was) - Math.abs(Number(b.id.slice(1)) - was));
    return found[0]?.id ?? null;
  };
}

// A person settles one conflict: the draft's version, or Google's.
export function resolveConflict(
  base: DocParagraph[],
  draft: DocDraft,
  conflictId: string,
  keep: 'mine' | 'theirs',
  now = new Date().toISOString(),
): DocDraft {
  const conflict = draft.conflicts?.find((c) => c.id === conflictId);
  if (!conflict) throw new DocError(`This draft has no conflict "${conflictId}". It may be settled already.`, 404);
  const conflicts = draft.conflicts!.filter((c) => c !== conflict);
  let edits = draft.edits.filter((e) => e.id !== conflict.paragraph);
  if (keep === 'mine') {
    const target = base.find((p) => p.id === conflict.paragraph);
    const by = conflict.by;
    if (conflict.mine === undefined) {
      if (target && !target.locked) edits.push({ op: 'delete', id: target.id, was: target.text, by, at: now });
    } else if (target && !target.locked) {
      if (conflict.mine !== target.text) edits.push({ op: 'edit', id: target.id, was: target.text, text: conflict.mine, by, at: now });
    } else {
      // Theirs is gone (or can't be edited here): mine comes back as a new paragraph where it was.
      const id = `n${Math.max(0, ...edits.map((e) => (e.op === 'add' ? Number(e.id.slice(1)) || 0 : 0))) + 1}`;
      const anchor = target ? target.id : conflict.after;
      edits = edits.map((e) => (e.op === 'add' && e.after === anchor ? { ...e, after: id } : e));
      edits.push({ op: 'add', id, after: anchor, text: conflict.mine, style: conflict.style ?? 'NORMAL_TEXT', by, at: now });
    }
  }
  const result: DocDraft = { ...draft, edits };
  if (conflicts.length) result.conflicts = conflicts;
  else delete result.conflicts;
  return result;
}

// ---- for agents ---------------------------------------------------------------

function who(actor: Actor): string {
  return `${actor.name} (${actor.kind})`;
}

function rowLine(row: DraftRow, numbers: Map<string, number>): string {
  const style = row.style !== 'NORMAL_TEXT' ? `[${STYLE_LABEL[row.style] ?? row.style}] ` : '';
  const list = row.list ? `${row.list.ordered ? `${numbers.get(row.id) ?? 1}.` : '•'} ` : '';
  const text = JSON.stringify(row.text);
  if (row.locked) {
    const what = [row.locked, row.detail, row.text && clip(row.text, 80)].filter(Boolean).join(' · ');
    return `- ${row.id} [${what}: read-only, edit in Google]`;
  }
  switch (row.state) {
    case 'same':
      return `- ${row.id} ${style}${list}${text}`;
    case 'changed':
      return `- ${row.id} ${style}${list}${text} (changed by ${who(row.by!)}; the doc has ${JSON.stringify(row.was)})`;
    case 'added':
      return `- ${row.id} ${style}${list}${text} (added by ${who(row.by!)})`;
    case 'removed':
      return `- ${row.id} ${style}${list}${JSON.stringify(row.was)} (removed by ${who(row.by!)})`;
  }
}

// Numbers for numbered list items, counted along each list.
export function listNumbers(rows: DraftRow[]): Map<string, number> {
  const numbers = new Map<string, number>();
  const counters = new Map<string, number>();
  let previous: DraftRow | undefined;
  for (const row of rows) {
    if (row.state === 'removed' || !row.list?.ordered) {
      if (row.state !== 'removed' && !row.list) counters.clear();
      previous = row.state === 'removed' ? previous : row;
      continue;
    }
    const key = `${row.list.id ?? previous?.list?.id ?? 'new'}:${row.list.level}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    numbers.set(row.id, n);
    previous = row;
  }
  return numbers;
}

// A doc and its draft as an agent reads it. `pinned` are people's requests
// and comments pinned to its paragraphs, as lines (see docPinLines).
export function docDigest(doc: PulledDoc, draft: DocDraft | undefined, blockId: string, name: string, pinned: string[] = []): string {
  const rows = draftRows(doc.paragraphs, draft);
  const numbers = listNumbers(rows);
  const authors = draftAuthors(draft);
  const lines = [
    `# Google Doc "${clip(name, 80)}" [block id: ${blockId}] · revision ${doc.revision}`,
    draft?.edits.length
      ? `Draft: ${plural(draft.edits.length, 'paragraph')} changed (${authors.map((a) => `${a.count} by ${who(a.by)}`).join(', ')}). Not saved to Google yet: a person saves it from the board.`
      : 'Draft: no changes yet.',
  ];
  if (draft?.conflicts?.length) {
    lines.push(
      `Saving stopped: the doc changed in Google since the draft began, and ${plural(draft.conflicts.length, 'paragraph')} changed on both sides. A person chooses which version to keep on the board; leave those paragraphs alone until then.`,
    );
    for (const c of draft.conflicts) {
      lines.push(`- ${c.id}: Google has ${c.theirs === undefined ? 'removed it' : JSON.stringify(c.theirs)}; the draft ${c.mine === undefined ? 'removes it' : `has ${JSON.stringify(c.mine)}`}`);
    }
  } else if (draft?.rebased) {
    lines.push('The draft was moved onto a newer version of the doc after someone edited it in Google; ids follow that version.');
  }
  if (pinned.length) lines.push('', 'Pinned to paragraphs by people (requests to act on first):', ...pinned);
  lines.push('', 'Paragraphs, in order (ids for edit_google_doc; [Heading 1] and the like are paragraph styles, • and 1. list items):', ...rows.map((row) => rowLine(row, numbers)));
  return lines.join('\n');
}
