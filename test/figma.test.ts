import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/core/store';
import { figmaFileId, figmaTarget, parseFigmaFileId } from '../src/core/connectors/figma/frame';
import { imageDimensions } from '../src/core/blocks/image/image';
import { linkCardSize } from '../src/core/blocks/link/link';
import { linkSource } from '../src/core/sources';
import type { Actor, Block } from '../src/core/types';
import { createApp } from '../src/server/app';
import { letIn, type TestSeat } from './seatHelper';
import { Connectors } from '../src/server/connectors';
import { drawPng, FakeFigma, FILE_KEY, FRAME, NO_USER_SCOPE_TOKEN, OTHER_TOKEN, VALID_TOKEN } from './fakeFigma';
import { versionsOf } from './tables';

const sam: Actor = { kind: 'human', name: 'Sam' };
const FRAME_URL = `https://www.figma.com/design/${FILE_KEY}/Onboarding?node-id=12-34&t=abc`;
const FILE_URL = `https://www.figma.com/design/${FILE_KEY}/Onboarding`;
const FRAME_ID = `${FILE_KEY}:${FRAME}`;

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

// The person's browser, let in as one of their seats (seatHelper.ts): it signs what needs one.
let seat: TestSeat;

describe('Figma links', () => {
  it('reads the file and the frame from the address', () => {
    assert.deepEqual(figmaTarget(FRAME_URL), { fileKey: FILE_KEY, nodeId: '12:34' });
    assert.deepEqual(figmaTarget(FILE_URL), { fileKey: FILE_KEY });
    assert.deepEqual(figmaTarget(`https://figma.com/file/${FILE_KEY}/Old?node-id=1-2`), { fileKey: FILE_KEY, nodeId: '1:2' });
    assert.deepEqual(figmaTarget(`https://www.figma.com/design/${FILE_KEY}/branch/BrAnCh12345/Name?node-id=3%3A4`), { fileKey: 'BrAnCh12345', nodeId: '3:4' });
    assert.deepEqual(figmaTarget(`https://www.figma.com/design/${FILE_KEY}/x?node-id=not-a-node`), { fileKey: FILE_KEY });
    assert.equal(figmaTarget('https://www.figma.com/community/file/836596421863073964/kit'), null);
    assert.equal(figmaTarget('https://www.figma.com/pricing'), null);
    assert.equal(figmaTarget('https://example.com/design/aBcD1234eFgH/x'), null);
    assert.deepEqual(parseFigmaFileId(figmaFileId({ fileKey: FILE_KEY, nodeId: '12:34' })), { fileKey: FILE_KEY, nodeId: '12:34' });
    assert.deepEqual(parseFigmaFileId(FILE_KEY), { fileKey: FILE_KEY });
    assert.equal(parseFigmaFileId(`${FILE_KEY}:oops`), null);
  });

  it('tags a file or frame link as the connector\'s, with a card tall enough for its preview, and leaves what it does not read alone', () => {
    const source = linkSource(FRAME_URL)!;
    assert.equal(source.connector, 'figma');
    assert.equal(source.fileId, FRAME_ID);
    assert.equal(source.kind, 'Figma');
    assert.ok(source.embed, 'it still opens in place');
    assert.deepEqual(linkCardSize(FRAME_URL), { w: 400, h: 260 });
    assert.equal(linkSource(FILE_URL)?.fileId, FILE_KEY);
    assert.equal(linkSource('https://www.figma.com/community/file/836596421863073964/kit')?.connector, undefined);
    assert.deepEqual(linkCardSize('https://example.com/x'), { w: 300, h: 90 });
  });
});

