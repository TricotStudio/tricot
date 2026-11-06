// What each board tool call costs an agent, in tokens (T234): for every MCP
// tool call, the size of what the agent sent (its arguments) and of what it
// was answered (the result, with the unread notice or the wait a call adds),
// tallied by tool and by agent. Tokens are estimated at four characters each;
// an image in a result is counted, not sized, as an agent doesn't read it as
// text. It keeps sizes and names only, never what was sent or answered, in
// memory: like steps and usage, it goes with a restart, and its `since` says
// when it began.
//
// Every tool goes through measure (mcp.ts), the connectors' own tools
// included, so a tool is measured without a line of its own. It sees the
// arguments as the tool's schema read them (a key the schema doesn't know is
// gone), and not a call the schema refused before the tool ran. GET
// /api/tool-costs shows it.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const CHARS_PER_TOKEN = 4;
// Agent names come from each session (?agent=), so they are held to as many as usage holds.
const MAX_AGENTS = 200;

// Characters, as counted.
interface Sizes {
  total: number;
  largest: number;
}

interface Tally {
  name: string;
  calls: number;
  errors: number; // calls answered with an error, which the agent reads all the same
  images: number; // images in results, which are not counted in the result's size
  input: Sizes;
  result: Sizes;
}

// The same, in estimated tokens, as GET /api/tool-costs shows it.
export interface TokenSizes {
  average: number;
  largest: number;
  total: number;
}

export interface CostLine {
  name: string;
  calls: number;
  errors: number;
  images: number;
  input: TokenSizes;
  result: TokenSizes;
}

export interface ToolCostsReport {
  since: string; // when the tally began: this server's start
  charsPerToken: number;
  total: Omit<CostLine, 'name'>;
  tools: CostLine[]; // most costly result first
  agents: CostLine[];
}

const empty = (name: string): Tally => ({ name, calls: 0, errors: 0, images: 0, input: { total: 0, largest: 0 }, result: { total: 0, largest: 0 } });

// What a result costs the agent: the characters of its text, and how many images it carries.
export function resultSize(result: CallToolResult): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  for (const item of result.content) {
    if (item.type === 'text') chars += item.text.length;
    else if (item.type === 'image' || item.type === 'audio') images += 1;
    else if (item.type === 'resource' && 'text' in item.resource) chars += item.resource.text.length;
    else chars += JSON.stringify(item).length;
  }
  if (result.structuredContent) chars += JSON.stringify(result.structuredContent).length;
  return { chars, images };
}

// What the agent wrote to call it: its arguments, as JSON.
export const inputSize = (args: Record<string, unknown>): number => JSON.stringify(args).length;

const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

function inTokens(sizes: Sizes, calls: number): TokenSizes {
  return { average: calls ? Math.round(sizes.total / calls / CHARS_PER_TOKEN) : 0, largest: tokens(sizes.largest), total: tokens(sizes.total) };
}

function line({ name, calls, errors, images, input, result }: Tally): CostLine {
  return { name, calls, errors, images, input: inTokens(input, calls), result: inTokens(result, calls) };
}

function add(tally: Tally, input: number, result: number, images: number, error: boolean): void {
  tally.calls += 1;
  if (error) tally.errors += 1;
  tally.images += images;
  tally.input.total += input;
  tally.input.largest = Math.max(tally.input.largest, input);
  tally.result.total += result;
  tally.result.largest = Math.max(tally.result.largest, result);
}

export class ToolCosts {
  private readonly tools = new Map<string, Tally>();
  private readonly agents = new Map<string, Tally>(); // lower-cased name -> its tally, least recently calling first
  private readonly all = empty('all');
  private readonly since: number;

  constructor(now: () => number = Date.now) {
    this.since = now();
  }

  // One call's sizes, in characters.
  record(agent: string, tool: string, sizes: { input: number; result: number; images?: number; error?: boolean }): void {
    const { input, result, images = 0, error = false } = sizes;
    const key = agent.trim().toLowerCase();
    const byAgent = this.agents.get(key) ?? empty(agent.trim());
    this.agents.delete(key); // re-inserted last: the map runs from the agent that called longest ago
    this.agents.set(key, byAgent);
    while (this.agents.size > MAX_AGENTS) this.agents.delete(this.agents.keys().next().value!);
    const byTool = this.tools.get(tool) ?? empty(tool);
    this.tools.set(tool, byTool);
    for (const tally of [byTool, byAgent, this.all]) add(tally, input, result, images, error);
  }

  // Runs one call and records it: what the agent sent, and what it was
  // answered. A call that throws is answered with its message (the SDK's
  // tool error), so that is what is counted.
  async measure(agent: string, tool: string, args: Record<string, unknown>, call: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const input = inputSize(args);
    let result: CallToolResult;
    try {
      result = await call();
    } catch (error) {
      this.record(agent, tool, { input, result: (error instanceof Error ? error.message : String(error)).length, error: true });
      throw error;
    }
    const { chars, images } = resultSize(result);
    this.record(agent, tool, { input, result: chars, images, error: result.isError === true });
    return result;
  }

  report(): ToolCostsReport {
    const costliest = (a: CostLine, b: CostLine) => b.result.total - a.result.total || b.calls - a.calls || a.name.localeCompare(b.name);
    const { name: _name, ...total } = line(this.all);
    return {
      since: new Date(this.since).toISOString(),
      charsPerToken: CHARS_PER_TOKEN,
      total,
      tools: [...this.tools.values()].map(line).sort(costliest),
      agents: [...this.agents.values()].map(line).sort(costliest),
    };
  }
}
