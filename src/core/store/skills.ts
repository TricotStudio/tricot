import { BoardError } from './errors';
import type { BoardRepository } from './repository';
import { LIMITS, limited, optional, randomId, required } from './validate';
import { samePerson } from '../format';
import { SKILL_NAME } from '../schemas/rules';
import { normalizeSkills, type SkillList, type TricotSkill } from '../skills';

// A Tricot skill as it is given: the name, a line, the instructions, and who it is for (blank: every agent).
interface TricotSkillInput {
  name: string;
  description: string;
  instructions: string;
  agent?: string;
}

// What agents tell Tricot of their skills (core/skills.ts): kept for each
// agent by name, for the whole app. A new report replaces the last. And the
// skills people add in Tricot, which agents never write.
export class Skills {
  constructor(private readonly repo: BoardRepository) {}

  list(): SkillList[] {
    return this.repo.agentSkills();
  }

  // The agent's whole list, which replaces what it reported before; [] clears it.
  report(agent: string, skills: { name: string; description: string }[]): SkillList {
    const name = limited(required(agent, 'agent'), LIMITS.name, 'An agent name');
    if (skills.length > LIMITS.skills) throw new BoardError(`Report at most ${LIMITS.skills} skills.`);
    for (const skill of skills) skillNameOf(skill.name);
    this.repo.reportSkills(name, normalizeSkills(skills));
    return this.repo.agentSkills().find((l) => l.agent === name)!;
  }

  // ---- Tricot skills ---------------------------------------------------------

  tricot(): TricotSkill[] {
    return this.repo.tricotSkills();
  }

  // A new one, for one agent or (none) every agent. A name is used once.
  addTricot(person: string, input: TricotSkillInput): TricotSkill {
    if (this.repo.tricotSkills().length >= LIMITS.tricotSkills) throw new BoardError(`Tricot keeps at most ${LIMITS.tricotSkills} skills.`);
    const now = new Date().toISOString();
    const skill: TricotSkill = { id: randomId(8), ...skillFields(input), createdBy: required(person, 'actor'), createdAt: now, updatedAt: now };
    this.guardName(skill);
    this.repo.putTricotSkill(skill);
    return skill;
  }

  // Changes what is given; a blank agent makes it for every agent.
  editTricot(id: string, patch: Partial<TricotSkillInput>): TricotSkill {
    const before = this.find(id);
    const { agent: _agent, ...rest } = before;
    const skill: TricotSkill = {
      ...rest,
      ...skillFields({
        name: patch.name ?? before.name,
        description: patch.description ?? before.description,
        instructions: patch.instructions ?? before.instructions,
        agent: patch.agent ?? before.agent,
      }),
      updatedAt: new Date().toISOString(),
    };
    this.guardName(skill);
    this.repo.putTricotSkill(skill);
    return skill;
  }

  deleteTricot(id: string): TricotSkill {
    const skill = this.find(id);
    this.repo.deleteTricotSkill(id);
    return skill;
  }

  private find(id: string): TricotSkill {
    const skill = this.repo.tricotSkills().find((s) => s.id === id);
    if (!skill) throw new BoardError(`No Tricot skill with id "${id}".`, 'not_found');
    return skill;
  }

  private guardName(skill: TricotSkill): void {
    if (this.repo.tricotSkills().some((s) => s.id !== skill.id && samePerson(s.name, skill.name))) {
      throw new BoardError(`There is a Tricot skill called /${skill.name} already.`, 'conflict');
    }
  }
}

function skillFields(input: TricotSkillInput) {
  const description = limited(required(input.description.replace(/\s+/g, ' '), 'description'), LIMITS.skillDescription, 'A description');
  const instructions = limited(required(input.instructions, 'instructions'), LIMITS.skillInstructions, 'Instructions');
  const agent = optional(limited(input.agent?.trim() ?? '', LIMITS.name, 'An agent'));
  return { name: skillNameOf(input.name), description, instructions, ...(agent ? { agent } : {}) };
}

// A skill's name as it is kept: the slash off, one word.
function skillNameOf(raw: string): string {
  const label = limited(required(raw, 'skill name'), LIMITS.skillName, 'A skill name');
  if (!SKILL_NAME.test(label.replace(/^\//, ''))) throw new BoardError('A skill name is one word, e.g. review or plugin:review.');
  return label.replace(/^\//, '');
}
