import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CORE_TOPICS, type GuideTopic } from './guide';
import type { Contribution, InstructionLine } from './instructions';
import { wordedBy, type Extra, type Tool } from './tool';
import type { ToolContext } from './tools/context';
import { Phrases, type Phrasing } from './words';

// How tools reach agents without the core naming whose they are, so a part
// (decisions, tasks, review, the status) can move to a repository of its own
// and plug in: a group of tools, with the guide topics it adds, is
// registered here, where the app is built (server/app.ts), as block kinds,
// connectors and agents register in theirs. A server with no group registered
// lists only the board's own tools and offers only the core's topics: a tool of
// a group nobody registered is not there to call, and asking for it by name gets
// the answer any unknown tool gets.
//
// A group gives the server up to six things:
// - `tools`: the tools it adds, built for each session as an area's are
//   (server/mcp/tools/), from the same context;
// - `topics`: the topics of the guide it adds, each with what it covers as
//   read_guide lists it. They are listed before the core's. A tool of the
//   group, or of the board, may have its part of the guide (its `guide`) in
//   one of them or in a core's topic;
// - `after`: the board tool its tools follow in the list an agent gets. None:
//   after all the board's tools, before read_guide. Groups that follow the
//   same tool, or none, keep the order they were added in;
// - `instructions`: the lines it adds to what every agent is told on connecting
//   (server/mcp/instructions.ts), each at a position it names among the core's
//   lines, so the text reads in the order it should with the group registered
//   and says nothing of it without. A group that has only these lists no tools
//   (`tools: () => []`);
// - `phrasing`: what it says in the board's own tools, guide and refusals
//   (server/mcp/words.ts): pieces it places among the core's named pieces of
//   a description, a guide or an argument's description, arguments it adds to
//   a board tool, and sentences it makes for a call. The core says what is
//   true without it, and a server with the group reads as it did before;
// - `answers`: what it answers of a board tool's call that carries an argument
//   it added (get_board's area), built for each session as `tools` is. The
//   board's own handler answers every other call.
//
// The registry is each server's own, not a list every server shares: nothing is
// registered by loading a module, so a test, or another Tricot, builds the
// groups it wants (McpOptions.groups).

// A group's answer to a call of a board tool, given the arguments it was sent: the result, or none when the call is not one it answers, which the
// board's own handler then does.
export type ToolAnswer = (args: Record<string, any>, extra: Extra) => Promise<CallToolResult | undefined>;

export interface ToolGroup {
  // What the registry knows it by, and names it by when it refuses one.
  id: string;
  tools(context: ToolContext): Tool[];
  topics?: Record<GuideTopic, string>;
  // By the name of a board tool.
  answers?(context: ToolContext): Record<string, ToolAnswer>;
  after?: string;
  // Built for each session's instructions, as `tools` is for its tools.
  instructions?(): InstructionLine[];
  // Built for each session, as `instructions` is.
  phrasing?(): Phrasing;
}

// What a session lists: the board's tools with each group's among them, and the topics those groups add.
export interface Composed {
  tools: Tool[];
  topics: Record<GuideTopic, string>;
}

export class ToolGroups {
  private readonly all: ToolGroup[] = [];
  // The failures that have been said, by what failed and the group, so one that fails in every session says so once.
  private readonly said = new Set<string>();

  // Adds a group, in the order the app builds them. A second group of one id, or a topic that is the core's or
  // another group's, is a mistake in Tricot, not in what a person did, so it is refused where it is made.
  add(group: ToolGroup): void {
    if (this.find(group.id)) throw new Error(`There are two tool groups named ${group.id}.`);
    for (const topic of Object.keys(group.topics ?? {})) {
      if (Object.hasOwn(CORE_TOPICS, topic)) throw new Error(`The tool group ${group.id} declares the guide topic ${topic}, which is the core's own.`);
      const other = this.all.find((added) => added.topics && Object.hasOwn(added.topics, topic));
      if (other) throw new Error(`The tool groups ${other.id} and ${group.id} both declare the guide topic ${topic}.`);
    }
    this.all.push(group);
  }

  groups(): readonly ToolGroup[] {
    return this.all;
  }

  find(id: string): ToolGroup | undefined {
    return this.all.find((group) => group.id === id);
  }

