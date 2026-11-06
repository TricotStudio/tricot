// Proves what adding a kind of block takes. It adds a throwaway "quote" kind:
// a folder on each side (core/blocks/quote, with its server.ts, and
// web/canvas/blocks/quote) and an import and an entry in each registry, and
// nothing else. It then checks the
// result end to end (types, REST, MCP, agent text, search, versions, the web
// bundle) and takes the kind out again.
//
//   npx tsx scripts/check-new-kind.ts            add it, check it, remove it
//   npx tsx scripts/check-new-kind.ts install    add it and leave it, to look at
//   npx tsx scripts/check-new-kind.ts uninstall  take it out
//
// Nothing here is loaded by the app; it is the contract's own test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const CORE_FOLDER = path.join(root, 'src/core/blocks/quote');
const WEB_FOLDER = path.join(root, 'src/web/canvas/blocks/quote');
const CORE_REGISTRY = path.join(root, 'src/core/blocks/registry.ts');
const WEB_REGISTRY = path.join(root, 'src/web/canvas/blocks/registry.ts');
const SAVED = path.join(os.tmpdir(), 'tricot-check-new-kind.json'); // the registries as they were, in case a run is cut short

// ---- the sample kind: everything it has is in these two files -----------------------------------

const CORE = `// A throwaway kind, for scripts/check-new-kind.ts: a quotation and who said it.
// What the browser needs of it is here; what only the server uses is in server.ts.

import type { BlockKind } from '../kind';
import { clip } from '../../format';
import { server } from './server';

export interface QuoteTypes {
  type: 'quote';
  fields: { quote: string; speaker?: string };
  snapshot: { quote: string; speaker?: string };
  input: { quote: string; speaker?: string };
  patch: { quote?: string; speaker?: string };
}

export const quote: BlockKind<QuoteTypes> = {
  type: 'quote',
  label: 'Quote',
  defaultSize: { w: 340, h: 180 },
  untitled: (block) => \`quote "\${clip(block.quote, 40)}"\`,
  fromSnapshot: (version) => ({ quote: version.quote, speaker: version.speaker }),

  ...server,
};
`;

const CORE_SERVER = `// What only the server uses of quote blocks.

import { z } from 'zod';
import type { QuoteTypes } from './index';
import type { ServerHalf } from '../kind';
import { missing } from '../shared';
import { LIMITS, limited, optional } from '../../store/validate';

const words = (value: string) => limited(value, LIMITS.text, 'A quote');
const said = (value: string | undefined) => (value === undefined ? undefined : optional(limited(value, LIMITS.title, 'An attribution')));

export const server: ServerHalf<QuoteTypes> = {
  patchFields: ['quote', 'speaker'],
  create: (input) => ({ quote: words(input.quote), speaker: said(input.speaker) }),
  change({ block, patch }) {
    if (patch.quote === undefined && patch.speaker === undefined) return undefined;
    const next = { quote: patch.quote === undefined ? block.quote : words(patch.quote), speaker: patch.speaker === undefined ? block.speaker : said(patch.speaker) };
    return {
      apply() {
        block.quote = next.quote;
        if (next.speaker) block.speaker = next.speaker;
        else delete block.speaker;
      },
    };
  },
  describe(before, after) {
    const parts: string[] = [];
    if (before.quote !== after.quote) parts.push('reworded the quote');
    if ((before.speaker ?? '') !== (after.speaker ?? '')) parts.push(after.speaker ? \`credited it to \${after.speaker}\` : 'removed the credit');
    return parts;
  },
  snapshot: (block) => ({ quote: block.quote, speaker: block.speaker }),
  restorePatch: (version) => ({ quote: version.quote, speaker: version.speaker ?? '' }),
  digest: (block) => \`“\${block.quote}”\${block.speaker ? \` — \${block.speaker}\` : ''}\`,
  searchText: (block) => [block.quote, block.speaker],

  agent: {
    addShape: {
      quote: z.string().optional().describe('Quote blocks: the words'),
      speaker: z.string().optional().describe('Quote blocks: who said them'),
    },
    updateShape: { quote: z.string().optional(), speaker: z.string().optional() },
    docs: { brief: 'quote → quote, + speaker', add: 'quote → quote (the words), plus optional speaker (who said them)', update: 'quote, speaker' },
    read(args) {
      if (args.quote === undefined) throw missing('quote', 'quote');
      const { quote, speaker } = args as { quote: string; speaker?: string };
      return () => ({ type: 'quote', quote, speaker });
    },
    patch: (args) => ({ quote: args.quote as string | undefined, speaker: args.speaker as string | undefined }),
  },

  people: {
    create: z.object({ type: z.literal('quote'), quote: z.string(), speaker: z.string().optional() }),
    patch: { quote: z.string().optional(), speaker: z.string().optional() },
  },
};
`;

