// Search over what a board holds: decisions, tasks, comments, findings and
// canvas blocks, closed ones included, since finding past work is the point.
// People reach it from the search palette, agents from the search tool. It
// scans the boards in memory; an index (SQLite FTS5, say) can take its place
// behind searchBoards without changing what callers get back.

import { clip } from './format';
import { decisionClosure, taskClosure, type Closure } from './closure';
import { kindOf } from './blocks/registry';
import { plainMarkdown } from './markdown';
import { TASK_STATUS_WORDS } from './pins';
import { refLabel } from './refs';
import type { Block, Board, Canvas, Comment, Decision, Status, Task, TaskStatus } from './types';

export type SearchKind = 'decision' | 'task' | 'comment' | 'finding' | 'block';

export const SEARCH_KINDS: SearchKind[] = ['decision', 'task', 'comment', 'finding', 'block'];

export interface SearchOptions {
  boardId?: string; // the board searched, unless allBoards
  allBoards?: boolean; // every board, archived ones included
  kinds?: SearchKind[]; // none: every kind
  openOnly?: boolean; // leave out closed cards, and what is on them
  limit?: number; // 50 by default
}

// A stretch of a text that matched, as offsets: [start, end).
export type Range = [number, number];

export interface SearchSnippet {
  where?: string; // the part of the item it comes from: Rationale, Option b, Comment by Sam, Note "Plan"
  text: string; // about 140 characters around the first match, with … where it was cut
  ranges: Range[];
}

// What to open: the card, and for a block the canvas it is on.
export interface SearchTarget {
  canvas?: 'board' | 'decision' | 'task'; // for a block, or a comment in a thread on one
  decisionId?: string;
  taskId?: string;
  blockId?: string;
  commentId?: string;
  pinId?: string; // a board context comment's thread
}

export interface SearchResult {
  kind: SearchKind;
  boardId: string;
  boardTitle: string;
  boardArchived: boolean;
  ref: string; // #12, T5, or Board Context: the card the item is, or is on
  title: string; // that card's question or title; on the board context, the block's
  titleRanges: Range[]; // matches in the title, when the title is the item's own
  status?: Status | TaskStatus; // the card's
  closed?: Closure['kind']; // done, dropped, decided or retired
  snippet?: SearchSnippet;
  target: SearchTarget;
  at: string; // when the item last changed
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number; // matches before the limit
}

export const MIN_QUERY = 2; // a shorter query finds nothing, rather than everything
export const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SNIPPET = 140;

// ---- folding ----------------------------------------------------------------
// Matching ignores case and accents: "Cafe" finds "Café". Hyphens and
// underscores read as spaces, so "sign-in" and "sign in" find each other. A
// folded text keeps, for each of its characters, where it came from, so
// matches map back onto the text as written.

interface Folded {
  text: string;
  from: number[] | null; // per folded character, its original start; null when nothing moved
  to: number[] | null; // …and end
}

const MARKS = /\p{M}/u;
const JOINERS = /[-_]/g;

export function foldText(text: string): string {
  return text.normalize('NFD').replace(new RegExp(MARKS, 'gu'), '').toLowerCase().replace(JOINERS, ' ');
}

function fold(text: string): Folded {
  // Most text has nothing to take apart: it only changes case, in place.
  if (!MARKS.test(text) && text.normalize('NFD') === text) {
    const lower = text.toLowerCase();
    if (lower.length === text.length) return { text: lower.replace(JOINERS, ' '), from: null, to: null };
  }
  let out = '';
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const folded = foldText(char);
    for (let k = 0; k < folded.length; k++) {
      from.push(i);
      to.push(i + char.length);
    }
    out += folded;
    i += char.length;
  }
  return { text: out, from, to };
}

function original(folded: Folded, [start, end]: Range): Range {
  if (!folded.from || !folded.to) return [start, end];
  return [folded.from[start], folded.to[end - 1]];
}

// ---- the query --------------------------------------------------------------

interface Query {
  words: string[];
  phrase: string; // the words in order, for the exact-phrase bonus
}

