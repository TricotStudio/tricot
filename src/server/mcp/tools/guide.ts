import { fieldsByType, guideSentences, moreSentences } from '../../../core/blocks/agent';
import { tools as schemas, type GuideTopic } from '../../../core/schemas';
import { TOPIC_ABOUT, guideText, topicsOf } from '../guide';
import { defineTool, text, type Tool } from '../tool';

// What a topic says before the tools' parts: the block kinds speak for themselves.
function intros(): Partial<Record<GuideTopic, string[]>> {
  return { blocks: [fieldsByType(), [...guideSentences(), ...moreSentences()].join('\n\n')] };
}

// read_guide, made last: it gives the guide of every tool the session has, connectors' included.
export function guideTool(others: Tool[]): Tool {
  const topics = topicsOf(others, intros());
  return defineTool({
    name: 'read_guide',
    title: 'Read guide',
    description: `How to use the board's tools well, by topic: read one when you first do that kind of work. Topics: ${topics.map((topic) => `${topic} (${TOPIC_ABOUT[topic]})`).join('; ')}.`,
    schema: schemas.read_guide,
    readOnly: true,
    handler: async ({ topic }) => text(guideText(topic, others, intros()[topic])),
  });
}
