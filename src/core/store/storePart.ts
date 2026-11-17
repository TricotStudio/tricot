// A part of the store: what a piece of Tricot besides the core gives the Store, as one object.
//
// The Store is the core's, and it is built from parts. A part's is the first: its
// decisions and tasks are rows the store reads and writes (entity lists, entityLists.ts), the canvases those cards own
// (owners, below) and the kinds of card the canvas asks for (cardKinds.ts). A Store takes them together,
// `new Store(dir, { parts })`, and composes them in order: a name, list, row kind, owner or kind of card that two parts
// both have is refused, naming the part that came second. A Store given no parts is a canvas alone, as `parts: []` is.
//
// A part gives thirteen things today, each optional:
// - `lists`: the lists of cards whose rows the store reads and writes;
// - `owners`: the owners of canvases, the prefix of `decision:<id>`, which a canvas is found by (`locate`);
// - `modules`: what the part's kinds of card work over, built by the Store from its own modules (`CoreModules`) once, and
//   handed to the part's `cards`; a part without it hands its `cards` the Store's own modules;
// - `cards`: the kinds of card a pin can become and whose discussion a comment goes to;
// - `data`: the part's own data version and migrations (dataParts.ts), which the Store hands to the database when it
//   opens it, so each Store has the data parts of its own parts and no other;
// - `tables`: the tables the part keeps keyed by board, which the Store's writer builds once for each connection
//   and asks to remove a board's rows when the board is deleted;
// - `subjects`: the kinds of thing events are about, each the generated column of the events table that holds its id
// and, to write one, the list its rows are in and the agent an event about it is for by default: a query
//   names one as `<name>Id`, a record in its `about`, and a Store refuses a name no part registered;
// - `activity`: what makes an event count towards a board's activity beyond the latest of each actor, a condition over
//   the events table's columns;
// - `reading`: how agents read the part's cards, which the Store sets for the process (cardReading.ts);
// - `boardCards`: what each of the part's kinds of card says of itself to a reader that has only a board (core/cards.ts),
//   which the Store sets for the process, as it does the reading;
// - `header`: the keys the part adds to the header of a board a Store makes (store/boards.ts), by position;
// - `activityStart`: the keys the part's activity notes keep in a board's activity, as they start;
// - `summary`: the keys the part adds to each board's entry in the list of boards (store/boards.ts listBoards).
// A part whose data the file holds in a version newer than the part knows is off for that Store (`without`): its lists,
// owners, kinds of card, board cards, tables, event subjects, activity rules and header keys are not registered, so its rows are foreign and left as they are. A Store whose parts
// give no table leaves the rows of a deleted board in every table that is not registered, as the file holds them.

import type { BoardCardKind } from '../cards';
import type { CardReading } from '../cardReading';
import type { Assets } from './assets';
import type { Blocks } from './blocks';
import type { CardKind } from './cardKinds';
import { checkParts, type DataPart } from './dataParts';
import { EntityLists, type EntityList } from './entityLists';
import { EventRegistry, type ActivityRule, type EventSubject } from './eventTables';
import type { CanvasRef, Located } from './inputs';
import type { People } from './people';
import type { BoardRepository } from './repository';
import type { Database } from './sqlite';
import type { Board, Canvas } from '../types';

// An owner of canvases: a kind of card that has a canvas of its own. A canvas is named by it three ways: the owner of
// its rows in `items` (`decision:<id>`), a CanvasRef's `<owner>Id` (`decisionId`) and the key of a Located (`decision`).
export interface CanvasOwner {
  owner: string; // `decision`: no colon
  list: string; // the list of the board whose cards own those canvases: `decisions`
  // Whether a ref that names the card and a board must name the board it is on: `locate` refuses it when it does not.
  // A task's never did.
  checksBoard?: boolean;
  // How a card of this owner is written before its number (`#` for a decision, `T` for a task), which the store says a
  // deleted card by (deletedCards.ts). An owner with none is a card the store cannot name once it is deleted.
  mark?: string;
  // Whether its cards hold the id of the board they are on (`boardId`), which renaming the board keeps right.
  holdsBoardId?: boolean;
  // The kinds of block only a canvas of this owner takes (`comparison`), each with the words that refuse it on another
  // canvas. A block kind that says `cardOnly` is taken by no canvas when no owner lists it.
  takes?: Readonly<Record<string, string>>;
  // The words that refuse pinning a block to an option on a canvas whose card has none (a part's cards that have options).
  noOptions?: string;
}