  private say(key: string, message: string, error: unknown): void {
    if (!this.said.has(key)) console.error(message, error);
    this.said.add(key);
  }

  // The lines the groups add to the instructions, in the order the groups were added (composeInstructions puts them
  // where they say). A group whose lines can't be built is left out of that session, and the rest are served, as
  // with its tools: the failure is said once in the server's output.
  instructionLines(): Contribution[] {
    const contributed: Contribution[] = [];
    for (const group of this.all) {
      if (!group.instructions) continue;
      try {
        contributed.push({ group: group.id, lines: group.instructions() });
      } catch (error) {
        this.say(`instructions ${group.id}`, `The tool group ${group.id} could not build its instruction lines, so no session is told them:`, error);
      }
    }
    return contributed;
  }

  // What the groups say in the board's own texts, for a session: a group whose phrasing can't be built is left out, as
  // with its lines, and the failure is said once. A mistake in what a group says is refused where the text is made.
  phrases(): Phrases {
    const contributions: { group: string; phrasing: Phrasing }[] = [];
    for (const group of this.all) {
      if (!group.phrasing) continue;
      try {
        contributions.push({ group: group.id, phrasing: group.phrasing() });
      } catch (error) {
        this.say(`phrasing ${group.id}`, `The tool group ${group.id} could not build its phrasing, so no session is told it:`, error);
      }
    }
    return new Phrases(contributions);
  }

  // The tools a session lists, and the topics its guide has: `board`, the board's own tools in their order (said as the
  // groups' phrasing has them), with each group's tools after the one it names, and what each group adds to the guide.
  //
  // A group that follows a tool the board doesn't have, or whose tools take a name another tool has, is a mistake in
  // Tricot, and is refused with its name. A group whose tools can't be built is not: it is left out of that session
  // (its tools and its topics), and the rest are served, as a card kind that fails leaves the canvas working
  // (cardKinds.ts). The failure is said once, in the server's output, so what an agent finds missing has its cause.
  compose(board: Tool[], context: ToolContext, phrases: Phrases = this.phrases()): Composed {
    const missing = phrases.toolsWithParams().find((name) => !board.some((tool) => tool.name === name));
    if (missing) throw new Error(`A tool group adds arguments to ${missing}, which is no tool of the board.`);
    board = board.map((tool) => wordedBy(tool, phrases));
    const owners = new Map(board.map((tool) => [tool.name, 'the board']));
    const after = new Map<string, Tool[]>();
    const last: Tool[] = [];
    const answers = new Map<string, ToolAnswer[]>();
    const topics: Record<GuideTopic, string> = {};
    for (const group of this.all) {
      if (group.after !== undefined && !owners.has(group.after)) throw new Error(`The tool group ${group.id} comes after ${group.after}, which is no tool of the board.`);
      let tools: Tool[];
      let answered: Record<string, ToolAnswer> = {};
      try {
        tools = group.tools(context);
        answered = group.answers?.(context) ?? {};
      } catch (error) {
        this.say(`tools ${group.id}`, `The tool group ${group.id} could not build its tools, so no session lists them:`, error);
        continue;
      }
      for (const { name } of tools) {
        if (owners.has(name)) throw new Error(`Two tools are named ${name}: ${owners.get(name)} and the tool group ${group.id}.`);
        owners.set(name, `the tool group ${group.id}`);
      }
      for (const [name, answer] of Object.entries(answered)) {
        if (!board.some((tool) => tool.name === name)) throw new Error(`The tool group ${group.id} answers calls of ${name}, which is no tool of the board.`);
        answers.set(name, [...(answers.get(name) ?? []), answer]);
      }
      Object.assign(topics, group.topics);
      if (group.after === undefined) last.push(...tools);
      else after.set(group.after, [...(after.get(group.after) ?? []), ...tools]);
    }
    const answering = (tool: Tool): Tool => {
      const given = answers.get(tool.name);
      if (!given) return tool;
      return {
        ...tool,
        async handler(args, extra) {
          for (const answer of given) {
            const result = await answer(args, extra);
            if (result) return result;
          }
          return tool.handler(args, extra);
        },
      };
    };
    return { tools: [...board.flatMap((tool) => [answering(tool), ...(after.get(tool.name) ?? [])]), ...last], topics };
  }
}
