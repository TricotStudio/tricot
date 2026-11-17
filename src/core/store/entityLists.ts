// The registry of entity lists: which of a board's lists have a row for each item and a canvas of rows beside it.
//
// A board lies in the database as a header and rows of the generic `items` table (see boardRows.ts). Most of its parts
// are the core's: Sketchbook pages, threads, requests, deletions, and the blocks, groups, links and pins of a canvas.
// A part besides the core (a part's cards) keeps cards the same way: a list of the board, a kind of row
// for each card, and an owner (`decision:<id>`) that the rows of its canvas name. The store reads and writes those
// lists only if they are registered here, and every other row of `items` is foreign to it: it keeps the row's owner,
// kind and id so the id stays taken, and never parses, compares or rewrites the row (the data a Tricot stores,
// CONTRIBUTING.md).

// One registered list.
export interface EntityList {
  list: string; // what the Board calls it: `decisions`
  kind: string; // the kind of its rows in `items`: `decision`
  owner: string; // what the rows of its cards' canvases name as their owner, before the card's id: `decision`
  // Whether a board always holds the list, empty when it has no card and its header says nothing of it. A board that a Store
  // without the list's part made has no such key, and the part's readers expect one (a part's `decisions` and `tasks`).
  always?: boolean;
}

// The lists of the core's that hold no canvas: each item is one row.
export const PLAIN_LISTS = [
  ['threads', 'thread'],
  ['requests', 'request'],
  ['deleted', 'deletion'],
] as const;

// What a canvas holds, and the kind of row each is.
export const CANVAS_LISTS = [
  ['blocks', 'block'],
  ['groups', 'group'],
  ['links', 'link'],
  ['pins', 'pin'],
] as const;

// Sketchbook pages: the core's one list with a canvas on each item.
export const PAGES: EntityList = { list: 'pages', kind: 'page', owner: 'page' };

// The board's own canvas, which is the owner of its rows.
const BOARD_OWNER = 'board';

const CANVAS_KINDS: ReadonlySet<string> = new Set(CANVAS_LISTS.map(([, kind]) => kind));
const PLAIN_KINDS: ReadonlySet<string> = new Set(PLAIN_LISTS.map(([, kind]) => kind));

export class EntityLists {
  // What was registered, in order.
  readonly registered: readonly EntityList[];
  // The lists whose items have a canvas: those registered, then the pages.
  readonly entities: readonly EntityList[];
  // Every board list with rows of its own, in the order a board is joined: the entities', then the plain lists'.
  readonly names: readonly string[];
  private readonly rowKinds: ReadonlySet<string>;

  constructor(registered: readonly EntityList[] = []) {
    this.registered = registered;
    this.entities = [...registered, PAGES];
    this.names = [...this.entities.map((entity) => entity.list), ...PLAIN_LISTS.map(([list]) => list)];
    this.rowKinds = new Set([...this.entities.map((entity) => entity.kind), ...PLAIN_KINDS]);
    this.refuseClashes();
  }

  // Whether a Board list is registered, or is the pages.
  has(list: string): boolean {
    return this.entities.some((entity) => entity.list === list);
  }

  // Whether the rows of this kind are items with a canvas of their own: a registered list's cards, or the Sketchbook's pages.
  hasCanvas(kind: string): boolean {
    return this.entities.some((entity) => entity.kind === kind);
  }

  // The entity whose canvases hold the rows with this owner (`decision:<id>`); none for the board's own canvas.
  ownedBy(owner: string): EntityList | undefined {
    const at = owner.indexOf(':');
    if (at <= 0 || at === owner.length - 1) return undefined;
    const kind = owner.slice(0, at);
    return this.entities.find((entity) => entity.owner === kind);
  }

  // Whether the store reads and writes this row of `items`. A card's row has no owner; a canvas item's owner is the
  // board or a card or page of a registered list. Anything else is foreign to this store.
  owns(owner: string, kind: string): boolean {
    if (owner === '') return this.rowKinds.has(kind);
    return (owner === BOARD_OWNER || this.ownedBy(owner) !== undefined) && CANVAS_KINDS.has(kind);
  }

  // What a row is compared and replaced together with (BoardImage.plan): its canvas, or its list.
  scopeOf(owner: string, kind: string): string {
    if (owner) return `canvas:${owner}`;
    return this.entities.find((entity) => entity.kind === kind)?.list ?? PLAIN_LISTS.find(([, plain]) => plain === kind)?.[0] ?? kind;
  }

  // A registered list may not take a name the core's own lists have, or one another list has.
  private refuseClashes(): void {
    const taken = {
      list: new Set<string>([PAGES.list, ...CANVAS_LISTS.map(([list]) => list), ...PLAIN_LISTS.map(([list]) => list)]),
      kind: new Set<string>([PAGES.kind, ...CANVAS_KINDS, ...PLAIN_KINDS]),
      owner: new Set<string>([BOARD_OWNER, PAGES.owner]),
    };
    for (const entry of this.registered) {
      for (const field of ['list', 'kind', 'owner'] as const) {
        const value = entry[field];
        if (!value || (field === 'owner' && value.includes(':'))) throw new Error(`An entity list needs a ${field}, and an owner has no colon: ${JSON.stringify(entry)}.`);
        if (taken[field].has(value)) throw new Error(`The ${field} "${value}" of an entity list is already the core's, or another list's.`);
        taken[field].add(value);
      }
    }
  }
}