// Folded words of two characters or more; quotes around words are dropped.
function readQuery(query: string): Query | null {
  const words = foldText(query)
    .split(/\s+/)
    .map((word) => word.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, ''))
    .filter((word) => word.length >= MIN_QUERY);
  if (words.length === 0) return null;
  return { words: [...new Set(words)], phrase: words.join(' ') };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function atWordStart(text: string, index: number): boolean {
  return index === 0 || !WORD_CHAR.test(text[index - 1]);
}

// Where a word occurs in a folded text: anywhere, and at the start of a word.
function find(text: string, word: string): { all: Range[]; starts: Range[] } {
  const all: Range[] = [];
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) all.push([at, at + word.length]);
  return { all, starts: all.filter(([at]) => atWordStart(text, at)) };
}

// A word matches where a word starts with it: "sign" finds "sign-in" and
// "signed", not "designed"; "in" finds "inbox", not "main".
function occurrences(text: string, word: string): Range[] {
  return find(text, word).starts;
}

// ---- items ------------------------------------------------------------------

type Weight = 'title' | 'body';

interface Field {
  text: string; // as shown: flattened onto one line
  weight: Weight;
  where?: string;
  shown?: boolean; // it is the result's title, so it isn't repeated as the snippet
}

interface Item {
  kind: SearchKind;
  board: Board;
  ref: string;
  title: string;
  fields: Field[];
  card?: { decision: Decision } | { task: Task }; // the card it is, or is on
  target: SearchTarget;
  at: string;
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

function field(text: string | undefined, weight: Weight, where?: string): Field[] {
  const shown = flat(text ?? '');
  return shown ? [{ text: shown, weight, where }] : [];
}

// The item's own title, shown as the result's.
function titleField(text: string): Field[] {
  return field(text, 'title').map((f) => ({ ...f, shown: true }));
}

// The word a block is called by in results: its kind's label.
const blockWord = (block: Block): string => kindOf(block.type).label;

function blockWhere(block: Block): string {
  return block.title ? `${blockWord(block)} "${clip(block.title, 32)}"` : blockWord(block);
}

// What a block says, as the words a search looks in: its kind says which.
function blockContent(block: Block, where: string): Field[] {
  return kindOf(block.type)
    .searchText(block)
    .flatMap((text) => field(text, 'body', where));
}

function decisionItem(board: Board, decision: Decision): Item {
  const { resolution, recommendation } = decision;
  return {
    kind: 'decision',
    board,
    ref: refLabel({ kind: 'decision', number: decision.number }),
    title: decision.question,
    fields: [
      ...titleField(decision.question),
      ...field(plainMarkdown(decision.context ?? ''), 'body', 'Context'),
      ...field(resolution?.answer, 'body', 'Answer'),
      ...field(resolution?.rationale, 'body', 'Rationale'),
      ...decision.options.flatMap((o) =>
        field([o.label, o.description, ...(o.pros ?? []), ...(o.cons ?? [])].filter(Boolean).join(' — '), 'body', `Option ${o.id}`),
      ),
      ...field(recommendation?.reason, 'body', 'Recommendation'),
      ...field(decision.retirement?.text, 'body', 'Retired'),
      ...field(decision.deferral?.text, 'body', 'Deferred'),
      ...field(decision.exploreRequest?.text, 'body', 'Explore'),
    ],
    card: { decision },
    target: { decisionId: decision.id },
    at: decision.updatedAt,
  };
}

function taskItem(board: Board, task: Task): Item {
  return {
    kind: 'task',
    board,
    ref: refLabel({ kind: 'task', number: task.number }),
    title: task.title,
    fields: [
      ...titleField(task.title),
      ...field(plainMarkdown(task.detail ?? ''), 'body', 'Detail'),
      // The latest note first: it says where the work stands.
      ...[...task.notes].reverse().flatMap((note) => field(note.text, 'body', `Note by ${note.by.name}`)),
      ...field(task.dropped?.text, 'body', 'Dropped'),
    ],
    card: { task },
    target: { taskId: task.id },
    at: task.updatedAt,
  };
}

function commentItem(board: Board, comment: Comment, owner: Owner): Item {
  return {
    kind: 'comment',
    board,
    ...owner,
    fields: field(plainMarkdown(comment.body), 'body', `Comment by ${comment.author.name}`),
    target: { ...owner.target, commentId: comment.id },
    at: comment.createdAt,
  };
}

// The card an item is, or is on: its ref, title and what opens it.
type Owner = Pick<Item, 'ref' | 'title' | 'card' | 'target'>;

// The blocks on a canvas, and the comment threads on their pins. On the board
// context the block is what a result is called; on a card's canvas the card
// is, and the block says where on it.
function* canvasItems(board: Board, canvas: Canvas, owner: Owner | undefined, kinds: ReadonlySet<SearchKind>): Generator<Item> {
  for (const block of canvas.blocks) {
    const located: Owner = {
      ref: owner?.ref ?? 'Board Context',
      title: owner?.title ?? block.title ?? blockWord(block),
      card: owner?.card,
      target: { ...(owner?.target ?? { canvas: 'board' }), blockId: block.id },
    };
    if (kinds.has('block')) {
      const heading = owner ? field(block.title, 'title', blockWord(block)) : titleField(block.title ?? '');
      const content = blockContent(block, owner ? blockWhere(block) : blockWord(block));
      yield { kind: 'block', board, ...located, fields: [...heading, ...content], at: block.updatedAt };
    }
    if (!kinds.has('comment')) continue;
    for (const pin of canvas.pins) {
      if (pin.blockId !== block.id) continue;
      for (const comment of pin.discussion?.thread ?? []) {
        yield commentItem(board, comment, { ...located, target: { ...located.target, pinId: pin.id } });
      }
    }
  }
}

// Everything a board holds that a search can find, card by card.
function* itemsOf(board: Board, kinds: ReadonlySet<SearchKind>): Generator<Item> {
  yield* canvasItems(board, board.canvas, undefined, kinds);
  for (const decision of board.decisions) {
    const owner: Owner = {
      ref: refLabel({ kind: 'decision', number: decision.number }),
      title: decision.question,
      card: { decision },
      target: { decisionId: decision.id },
    };
    if (kinds.has('decision')) yield decisionItem(board, decision);
    if (kinds.has('comment')) for (const comment of decision.comments) yield commentItem(board, comment, owner);
    if (kinds.has('finding')) {
      for (const finding of decision.findings) {
        const where = finding.optionId ? `Finding on option ${finding.optionId}` : 'Finding';
        const metrics = Object.entries(finding.metrics ?? {}).map(([name, value]) => `${name}: ${value}`);
        const fields = [...field(finding.summary, 'body', where), ...field(metrics.join(' · '), 'body', where)];
        yield { kind: 'finding', board, ...owner, fields, at: finding.createdAt };
      }
    }
    yield* canvasItems(board, decision.canvas, { ...owner, target: { canvas: 'decision', decisionId: decision.id } }, kinds);
  }
  for (const task of board.tasks) {
    const owner: Owner = {
      ref: refLabel({ kind: 'task', number: task.number }),
      title: task.title,
      card: { task },
      target: { taskId: task.id },
    };
    if (kinds.has('task')) yield taskItem(board, task);
    if (kinds.has('comment')) for (const comment of task.comments) yield commentItem(board, comment, owner);
    yield* canvasItems(board, task.canvas, { ...owner, target: { canvas: 'task', taskId: task.id } }, kinds);
  }
}

// ---- scoring ----------------------------------------------------------------

interface Match {
  score: number;
  folded: Folded[]; // per field
}

// What a word scores in a field: in a title or question it beats the body.
const WORD_SCORE = { title: 10, body: 3 };

// Every word must start a word somewhere in the item. Each counts for where
// it scores best, and the words together as typed earn a bonus.
function match(item: Item, query: Query): Match | null {
  const folded = item.fields.map((f) => fold(f.text));
  let score = 0;
  for (const word of query.words) {
    let best = 0;
    folded.forEach((f, i) => {
      if (occurrences(f.text, word).length) best = Math.max(best, WORD_SCORE[item.fields[i].weight]);
    });
    if (best === 0) return null;
    score += best;
  }
  if (query.words.length > 1) {
    const hasPhrase = (f: Folded) => occurrences(f.text, query.phrase).length > 0;
    if (folded.some((f, i) => item.fields[i].weight === 'title' && hasPhrase(f))) score += 12;
    else if (folded.some(hasPhrase)) score += 5;
  }
  if (folded.some((f, i) => item.fields[i].weight === 'title' && f.text.trim() === query.phrase)) score += 5;
  return { score, folded };
}

// Matches in a field, as offsets into its text: the phrase where it occurs,
// then each word, merged where they overlap.
function rangesIn(folded: Folded, query: Query): Range[] {
  const found = [
    ...(query.words.length > 1 ? occurrences(folded.text, query.phrase) : []),
    ...query.words.flatMap((word) => occurrences(folded.text, word)),
  ]
    .map((range) => original(folded, range))
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Range[] = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

// About 140 characters of a text around its first match (or `focus`), cut at spaces.
export function snippetAround(text: string, ranges: Range[], focus?: number, size = SNIPPET): { text: string; ranges: Range[] } {
  if (text.length <= size) return { text, ranges };
  const first = focus ?? ranges[0]?.[0] ?? 0;
  let start = Math.max(0, first - Math.round(size * 0.3));
  let end = Math.min(text.length, start + size);
  if (end === text.length) start = Math.max(0, end - size);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < first) start = space + 1;
  }
  // A match the cut would split is kept whole; otherwise the cut moves back to a space.
  const split = ranges.find(([s, e]) => s < end && e > end);
  if (split) end = split[1];
  else if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    const lastMatch = ranges.filter(([s]) => s < end).at(-1)?.[1] ?? first;
    if (space > Math.max(start, lastMatch, first)) end = space;
  }
  const lead = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  const shown = ranges
    .filter(([s, e]) => e > start && s < end)
    .map(([s, e]): Range => [Math.max(s, start) - start + lead.length, Math.min(e, end) - start + lead.length]);
  return { text: `${lead}${text.slice(start, end)}${tail}`, ranges: shown };
}

