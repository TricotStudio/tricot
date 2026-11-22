// Search over what a board holds: its cards (a part's cards, as the part that keeps them says, searchCards.ts),
// comments, findings, canvas blocks and the messages of its threads, closed ones included, since finding past work is
// the point. People reach it from the search palette, agents from the search tool, which leaves the threads' messages
// out: an agent reads a thread with get_thread. It
// scans the boards in memory; an index (SQLite FTS5, say) can take its place
// behind searchBoards without changing what callers get back.

import { clip } from './format';
import { saying, type Told } from './words';
import { kindOf } from './blocks/registry';
import { plainMarkdown } from './markdown';
import { cardsOf, type BoardCard } from './cards';
import { pageName } from './scratchPad';
import type { CardKindName } from './pins';
import { refLabel } from './refKinds';
import { searchCardNamed, searchCardOf, searchOwners, standingOf, type CardStanding, type SearchField } from './searchCards';
import { inConversation } from './threadList';
import { shownTitle } from './threads';
import type { Block, Board, Canvas, Comment, ScratchPage } from './types';

// What a result is: a comment, a finding, a block or a thread's message, and a card of each kind a part registered
// (searchCards.ts), which the part adds by name (a part's kinds of card).
export interface SearchKinds {
  comment: true;
  finding: true;
  block: true;
  message: true;
}
export type SearchKind = keyof SearchKinds;

// The kinds the core itself finds for an agent, whatever cards a board holds: its search tool offers these.
export const CORE_SEARCH_KINDS = ['comment', 'finding', 'block'] as const satisfies readonly SearchKind[];

// What a person's search finds besides: a thread's messages.
export const PEOPLE_SEARCH_KINDS = [...CORE_SEARCH_KINDS, 'message'] as const satisfies readonly SearchKind[];

// Every kind a person's search can look for here: the registered kinds of card, then the core's.
export const searchKinds = (): string[] => [...searchOwners(), ...PEOPLE_SEARCH_KINDS];

// The kinds a search looks for, which a part's kinds of card ask about by name (searchCards.ts).
export type KindsSearched = Pick<ReadonlySet<string>, 'has'>;

export interface SearchOptions {
  boardId?: string; // the board searched, unless allBoards
  allBoards?: boolean; // every board, archived ones included
  kinds?: SearchKind[]; // none: every kind
  openOnly?: boolean; // leave out closed cards, and what is on them
  limit?: number; // 50 by default
  // What a server tells of: the cards, with what is on their canvases and in their discussions, and the board
  // context's blocks. All of it unless said (the page's search); an agent's server says what its tool groups offer (core/words.ts).
  cards?: boolean;
  context?: boolean;
  // The threads' messages: found unless said, as the page's search finds them. An agent's search says false, as an
  // agent reads a thread with get_thread.
  threads?: boolean;
}

// A stretch of a text that matched, as offsets: [start, end).
export type Range = [number, number];

export interface SearchSnippet {
  where?: string; // the part of the item it comes from: Rationale, Option b, Comment by Sam, Note "Plan"
  text: string; // about 140 characters around the first match, with … where it was cut
  ranges: Range[];
}

// What to open: the card, and for a block the canvas it is on, or for a message its thread.
export interface SearchTarget {
  canvas?: 'board' | 'page' | CardKindName; // for a block, or a comment in a thread on one: the card's kind
  pageId?: string; // a Sketchbook page the block is on
  blockId?: string;
  commentId?: string;
  pinId?: string; // the thread of a comment on the board context or a Sketchbook page
  threadId?: string; // the thread a message is in
  messageId?: string;
  conversation?: true; // that thread is the board's conversation's (threadList.ts inConversation), which opens there
}