const WEB = `// A throwaway kind, for scripts/check-new-kind.ts: how a quote is drawn and added.

import type { Block } from '../../../../core/types';
import type { WebBlockKind } from '../kind';

type QuoteBlock = Extract<Block, { type: 'quote' }>;

export const quote: WebBlockKind<QuoteBlock> = {
  type: 'quote',
  Body: ({ block }) => (
    <blockquote className="block-note" style={{ margin: 0, padding: 12 }}>
      <p>“{block.quote}”</p>
      {block.speaker && <footer>— {block.speaker}</footer>}
    </blockquote>
  ),
  menu: { label: 'Quote', add: () => ({ content: { type: 'quote', quote: 'Say something worth quoting', speaker: '' } }) },
};
`;

// ---- adding and removing it ----------------------------------------------------------------

// Registers a kind in a registry: its import, and its entry in the list.
function register(file: string, before: string, list: RegExp): string {
  const text = readFileSync(file, 'utf8');
  const imported = text.replace(/(import \{ table \} from '\.\/table';\n)/, `$1import { quote } from './quote';\n`);
  const listed = imported.replace(list, (match) => match.replace(/\]/, ', quote]'));
  assert.notEqual(listed, text, `${before}: nothing to register in`);
  return listed;
}

function install(): void {
  if (existsSync(CORE_FOLDER) || existsSync(WEB_FOLDER)) throw new Error('The sample kind is already installed: run uninstall.');
  writeFileSync(SAVED, JSON.stringify({ core: readFileSync(CORE_REGISTRY, 'utf8'), web: readFileSync(WEB_REGISTRY, 'utf8') }));
  mkdirSync(CORE_FOLDER, { recursive: true });
  mkdirSync(WEB_FOLDER, { recursive: true });
  writeFileSync(path.join(CORE_FOLDER, 'index.ts'), CORE);
  writeFileSync(path.join(CORE_FOLDER, 'server.ts'), CORE_SERVER);
  writeFileSync(path.join(WEB_FOLDER, 'index.tsx'), WEB);
  writeFileSync(CORE_REGISTRY, register(CORE_REGISTRY, 'core registry', /\[note, [^\]]*\] as const/));
  writeFileSync(WEB_REGISTRY, register(WEB_REGISTRY, 'web registry', /\[note, [^\]]*\]/));
}

function uninstall(): void {
  rmSync(CORE_FOLDER, { recursive: true, force: true });
  rmSync(WEB_FOLDER, { recursive: true, force: true });
  if (!existsSync(SAVED)) return;
  const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as { core: string; web: string };
  writeFileSync(CORE_REGISTRY, saved.core);
  writeFileSync(WEB_REGISTRY, saved.web);
  rmSync(SAVED);
}

// ---- the check ---------------------------------------------------------------------------------

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`${command} ${args.join(' ')} failed:\n${stdout ?? ''}${stderr ?? ''}`.slice(0, 3000));
  }
}