describe('Figma connector', () => {
  let dir: string;
  let figma: FakeFigma;
  let server: Server;
  let base: string;
  let store: Store;
  let client: Client;
  let now = Date.parse('2026-10-30T12:00:00Z');
  let boardId: string;
  const tokenFile = () => path.join(dir, 'connectors', 'figma.json');

  const rest = async (method: string, route: string, body?: object) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...seat.sign(method, route, body ? JSON.stringify(body) : '') }, body: body && JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, json: text ? (JSON.parse(text) as any) : {} };
  };
  const status = async () => ((await rest('GET', '/api/connectors')).json as { id: string }[]).find((c) => c.id === 'figma') as any;
  const connect = (token = VALID_TOKEN) => rest('POST', '/api/connectors/figma/token', { token });
  const card = async (fileId = FRAME_ID) => (await rest('GET', `/api/connectors/figma/files/${encodeURIComponent(fileId)}`)).json;
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const addLink = (url = FRAME_URL) => {
    const block = store.addBlock({ boardId }, { content: { type: 'link', url }, title: 'Welcome' }, sam);
    return block.id;
  };
  const imageOf = (id: string) => store.blockOf(id) as Extract<Block, { type: 'image' }>;
  const assetBytes = (assetId: string) => readFileSync(store.assetFile(assetId).file);

  before(async () => {
    figma = new FakeFigma();
    await figma.start();
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-figma-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Onboarding' }, sam).id;
    const connectors = new Connectors({ dataDir: dir, now: () => now, figma: { api: figma.base }, google: { builtIn: null } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    seat = letIn(app);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    figma.stop();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  // Each test starts from a Figma that isn't connected, with a fresh fake.
  beforeEach(async () => {
    await rest('POST', '/api/connectors/figma/disconnect', {});
    figma.requests = [];
    figma.revoked.clear();
    figma.hidden.clear();
    figma.unrenderable.clear();
    figma.rateLimited = 0;
    figma.commentsRefused = null;
    figma.down = false;
    figma.tooBigAbove = Infinity;
    figma.seed = 1;
    now += 10 * 60_000; // past what the server remembers of any card
  });
  afterEach(() => {
    figma.requests = [];
  });

  describe('connecting with a token', () => {
    it('is not connected at first, and says what it can read', async () => {
      const figmaStatus = await status();
      assert.equal(figmaStatus.state, 'ready');
      assert.equal(figmaStatus.name, 'Figma');
      assert.deepEqual(figmaStatus.access.map((a: { scope: string }) => a.scope), ['file_content:read', 'file_comments:read']);
      assert.equal(figmaStatus.account, undefined);
    });

    it('checks the token with Figma\'s "me", keeps it at 600 in the connectors folder, and shows who is connected', async () => {
      const { status: code, json } = await connect(`  ${VALID_TOKEN}\n`);
      assert.equal(code, 200);
      assert.equal(json.connector.state, 'connected');
      assert.equal(json.connector.account.email, 'ada', 'the name Figma gave');
      assert.ok(json.connector.access.every((a: { granted: boolean }) => a.granted));
      assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(tokenFile())).mode & 0o777, 0o700);
      assert.equal(JSON.parse(readFileSync(tokenFile(), 'utf8')).token, VALID_TOKEN);
      assert.deepEqual(figma.requests.map((r) => r.path), ['/v1/me']);
      assert.equal(figma.requests[0].token, VALID_TOKEN);
      assert.equal((await status()).state, 'connected');
    });

    it('never hands the token back, to the page or to an agent', async () => {
      const { text: connected } = await connect();
      assert.ok(!connected.includes(VALID_TOKEN));
      assert.ok(!(await rest('GET', '/api/connectors')).text.includes(VALID_TOKEN));
      const boards = (await call('list_boards')).content[0].text!;
      assert.ok(!boards.includes(VALID_TOKEN));
      assert.match(boards, /Figma, connected as ada \(Figma frames, Figma comments\)/);
      assert.match(boards, /People's link cards show .*the real names of Figma files and frames, with a thumbnail.*; .*Figma frames on link cards: read_figma_frame\./);
    });

    it('sends the token to the API only, in the X-Figma-Token header, and never with a picture', async () => {
      await connect();
      const linkId = addLink();
      await card();
      await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: linkId });
      assert.ok(figma.requests.length > 3);
      for (const request of figma.requests) {
        if (request.path.startsWith('/v1/')) assert.equal(request.token, VALID_TOKEN, request.path);
        else assert.equal(request.token, undefined, `no token with ${request.path}`);
      }
      assert.ok(figma.requests.some((r) => r.path.startsWith('/pictures/')), 'the picture was fetched');
    });

    it('turns away a token Figma does not know, one that is not a token, and one that cannot say whose it is, in plain words', async () => {
      const unknown = await connect('figd_made-up-token-0000000');
      assert.equal(unknown.status, 400);
      assert.match(unknown.json.error, /Figma didn't accept that token\. Check you copied all of it/);
      const spaces = await connect('not a token');
      assert.equal(spaces.status, 400);
      assert.match(spaces.json.error, /doesn't look like a Figma token/);
      const noUser = await connect(NO_USER_SCOPE_TOKEN);
      assert.equal(noUser.status, 400);
      assert.match(noUser.json.error, /"Current user" permission/);
      assert.equal((await status()).state, 'ready');
      assert.equal(existsSync(tokenFile()), false);
      assert.ok(!JSON.stringify([unknown.json, spaces.json, noUser.json]).includes('made-up-token'));
    });

    it('disconnects: forgets the token, and cards go back to plain', async () => {
      await connect();
      assert.equal((await card()).file.name, 'Welcome screen');
      const gone = await rest('POST', '/api/connectors/figma/disconnect', {});
      assert.equal(gone.status, 200);
      assert.equal(gone.json.connector.state, 'ready');
      assert.equal(gone.json.revoked, false, "Figma can't revoke a personal token for the person");
      assert.equal(existsSync(tokenFile()), false);
      assert.equal((await card()).problem.code, 'not_connected');
      assert.equal((await call('read_figma_frame', { url: FRAME_URL })).isError, true);
    });

    it('has no sign-in page to send people to', async () => {
      const start = await rest('POST', '/api/connectors/figma/start', {});
      assert.equal(start.status, 400);
      assert.match(start.json.error, /token you paste/);
    });

    it('can be connected again with another token, replacing the first', async () => {
      await connect();
      const again = await connect(OTHER_TOKEN);
      assert.equal(again.json.connector.account.email, 'grace');
      assert.equal(JSON.parse(readFileSync(tokenFile(), 'utf8')).token, OTHER_TOKEN);
    });
  });

  describe('a link card', () => {
    it('stays as it is, offering to connect, while Figma is not connected', async () => {
      const answer = await card();
      assert.equal(answer.file, null);
      assert.equal(answer.problem.code, 'not_connected');
      assert.equal(figma.requests.length, 0, 'nothing is asked of Figma');
    });

    it('shows a frame\'s name and a thumbnail kept as an asset, once connected', async () => {
      await connect();
      const { file } = await card();
      assert.equal(file.name, 'Welcome screen');
      assert.equal(file.fileName, 'Onboarding designs');
      assert.equal(file.frame, true);
      assert.equal(file.modifiedTime, '2026-10-29T10:00:00Z');
      assert.match(file.thumbnail, /^[a-z2-9]{12}\.png$/);
      const asset = await fetch(`${base}/api/assets/${file.thumbnail}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), 'image/png');
      assert.deepEqual(imageDimensions(new Uint8Array(await asset.arrayBuffer())), { width: 360, height: 240 }, 'drawn at half size');
      const nodes = figma.apiCalls(/\/nodes\?/);
      assert.match(nodes[0].path, /ids=12%3A34&depth=1/, 'only the frame itself, not what is inside it');
    });

    it('shows a file link\'s name and Figma\'s own thumbnail', async () => {
      await connect();
      const { file } = await card(FILE_KEY);
      assert.equal(file.name, 'Onboarding designs');
      assert.equal(file.frame, false);
      assert.match(file.thumbnail, /^[a-z2-9]{12}\.png$/);
    });

    it('is not asked of Figma again while it is fresh, nor drawn again until the file changes', async () => {
      await connect();
      const first = (await card()).file;
      const drawn = figma.apiCalls(/\/v1\/images\//).length;
      const calls = figma.requests.length;
      assert.equal((await card()).file.thumbnail, first.thumbnail);
      assert.equal(figma.requests.length, calls, 'a second look costs no calls');

      now += 3 * 60_000; // the server looks again…
      assert.equal((await card()).file.thumbnail, first.thumbnail, '…but the file has not changed, so the thumbnail stays');
      assert.equal(figma.apiCalls(/\/v1\/images\//).length, drawn, 'the thumbnail was not drawn again');

      now += 3 * 60_000;
      figma.files[FILE_KEY].lastModified = '2026-10-30T11:00:00Z';
      const changed = (await card()).file;
      assert.notEqual(changed.thumbnail, first.thumbnail, 'a newer file gets a new thumbnail');
      assert.equal(existsSync(path.join(dir, 'assets', first.thumbnail)), false, 'and the old one is removed');
      figma.files[FILE_KEY].lastModified = '2026-10-29T10:00:00Z';
    });

    it('is remembered across a restart, so the thumbnail is not drawn and kept again', async () => {
      await connect();
      const first = (await card()).file.thumbnail;
      const again = new Connectors({ dataDir: dir, now: () => now, figma: { api: figma.base }, google: { builtIn: null } });
      const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors: again });
      const second = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });
      try {
        const port = (second.address() as AddressInfo).port;
        const body = await (await fetch(`http://127.0.0.1:${port}/api/connectors/figma/files/${encodeURIComponent(FRAME_ID)}`)).json();
        assert.equal(body.file.thumbnail, first);
      } finally {
        second.closeAllConnections();
        second.close();
      }
    });
  });

  describe('bringing a frame in, and refreshing it', () => {
    it('adds an image block of the frame at 2x, as a Tricot asset, remembering where it came from', async () => {
      await connect();
      const linkId = addLink();
      const { status: code, json } = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: linkId });
      assert.equal(code, 201);
      const image = imageOf(json.block.id);
      assert.equal(image.type, 'image');
      assert.deepEqual(image.origin, { connector: 'figma', fileId: FILE_KEY, nodeId: FRAME });
      assert.equal(image.title, 'Welcome screen');
      assert.equal(image.caption, 'Onboarding designs on Figma');
      assert.equal(image.author.name, 'Sam');
      assert.deepEqual(imageDimensions(assetBytes(image.assetId)), { width: 1440, height: 960 }, 'rendered at 2x');
      assert.ok(figma.apiCalls(/\/v1\/images\/.*scale=2$/).length === 1);
      assert.equal(store.canvasOf(image.id).canvas, store.canvasOf(linkId).canvas, 'on the same canvas as the card');
      assert.deepEqual(store.blockOf(linkId).type, 'link', 'the card stays');
    });

    it('comes over smaller when 2x is too big for an image block', async () => {
      await connect();
      figma.tooBigAbove = 1;
      const { json } = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() });
      assert.deepEqual(imageDimensions(assetBytes(imageOf(json.block.id).assetId)), { width: 720, height: 480 }, 'at 1x');
      assert.deepEqual(figma.apiCalls(/\/v1\/images\//).map((r) => /scale=([\d.]+)/.exec(r.path)![1]), ['2', '1']);
    });

    it('refuses a card that is not a link to a frame, in words', async () => {
      await connect();
      const file = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink(FILE_URL) });
      assert.equal(file.status, 400);
      assert.match(file.json.error, /not a link to a Figma frame/);
      const plain = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink('https://example.com/design') });
      assert.equal(plain.status, 400);
      assert.equal((await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: 'nope' })).status, 404);
    });

    it('refreshes in place: a new picture is a new version, and the one it replaces is kept as an earlier version', async () => {
      await connect();
      const { json } = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() });
      const id: string = json.block.id;
      const before = structuredClone(imageOf(id));
      assert.equal(before.rev, 1);

      figma.seed = 2; // the frame was changed in Figma
      const refreshed = await rest('POST', `/api/connectors/figma/images/${id}/refresh`, { actor: 'Ada' });
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.json.changed, true);
      const after = imageOf(id);
      assert.equal(after.id, id, 'the same block');
      assert.equal(after.rev, 2);
      assert.notEqual(after.assetId, before.assetId);
      assert.deepEqual(after.origin, before.origin, 'it still remembers where it came from');
      assert.equal(after.updatedBy.name, 'Ada');
      assert.equal(after.versionCount, 1, 'one earlier version kept');
      const kept = versionsOf(store, id);
      assert.equal(kept.length, 1);
      assert.equal(kept[0].type === 'image' && kept[0].assetId, before.assetId);
      assert.deepEqual(store.versionSummaries(id).map((v) => [v.rev, v.change]), [[2, 'replaced the image'], [1, 'made it']]);
      assert.ok(existsSync(path.join(dir, 'assets', before.assetId)), 'the earlier picture is still on disk');

      // Brought back to the first picture, the block is still what it was.
      store.restoreBlock(id, 1, sam);
      assert.equal(imageOf(id).assetId, before.assetId);
      assert.deepEqual(imageOf(id).origin, before.origin);
    });

    it('leaves the block alone when Figma draws the same picture', async () => {
      await connect();
      const { json } = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() });
      const id: string = json.block.id;
      const refreshed = await rest('POST', `/api/connectors/figma/images/${id}/refresh`, { actor: 'Sam' });
      assert.equal(refreshed.json.changed, false);
      assert.equal(imageOf(id).rev, 1);
      assert.equal(versionsOf(store, id).length, 0);
    });

    it('keeps the comments people pinned on it, which are fractions of the picture', async () => {
      await connect();
      const { json } = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() });
      const id: string = json.block.id;
      const { pin } = store.pinComment(id, { kind: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, 'Is this the final hero?', sam);
      figma.seed = 3;
      await rest('POST', `/api/connectors/figma/images/${id}/refresh`, { actor: 'Ada' });
      const pins = store.canvasOf(id).canvas.pins.filter((p) => p.blockId === id);
      assert.deepEqual(pins.map((p) => p.id), [pin.id]);
      assert.equal(pins[0].anchor.kind, 'box');
    });

    it('refuses to refresh a picture that did not come from Figma', async () => {
      await connect();
      const plain = store.addBlock({ boardId }, { content: { type: 'image', assetId: store.saveAsset(drawPng(40, 30)) } }, sam);
      const refused = await rest('POST', `/api/connectors/figma/images/${plain.id}/refresh`, { actor: 'Sam' });
      assert.equal(refused.status, 400);
      assert.match(refused.json.error, /did not come from Figma/);
      assert.equal((await rest('POST', `/api/connectors/figma/images/${addLink()}/refresh`, { actor: 'Sam' })).status, 400, 'nor a link');
    });

    it('cannot be given an origin by REST: only the connector sets it', async () => {
      const assetId = store.saveAsset(drawPng(40, 30));
      const made = await rest('POST', '/api/canvas/blocks', {
        actor: 'Sam',
        boardId,
        content: { type: 'image', assetId, origin: { connector: 'figma', fileId: FILE_KEY, nodeId: FRAME } },
      });
      assert.equal(made.status, 201);
      assert.equal(made.json.origin, undefined);
    });
  });

  describe('for agents', () => {
    it("lists read_figma_frame with a short description, after the board's own tools", async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'read_figma_frame');
      assert.ok(tool);
      assert.ok(tool.description!.length < 330, `${tool.description!.length} characters`);
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['block_id', 'url']);
      assert.ok(tools.findIndex((t) => t.name === tool.name) > tools.findIndex((t) => t.name === 'restore_item'));
    });

    it('returns the frame as an image with its comments: author, text, when, and the replies under each', async () => {
      await connect();
      const result = await call('read_figma_frame', { block_id: addLink() });
      assert.ok(!result.isError, result.content[0].text);
      const [text, picture] = result.content;
      assert.equal(picture.type, 'image');
      assert.equal(picture.mimeType, 'image/png');
      assert.deepEqual(imageDimensions(Buffer.from(picture.data!, 'base64')), { width: 720, height: 480 });
      assert.equal(
        text.text,
        [
          `Figma frame "Welcome screen" in "Onboarding designs", edited 2026-10-29: ${FRAME_URL}`,
          'Comments (2), with who and when:',
          '- Sam, 2026-10-28: "Make the button larger"',
          '  - Ada, 2026-10-28: "Done, 48px now"',
          '- Grace, 2026-10-29: "Title wraps on small phones" (resolved)',
        ].join('\n'),
        "those on the frame and what is inside it; not the other frame's, nor one on the canvas",
      );
    });

    it('reads a frame address too, and says when a frame has no comments', async () => {
      await connect();
      const result = await call('read_figma_frame', { url: `https://www.figma.com/design/${FILE_KEY}/x?node-id=12-99` });
      assert.match(result.content[0].text!, /^Figma frame "Pricing" in "Onboarding designs"/);
      assert.match(result.content[0].text!, /- Sam, 2026-10-29: "Which plans do we show\?"/);
      const comments = figma.files[FILE_KEY].comments;
      figma.files[FILE_KEY].comments = [];
      try {
        assert.match((await call('read_figma_frame', { url: FRAME_URL })).content[0].text!, /Comments: none on this frame\./);
      } finally {
        figma.files[FILE_KEY].comments = comments;
      }
    });

    it('sends a smaller picture when the frame is big, to keep what an agent reads light', async () => {
      await connect();
      figma.tooBigAbove = 0.9;
      const result = await call('read_figma_frame', { url: FRAME_URL });
      assert.deepEqual(imageDimensions(Buffer.from(result.content[1].data!, 'base64')), { width: 360, height: 240 }, 'at half size');
    });

    it('refuses clearly: not connected, a whole file, a block that is not a Figma link, both or neither argument', async () => {
      const refused = async (args: Record<string, unknown>) => {
        const result = await call('read_figma_frame', args);
        assert.equal(result.isError, true, JSON.stringify(args));
        return result.content[0].text!;
      };
      assert.match(await refused({ url: FRAME_URL }), /^Figma isn't connected, so agents can't read Figma frames\. A person pastes a Figma token on the Connectors page\./);
      assert.equal(figma.requests.length, 0);
      await connect();
      assert.match(await refused({ url: FILE_URL }), /whole Figma file\. In Figma, select a frame and Copy link to selection/);
      assert.match(await refused({ block_id: addLink('https://example.com/x') }), /isn't a Figma file address/);
      const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'hi' } }, sam);
      assert.match(await refused({ block_id: note.id }), /is not a link block/);
      assert.match(await refused({}), /either block_id or url/);
      assert.match(await refused({ url: FRAME_URL, block_id: addLink() }), /either block_id or url/);
      assert.match(await refused({ url: 'https://example.com' }), /isn't a Figma file address/);
    });
  });

  describe('when something goes wrong', () => {
    it('says a file the token cannot see is not shown to it, on the card and to an agent', async () => {
      await connect();
      figma.hide(FILE_KEY);
      const answer = await card();
      assert.equal(answer.file, null);
      assert.equal(answer.problem.code, 'no_access');
      assert.equal(answer.problem.message, "Figma doesn't show this file to the connected token: it may be private to someone else, or the link may be wrong.");
      const result = await call('read_figma_frame', { url: FRAME_URL });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text!, /doesn't show this file to the connected token/);
      assert.equal((await status()).state, 'connected', 'the token itself is fine');
      assert.equal((await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() })).status, 404);
    });

    it('says a frame that is gone is gone', async () => {
      await connect();
      const result = await call('read_figma_frame', { url: `https://www.figma.com/design/${FILE_KEY}/x?node-id=99-99` });
      assert.match(result.content[0].text!, /can't find that frame in the file/);
    });

    it('says when Figma cannot draw a frame', async () => {
      await connect();
      figma.unrenderable.add(FRAME);
      const made = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() });
      assert.equal(made.status, 422);
      assert.match(made.json.error, /couldn't draw that frame as a picture/);
    });

    it('asks for a new token once Figma turns the saved one down (expired or revoked), on the page, the card and for agents', async () => {
      await connect();
      assert.equal((await card()).file.name, 'Welcome screen');
      figma.revoked.add(VALID_TOKEN);
      now += 10 * 60_000;
      const answer = await card(FILE_KEY);
      assert.equal(answer.file, null);
      assert.equal(answer.problem.code, 'token_refused');

      const figmaStatus = await status();
      assert.equal(figmaStatus.state, 'needs_sign_in');
      assert.equal(figmaStatus.message, 'Figma no longer accepts the saved token: it expired or was revoked. Paste a new one on the Connectors page.');
      assert.equal(figmaStatus.account.email, 'ada', 'still says whose it was');
      assert.equal(statSync(tokenFile()).mode & 0o777, 0o600);

      const asked = figma.requests.length;
      const result = await call('read_figma_frame', { url: FRAME_URL });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text!, /^Figma no longer accepts the saved token\. A person pastes a new one on the Connectors page\./);
      assert.equal(figma.requests.length, asked, 'not asked of Figma again until a new token is pasted');
      assert.equal((await card()).problem.code, 'needs_sign_in');

      figma.revoked.clear();
      assert.equal((await connect(OTHER_TOKEN)).json.connector.state, 'connected');
      assert.equal((await card()).file.name, 'Welcome screen');
    });

    it('backs off when Figma says to slow down, saying "try again in a minute", and does not ask again until then', async () => {
      await connect();
      figma.rateLimited = 1;
      const first = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() });
      assert.equal(first.status, 429);
      assert.equal(first.json.error, 'Figma is limiting how often Tricot can ask. Try again in a minute.');
      assert.equal(first.json.code, 'rate_limited');
      const asked = figma.requests.length;

      const during = await call('read_figma_frame', { url: FRAME_URL });
      assert.equal(during.isError, true);
      assert.match(during.content[0].text!, /Figma is limiting how often Tricot can ask\. Try again in a minute\./);
      assert.equal((await card()).problem.code, 'rate_limited');
      assert.equal(figma.requests.length, asked, 'nothing went to Figma while it was resting');

      now += 61_000;
      const after = await rest('POST', '/api/connectors/figma/frames', { actor: 'Sam', blockId: addLink() });
      assert.equal(after.status, 201);
      assert.equal((await status()).state, 'connected', 'a rate limit is not a bad token');
    });

    it('still returns the picture when only the comments cannot be read, and says why', async () => {
      await connect();
      figma.commentsRefused = 'Invalid scope(s): file_content:read. This endpoint requires the file_comments:read scope';
      const result = await call('read_figma_frame', { url: FRAME_URL });
      assert.ok(!result.isError);
      assert.equal(result.content[1].type, 'image');
      assert.match(result.content[0].text!, /Comments: couldn't be read\. This Figma token is missing a permission it needs/);
    });

    it('says when Figma cannot be reached', async () => {
      figma.down = true;
      const result = await connect();
      assert.equal(result.status, 502);
      assert.equal(result.json.error, "Couldn't reach Figma. Check the connection and try again.");
      assert.equal(existsSync(tokenFile()), false);
    });
  });
});
