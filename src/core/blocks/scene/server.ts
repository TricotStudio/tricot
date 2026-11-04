// What only REST and MCP need of 3D scene blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { SceneTypes } from './index';
import type { AgentHalf, PartWords, PeopleHalf, ServerHalf } from '../kind';
import { blockNamed, partAsksDigest, type AskWords } from '../asks';
import { pinWhere } from '../../digest';
import { missing, more } from '../shared';
import { BoardError } from '../../store/errors';
import { blockLabel } from '../../canvas';
import { listNames } from '../../format';
import type { SceneView } from '../../types';
import { MAX_SCENE, SCENE_EXAMPLE, findObject, namedObjects, nextSpot, readScene, sceneMakeUp, spotQuote, type SceneFacts } from './scene';

type Vec3 = [number, number, number];

// The source as it is kept, once it reads as a scene.
function sceneSource(source: string | undefined): string {
  if (source === undefined) throw missing('scene', 'scene: its three.js JSON, as Object3D.toJSON() writes it');
  readScene(source);
  return source;
}

const facts = (source: string): SceneFacts => readScene(source).facts;

// A coordinate as it is kept: 6 significant figures, plenty for a spot.
const kept = (v: number) => Number(v.toPrecision(6)) + 0;
const triple = (value: unknown): Vec3 | undefined =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (value.map(kept) as Vec3) : undefined;

// The view a spot was pinned from, checked: two points that aren't the same.
function checkedView(view: SceneView | undefined): SceneView | undefined {
  if (view === undefined) return undefined;
  const [eye, target] = [triple(view.eye), triple(view.target)];
  if (!eye || !target || eye.every((v, i) => v === target[i])) throw new BoardError("A spot's view is eye and target: two different points, each [x, y, z].");
  return { eye, target };
}

// A scene with nothing named has nothing for people to pin spots on, or agents to name.
const unnamedAdvice = (source: string) =>
  facts(source).named.length === 0 ? ["Name the objects people will talk about (a name on each): spots people pin are on named objects, and you're told which."] : [];

// What changed, in the objects it names: added "Q4", removed "Q1".
function describeScene(before: string, after: string): string {
  const [was, now] = [safeFacts(before), safeFacts(after)];
  if (!was || !now) return 'edited the scene';
  const names = (f: SceneFacts) => new Set(f.named.map((o) => o.name));
  const [had, has] = [names(was), names(now)];
  const added = [...has].filter((n) => !had.has(n)).map((n) => `"${n}"`);
  const removed = [...had].filter((n) => !has.has(n)).map((n) => `"${n}"`);
  const parts = [added.length && `added ${listNames(added.slice(0, 3))}${added.length > 3 ? ' and more' : ''}`, removed.length && `removed ${listNames(removed.slice(0, 3))}${removed.length > 3 ? ' and more' : ''}`];
  const said = parts.filter(Boolean).join(', ');
  return said ? `edited the scene (${said})` : 'edited the scene';
}

function safeFacts(source: string): SceneFacts | undefined {
  try {
    return facts(source);
  } catch {
    return undefined;
  }
}

// Its named objects take requests (core/parts.ts): people click one in its
// full view and ask an agent to change it, which it does by sending the
// scene's JSON whole. Spots stay on their objects while the scene keeps
// them, by uuid or name, wherever they move.
const part: PartWords = {
  kind: 'scene',
  anchors: ['spot'],
  ask: {
    verb: 'change',
    asking: 'asking agents to change it in the 3D scene',
    doing: "Change the scene's JSON with update_block, keeping its objects' names, then reply",
    act: "change the scene's JSON with update_block, keeping its objects' names, then ",
    request: 'request to change the 3D scene, ',
    what: "a 3D scene's objects",
  },
};

const ask: AskWords = {
  part: ({ pin, block }) => `${pin.quote}${pinWhere(pin)} of ${blockNamed(block, '3D scene')}`,
  how: ({ block }) =>
    `Change the scene with update_block (block_id: ${block.id}, scene: its whole three.js JSON, as get_block gives it), keeping the name (and uuid) of each object you keep: spots stay on their objects by them`,
  view: 'the scene',
};

