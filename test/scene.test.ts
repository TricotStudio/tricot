import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agentTypes } from '../src/core/blocks/agent';
import { findKind } from '../src/core/blocks/registry';
import { MAX_SCENE, SCENE_EXAMPLE, editableSource, readScene } from '../src/core/blocks/scene/scene';
import { placePin } from '../src/core/pins';
import { BoardError, Store } from '../src/core/store';
import type { Actor, Block } from '../src/core/types';
import { createApp } from '../src/server/app';
import { eventsOf } from './tables';
import { readGuide } from './guide';
import { removeScratch } from './platform';

const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };

// ---- scenes, as agents write them -------------------------------------------------------

type Json = Record<string, any>;
const scene = (object: Json, more: Json = {}) =>
  JSON.stringify({
    metadata: { version: 4.6, type: 'Object' },
    geometries: [{ uuid: 'box', type: 'BoxGeometry', width: 1, height: 1, depth: 1 }],
    materials: [{ uuid: 'blue', type: 'MeshStandardMaterial', color: '#3b6fd6' }],
    object,
    ...more,
  });
const mesh = (name: string, extra: Json = {}) => ({ type: 'Mesh', name, geometry: 'box', material: 'blue', position: [0, 0.5, 0], ...extra });
const root = (...children: Json[]) => ({ type: 'Scene', children });

// A bar per quarter, as a small 3D chart.
const QUARTERS = scene(root(mesh('Q1', { uuid: 'q1' }), mesh('Q2', { uuid: 'q2', position: [1.5, 1, 0], scale: [1, 2, 1] }), mesh('Q3', { uuid: 'q3', position: [3, 0.75, 0] })));