// How well a field matched, to pick the snippet: the phrase, then each word.
function fieldStrength(folded: Folded, query: Query): number {
  const words = query.words.reduce((sum, word) => sum + (occurrences(folded.text, word).length ? 2 : 0), 0);
  return words + (query.words.length > 1 && occurrences(folded.text, query.phrase).length ? 3 : 0);
}

// The snippet comes from the field that matched best, leaving out the one
// shown as the title, around the phrase if it is there; when only the title
// matched, it is the start of what follows it, for context.
function snippetOf(item: Item, matched: Match, query: Query): SearchSnippet | undefined {
  let best = -1;
  let bestStrength = 0;
  item.fields.forEach((f, i) => {
    if (f.shown) return;
    const strength = fieldStrength(matched.folded[i], query);
    if (strength > bestStrength) {
      best = i;
      bestStrength = strength;
    }
  });
  if (best === -1) {
    const next = item.fields.find((f) => !f.shown);
    if (!next) return undefined;
    return { where: next.where, ...snippetAround(next.text, []) };
  }
  const f = item.fields[best];
  const folded = matched.folded[best];
  const phrase = query.words.length > 1 ? folded.text.indexOf(query.phrase) : -1;
  const focus = phrase === -1 ? undefined : original(folded, [phrase, phrase + query.phrase.length])[0];
  return { where: f.where, ...snippetAround(f.text, rangesIn(folded, query), focus) };
}

