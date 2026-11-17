// The instructions every agent is told when it connects, in full, as an agent
// meets them over MCP (test/instructions.test.ts holds the rules). They are
// composed from named lines (server/mcp/instructions.ts), the core's and the
// tool groups' (server/mcp/toolGroups.ts), and golden files in test/golden/
// hold the text itself, plain text a person can read in a diff:
//
// - mcp-instructions-canvas.txt: with nothing registered, the canvas alone,
//   plain and woken. It moves when the core's own lines do.
// - a part's own, in a tree that has it: with it registered, as an agent
//   connected on its own is told them (plain), one Tricot's terminal wakes (woken),
//   and one whose client sleeps by `tricot listen` (listening). Written once, from
//   the code as it was before the instructions were composed, and never taken again
//   for a change that is not meant to reword what its agents are told. Its file, its
//   words and what registers them are its own, beside its own script.
//
// `npx tsx test/instructionsSurface.ts --write canvas` writes the first again.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { wakeUrl } from '../src/core/sessions';
import { Store } from '../src/core/store';
import { createApp } from '../src/server/app';
import { ToolGroups } from '../src/server/mcp/toolGroups';
import { removeScratch } from './platform';

export const GOLDEN = path.join(import.meta.dirname, 'golden');
export const CANVAS_FILE = path.join(GOLDEN, 'mcp-instructions-canvas.txt');

export type Variant = 'plain' | 'woken' | 'listening';
export type Told = Record<Variant, string>;

// What a server over these groups tells each kind of session, as the client receives it, and the tools it lists to
// the first: an empty ToolGroups is the canvas alone, and a part's groups the
// server with it.
export async function meet(groups: ToolGroups): Promise<{ told: Told; tools: string[] }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-instructions-'));
  const store = new Store(dir);
  store.load();
  const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', version: '9.8.7', toolGroups: groups });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  const connect = async (url: string, client: { name: string; version: string }): Promise<Client> => {
    const connected = new Client(client);
    await connected.connect(new StreamableHTTPClientTransport(new URL(url)));
    clients.push(connected);
    return connected;
  };
  try {
    const plain = await connect(`${base}/mcp?agent=Planner`, { name: 'test-client', version: '1.0.0' });
    const woken = await connect(wakeUrl(`${base}/mcp?agent=Planner`, 'instructions-terminal'), { name: 'test-client', version: '1.0.0' });
    const listening = await connect(`${base}/mcp?agent=Planner`, { name: 'claude-code', version: '2.1.321' });
    return {
      told: { plain: plain.getInstructions() ?? '', woken: woken.getInstructions() ?? '', listening: listening.getInstructions() ?? '' },
      tools: (await plain.listTools()).tools.map((tool) => tool.name),
    };
  } finally {
    for (const client of clients) await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  }
}

// ---- the golden files -------------------------------------------------------------------

const HEADER = /^===== (\w+): (\d+) characters =====\n/m;

// A golden: its comment lines, then each variant under a line that says its length.
export function goldenText(about: string[], told: Partial<Told>): string {
  const sections = Object.entries(told).map(([variant, text]) => `===== ${variant}: ${text.length} characters =====\n${text}\n`);
  return `${about.map((line) => `# ${line}`).join('\n')}\n\n${sections.join('\n')}`;
}

// Each variant's text in a golden, and the length it says, as a person reading the file would find them.
export function parseGolden(file: string): Record<string, { text: string; says: number }> {
  const parts = file.split(HEADER);
  const found: Record<string, { text: string; says: number }> = {};
  for (let at = 1; at < parts.length; at += 3) found[parts[at]] = { says: Number(parts[at + 1]), text: parts[at + 2].replace(/\n+$/, '') };
  return found;
}

export const CANVAS_ABOUT = [
  'The instructions an agent is told when nothing is registered, the canvas alone, in full: connected on its own',
  "(plain) and woken by Tricot's terminal (woken). It moves when the core's own lines do; read the diff.",
  'Written by test/instructionsSurface.ts: `npx tsx test/instructionsSurface.ts --write canvas`.',
];

export const read = (file: string): string => readFileSync(file, 'utf8');

// The two lines an agent is told how to idle by, which a session Tricot's terminal wakes, or one that sleeps by
// `tricot listen`, is told the second of.
export const LISTEN_LINE = '- When idle, listen: call wait_for_updates, and again each time it returns.';
export const SLEEP_LINE = '- When idle, call wait_for_updates and do as it says: end your turn, or wait.';

export const lines = (text: string) => text.split('\n');

// The first line of a text that is not the other's, for a message a person can act on.
export function firstDifference(was: string, now: string): string {
  const [before, after] = [lines(was), lines(now)];
  const at = before.findIndex((line, index) => line !== after[index]);
  const index = at < 0 ? Math.min(before.length, after.length) : at;
  return `line ${index + 1}:\n  was: ${before[index] ?? '(none)'}\n  now: ${after[index] ?? '(none)'}`;
}

export const golden = (file: string) => parseGolden(read(file));

// The tools a text names, which are those of this server or of a part's: a word shaped like a tool's name and that is one.
export const toolsNamedIn = (text: string, known: Set<string>) => [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])].filter((word) => known.has(word));

// `npx tsx test/instructionsSurface.ts --write canvas` takes the canvas file again. A part's is written by its own script.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const which = process.argv[process.argv.indexOf('--write') + 1];
  if (which === 'canvas') {
    mkdirSync(GOLDEN, { recursive: true });
    const { plain, woken } = (await meet(new ToolGroups())).told;
    writeFileSync(CANVAS_FILE, goldenText(CANVAS_ABOUT, { plain, woken }));
    console.log(`test/golden/mcp-instructions-canvas.txt: ${plain.length} and ${woken.length} characters.`);
  } else {
    throw new Error("Say `--write canvas`. A part's file is written by its own script, in a tree that has it.");
  }
}
