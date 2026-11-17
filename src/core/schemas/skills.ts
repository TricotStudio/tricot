import { z } from 'zod';
import { LIMITS } from './limits';
import { SKILL_NAME } from './rules';
import { text } from './text';

// A skill an agent reports: its name as people type it after a "/", and a
// line on what it does. The name is one word (plugins join theirs with a
// colon), with or without the slash the agent's own tool shows. A description
// longer than the limit is clipped, not refused: an agent's skills come with
// descriptions of any length. (The name's pattern, SKILL_NAME, is in ./rules.)

export const skillName = text({ empty: 'skill name', name: 'A skill name', max: LIMITS.skillName, trim: true }).refine(
  (value) => value.trim() === '' || SKILL_NAME.test(value.trim().replace(/^\//, '')), // a blank one is said blank
  { error: 'A skill name is one word, e.g. review or plugin:review.' },
);

// A Tricot skill, which people add and agents never write: the name as above,
// a line on what it does (a person is told when it is too long, where an
// agent's own are clipped), the instructions the agent follows when it is
// called, and who it is for: a blank agent is every agent.
export const tricotSkill = {
  description: text({ empty: 'description', name: 'A description', max: LIMITS.skillDescription, tidy: true }),
  instructions: text({ empty: 'instructions', name: 'Instructions', max: LIMITS.skillInstructions }),
  agent: text({ name: 'An agent', max: LIMITS.name, trim: true }),
};

export const newSkill = z.object({
  name: skillName.describe('The name people type after "/", e.g. review (the slash is optional)'),
  description: z.string().describe('What it does, in one line'),
});
