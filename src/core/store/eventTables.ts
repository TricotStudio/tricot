import { BoardError } from './errors';
import type { Database, Statement } from './sqlite';
import { emptyActivity, noteEvent, type ActivityNote } from '../activity';
import { NOT_NEWS } from '../notNews';
import { samePerson } from '../format';
import type { Actor, Board, BoardActivity, BoardEvent } from '../types';

// A board's event log: a row each in the events table (see migrations.ts),
// found by board and seq, and by what an event is about. Only what a board
// needs to know of it is in memory (BoardActivity).

// A kind of thing events are about, and the generated column of the events table that holds its id (migrations.ts).
// A query asks about one by its name and `Id`: the subject `decision` is `decisionId`. The core's own is `item`.
//
// A subject may also say where its things are kept and whose they are by default, for writing an event about one
// (BoardRepository.record): the entity list its rows live in, so a change that names one saves that row and no list is
// named in the core, and the agent an event about it is for when the caller says none.
export interface EventSubject {
  name: string; // `decision`: letters and digits
  column: string; // `decision_id`
  list?: string; // the list of the board its rows are in (entityLists.ts): `decisions`
  agent?: (board: Board, id: string) => string | undefined; // the one agent an event about it is for, if any: a task's assignee
}

// What an event is about, by subject name: the ids of the things it names. `item` is the core's own (a canvas block,
// group, link, pin, page, thread or request); the others are the subjects a part registered. Recording an event that
// names a subject no part registered is refused (EventRegistry.named).
export interface EventAbout {
  item?: string;
  [subject: string]: string | undefined;
}

// The read side of this is in core/cards.ts (`eventCards`, `eventCard`): which cards an event names, by the same subject names,
// for the readers that run on the page, which imports no module of the store.

// A subject an event names, with the id it names.
export interface NamedSubject {
  subject: EventSubject;
  id: string;
}

// What makes an event count towards a board's activity, beyond the latest of each actor: a condition over the columns
// of the events table. The events it picks are taken in oldest first (core/activity.ts noteEvent). `note` is what the
// rule's part makes of an event: how it changes the board's activity (the part's own keys of it). The Store hands every
// event to every rule's note, as it is logged and as the board loads, so a note ignores an event that is not its part's.
export interface ActivityRule {
  name: string;
  where: string;
  note?: ActivityNote;
}

const CORE_SUBJECTS: readonly EventSubject[] = [{ name: 'item', column: 'item_id' }];

// The subject names and columns end up in SQL, so they are checked where they are registered.
const NAME = /^[a-z][a-zA-Z0-9]*$/;
const COLUMN = /^[a-z][a-z0-9_]*$/;

// What a Store's parts gave of how events are read: the subjects a query can name, the core's `item` first, and the
// rules for activity (storePart.ts composes them).
export class EventRegistry {
  readonly subjects: readonly EventSubject[];
  private readonly notes: readonly ActivityNote[];

  // `start` is the keys the parts' notes keep in a board's activity, as they start (StorePart.activityStart).
  constructor(subjects: readonly EventSubject[] = [], readonly activity: readonly ActivityRule[] = [], private readonly start: () => Record<string, unknown> = () => ({})) {
    this.subjects = [...CORE_SUBJECTS, ...subjects];
    this.notes = activity.flatMap((rule) => (rule.note ? [rule.note] : []));
    const seen = new Set<string>();
    for (const { name, column } of this.subjects) {
      if (!NAME.test(name)) throw new Error(`"${name}" is not a name for what events are about.`);
      if (!COLUMN.test(column)) throw new Error(`"${column}" is not a column for the subject "${name}".`);
      if (seen.has(name)) throw new Error(`The subject "${name}" is there twice.`);
      seen.add(name);
    }
  }

  find(name: string): EventSubject | undefined {
    return this.subjects.find((subject) => subject.name === name);
  }

  // The activity of a board nothing has happened on: who acted, none yet, and the keys the parts' notes keep, as they start.
  emptyActivity(): BoardActivity {
    return Object.assign(emptyActivity(), this.start());
  }

  // Takes an event into a board's activity: who acted, and what each rule's note makes of it.
  noteEvent(activity: BoardActivity, event: BoardEvent): void {
    noteEvent(activity, event, this.notes);
  }

  // The subjects an event names, in the order `about` gives them. Refuses one this registry does not have.
  named(about: EventAbout): NamedSubject[] {
    const named: NamedSubject[] = [];
    for (const [name, id] of Object.entries(about)) {
      if (id === undefined) continue;
      const subject = this.find(name);
      if (!subject) throw new BoardError(`This Tricot keeps no events about a ${name}, so it cannot record one.`);
      named.push({ subject, id });
    }
    return named;
  }

  // What `about` says of the subjects this registry has, and nothing of the rest: for a change whose links come from
  // stored data (a pin's task or decision), which a Store that kept no such subject records as about the item alone.
  known(about: EventAbout): EventAbout {
    return Object.fromEntries(Object.entries(about).filter(([name]) => this.find(name)));
  }

  // The one agent an event about these subjects is for when its caller says none: what the first of them that has an
  // agent gives.
  agentFor(board: Board, named: readonly NamedSubject[]): string | undefined {
    for (const { subject, id } of named) {
      const agent = id ? subject.agent?.(board, id) : undefined;
      if (agent) return agent;
    }
    return undefined;
  }
}