// What an owner's card gives the canvas: its id, its canvas, and when it last changed.
export interface CanvasCard {
  id: string;
  canvas: Canvas;
  updatedAt?: string;
}

// The keys a part adds to the header of a board a Store makes (store/boards.ts createBoard), by where they go: the header
// is written in the core's order (`id`, `title`, `goal`, `folder`, `createdBy`, `createdAt`, `updatedAt`, `seq`, `canvas`),
// and the text a board is stored as keeps the order, so a part says which of the core's keys its own follow. A function,
// so that a board never shares a value (a list) with another. A key a part adds twice, or one of the core's, is refused.
export interface NewBoardHeader {
  afterSeq?: () => Record<string, unknown>;
  afterCanvas?: () => Record<string, unknown>;
}

// The keys of a board's header the core writes itself.
const CORE_HEADER_KEYS: ReadonlySet<string> = new Set(['id', 'title', 'goal', 'folder', 'createdBy', 'createdAt', 'updatedAt', 'seq', 'canvas', 'activity']);

// A table a part keeps keyed by board, built over the database when a connection opens. The table is made by a
// migration (the part's own, or core's for the dismissals), never by `build`. `removeBoard` takes away what the table
// holds of a board that is deleted for good: the caller wraps it in the transaction that removes the board.
export interface BoardTable {
  removeBoard(key: string): void;
}

// What a part gives of such a table: its name, which no other part's table has, and how to build it.
export interface StoreTable<T extends BoardTable = BoardTable> {
  name: string;
  build(db: Database): T;
}

// The Store's own modules that a part builds what its cards work over from (`StorePart.modules`), and the ones a part
// with no builder hands its cards: the repository they all work over, the pictures and blocks, and the people.
export interface CoreModules {
  repo: BoardRepository;
  assets: Assets;
  blocks: Blocks;
  people: People;
}

// What a part gives a Store. `Modules` is what the part's kinds of card work over: the Store's own (`CoreModules`) unless
// the part builds its own (`modules`, as a part may).
export interface StorePart<Modules = never> {
  name: string;
  lists?: readonly EntityList[];
  owners?: readonly CanvasOwner[];
  // Builds what `cards` works over, once for a Store, from the Store's modules; it makes the `Modules` of `cards`, typed
  // `object` so that parts with different modules go in one list (`StorePart<never>`).
  modules?: (core: CoreModules) => object;
  cards?: (modules: Modules) => CardKind[];
  // The part's own data version and migrations. The part is switched off while the file holds a newer version of it.
  data?: DataPart;
  // The tables the part keeps keyed by board, in the order they are built and asked to remove a board.
  tables?: readonly StoreTable[];
  // The kinds of thing events are about besides the core's `item`: a name, which no other part's subject has, its column,
  // and what writing one needs (the list its rows are in, the agent an event about it is for).
  subjects?: readonly EventSubject[];
  // What makes an event count towards a board's activity (BoardActivity), besides the latest of each actor.
  activity?: readonly ActivityRule[];
  // How agents read the part's cards: who a backlog card is for besides those @-mentioned on it, and what an event about
  // one of its tasks means to an agent. One part gives it: the Store sets it for the process when it is built.
  reading?: CardReading;
  // What the part's kinds of card say of themselves to a reader that has only a board: one per kind of card the part keeps a
  // list of, named as its owner is. The Store sets them for the process (core/cards.ts).
  boardCards?: readonly BoardCardKind[];
  // The keys the part adds to a new board's header, by position (NewBoardHeader).
  header?: NewBoardHeader;
  // The keys its activity rules' notes keep in a board's activity, and what they start as (a part's: `done` and
  // `reviewSentAt`, empty), so the activity of a new board, and of one built from its log, has them.
  activityStart?: () => Record<string, unknown>;
  // What the part says of a board in the list of boards, beyond the core's id, title, goal, archived and updatedAt: its keys
  // are added to the entry (a part's counts of its decisions).
  summary?: (board: Board) => Record<string, unknown>;
  // The name of the agent tool that finishes a person's sync of the board context, which the store's refusals send an agent
  // to; with none, they say it in plain words. One part gives it.
  syncTool?: string;
}

// The owners the Store knows, in the order the parts gave them.
export class CanvasOwners {
  constructor(readonly registered: readonly CanvasOwner[] = []) {}