export const agent: AgentHalf<SceneTypes> = {
  addShape: {
    scene: z
      .string()
      .optional()
      .describe(`Scene blocks: a three.js scene as JSON text, as Object3D.toJSON() writes it and ObjectLoader reads it (up to ${MAX_SCENE.toLocaleString('en-US')} characters)`),
  },
  updateShape: { scene: z.string().optional() },
  docs: {
    add: 'scene → scene: a three.js scene as JSON text, in the format Object3D.toJSON() writes (parametric geometries by type, e.g. BoxGeometry with width, height, depth; built-in materials; colours as "#rrggbb" or numbers; objects with name, position, rotation and scale; no shaders; pictures only as data: URLs)',
    guide: `Show people a 3D scene with a scene block: they turn it, zoom and pin comments to its named objects, so name the objects people will talk about. Without lights or a camera of its own it is lit evenly and framed whole. A small one: ${SCENE_EXAMPLE}. You read its make-up and source, not how it looks.`,
    updateSpecial: "scene replaces a 3D scene's JSON whole",
  },
  read(args) {
    const scene = sceneSource(args.scene as string | undefined);
    return () => ({ type: 'scene', scene });
  },
  patch: (args) => ({ scene: args.scene as string | undefined }),
  adviceAdded: (block) => unnamedAdvice(block.scene),
  adviceUpdated: (block, args) => (args.scene !== undefined ? unnamedAdvice(block.scene) : []),
  asks: partAsksDigest(part, ask),
  pinShape: {
    object: z.string().optional().describe('A named object in a 3D scene: its name (or uuid)'),
  },
  pinPart(_block, args) {
    if (args.object === undefined) return undefined;
    const others = ['text', 'item', 'row', 'to_row', 'column', 'to_column', 'node', 'to_node', 'box', 'category', 'series', 'file', 'line', 'side'];
    if (others.some((name) => args[name] !== undefined)) throw new BoardError('Pin a scene object with object only.');
    return { kind: 'spot', object: String(args.object) };
  },
};

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('scene'), scene: z.string() }),
  patch: { scene: z.string().optional() },
};

export const server: ServerHalf<SceneTypes> = {
  patchFields: ['scene'],

  create: (input) => ({ scene: sceneSource(input.scene) }),

  change({ block, patch }) {
    if (patch.scene === undefined) return undefined;
    const scene = sceneSource(patch.scene);
    return {
      apply() {
        block.scene = scene;
      },
    };
  },

  describe: (before, after) => (before.scene !== after.scene ? [describeScene(before.scene, after.scene)] : []),
  snapshot: (block) => ({ scene: block.scene }),
  restorePatch: (version) => ({ scene: version.scene }),

  // Its make-up and named objects, then its source, as a diagram's is given.
  digest(block, full) {
    const made = safeFacts(block.scene);
    const lines = made ? [`three.js scene · ${sceneMakeUp(made)}`, made.named.length ? `Named: ${namedObjects(made)}` : 'No named objects.'] : ['three.js scene (it no longer reads)'];
    return [...lines, '```json', full ? block.scene : more(block.scene), '```'].join('\n');
  },
  searchText: (block) => [safeFacts(block.scene)?.named.map((o) => o.name).join(' · ')],

  anchor(block, part, pins) {
    if (part.kind !== 'spot') return undefined;
    const made = facts(block.scene);
    const named = part.object !== undefined ? findObject(made, part.object, part.object) : undefined;
    if (part.object !== undefined && !named) {
      const names = made.named.slice(0, 20).map((o) => `"${o.name}"`);
      throw new BoardError(
        names.length
          ? `${blockLabel(block)} has no object named "${part.object}". Its named objects: ${listNames(names)}${made.named.length > names.length ? ', …' : ''}.`
          : `${blockLabel(block)} names none of its objects, so there's no "${part.object}" to pin: give the objects people talk about a name.`,
      );
    }
    const given = [part.x, part.y, part.z];
    const at = given.every((v) => v === undefined) && named ? ([0, 0, 0] as Vec3) : triple(given); // on an object: its middle, unless a point is given
    if (!at) throw new BoardError('A spot is on a named object (object), or at a point in the scene: x, y and z.');
    const view = checkedView(part.view);
    const n = nextSpot(pins, block.id);
    const on = named && { name: named.name, ...(named.uuid ? { object: named.uuid } : {}) };
    return { anchor: { kind: 'spot', n, x: at[0], y: at[1], z: at[2], ...on, ...(view ? { view } : {}) }, quote: spotQuote(n, named?.name) };
  },
  part,

  agent,
  people,
};