async function endToEnd(): Promise<void> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { Store } = await import('../src/core/store');
  const { createApp } = await import('../src/server/app');
  const { letIn } = await import('../test/seatHelper');

  const store = new Store(mkdtempSync(path.join(os.tmpdir(), 'check-kind-')));
  store.load();
  const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
  const seat = letIn(app); // the person's browser, let in: what a person does is signed with its key
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new Client({ name: 'check', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Checker`)));
  const call = async (name: string, args: object) => {
    const result = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join('\n'), failed: Boolean(result.isError) };
  };
  const rest = async (method: string, route: string, body?: object) => {
    const text = body && JSON.stringify(body);
    const res = await fetch(`${base}/api${route}`, { method, headers: { 'content-type': 'application/json', Origin: base, ...seat.sign(method, `/api${route}`, text) }, body: text });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const done: string[] = [];
  const ok = (what: string) => done.push(what);

  // what agents are told: the tool lists the type and its fields, and says what it is for
  const { tools } = await client.listTools();
  const add = tools.find((t) => t.name === 'add_block')!;
  const props = (add.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
  assert.ok(props.type.enum!.includes('quote'), 'add_block lists the type');
  assert.equal(props.quote.description, 'Quote blocks: the words');
  assert.match(add.description!, /chart → [^]*; quote → quote, \+ speaker\./);
  const guide = ((await client.callTool({ name: 'read_guide', arguments: { topic: 'blocks' } })) as { content: { text: string }[] }).content[0].text;
  assert.match(guide, /chart → [^]*; quote → quote \(the words\), plus optional speaker \(who said them\)\./);
  assert.match(guide, /Content fields by type: .*, focus, quote, speaker, and for code /);
  ok('tools/list names the type, its fields and what it is for');

  // an agent adds one; the canvas, get_block and search read it
  const board = (await call('create_board', { title: 'Quotes' })).text.match(/\[id: ([^\]]+)\]/)![1];
  const added = await call('add_block', { board_id: board, type: 'quote', quote: 'Be kind', speaker: 'Ada' });
  assert.match(added.text, /^Added quote "Be kind" \[id: \w+\] \(rev 1\)\.$/);
  const id = added.text.match(/\[id: ([^\]]+)\]/)![1];
  assert.match((await call('get_canvas', { board_id: board })).text, /- quote "Be kind" \[id: \w+\] · rev 1 · by Checker \(agent\)\n {2}“Be kind” — Ada/);
  assert.match((await call('search', { board_id: board, query: 'ada' })).text, /Quote/);
  ok('MCP add_block, get_canvas text and search');

  // changes, versions and a restore
  assert.match((await call('update_block', { block_id: id, rev: 1, quote: 'Be kinder', speaker: 'Ada L.' })).text, /^Updated quote "Be kinder" \[id: \w+\] \(now rev 2\)\.$/);
  const block = (await call('get_block', { block_id: id })).text;
  assert.match(block, /Versions, newest first[\s\S]*- v2 \(current\) · .* · reworded the quote; credited it to Ada L\.\n- v1 · .* · made it/);
  assert.match((await call('update_block', { block_id: id, rev: 2, restore_rev: 1 })).text, /^Restored v1 of quote "Be kind"/);
  ok('update_block, its versions in the words the kind gives, and restore');

  // a whole-block pin works on any kind, with nothing from it
  const planned = (await call('plan_tasks', { board_id: board, tasks: [{ title: 'Use it' }] })).text;
  const task = planned.match(/\[id: ([^\]]+)\]/)![1];
  assert.match((await call('pin', { block_id: id, task_id: task })).text, /^Pinned the whole block in quote "Be kind" to T1/);
  ok('pins the whole block');

  // fields that are not its own are refused, in both directions
  assert.match((await call('update_block', { block_id: id, rev: 3, rows: [['x']] })).text, /A quote block has no columns or rows\./);
  const note = (await call('add_block', { board_id: board, type: 'note', text: 'hi' })).text.match(/\[id: ([^\]]+)\]/)![1];
  assert.match((await call('update_block', { block_id: note, rev: 1, quote: 'no' })).text, /A note block has no quote\./);
  assert.match((await call('add_block', { board_id: board, type: 'quote' })).text, /A quote block needs quote\./);
  ok('refuses what a kind does not have, and what it needs');

  // people add and change one over REST
  const made = await rest('POST', '/canvas/blocks', { actor: 'Sam', boardId: board, content: { type: 'quote', quote: 'From a person', speaker: 'Sam' } });
  assert.equal(made.status, 201);
  assert.deepEqual([made.json.type, made.json.quote, made.json.speaker, made.json.w, made.json.h], ['quote', 'From a person', 'Sam', 340, 180]);
  const patched = await rest('POST', `/canvas/blocks/${made.json.id}`, { actor: 'Sam', quote: 'Changed by a person', rev: 1 });
  assert.deepEqual([patched.status, patched.json.quote, patched.json.rev], [200, 'Changed by a person', 2]);
  const unknown = await rest('POST', '/canvas/blocks', { actor: 'Sam', boardId: board, content: { type: 'sparkline' } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /A block's type is one of: .*, quote\./);
  assert.match((await call('get_updates', { board_id: board, since: 0 })).text, /Sam \(human\) updated quote "Changed by a person".*reworded the quote/);
  ok('REST create, change and its refusals; what people did shows in agents\' updates');

  await client.close();
  server.closeAllConnections();
  server.close();
  await store.flush();
  console.log(done.map((line) => `  ok  ${line}`).join('\n'));
}

async function check(): Promise<void> {
  install();
  try {
    const touched = [CORE_FOLDER, WEB_FOLDER, CORE_REGISTRY, WEB_REGISTRY].map((p) => path.relative(root, p));
    console.log(`Added the sample kind: ${touched.join(', ')}`);
    console.log('  typecheck...');
    run('npx', ['tsc', '--noEmit']);
    console.log('  ok  the board\'s Block, snapshot, content and patch types include it, and both halves compile');
    console.log('  end to end...');
    process.stdout.write(run('npx', ['tsx', 'scripts/check-new-kind.ts', 'e2e']));
    console.log('  web bundle...');
    const out = mkdtempSync(path.join(os.tmpdir(), 'check-kind-web-'));
    run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir']);
    const bundles = run('grep', ['-l', 'Say something worth quoting', '-r', path.join(out, 'assets')]);
    assert.ok(bundles.trim(), 'the web bundle carries the kind');
    assert.throws(() => run('grep', ['-rl', 'Quote blocks: who said them', path.join(out, 'assets')]), 'the web bundle leaves its server half out');
    rmSync(out, { recursive: true, force: true });
    console.log('  ok  the web bundle carries its Add menu entry and its drawing, and leaves its server half out');
  } finally {
    uninstall();
    console.log('Took the sample kind out again.');
  }
}

const mode = process.argv[2] ?? 'check';
if (mode === 'install') install();
else if (mode === 'uninstall') uninstall();
else if (mode === 'e2e') await endToEnd();
else await check();
