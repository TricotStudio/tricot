import type { Database, Statement } from './sqlite';
import type { TricotSkill } from '../skills';

// The skills people add in Tricot (see migrations.ts): a row each, in the
// order they were added, one for each name lower-cased. Written at once, not
// with a board's save: they are the app's, not a board's.

interface TricotSkillRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  agent: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, name, description, instructions, agent, created_by, created_at, updated_at';

function skillOf(row: TricotSkillRow): TricotSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    ...(row.agent ? { agent: row.agent } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TricotSkillTable {
  private readonly cache = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private statement(sql: string): Statement {
    let statement = this.cache.get(sql);
    if (!statement) this.cache.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  all(): TricotSkill[] {
    return (this.statement(`SELECT ${COLUMNS} FROM tricot_skills ORDER BY rowid`).all() as unknown as TricotSkillRow[]).map(skillOf);
  }

  get(id: string): TricotSkill | undefined {
    const row = this.statement(`SELECT ${COLUMNS} FROM tricot_skills WHERE id = ?`).get(id) as TricotSkillRow | undefined;
    return row && skillOf(row);
  }

  put(skill: TricotSkill): void {
    this.statement(
      `INSERT INTO tricot_skills (id, key, name, description, instructions, agent, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET key = excluded.key, name = excluded.name, description = excluded.description,
         instructions = excluded.instructions, agent = excluded.agent, updated_at = excluded.updated_at`,
    ).run(skill.id, skill.name.toLowerCase(), skill.name, skill.description, skill.instructions, skill.agent ?? null, skill.createdBy, skill.createdAt, skill.updatedAt);
  }

  remove(id: string): boolean {
    return Number(this.statement('DELETE FROM tricot_skills WHERE id = ?').run(id).changes) > 0;
  }
}
