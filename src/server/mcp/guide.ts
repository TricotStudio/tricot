import { GUIDE_TOPICS, type GuideTopic } from '../../core/schemas';
import type { Tool } from './tool';

// The board's how-to, read when needed. Every session carries the tools'
// descriptions and the instructions, so those say only what a tool does and
// what to pass; how to use the tools well is here, by topic, and an agent
// reads a topic with read_guide when it first does that kind of work. Each
// tool writes its own part (its `guide`), so the advice stays next to the
// tool it is about; a topic may open with lines of its own.

export { GUIDE_TOPICS, type GuideTopic };

// What each topic covers, as read_guide lists them.
export const TOPIC_ABOUT: Record<GuideTopic, string> = {
  decisions: 'posting, refining and refreshing decisions; criteria, findings, judgement calls',
  tasks: 'planning, claiming, first looks, briefs, review and commits, stale tasks',
  canvas: 'the board context, reading canvases, pins, syncs and requests',
  blocks: 'which block shows what, each type\'s fields in full, charts, diffs, code, 3D scenes',
  conversation: 'comments, mentions, reactions, threads and lenses, listening, skills',
};

// The longest description a tool may have, its guide pointer included
// (test/mcpTools.test.ts holds every tool to it).
export const MAX_DESCRIPTION = 900;

// One topic in full: its own lines, then each tool's part, in the order the tools are listed.
export function guideText(topic: GuideTopic, tools: Tool[], intro: string[] = []): string {
  const parts = tools.filter((tool) => tool.guide?.topic === topic).map((tool) => `## ${tool.name}\n${tool.guide!.text}`);
  return [`# Guide: ${topic}`, ...intro, ...parts].join('\n\n');
}

// The topics that have something to say, given the tools a session has.
export function topicsOf(tools: Tool[], intros: Partial<Record<GuideTopic, string[]>>): GuideTopic[] {
  return GUIDE_TOPICS.filter((topic) => (intros[topic]?.length ?? 0) > 0 || tools.some((tool) => tool.guide?.topic === topic));
}
