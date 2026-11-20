import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { note as noteKind } from '../src/core/blocks/note';
import { useBlockKinds } from '../src/core/blocks/registry';
import { wakeUrl } from '../src/core/sessions';
import { Connectors } from '../src/server/connectors';
import { BOARD_TOOLS, CONNECTOR_CALLS, CONNECTOR_TOOLS, refusedWith, type Listed } from './canvasAgentKit';
import { canvasServer, type CanvasServer } from './canvasEdition';
import { CANVAS_FILE, parseGolden, read } from './instructionsSurface';

// What an agent is told by a server of Tricot Canvas: the board's own tools, the core's short neutral
// instructions, and the guide's topics that are the core's own (src/server/mcp/words.ts). The instructions are pinned in full by
// the golden of instructions.test.ts; this reads the server as the entry builds it (src/server/canvasEdition.ts). That none of
// what it tells says a word of a part's, and that the check can fail, is held in a part's counterpart of this file, which has its
// words to read it by. The board context is one of them: no tool takes it as a target, no tool is only for it, and
// nothing an agent reads of it is told, whatever the board holds in it.

describe('What an agent is told by a server of Tricot Canvas', () => {
  let canvas: CanvasServer;
  let client: Client;
  let woken: Client;
  let tools: Listed;

  before(async () => {
    canvas = await canvasServer();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${canvas.base}/mcp?agent=Planner`)));
    woken = new Client({ name: 'test-client', version: '1.0.0' });
    await woken.connect(new StreamableHTTPClientTransport(new URL(wakeUrl(`${canvas.base}/mcp?agent=Planner`, 'canvas-terminal'))));
    tools = (await client.listTools()).tools;
  });

  after(async () => {
    await client.close();
    await woken.close();
    await canvas.stop();
  });

  it("lists exactly the board's 26 tools", () => {
    assert.equal(tools.length, 26);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...BOARD_TOOLS].sort());
  });

  it("offers no pin tool: add_block takes the core's own block types, and a call for another is refused by its schema", async () => {
    assert.ok(!tools.some((tool) => tool.name === 'pin'), 'no pin tool');
    const add = tools.find((tool) => tool.name === 'add_block')!;
    const types = (add.inputSchema.properties?.type as { enum: string[] }).enum;
    assert.deepEqual(types, ['note', 'table', 'checklist', 'diagram', 'image', 'link', 'diff', 'code', 'chart', 'scene', 'site', 'shape']);
    const said = await refusedWith(client, 'add_block', { page_id: 'anything', type: 'hologram' });
    assert.match(said, /type/);
  });

  it("reads a stored block of a type it has no kind for as an unknown block, kept as it is: told to agents, found by its title, renamed, and made or changed by none", async () => {
    const sam = { kind: 'human', name: 'Sam' } as const;
    const board = canvas.store.createBoard({ title: 'Imported' }, sam);
    const page = canvas.store.addPage(board.id, 'Page', sam);
    const block = canvas.store.addBlock({ pageId: page.id }, { title: 'Aurora', content: { type: 'note', text: 'Kept' } }, sam);
    (canvas.store.getPage(page.id).page.canvas.blocks[0] as { type: string }).type = 'hologram';
    const read = (await client.callTool({ name: 'get_canvas', arguments: { page_id: page.id } })) as { content: { text: string }[] };
    assert.match(read.content[0].text, /hologram "Aurora".*A hologram block, which this Tricot has no kind for\./s);
    canvas.store.updateBlock(block.id, { title: 'Dawn' }, sam);
    assert.throws(() => canvas.store.updateBlock(block.id, { text: 'Changed' }, sam), { message: 'A hologram block has no text.' });
    assert.throws(() => canvas.store.addBlock({ pageId: page.id }, { content: { type: 'hologram' } as never }, sam), { message: 'Unknown block type "hologram".' });
  });

  it("refuses a block only a card's canvas takes, a pin to an option, and a change in a sync a person asked for, in words that name no kind of card and no tool of a part", () => {
    const sam = { kind: 'human', name: 'Sam' } as const;
    const claude = { kind: 'agent', name: 'Claude' } as const;
    const board = canvas.store.createBoard({ title: 'Plain' }, sam);
    const page = canvas.store.addPage(board.id, 'Page', sam);
    // A kind only a card's canvas takes, as a part adds one: made up here, with the words it refuses in on any other canvas.
    const unregister = useBlockKinds([{ ...noteKind, type: 'pinboard', people: undefined, agent: { ...noteKind.agent, addShape: {}, updateShape: {}, pinShape: undefined }, cardOnly: 'Pinboards only work on the canvas of a card that shows them.' }]);
    try {
      assert.throws(() => canvas.store.addBlock({ pageId: page.id }, { content: { type: 'pinboard' } as never }, sam), { message: 'Pinboards only work on the canvas of a card that shows them.' });
    } finally {
      unregister();
    }
    assert.throws(
      () => canvas.store.addBlock({ pageId: page.id }, { optionId: 'a', content: { type: 'note', text: 'Evidence' } }, sam),
      { message: 'Only blocks on the canvas of a card with options can be pinned to an option.' },
    );
    canvas.store.addBlock({ boardId: board.id }, { content: { type: 'note', text: 'Goal' } }, sam);
    canvas.store.requestSync(board.id, undefined, sam);
    assert.throws(() => canvas.store.cancelSync(board.id, claude), { message: 'Only people cancel a sync; finish it instead.' });
    const note = canvas.store.getBoard(board.id).canvas.blocks[0];
    canvas.store.updateBlock(note.id, { text: 'Edited by a person' }, sam);
    assert.throws(() => canvas.store.updateBlock(note.id, { text: 'Edited by an agent' }, claude), /say so in your note when you finish the sync\.$/);
  });

  it("tells the core's short neutral instructions, in full as the golden has them", () => {
    const golden = parseGolden(read(CANVAS_FILE));
    assert.equal(client.getInstructions(), golden.plain.text);
    assert.equal(woken.getInstructions(), golden.woken.text);
    assert.equal(golden.plain.text.length, 1715);
  });

  it("lists the seven tools of the connectors besides, when a server has them, as startServer gives one, and each refuses in a sentence that says how to ask", async () => {
    const withConnectors = await canvasServer({ connectors: new Connectors({ dataDir: canvas.dir, google: { builtIn: null } }) });
    const connected = new Client({ name: 'test-client', version: '1.0.0' });
    try {
      await connected.connect(new StreamableHTTPClientTransport(new URL(`${withConnectors.base}/mcp?agent=Planner`)));
      const listed = (await connected.listTools()).tools;
      assert.deepEqual(listed.map((tool) => tool.name).sort(), [...BOARD_TOOLS, ...CONNECTOR_TOOLS].sort(), '26 and 7');
      for (const [name, args] of CONNECTOR_CALLS) {
        const said = await refusedWith(connected, name, args);
        assert.match(said, /isn't connected|not connected|needs a person|Connectors page/, `${name}: it says what a person has to do: ${said}`);
        // GitHub says only what a person does when it isn't connected: it asks for help where Tricot isn't installed on a repository.
        if (name !== 'read_github') assert.match(said, /Ask (?:a person|them) \(comment\) if you need it; don't retry until they have\./, `${name}: it still says how to ask: ${said}`);
      }
    } finally {
      await connected.close();
      await withConnectors.stop();
    }
  });
});
