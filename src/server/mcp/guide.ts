import type { Tool } from './tool';
import { Phrases, plain, type Words } from './words';

// The board's how-to, read when needed. Every session carries the tools'
// descriptions and the instructions, so those say only what a tool does and
// what to pass; how to use the tools well is here, by topic, and an agent
// reads a topic with read_guide when it first does that kind of work. Each
// tool writes its own part (its `guide`), so the advice stays next to the
// tool it is about; a topic may open with lines of its own.
//
// A topic is a name, and which topics a session offers is decided by what is
// registered: the core's are here, and a group of tools adds its own with its
// tools (toolGroups.ts), so a server without that group offers none of them.

export type GuideTopic = string;

// What each of the core's own topics covers, as read_guide lists them, in the
// order it lists them. The topics a group adds come before these. A group may
// add to what one covers (words.ts, `topic.<name>`): a part's board context, status
// and syncs are on the canvas topic.
const CORE_TOPIC_WORDS: Record<GuideTopic, Words> = {
  canvas: [
    ['reading', 'reading canvases, pins'],
    ['syncs', ''],
    ['requests', ' and requests'],
  ],
  blocks: 'which block shows what, each type\'s fields in full, charts, diffs, code, 3D scenes',
  conversation: 'comments, mentions, reactions, threads and lenses, listening, skills',
};

// The same as the core says them, with no group registered.
export const CORE_TOPICS: Record<GuideTopic, string> = Object.fromEntries(Object.entries(CORE_TOPIC_WORDS).map(([topic, words]) => [topic, plain(words)]));

// The longest description a tool may have, its guide pointer included.
export const MAX_DESCRIPTION = 900;

// One topic in full: its own lines, then each tool's part, in the order the tools are listed.
export function guideText(topic: GuideTopic, tools: Tool[], intro: string[] = []): string {
  const parts = tools.filter((tool) => tool.guide?.topic === topic).map((tool) => `## ${tool.name}\n${plain(tool.guide!.text)}`);
  return [`# Guide: ${topic}`, ...intro, ...parts].join('\n\n');
}

// The topics that have something to say, given the tools a session has, in the
// order read_guide lists them: `declared`, what the groups add and what each
// covers, then the core's. A tool with its part in a topic nothing declares
// would never be read, which is a mistake in Tricot.
export function topicsOf(tools: Tool[], intros: Partial<Record<GuideTopic, string[]>>, declared: Record<GuideTopic, string>, said: Phrases = new Phrases()): Record<GuideTopic, string> {
  const about = { ...declared, ...Object.fromEntries(Object.entries(CORE_TOPIC_WORDS).map(([topic, words]) => [topic, said.say(`topic.${topic}`, words)])) };
  const lost = tools.find((tool) => tool.guide && !Object.hasOwn(about, tool.guide.topic));
  if (lost) throw new Error(`${lost.name} has its part of the guide in the topic ${lost.guide!.topic}, which no tool group declares.`);
  return Object.fromEntries(Object.entries(about).filter(([topic]) => (intros[topic]?.length ?? 0) > 0 || tools.some((tool) => tool.guide?.topic === topic)));
}