// Which events to read. They come oldest first when `since` is given (catching
// up from a cursor) and newest first otherwise (history). A subject a part
// registered is asked about by its name and `Id` (`decisionId`); a Store refuses
// one it has not registered.
export interface EventQuery {
  since?: number; // events after this seq
  before?: number; // events before this seq
  limit?: number;
  itemId?: string;
  [subject: `${string}Id`]: string | undefined;
  types?: string[];
  // Whoever is reading, whose own events are left out. An agent catching up
  // also leaves out what is for another agent alone (BoardEvent.forAgent),
  // unless it @-mentions this one (as core/concerns.ts forReader).
  exclude?: Actor;
  byAgent?: string; // only what this agent did, as an agent's panel shows
  after?: string; // only events at or after this time (ISO), as its Usage section counts them
  unseenBy?: string; // what others changed that this person hasn't seen: not what isn't news (NOT_NEWS), nor their own doing
  order?: 'asc' | 'desc';
}

interface EventRow {
  body: string;
}

// Whether two names are one person (core/format.ts samePerson), for the database to ask.
const SAME_PERSON = 'same_person';

// The one agent an event is for, read from its body: few events have one, so it has no column.
const FOR_AGENT = "json_extract(body, '$.forAgent')";

export class EventTables {
  private readonly cache = new Map<string, Statement>();

  constructor(
    private readonly db: Database,
    private readonly registry: EventRegistry = new EventRegistry(),
  ) {
    db.function(SAME_PERSON, { deterministic: true }, (a, b) => (typeof a === 'string' && typeof b === 'string' && samePerson(a, b) ? 1 : 0));
  }

  private statement(sql: string): Statement {
    let statement = this.cache.get(sql);
    if (!statement) this.cache.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  // Idempotent, so an event written twice (a save that is checked, then done) is one.
  insert(board: string, event: BoardEvent): void {
    this.statement('INSERT OR IGNORE INTO events (board, seq, at, body) VALUES (?, ?, ?, ?)').run(board, event.seq, event.at, JSON.stringify(event));
  }

  // A board's whole log, for a board deleted for good.
  removeBoard(board: string): void {
    this.statement('DELETE FROM events WHERE board = ?').run(board);
  }

  private conditions(board: string, query: EventQuery): { where: string; params: (string | number)[] } {
    const where = ['board = ?'];
    const params: (string | number)[] = [board];
    const add = (condition: string, ...values: (string | number)[]) => {
      where.push(condition);
      params.push(...values);
    };
    if (query.since !== undefined) add('seq > ?', query.since);
    if (query.before !== undefined) add('seq < ?', query.before);
    for (const [key, id] of Object.entries(query)) {
      if (!key.endsWith('Id') || id === undefined) continue;
      const name = key.slice(0, -2);
      const subject = this.registry.find(name);
      if (!subject) throw new BoardError(`This Tricot keeps no events about a ${name}, so it cannot read them by ${key}.`);
      add(`${subject.column} = ?`, id as string);
    }
    if (query.types?.length) add(`type IN (${query.types.map(() => '?').join(', ')})`, ...query.types);
    if (query.exclude) add('NOT (actor_kind = ? AND actor_name = ?)', query.exclude.kind, query.exclude.name);
    if (query.exclude?.kind === 'agent') {
      const mentioned = `EXISTS (SELECT 1 FROM json_each(body, '$.mentions') WHERE ${SAME_PERSON}(value, ?))`;
      add(`(${FOR_AGENT} IS NULL OR ${SAME_PERSON}(${FOR_AGENT}, ?) OR ${mentioned})`, query.exclude.name, query.exclude.name);
    }
    if (query.byAgent !== undefined) add(`actor_kind = 'agent' AND ${SAME_PERSON}(actor_name, ?)`, query.byAgent);
    if (query.after !== undefined) add('at >= ?', query.after);
    if (query.unseenBy !== undefined) {
      const news = `type NOT IN (${NOT_NEWS.map(() => '?').join(', ')})`;
      add(`${news} AND NOT (actor_kind = 'human' AND ${SAME_PERSON}(actor_name, ?))`, ...NOT_NEWS, query.unseenBy);
    }
    return { where: where.join(' AND '), params };
  }

  query(board: string, query: EventQuery): BoardEvent[] {
    const { where, params } = this.conditions(board, query);
    const order = query.order ?? (query.since !== undefined ? 'asc' : 'desc');
    const limit = query.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.floor(query.limit))}`;
    const rows = this.statement(`SELECT body FROM events WHERE ${where} ORDER BY seq ${order === 'asc' ? 'ASC' : 'DESC'}${limit}`).all(...params) as unknown as EventRow[];
    return rows.map((row) => JSON.parse(row.body) as BoardEvent);
  }

  count(board: string, query: EventQuery): number {
    const { where, params } = this.conditions(board, query);
    const row = this.statement(`SELECT COUNT(*) AS n FROM events WHERE ${where}`).get(...params) as { n: number };
    return row.n;
  }

  // What a board's activity is, from its log: the latest event of each actor,
  // and the events the parts' rules pick (an event that moved a task, for a part's), taken in as they happened.
  activity(board: string): BoardActivity {
    const activity = this.registry.emptyActivity();
    if (this.registry.activity.length) {
      const picked = this.registry.activity.map((rule) => `(${rule.where})`).join(' OR ');
      const moves = this.statement(`SELECT body FROM events WHERE board = ? AND (${picked}) ORDER BY seq`).all(board) as unknown as EventRow[];
      for (const row of moves) this.registry.noteEvent(activity, JSON.parse(row.body) as BoardEvent);
    }
    const latest = this.statement(
      `SELECT body FROM events WHERE board = ? AND seq IN
         (SELECT MAX(seq) FROM events WHERE board = ? GROUP BY actor_kind, actor_name) ORDER BY seq`,
    ).all(board, board) as unknown as EventRow[];
    for (const row of latest) this.registry.noteEvent(activity, JSON.parse(row.body) as BoardEvent);
    return activity;
  }
}
