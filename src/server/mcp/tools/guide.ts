import { fieldsWords, guideSentences, moreSentences } from '../../../core/blocks/agent';
import { readGuideArgs } from '../../../core/schemas';
import { guideText, topicsOf, type GuideTopic } from '../guide';
import { defineTool, text, type Tool } from '../tool';
import { Phrases } from '../words';

// What a topic says before the tools' parts: the block kinds speak for themselves, and the groups add to their entries.
function intros(words: Phrases): Partial<Record<GuideTopic, string[]>> {
  return { blocks: [words.say('topic.blocks.fields', fieldsWords(false, (what) => words.offers(what))), [...guideSentences(), ...moreSentences()].join('\n\n')] };
}

// read_guide, made last: it gives the guide of every tool the session has, connectors' included, and offers
// the topics the core has and `declared` adds (the groups', toolGroups.ts): its description and the topics
// it takes are the same list. `words` is what the groups say in the core's topics.
export function guideTool(others: Tool[], declared: Record<GuideTopic, string> = {}, words: Phrases = new Phrases()): Tool {
  const about = topicsOf(others, intros(words), declared, words);
  const topics = Object.keys(about) as [GuideTopic, ...GuideTopic[]];
  return defineTool({
    name: 'read_guide',
    title: 'Read guide',
    description: `How to use the board's tools well, by topic: read one when you first do that kind of work. Topics: ${topics.map((topic) => `${topic} (${about[topic]})`).join('; ')}.`,
    schema: readGuideArgs(topics),
    readOnly: true,
    handler: async ({ topic }) => text(guideText(topic, others, intros(words)[topic])),
  });
}