export interface SearchResult {
  kind: SearchKind;
  boardId: string;
  boardTitle: string;
  boardArchived: boolean;
  ref: string; // #12, T5, or Board Context: the card the item is, or is on
  title: string; // that card's question or title; on the board context, the block's
  titleRanges: Range[]; // matches in the title, when the title is the item's own
  status?: string; // the card's, in the words of its kind (a decision's `open`, a task's `in_progress`)
  closed?: string; // how a closed card closed: done, dropped, decided or retired (searchCards.ts)
  replacedBy?: number; // a decision whose answer a later one replaced: that one's number (searchCards.ts)
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

export interface Folded {
  text: string;
  from: number[] | null; // per folded character, its original start; null when nothing moved
  to: number[] | null; // …and end
}

const MARKS = /\p{M}/u;
const JOINERS = /[-_]/g;

export function foldText(text: string): string {
  return text.normalize('NFD').replace(new RegExp(MARKS, 'gu'), '').toLowerCase().replace(JOINERS, ' ');
}

export function fold(text: string): Folded {
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

export interface Query {
  words: string[];
  phrase: string; // the words in order, for the exact-phrase bonus
}

// Folded words of two characters or more; quotes around words are dropped.
export function readQuery(query: string): Query | null {
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
export function occurrences(text: string, word: string): Range[] {
  return find(text, word).starts;
}

// ---- items ------------------------------------------------------------------

type Weight = SearchField['weight'];
type Field = SearchField;

export interface Item {
  kind: SearchKind;
  board: Board;
  ref: string;
  title: string;
  fields: Field[];
  card?: BoardCard; // the card it is, or is on
  target: SearchTarget;
  at: string;
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

// A field of the words a search looks in: none for a text with nothing in it.
export function field(text: string | undefined, weight: Weight, where?: string): Field[] {
  const shown = flat(text ?? '');
  return shown ? [{ text: shown, weight, where }] : [];
}

// The item's own title, shown as the result's.
export function titleField(text: string): Field[] {
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
// context and a Sketchbook page the block is what a result is called; on a
// card's canvas the card is, and the block says where on it.
function* canvasItems(board: Board, canvas: Canvas, owner: Owner | undefined, kinds: KindsSearched, page?: ScratchPage): Generator<Item> {
  for (const block of canvas.blocks) {
    const located: Owner = {
      ref: owner?.ref ?? (page ? pageName(page) : 'Board Context'),
      title: owner?.title ?? block.title ?? blockWord(block),
      card: owner?.card,
      target: { ...(owner?.target ?? (page ? { canvas: 'page', pageId: page.id } : { canvas: 'board' })), blockId: block.id },
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

// What a card of a kind found as another kind's own is found by: the card's `<kind>Id`, which a result's target opens it by.
const cardTarget = (card: BoardCard): SearchTarget => ({ [`${card.kind.kind}Id`]: card.id }) as SearchTarget;

// Everything a board holds that a search can find, card by card. A card is found as its kind says (searchCards.ts), by
// its discussion and by what is on its canvas; what a kind says of itself is its own result, and what else it holds
// (a decision's findings) is each one of its kind.
function* itemsOf(board: Board, kinds: KindsSearched): Generator<Item> {
  yield* canvasItems(board, board.canvas, undefined, kinds);
  for (const card of cardsOf(board)) {
    const kind = card.kind.kind as SearchKind;
    const says = searchCardNamed(kind);
    const owner: Owner = { ref: refLabel(kind, card.number), title: card.title, card, target: cardTarget(card) };
    if (kinds.has(kind) && says?.item) yield { kind, board, ...owner, ...says.item(card.card) };
    if (kinds.has('comment')) for (const comment of card.comments) yield commentItem(board, comment, owner);
    for (const { kind: part, words } of says?.parts?.(card.card, kinds) ?? []) yield { kind: part as SearchKind, board, ...owner, ...words };
    yield* canvasItems(board, card.canvas, { ...owner, target: { canvas: kind as SearchTarget['canvas'], ...owner.target } }, kinds);
  }
  for (const page of board.pages ?? []) yield* canvasItems(board, page.canvas, undefined, kinds, page);
}

// What the threads say: each message, found by what it says. One in the board's conversation is called that, which it
// opens in; one in work is called by its thread. A coordinator's word that it sent an ask on is drawn as the card under
// the ask, not as a message, so it is left out.
function* threadItems(board: Board, kinds: KindsSearched): Generator<Item> {
  if (!kinds.has('message')) return;
  for (const thread of board.threads ?? []) {
    const conversation = inConversation(thread);
    const title = shownTitle(thread);
    for (const message of thread.messages) {
      if (message.sent) continue;
      yield {
        kind: 'message',
        board,
        ref: conversation ? 'Conversation' : 'Thread',
        title,
        fields: field(plainMarkdown(message.body), 'body', message.author.name),
        target: { threadId: thread.id, messageId: message.id, ...(conversation && { conversation: true as const }) },
        at: message.at,
      };
    }
  }
}

// ---- scoring ----------------------------------------------------------------

export interface Match {
  score: number;
  folded: Folded[]; // per field
}

// What a word scores in a field: in a title or question it beats the body.
const WORD_SCORE = { title: 10, body: 3 };

// Every word must start a word somewhere in the item. Each counts for where
// it scores best, and the words together as typed earn a bonus.
export function match(item: Pick<Item, 'fields'>, query: Query): Match | null {
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

// Searches the boards given: the one named by boardId (an earlier id works
// too), or all of them with allBoards. Best matches first, then the latest.
export function searchBoards(boards: Iterable<Board>, query: string, options: SearchOptions = {}): SearchResponse {
  const parsed = readQuery(query);
  if (!parsed) return { results: [], total: 0 };
  // None asked for: every kind, those the registered kinds of card add to the core's included.
  const asked = options.kinds?.length ? new Set<string>(options.kinds) : undefined;
  const kinds: KindsSearched = { has: (kind) => !asked || asked.has(kind) };
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const searched = [...boards].filter(
    (board) => options.allBoards || (options.boardId !== undefined && (board.id === options.boardId || board.aliases?.includes(options.boardId))),
  );

  const results: SearchResult[] = [];
  for (const board of searched) {
    const standings = new Map<string, CardStanding>(); // per card, worked out once
    const standing = (card: Item['card']): CardStanding => {
      if (!card) return {};
      if (!standings.has(card.id)) standings.set(card.id, standingOf(board, { [card.kind.kind]: card.card }));
      return standings.get(card.id)!;
    };
    for (const item of [...itemsOf(board, kinds), ...(options.threads === false ? [] : threadItems(board, kinds))]) {
      if ((item.card && options.cards === false) || (item.target.canvas === 'board' && options.context === false)) continue;
      const matched = match(item, parsed);
      if (!matched) continue;
      const { closed, replacedBy } = standing(item.card);
      if (options.openOnly && closed) continue;
      const titleIndex = item.fields.findIndex((f) => f.shown);
      results.push({
        kind: item.kind,
        boardId: board.id,
        boardTitle: board.title,
        boardArchived: Boolean(board.archived),
        ref: item.ref,
        title: item.title,
        titleRanges: titleIndex === -1 ? [] : rangesIn(matched.folded[titleIndex], parsed),
        status: item.card?.status,
        closed,
        ...(replacedBy !== undefined && { replacedBy }),
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

// ---- for agents ---------------------------------------------------------------

// One line per result, with the ids to follow up with get_decision, get_task
// or get_block. A card whose answer was replaced says by which.
function resultLine(result: SearchResult, allBoards: boolean): string {
  const { kind, target, snippet } = result;
  const replaced = result.replacedBy ? `, replaced by #${result.replacedBy}` : '';
  const says = searchCardOf(target);
  const status = result.status && (says?.statusWord ? says.statusWord(result.status) : `${result.status}${replaced}`);
  const own = searchCardNamed(kind) !== undefined;
  const card = `${result.ref} ${clip(result.title, own ? 90 : 60)}${status ? ` (${status})` : ''}`;
  const cardIds = searchOwners().flatMap((owner) => {
    const id = (target as Record<string, string | undefined>)[`${owner}Id`];
    return id ? [`${owner}_id: ${id}`] : [];
  });
  const ids = [target.blockId && `block_id: ${target.blockId}`, ...cardIds, target.pinId && `pin_id: ${target.pinId}`, target.pageId && `page_id: ${target.pageId}`].filter(Boolean);
  const quote = snippet ? `: "${snippet.text}"` : '';
  // A decision or task is its own line; anything else says what it is (its
  // where: Comment by Sam, Finding, Note "Plan") and which card it is on.
  let what: string;
  if (own) what = `${card} [${ids.join(', ')}]${snippet?.where ? ` · ${snippet.where}` : ''}`;
  else if (target.canvas === 'board' || target.canvas === 'page') {
    const block = kind === 'block' && result.title !== snippet?.where ? `${snippet?.where ?? 'Block'} "${clip(result.title, 50)}"` : result.title;
    const place = target.canvas === 'page' ? result.ref : 'the board context';
    what = kind === 'block' ? `${block} on ${place}` : `${snippet?.where} on a pin in ${block}, ${place.replace(/^the /, '')}`;
    what += ` [${ids.join(', ')}]`;
  } else what = `${snippet?.where ?? kind} on ${card} [${ids.join(', ')}]`;
  const board = allBoards ? ` (board "${result.boardTitle}" [board_id: ${result.boardId}]${result.boardArchived ? ', archived' : ''})` : '';
  return `- ${what}${board}${quote}`;
}

export function searchDigest(
  response: SearchResponse,
  query: string,
  scope: { boardTitle?: string; allBoards?: boolean; openOnly?: boolean },
  told?: Told,
): string {
  if (!readQuery(query)) return `Search with a word of at least ${MIN_QUERY} characters.`;
  const where = scope.allBoards ? 'across all boards' : `on ${scope.boardTitle ?? 'this board'}`;
  // Whether closed cards are searched is said where a group offers cards.
  const closed = told?.line('search.scope', { openOnly: String(Boolean(scope.openOnly)) }) ?? '';
  const { results, total } = response;
  if (total === 0) return `Nothing found for "${query.trim()}" ${where}${closed}.`;
  const shown = results.length < total ? `the best ${results.length} of ${total}` : `${total}`;
  const read = saying(told, 'search.read', [
    ['read-one', 'Read one with '],
    ['read', 'get_block'],
    ['end', '.'],
  ]);
  const head = `Found ${shown} for "${query.trim()}" ${where}${closed}. ${read}`;
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
