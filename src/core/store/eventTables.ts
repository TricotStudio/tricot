import type { Database, Statement } from './sqlite';
import { emptyActivity, noteEvent } from '../activity';
import { NOT_NEWS } from '../attention';
import { samePerson } from '../format';
import type { Actor, BoardActivity, BoardEvent } from '../types';

// A board's event log: a row each in the events table (see migrations.ts),
// found by board and seq, and by what an event is about. Only what a board
// needs to know of it is in memory (BoardActivity).

// Which events to read. They come oldest first when `since` is given (catching
// up from a cursor) and newest first otherwise (history).
export interface EventQuery {
  since?: number; // events after this seq
  before?: number; // events before this seq
  limit?: number;
  decisionId?: string;
  taskId?: string;
  itemId?: string;
  types?: string[];
  // Whoever is reading, whose own events are left out. An agent catching up
  // also leaves out what is for another agent alone (BoardEvent.forAgent),
  // unless it @-mentions this one (as eventLog.ts forReader).
  exclude?: Actor;
  byAgent?: string; // only what this agent did, as an agent's panel shows
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

  constructor(private readonly db: Database) {
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
    if (query.decisionId !== undefined) add('decision_id = ?', query.decisionId);
    if (query.taskId !== undefined) add('task_id = ?', query.taskId);
    if (query.itemId !== undefined) add('item_id = ?', query.itemId);
    if (query.types?.length) add(`type IN (${query.types.map(() => '?').join(', ')})`, ...query.types);
    if (query.exclude) add('NOT (actor_kind = ? AND actor_name = ?)', query.exclude.kind, query.exclude.name);
    if (query.exclude?.kind === 'agent') {
      const mentioned = `EXISTS (SELECT 1 FROM json_each(body, '$.mentions') WHERE ${SAME_PERSON}(value, ?))`;
      add(`(${FOR_AGENT} IS NULL OR ${SAME_PERSON}(${FOR_AGENT}, ?) OR ${mentioned})`, query.exclude.name, query.exclude.name);
    }
    if (query.byAgent !== undefined) add(`actor_kind = 'agent' AND ${SAME_PERSON}(actor_name, ?)`, query.byAgent);
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
  // and the events that moved tasks, taken in as they happened.
  activity(board: string): BoardActivity {
    const activity = emptyActivity();
    const moves = this.statement(
      `SELECT body FROM events WHERE board = ? AND task_id IS NOT NULL
         AND (summary LIKE '%sent it for review%' OR summary LIKE '%approved it%' OR summary LIKE '%marked it done%') ORDER BY seq`,
    ).all(board) as unknown as EventRow[];
    for (const row of moves) noteEvent(activity, JSON.parse(row.body) as BoardEvent);
    const latest = this.statement(
      `SELECT body FROM events WHERE board = ? AND seq IN
         (SELECT MAX(seq) FROM events WHERE board = ? GROUP BY actor_kind, actor_name) ORDER BY seq`,
    ).all(board, board) as unknown as EventRow[];
    for (const row of latest) noteEvent(activity, JSON.parse(row.body) as BoardEvent);
    return activity;
  }
}
