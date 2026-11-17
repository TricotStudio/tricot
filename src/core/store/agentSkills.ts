import type { Database, Statement } from './sqlite';
import type { AgentSkill, SkillList } from '../skills';

// The skills each agent last reported (see migrations.ts), one row an agent,
// by its name lower-cased: a new report replaces the old one. Written at
// once, not with a board's save: they are the agent's, not a board's.

interface SkillRow {
  name: string;
  skills: string;
  reported_at: string;
}

export class AgentSkillTable {
  private readonly cache = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private statement(sql: string): Statement {
    let statement = this.cache.get(sql);
    if (!statement) this.cache.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  all(): SkillList[] {
    const rows = this.statement('SELECT name, skills, reported_at FROM agent_skills ORDER BY name').all() as unknown as SkillRow[];
    return rows.map((row) => ({ agent: row.name, skills: JSON.parse(row.skills) as AgentSkill[], reportedAt: row.reported_at }));
  }

  replace(agent: string, skills: AgentSkill[], at: string): void {
    this.statement(
      `INSERT INTO agent_skills (agent, name, skills, reported_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (agent) DO UPDATE SET name = excluded.name, skills = excluded.skills, reported_at = excluded.reported_at`,
    ).run(agent.trim().toLowerCase(), agent.trim(), JSON.stringify(skills), at);
  }
}