  find(owner: string): CanvasOwner | undefined {
    return this.registered.find((entry) => entry.owner === owner);
  }

  // The owner whose canvases take this kind of block, when a block kind is only for a card's canvas.
  taking(blockType: string): CanvasOwner | undefined {
    return this.registered.find((owner) => owner.takes?.[blockType] !== undefined);
  }

  // The words that refuse pinning a block to an option where there are none, from the owner of the cards that have them.
  noOptions(): string | undefined {
    return this.registered.find((owner) => owner.noOptions !== undefined)?.noOptions;
  }

  // The registered owner a ref names, with the card's id.
  named(ref: CanvasRef): { owner: CanvasOwner; id: string } | undefined {
    const keyed = ref as Record<string, string | undefined>;
    for (const owner of this.registered) {
      const id = keyed[`${owner.owner}Id`];
      if (id) return { owner, id };
    }
    return undefined;
  }

  // Every card a link names, by the `<owner>Id` keys it holds, in the order the owners were registered: what a pin or a pin's
  // target links to (`{ taskId }`). A link names one card, or none for a pin people comment on.
  links(link: object): { owner: CanvasOwner; id: string }[] {
    const keyed = link as Record<string, unknown>;
    return this.registered.flatMap((owner) => {
      const id = keyed[`${owner.owner}Id`];
      return typeof id === 'string' && id ? [{ owner, id }] : [];
    });
  }

  // The link that names this card, as it is stored: the owner's `<owner>Id` key and the card's id (`{ taskId: id }`).
  linkTo(owner: string, id: string): Record<string, string> {
    return { [`${owner}Id`]: id };
  }
}

// The key of a Located that is not an owner's card.
const NOT_OWNERS: ReadonlySet<string> = new Set(['board', 'canvas', 'page']);

// The card whose canvas a Located is, with the kind of owner it is: none for the board context and a Sketchbook page.
export function ownedCard(located: Located): { owner: string; card: CanvasCard } | undefined {
  for (const [owner, card] of Object.entries(located)) if (!NOT_OWNERS.has(owner) && card) return { owner, card: card as CanvasCard };
  return undefined;
}

// The owners of some lists, for a Store given lists alone (StoreOptions.lists): the owner `known` has for the list where it
// has one (the part the Store would have been made of), else a plain one.
export const ownersOfLists = (lists: readonly EntityList[], known: readonly CanvasOwner[] = []): CanvasOwner[] =>
  lists.map(({ list, owner }) => known.find((own) => own.owner === owner && own.list === list) ?? { owner, list });

// The parts a Store is built from (StoreOptions): the ones given, or `base` when none are: the part a Store means by
// "nothing said", with `lists` or `cards` replacing its half (so a canvas whose data still holds decisions and tasks is
// `cards: () => []`). Give parts, or lists and cards, not both. A Store means no part by default, a canvas alone, and the
// Store a part adds its methods to means its whole part, which has the lists, owners and kinds of card.
export function partsOf(
  { parts, cards, lists }: { parts?: readonly StorePart<never>[]; cards?: (modules: never) => CardKind[]; lists?: readonly EntityList[] },
  base?: StorePart<never>,
): readonly StorePart<never>[] {
  if (parts) {
    if (cards || lists) throw new Error('Give a Store its parts, or cards and lists, not both.');
    return parts;
  }
  if (!cards && !lists) return base ? [base] : [];
  const own = base ?? { name: 'options' };
  const owners = lists ? ownersOfLists(lists, own.owners) : own.owners;
  // The board cards of the owners that are left, as the kinds of card are those the lists have.
  const boardCards = own.boardCards?.filter((card) => owners?.some((owner) => owner.owner === card.kind && owner.list === card.list));
  return [{ ...own, lists: lists ?? own.lists, owners, cards: cards ?? own.cards, boardCards }];
}