// ---- search -----------------------------------------------------------------

function closureOf(board: Board, card: Item['card']): Closure | null {
  if (!card) return null;
  return 'decision' in card ? decisionClosure(card.decision) : taskClosure(board, card.task);
}

// Searches the boards given: the one named by boardId (an earlier id works
// too), or all of them with allBoards. Best matches first, then the latest.
export function searchBoards(boards: Iterable<Board>, query: string, options: SearchOptions = {}): SearchResponse {
  const parsed = readQuery(query);
  if (!parsed) return { results: [], total: 0 };
  const kinds = new Set(options.kinds?.length ? options.kinds : SEARCH_KINDS);
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const searched = [...boards].filter(
    (board) => options.allBoards || (options.boardId !== undefined && (board.id === options.boardId || board.aliases?.includes(options.boardId))),
  );

  const results: SearchResult[] = [];
  for (const board of searched) {
    const closures = new Map<string, Closure | null>(); // per card, worked out once
    const closed = (card: Item['card']) => {
      if (!card) return null;
      const id = 'decision' in card ? card.decision.id : card.task.id;
      if (!closures.has(id)) closures.set(id, closureOf(board, card));
      return closures.get(id)!;
    };
    for (const item of itemsOf(board, kinds)) {
      const matched = match(item, parsed);
      if (!matched) continue;
      const closure = closed(item.card);
      if (options.openOnly && closure) continue;
      const titleIndex = item.fields.findIndex((f) => f.shown);
      results.push({
        kind: item.kind,
        boardId: board.id,
        boardTitle: board.title,
        boardArchived: Boolean(board.archived),
        ref: item.ref,
        title: item.title,
        titleRanges: titleIndex === -1 ? [] : rangesIn(matched.folded[titleIndex], parsed),
        status: item.card && ('decision' in item.card ? item.card.decision.status : item.card.task.status),
        closed: closure?.kind,
        snippet: snippetOf(item, matched, parsed),
        target: item.target,
        at: item.at,
        score: matched.score,
      });
    }
  }
  results.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  return { results: results.slice(0, limit), total: results.length };
}