// A seeded random number, so a run that fails can be run again.
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('Scene sources', () => {
  it('reads the example agents are given, and what it is made of', () => {
    const { facts } = readScene(SCENE_EXAMPLE);
    assert.deepEqual(facts, { objects: 2, meshes: 1, lights: 0, cameras: 0, geometries: 1, materials: 1, textures: 0, animations: 0, named: [{ name: 'Crate', type: 'Mesh' }] });
    assert.ok(SCENE_EXAMPLE.length < 400, 'short enough to put in a tool description');
  });

  it('names its named objects in the order the source gives them, with their uuids', () => {
    const lit = scene(root(mesh('Q1', { uuid: 'q1' }), { type: 'Group', name: 'Labels', children: [mesh('Tag')] }, { type: 'PointLight', name: '', position: [2, 4, 2] }));
    const { facts } = readScene(lit);
    assert.deepEqual(facts.named, [
      { name: 'Q1', type: 'Mesh', uuid: 'q1' },
      { name: 'Labels', type: 'Group' },
      { name: 'Tag', type: 'Mesh' },
    ]);
    assert.deepEqual([facts.objects, facts.meshes, facts.lights], [5, 2, 1]);
  });

  it('refuses what is not a scene, saying what to change', () => {
    const refuse = (source: string, message: RegExp) => assert.throws(() => readScene(source), (e: unknown) => e instanceof BoardError && message.test(e.message));
    refuse('  ', /A scene needs its three.js JSON, as Object3D.toJSON\(\) writes it\./);
    refuse('{ "object": ', /^The scene isn't valid JSON: .+\.$/);
    refuse('[1, 2]', /JSON but not a three.js scene/);
    refuse(JSON.stringify({ metadata: { type: 'Geometry' }, object: root() }), /metadata says it is "Geometry"; a scene is "Object"/);
    refuse(JSON.stringify({ geometries: [] }), /The scene has no object, its root/);
    refuse(scene(root({ type: 'Cube', name: 'Box' })), /Object "Box" has type "Cube": an object is one of Mesh, Group, Scene/);
    refuse(scene(root(mesh('Lid', { geometry: 'lid' }))), /Object "Lid" uses geometry "lid", which isn't among the scene's geometries\./);
    refuse(scene(root(mesh('Lid', { material: ['blue', 'red'] }))), /uses material "red", which isn't among the scene's materials/);
    refuse(scene(root({ type: 'Mesh', material: 'blue', geometry: 'box', position: [1, 2] })), /The Mesh at object.children\[0\] has position \[1,2\]: it is \[x, y, z\]\./);
    refuse(scene(root(), { geometries: [{ uuid: 'g', type: 'TeapotGeometry' }] }), /Geometry "g" has type "TeapotGeometry": a geometry is one of BoxGeometry/);
    refuse(scene(root(), { geometries: [{ type: 'BoxGeometry' }] }), /Geometry 1 needs a uuid: meshes name their geometry by it\./);
    refuse(scene(root(), { geometries: [{ uuid: 'ball', type: 'SphereGeometry', radius: 1, widthSegments: 100000 }] }), /Geometry "ball" asks for 100000 widthSegments; at most 256 are drawn\./);
    refuse(scene(root(), { geometries: [{ uuid: 'gem', type: 'IcosahedronGeometry', radius: 1, detail: 200 }] }), /Geometry "gem" asks for 200 detail; at most 32 are drawn\./);
    refuse(scene(root(mesh('Crowd', { type: 'InstancedMesh', count: 1e9, instanceMatrix: { type: 'Float32Array', array: [] } }))), /Object "Crowd" has count 1000000000: an InstancedMesh draws from 0 to 10,000 copies\./);
    refuse(scene(root(), { materials: [{ uuid: 'glow', type: 'ShaderMaterial', fragmentShader: 'void main() {}' }] }), /Material "glow" is a ShaderMaterial: the board doesn't run shader code\./);
    refuse(scene(root(), { materials: [{ uuid: 'red', type: 'MeshStandardMaterial', color: 'red' }] }), /Material "red" has color "red": a colour is "#ff8800", or a number/);
    refuse(scene({ type: 'Scene', children: { a: 1 } }), /has children that aren't a list/);
  });

  it('takes colours as numbers or "#rrggbb"', () => {
    for (const color of [16746496, '#ff8800', '#f80']) readScene(scene(root(), { materials: [{ uuid: 'c', type: 'MeshBasicMaterial', color }] }));
  });

  it('fetches nothing from elsewhere: pictures come embedded', () => {
    const picture = (url: unknown) => scene(root(), { images: [{ uuid: 'i', url }], textures: [{ uuid: 't', image: 'i' }] });
    assert.ok(readScene(picture('data:image/png;base64,iVBORw0KGgo=')).facts.textures === 1);
    assert.throws(() => readScene(picture('https://example.com/wood.png')), /fetches nothing from elsewhere/);
    assert.throws(() => readScene(picture('textures/wood.png')), /The scene's picture "textures\/wood\.png" isn't embedded, and the board fetches nothing from elsewhere: give it as a data: URL/);
    assert.throws(() => readScene(picture(['data:image/png;base64,AA==', 'side.png'])), /"side\.png" isn't embedded/);
    assert.throws(() => readScene(picture('data:text/html;base64,PHNjcmlwdD4=')), /isn't embedded/);
    assert.throws(() => readScene(scene(root(mesh('Q1', { userData: { see: '//evil.example/x' } })))), /The scene names "\/\/evil\.example\/x", and the board fetches nothing from elsewhere/);
  });

  it('holds a sensible amount: characters, objects and depth', () => {
    assert.throws(() => readScene(' '.repeat(MAX_SCENE + 1) + '{}'), /A scene holds up to 200,000 characters; this one has 200,003\./);
    const many = scene(root(...Array.from({ length: 5000 }, () => ({ type: 'Group' }))));
    assert.throws(() => readScene(many), /A scene holds up to 5,000 objects\./);
    let deep: Json = { type: 'Group' };
    for (let i = 0; i < 70; i++) deep = { type: 'Group', children: [deep] };
    assert.throws(() => readScene(scene(deep)), /nests objects more than 64 deep/);
  });

  it('never throws anything but a refusal, whatever is changed in a scene', () => {
    const next = random(116);
    for (let i = 0; i < 400; i++) {
      const chars = [...QUARTERS];
      for (let n = 1 + Math.floor(next() * 4); n > 0; n--) chars[Math.floor(next() * chars.length)] = '{}[]",:0aQ'[Math.floor(next() * 10)];
      try {
        readScene(chars.join(''));
      } catch (error) {
        assert.ok(error instanceof BoardError, `a changed scene threw ${(error as Error)?.stack}`);
      }
    }
  });

  it('lays out a one-line source for people to edit', () => {
    assert.match(editableSource(SCENE_EXAMPLE), /^\{\n {2}"metadata": \{/);
    assert.equal(editableSource('{\n "object": 1 }'), '{\n "object": 1 }', 'one laid out already stays as written');
  });
});

// ---- the kind, in the store -------------------------------------------------------------

describe('3D scene blocks in the store', () => {
  let dir: string;
  let store: Store;
  let boardId: string;
  const sceneOf = (id: string) => store.blockOf(id) as Extract<Block, { type: 'scene' }>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-scene-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Quarters' }, sam).id;
  });
  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('is a kind of block agents can add', () => {
    assert.equal(findKind('scene')?.label, '3D scene');
    assert.ok(agentTypes().includes('scene'));
  });

  it('keeps each change as a version, saying which named objects came and went', () => {
    const id = store.addBlock({ boardId }, { content: { type: 'scene', scene: QUARTERS } }, claude).id;
    assert.deepEqual([sceneOf(id).w, sceneOf(id).h], [460, 400]);
    const fourth = scene(root(mesh('Q2', { uuid: 'q2' }), mesh('Q3', { uuid: 'q3' }), mesh('Q4')));
    store.updateBlock(id, { scene: fourth }, claude);
    assert.deepEqual(
      store.versionSummaries(id).map((v) => v.change),
      ['edited the scene (added "Q4", removed "Q1")', 'made it'],
    );
    assert.throws(() => store.updateBlock(id, { scene: '{ nope' }, claude), /isn't valid JSON/);
    assert.equal(sceneOf(id).rev, 2, 'a refused scene changes nothing');
    assert.equal(store.restoreBlock(id, 1, sam).type === 'scene' && sceneOf(id).scene, QUARTERS);
  });

  it('pins a spot on a named object, which follows it and is lost with it', () => {
    const id = store.addBlock({ boardId }, { content: { type: 'scene', scene: QUARTERS } }, claude).id;
    const view = { eye: [3, 2, 5] as [number, number, number], target: [1.5, 1, 0] as [number, number, number] };
    const { pin } = store.pinComment(id, { kind: 'spot', object: 'q2', x: 0.2, y: 0.5, z: 0.5, view }, 'Taller than it should be', sam);
    assert.deepEqual(pin.anchor, { kind: 'spot', n: 1, x: 0.2, y: 0.5, z: 0.5, name: 'Q2', object: 'q2', view });
    assert.equal(pin.quote, 'spot 1 on "Q2"');
    const byName = store.pinComment(id, { kind: 'spot', object: 'Q3' }, 'And this one?', sam).pin;
    assert.deepEqual([byName.anchor.kind === 'spot' && [byName.anchor.x, byName.anchor.y, byName.anchor.z], byName.quote], [[0, 0, 0], 'spot 2 on "Q3"']);
    const loose = store.pinComment(id, { kind: 'spot', x: 9, y: 0, z: 0 }, 'Leave room here', sam).pin;
    assert.equal(loose.quote, 'spot 3');

    // Renamed but with its uuid, Q2 keeps its spot; Q3, gone, loses its own.
    store.updateBlock(id, { scene: scene(root(mesh('Q1'), mesh('Second quarter', { uuid: 'q2' }))) }, claude);
    const placed = (p: typeof pin) => placePin(sceneOf(id), p);
    assert.ok(placed(pin), 'found by its uuid');
    assert.equal(placed(byName), null);
    assert.ok(placed(loose), 'a point in the scene holds');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /spot 2 on "Q3", commented on, is no longer there/);

    assert.throws(() => store.pinComment(id, { kind: 'spot', object: 'Q9' }, 'x', sam), /scene "Q1" has no object named "Q9"\. Its named objects: "Q1" and "Second quarter"\./);
    assert.throws(() => store.pinComment(id, { kind: 'spot' }, 'x', sam), /A spot is on a named object \(object\), or at a point in the scene: x, y and z\./);
    assert.throws(() => store.pinComment(id, { kind: 'spot', x: 0, y: 0, z: 0, view: { eye: [1, 1, 1], target: [1, 1, 1] } }, 'x', sam), /two different points/);
    const plain = store.addBlock({ boardId }, { content: { type: 'scene', scene: scene(root({ type: 'Mesh', geometry: 'box', material: 'blue' })) } }, claude).id;
    assert.throws(() => store.pinComment(plain, { kind: 'spot', object: 'Lid' }, 'x', sam), /names none of its objects, so there's no "Lid" to pin/);
    const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'hi' } }, sam).id;
    assert.throws(() => store.pinComment(note, { kind: 'spot', x: 0, y: 0, z: 0 }, 'x', sam), /Spots are pinned on 3D scenes; note "hi" is a note\./);
  });
});

// ---- over MCP and REST ------------------------------------------------------------------------

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

describe('3D scene blocks over MCP and REST', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;
  let boardId: string;

  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content.map((c) => c.text).join('\n');
  }
  async function refused(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} should have been refused`);
    return result.content[0].text;
  }
  async function request(method: string, route: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body && JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  }
  const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-scene-mcp-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    boardId = idOf(await callText('create_board', { title: 'Quarters' }));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
    removeScratch(dir);
  });

  it('tells agents how to write one, with an example that loads', async () => {
    const { tools } = await client.listTools();
    const add = tools.find((t) => t.name === 'add_block')!;
    const props = (add.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
    assert.ok(props.type.enum!.includes('scene'));
    assert.match(props.scene.description!, /a three.js scene as JSON text, as Object3D.toJSON\(\) writes it and ObjectLoader reads it \(up to 200,000 characters\)/);
    assert.match(add.description!, /scene → scene \(three.js JSON\)/);
    const blocks = await readGuide(client, 'blocks');
    assert.match(blocks, /scene → scene: a three.js scene as JSON text, in the format Object3D.toJSON\(\) writes \(parametric geometries by type/);
    assert.ok(blocks.includes(`A small one: ${SCENE_EXAMPLE}.`));
    assert.match(blocks, /; image_path or image_base64 replaces an image; scene replaces a 3D scene's JSON whole\./);
    assert.match(JSON.stringify(tools.find((t) => t.name === 'pin')!.inputSchema), /A named object in a 3D scene: its name \(or uuid\)/);
  });

  it('adds one from its JSON, and agents read what it is made of and its source', async () => {
    const added = await callText('add_block', { board_id: boardId, type: 'scene', title: 'Done by quarter', scene: QUARTERS });
    assert.match(added, /^Added scene "Done by quarter" \[id: \w+\] \(rev 1\)\.$/);
    const canvas = await callText('get_canvas', { board_id: boardId });
    assert.match(
      canvas,
      /- scene "Done by quarter" \[id: \w+\] · rev 1 · by Claude \(agent\)\n {2}three.js scene · 4 objects: 3 meshes; 1 geometry, 1 material\n {2}Named: "Q1" \(Mesh\), "Q2" \(Mesh\), "Q3" \(Mesh\)\n {2}```json\n {2}\{"metadata"/,
    );
    assert.match(await callText('search', { board_id: boardId, query: 'Q2' }), /3D scene/);

    // A long source is cut where agents read the canvas; get_block gives it whole.
    const long = scene(root(...Array.from({ length: 40 }, (_, i) => mesh(`Bar ${i + 1}`, { position: [i, 0.5, 0] }))));
    const id = idOf(await callText('add_block', { board_id: boardId, type: 'scene', title: 'Long', scene: long }));
    assert.match(await callText('get_canvas', { board_id: boardId }), /… \(truncated; get_block for the rest\)/);
    assert.ok((await callText('get_block', { block_id: id })).includes(long));
  });

  it('changes it in place, keeping what it was as a version', async () => {
    const id = idOf(await callText('add_block', { board_id: boardId, type: 'scene', scene: QUARTERS }));
    assert.match(await callText('update_block', { block_id: id, rev: 1, scene: scene(root(mesh('Q1'), mesh('Q4'))) }), /^Updated scene "Q1" \[id: \w+\] \(now rev 2\)\./);
    assert.match(await callText('get_block', { block_id: id }), /- v2 \(current\) · .* · edited the scene \(added "Q4", removed "Q2" and "Q3"\)\n- v1 · .* · made it/);
    assert.match(await callText('update_block', { block_id: id, rev: 2, restore_rev: 1 }), /^Restored v1 of scene "Q1"/);
  });

  it('refuses a scene it cannot keep, saying why, and asks for names', async () => {
    assert.match(await refused('add_block', { board_id: boardId, type: 'scene' }), /A scene block needs scene: its three.js JSON, as Object3D.toJSON\(\) writes it\./);
    assert.match(await refused('add_block', { board_id: boardId, type: 'scene', scene: '{"object": {"type": "Scene"' }), /The scene isn't valid JSON/);
    const shader = scene(root(), { materials: [{ uuid: 'm', type: 'RawShaderMaterial' }] });
    assert.match(await refused('add_block', { board_id: boardId, type: 'scene', scene: shader }), /doesn't run shader code/);
    const note = idOf(await callText('add_block', { board_id: boardId, type: 'note', text: 'hi' }));
    assert.match(await refused('update_block', { block_id: note, rev: 1, scene: QUARTERS }), /A note block has no scene\./);
    const bare = await callText('add_block', { board_id: boardId, type: 'scene', scene: scene(root({ type: 'Mesh', geometry: 'box', material: 'blue' })) });
    assert.match(bare, /Name the objects people will talk about/);
  });

  it('pins work to a named object', async () => {
    const id = idOf(await callText('add_block', { board_id: boardId, type: 'scene', title: 'Bars', scene: QUARTERS }));
    const task = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Check Q2' }] }));
    assert.match(await callText('pin', { block_id: id, task_id: task, object: 'Q2' }), /^Pinned spot 1 on "Q2" in scene "Bars" to T\d+/);
    assert.match(await refused('pin', { block_id: id, task_id: task, object: 'Q7' }), /has no object named "Q7"\. Its named objects: "Q1", "Q2" and "Q3"\./);
    assert.match(await refused('pin', { block_id: id, task_id: task, object: 'Q2', row: 1 }), /Pin a scene object with object only\./);
    assert.match(await callText('get_canvas', { board_id: boardId }), /pinned spot 1 on "Q2" \(at x 0, y 0, z 0 on the object, uuid q2\) → T\d+/);
  });

  it('takes one people make and edit, and a spot they comment on', async () => {
    const made = await request('POST', '/canvas/blocks', { actor: 'Sam', boardId, content: { type: 'scene', scene: SCENE_EXAMPLE } });
    assert.equal(made.status, 201);
    assert.equal(made.json.scene, SCENE_EXAMPLE);
    const edited = await request('POST', `/canvas/blocks/${made.json.id}`, { actor: 'Sam', scene: editableSource(QUARTERS), rev: 1 });
    assert.deepEqual([edited.status, edited.json.rev], [200, 2]);
    const wrong = await request('POST', `/canvas/blocks/${made.json.id}`, { actor: 'Sam', scene: '{', rev: 2 });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /^The scene isn't valid JSON/);

    const comment = await request('POST', `/canvas/blocks/${made.json.id}/pins/comment`, {
      actor: 'Sam',
      part: { kind: 'spot', object: 'q1', x: 0.1, y: 0.5, z: 0.2, view: { eye: [2, 2, 4], target: [0, 0.5, 0] } },
      body: 'Make this one the highlight',
    });
    assert.equal(comment.status, 201);
    assert.deepEqual(comment.json.pin.anchor, { kind: 'spot', n: 1, x: 0.1, y: 0.5, z: 0.2, name: 'Q1', object: 'q1', view: { eye: [2, 2, 4], target: [0, 0.5, 0] } });
  });
});