// The parts composed: the registry of lists, the owners, the data parts, the tables and the kinds of card, in the order
// the parts gave them.
export interface ComposedParts<Modules> {
  readonly parts: readonly StorePart<Modules>[];
  readonly lists: EntityLists;
  readonly owners: CanvasOwners;
  // The data parts of the parts, which openData migrates and checks.
  readonly data: readonly DataPart[];
  // The tables the parts keep by board, which the writer builds and removes a deleted board from.
  readonly tables: readonly StoreTable[];
  // How events are asked about and what counts towards a board's activity, which the writer's event tables read.
  readonly events: EventRegistry;
  // How agents read the parts' cards, if a part gives a reading.
  readonly reading: CardReading | undefined;
  // What the parts' kinds of card say of themselves to a reader that has only a board, in the order the parts gave them.
  readonly boardCards: readonly BoardCardKind[];
  // The keys the parts add to a new board's header, the parts' in the order they were given at each place.
  readonly header: Required<NewBoardHeader>;
  // What the parts say of a board in the list of boards: each part's keys, in the order the parts were given.
  readonly summary: (board: Board) => Record<string, unknown>;
  // The tool that finishes a sync, if a part gives one.
  readonly syncTool: string | undefined;
  // The same parts without those whose data part is one of these names (the ones the file holds newer data of): what
  // the Store registers once it finds a part off.
  without(dataPartNames: readonly string[]): ComposedParts<Modules>;
  // The kinds of card, made over the Store's modules. Refuses a kind two parts both make.
  cardKinds(modules: Modules): CardKind[];
  // The same, each part's kinds made over the modules that part has (its own `modules`, else the Store's).
  cardKindsOver(modulesOf: (part: StorePart<Modules>) => Modules): CardKind[];
}

const refused = (part: string, what: string): Error => new Error(`The part "${part}" ${what}`);