// The decisions on a board that a search of decisions finds, all of them and
// in board order: the Decisions tab filters its table with it, so it finds
// what the search palette does. Null for a query too short to search with.
export function decisionsMatching(board: Board, query: string): Set<string> | null {
  const parsed = readQuery(query);
  if (!parsed) return null;
  return new Set(board.decisions.filter((d) => match(decisionItem(board, d), parsed)).map((d) => d.id));
}

// ---- similar wording ----------------------------------------------------------
// How closely the other decisions on a board are worded like one, for its
// "Could affect" list (affects.ts). Its key words, from its question and its
// options, are found in each other decision the way a search finds them: at
// the start of a word, whatever the case and accents. One found in the other's
// question counts 2, one found only elsewhere on it (context, options, answer)
// counts 1. A word found in most of a board's decisions tells none of them
// apart, so on a board of six others or more it doesn't count.

// Words that say nothing of what a question is about.
const COMMON = new Set(
  (
    'the and for are but not you all any can had her was one our out has his how its may new now own say she too use way who why yes did get got let ' +
    'put see set via per etc what which when where whom whose with this that these those there their them they then than from into onto over under ' +
    'about after before should would could shall will does done have having been being were more most some such each every other only also just very ' +
    'much many make made need want first next last still even both either neither whether while within without your ours here well like keep take ' +
    'used using go going instead rather between same different option options decision decisions question'
  ).split(' '),
);