export function composeParts<Modules>(parts: readonly StorePart<Modules>[]): ComposedParts<Modules> {
  const names = new Set<string>();
  const lists: EntityList[] = [];
  const owners: CanvasOwner[] = [];
  const ownedBy = new Map<string, string>();
  const data: DataPart[] = [];
  const dataOf = new Map<string, string>();
  const tables: StoreTable[] = [];
  const tableOf = new Map<string, string>();
  const subjects: EventSubject[] = [];
  const subjectOf = new Map<string, string>();
  const rules: ActivityRule[] = [];
  const ruleOf = new Map<string, string>();
  let reading: { part: string; of: CardReading } | undefined;
  const boardCards: BoardCardKind[] = [];
  const headerKeys = new Map<string, string>();
  const startKeys = new Map<string, string>();
  const summaries: ((board: Board) => Record<string, unknown>)[] = [];
  let syncTool: { part: string; name: string } | undefined;
  for (const part of parts) {
    if (!part.name) throw new Error('A part of the store needs a name.');
    if (names.has(part.name)) throw refused(part.name, 'is registered twice.');
    names.add(part.name);
    const own = part.lists ?? [];
    try {
      new EntityLists([...lists, ...own]);
    } catch (error) {
      throw refused(part.name, `cannot be added: ${(error as Error).message}`);
    }
    for (const entry of part.owners ?? []) {
      const taken = ownedBy.get(entry.owner);
      if (taken !== undefined) throw refused(part.name, `has the canvas owner "${entry.owner}", which the part "${taken}" has already.`);
      if (!own.some((list) => list.list === entry.list && list.owner === entry.owner)) {
        throw refused(part.name, `has the canvas owner "${entry.owner}" for the list "${entry.list}", which it does not register with that owner.`);
      }
      ownedBy.set(entry.owner, part.name);
      owners.push(entry);
    }
    for (const list of own) {
      if (!(part.owners ?? []).some((entry) => entry.owner === list.owner)) throw refused(part.name, `registers the list "${list.list}" with no canvas owner "${list.owner}".`);
    }
    lists.push(...own);
    if (part.data) {
      const taken = dataOf.get(part.data.name);
      if (taken !== undefined) throw refused(part.name, `has the data part "${part.data.name}", which the part "${taken}" has already.`);
      try {
        checkParts([part.data]);
      } catch (error) {
        throw refused(part.name, `has a data part that cannot be added: ${(error as Error).message}`);
      }
      dataOf.set(part.data.name, part.name);
      data.push(part.data);
    }
    for (const table of part.tables ?? []) {
      const taken = tableOf.get(table.name);
      if (taken !== undefined) throw refused(part.name, `has the table "${table.name}", which the part "${taken}" has already.`);
      tableOf.set(table.name, part.name);
      tables.push(table);
    }
    for (const subject of part.subjects ?? []) {
      const taken = subjectOf.get(subject.name) ?? (new EventRegistry().find(subject.name) ? 'the core' : undefined);
      if (taken !== undefined) throw refused(part.name, `has the event subject "${subject.name}", which ${taken === 'the core' ? taken : `the part "${taken}"`} has already.`);
      try {
        new EventRegistry([subject]);
      } catch (error) {
        throw refused(part.name, `has an event subject that cannot be added: ${(error as Error).message}`);
      }
      subjectOf.set(subject.name, part.name);
      subjects.push(subject);
    }
    for (const rule of part.activity ?? []) {
      const taken = ruleOf.get(rule.name);
      if (taken !== undefined) throw refused(part.name, `has the activity rule "${rule.name}", which the part "${taken}" has already.`);
      ruleOf.set(rule.name, part.name);
      rules.push(rule);
    }
    if (part.reading) {
      if (reading) throw refused(part.name, `has a reading of cards, which the part "${reading.part}" has already.`);
      reading = { part: part.name, of: part.reading };
    }
    for (const card of part.boardCards ?? []) {
      const owner = (part.owners ?? []).find((entry) => entry.owner === card.kind && entry.list === card.list);
      if (!owner) throw refused(part.name, `has the board card "${card.kind}" for the list "${card.list}", which it has no canvas owner of that name and list for.`);
      if (owner.mark !== undefined && owner.mark !== card.mark) throw refused(part.name, `writes the board card "${card.kind}" with "${card.mark}", where its canvas owner says "${owner.mark}".`);
      if (boardCards.some((made) => made.kind === card.kind)) throw refused(part.name, `has the board card "${card.kind}" twice.`);
      boardCards.push(card);
    }
    for (const key of Object.keys({ ...part.header?.afterSeq?.(), ...part.header?.afterCanvas?.() })) {
      const taken = headerKeys.get(key) ?? (CORE_HEADER_KEYS.has(key) ? 'the core' : undefined);
      if (taken !== undefined) throw refused(part.name, `has the header key "${key}", which ${taken === 'the core' ? taken : `the part "${taken}"`} has already.`);
      headerKeys.set(key, part.name);
    }
    for (const key of Object.keys(part.activityStart?.() ?? {})) {
      const taken = startKeys.get(key) ?? (key === 'actors' ? 'the core' : undefined);
      if (taken !== undefined) throw refused(part.name, `starts the activity key "${key}", which ${taken === 'the core' ? taken : `the part "${taken}"`} has already.`);
      startKeys.set(key, part.name);
    }
    if (part.summary) summaries.push(part.summary);
    if (part.syncTool !== undefined) {
      if (syncTool) throw refused(part.name, `has a tool that finishes a sync, which the part "${syncTool.part}" has already.`);
      syncTool = { part: part.name, name: part.syncTool };
    }
  }
  return {
    parts,
    lists: new EntityLists(lists),
    owners: new CanvasOwners(owners),
    data,
    tables,
    events: new EventRegistry(subjects, rules, () => Object.assign({}, ...parts.map((part) => part.activityStart?.()))),
    reading: reading?.of,
    boardCards,
    header: composeHeaders(parts.flatMap((part) => (part.header ? [part.header] : []))),
    summary: (board) => Object.assign({}, ...summaries.map((summary) => summary(board))),
    syncTool: syncTool?.name,
    without: (dataPartNames) => composeParts(parts.filter((part) => !part.data || !dataPartNames.includes(part.data.name))),
    cardKinds: (modules) => cardKindsOver(parts, () => modules),
    cardKindsOver: (modulesOf) => cardKindsOver(parts, modulesOf),
  };
}

// Header keys composed: each place has every header's keys there, in the order the headers were given.
export function composeHeaders(headers: readonly NewBoardHeader[]): Required<NewBoardHeader> {
  const merged = (place: keyof NewBoardHeader) => () => Object.assign({}, ...headers.map((header) => header[place]?.()));
  return { afterSeq: merged('afterSeq'), afterCanvas: merged('afterCanvas') };
}

function cardKindsOver<Modules>(parts: readonly StorePart<Modules>[], modulesOf: (part: StorePart<Modules>) => Modules): CardKind[] {
  const made = new Map<string, string>();
  const kinds: CardKind[] = [];
  for (const part of parts) {
    for (const kind of part.cards?.(modulesOf(part)) ?? []) {
      const taken = made.get(kind.id);
      if (taken !== undefined) throw refused(part.name, `makes a kind of card "${kind.id}", which the part "${taken}" makes already.`);
      made.set(kind.id, part.name);
      kinds.push(kind);
    }
  }
  return kinds;
}