// A plural's last s goes, so "licences" finds "licence" as well as "licences".
const stem = (word: string) => (word.length >= 5 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

// The words a text is about: folded, of three letters or more, without the common ones.
export function keyWords(text: string): string[] {
  const words = foldText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((word) => word.length >= 3 && !COMMON.has(word)).map(stem);
  return [...new Set(kept.filter((word) => !COMMON.has(word)))];
}

const COMMON_AMONG = 6; // others on the board before a word can be too common to count

// Each other decision on the board worded like this one, with how closely: the
// sum of what its key words count there. Those that share none are left out.
export function similarDecisions(board: Board, decision: Decision): Map<string, number> {
  const words = keyWords([decision.question, ...decision.options.map((o) => o.label)].join(' '));
  const scores = new Map<string, number>();
  if (words.length === 0) return scores;
  const others = board.decisions.filter((d) => d.id !== decision.id);
  const counts = others.map((other) => {
    const fields = decisionItem(board, other).fields.map((f) => ({ text: fold(f.text).text, question: f.weight === 'title' }));
    return words.map((word) => {
      let count = 0;
      for (const f of fields) if (occurrences(f.text, word).length) count = Math.max(count, f.question ? 2 : 1);
      return count;
    });
  });
  const tooCommon = words.map((_, i) => others.length >= COMMON_AMONG && counts.filter((c) => c[i] > 0).length > others.length / 2);
  others.forEach((other, n) => {
    const score = counts[n].reduce((sum, count, i) => sum + (tooCommon[i] ? 0 : count), 0);
    if (score > 0) scores.set(other.id, score);
  });
  return scores;
}

// ---- for agents ---------------------------------------------------------------

// One line per result, with the ids to follow up with get_decision, get_task
// or get_block.
function resultLine(result: SearchResult, allBoards: boolean): string {
  const { kind, target, snippet } = result;
  const status = result.status && (target.taskId ? TASK_STATUS_WORDS[result.status as TaskStatus] : result.status);
  const own = kind === 'decision' || kind === 'task';
  const card = `${result.ref} ${clip(result.title, own ? 90 : 60)}${status ? ` (${status})` : ''}`;
  const ids = [
    target.blockId && `block_id: ${target.blockId}`,
    target.decisionId && `decision_id: ${target.decisionId}`,
    target.taskId && `task_id: ${target.taskId}`,
    target.pinId && `pin_id: ${target.pinId}`,
  ].filter(Boolean);
  const quote = snippet ? `: "${snippet.text}"` : '';
  // A decision or task is its own line; anything else says what it is (its
  // where: Comment by Sam, Finding, Note "Plan") and which card it is on.
  let what: string;
  if (own) what = `${card} [${ids.join(', ')}]${snippet?.where ? ` · ${snippet.where}` : ''}`;
  else if (target.canvas === 'board') {
    const block = kind === 'block' && result.title !== snippet?.where ? `${snippet?.where ?? 'Block'} "${clip(result.title, 50)}"` : result.title;
    what = kind === 'block' ? `${block} on the board context` : `${snippet?.where} on a pin in ${block}, board context`;
    what += ` [${ids.join(', ')}]`;
  } else what = `${snippet?.where ?? kind} on ${card} [${ids.join(', ')}]`;
  const board = allBoards ? ` (board "${result.boardTitle}" [board_id: ${result.boardId}]${result.boardArchived ? ', archived' : ''})` : '';
  return `- ${what}${board}${quote}`;
}

export function searchDigest(
  response: SearchResponse,
  query: string,
  scope: { boardTitle?: string; allBoards?: boolean; openOnly?: boolean },
): string {
  if (!readQuery(query)) return `Search with a word of at least ${MIN_QUERY} characters.`;
  const where = scope.allBoards ? 'across all boards' : `on ${scope.boardTitle ?? 'this board'}`;
  const closed = scope.openOnly ? 'open cards only' : 'closed cards included';
  const { results, total } = response;
  if (total === 0) return `Nothing found for "${query.trim()}" ${where} (${closed}).`;
  const shown = results.length < total ? `the best ${results.length} of ${total}` : `${total}`;
  const head = `Found ${shown} for "${query.trim()}" ${where} (${closed}). Read one with get_decision, get_task or get_block.`;
  return [head, ...results.map((r) => resultLine(r, Boolean(scope.allBoards)))].join('\n');
}

// The boards a store holds, as a search reads them.
export interface BoardSource {
  listBoards(): { id: string }[];
  getBoard(boardId: string): Board;
}

// A search through a store: the board asked for (by any of its ids), or all.
export function searchStore(store: BoardSource, query: string, options: SearchOptions): SearchResponse {
  if (options.allBoards) return searchBoards(store.listBoards().map((b) => store.getBoard(b.id)), query, options);
  if (!options.boardId) throw new Error('Pass a board id, or search all boards.');
  const board = store.getBoard(options.boardId);
  return searchBoards([board], query, { ...options, boardId: board.id });
}
