// What the server and the browser both know of a 3D scene block's source: a
// three.js scene written as JSON, in the format Object3D.toJSON() writes and
// ObjectLoader reads. Here are the checks a scene passes before it is kept
// (on the server) or saved from an edit (in the browser), what it is made of,
// which agents read in place of seeing it, and the words they read it in.
//
// A scene is data, never code: no shader materials, and nothing it would
// fetch from elsewhere. Pictures come embedded, as data: URLs.

import { BoardError } from '../../store/errors';
import { clip } from '../../format';
import type { Pin } from '../../types';

export const MAX_SCENE = 200_000; // characters: plenty for parametric scenes and a few small pictures
const MAX_OBJECTS = 5_000;
const MAX_DEPTH = 64;
const MAX_SEGMENTS = 256; // a parametric geometry's segments or steps
const MAX_DETAIL = 32; // a polyhedron's: its triangles grow with the square of it
const MAX_INSTANCES = 10_000; // an InstancedMesh's: three makes room for each, whatever the source holds

// What ObjectLoader makes of each, by type. An object of another type would
// load as an empty Object3D, so it is refused, saying what there is.
const OBJECT_TYPES = [
  'Scene', 'Group', 'Object3D', 'Mesh', 'InstancedMesh', 'SkinnedMesh', 'Bone', 'LOD', 'Line', 'LineLoop', 'LineSegments', 'Points', 'Sprite',
  'AmbientLight', 'DirectionalLight', 'HemisphereLight', 'PointLight', 'SpotLight', 'RectAreaLight', 'LightProbe', 'PerspectiveCamera', 'OrthographicCamera',
];
const DRAWN_WITH_GEOMETRY = new Set(['Mesh', 'InstancedMesh', 'SkinnedMesh', 'Line', 'LineLoop', 'LineSegments', 'Points']);
const GEOMETRY_TYPES = [
  'BoxGeometry', 'CapsuleGeometry', 'CircleGeometry', 'ConeGeometry', 'CylinderGeometry', 'DodecahedronGeometry', 'EdgesGeometry', 'ExtrudeGeometry',
  'IcosahedronGeometry', 'LatheGeometry', 'OctahedronGeometry', 'PlaneGeometry', 'PolyhedronGeometry', 'RingGeometry', 'ShapeGeometry', 'SphereGeometry',
  'TetrahedronGeometry', 'TorusGeometry', 'TorusKnotGeometry', 'TubeGeometry', 'WireframeGeometry', 'BufferGeometry',
];
const MATERIAL_TYPES = [
  'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshToonMaterial', 'MeshNormalMaterial',
  'MeshMatcapMaterial', 'MeshDepthMaterial', 'MeshDistanceMaterial', 'LineBasicMaterial', 'LineDashedMaterial', 'PointsMaterial', 'SpriteMaterial', 'ShadowMaterial',
];
const SHADERS = new Set(['ShaderMaterial', 'RawShaderMaterial']);

// A material's colours: numbers, as toJSON writes them (0x3b6fd6 is
// 3895254), or "#3b6fd6", which the browser reads as the number.
export const COLOUR_FIELDS = ['color', 'emissive', 'specular', 'sheenColor', 'specularColor', 'attenuationColor'];
export const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// A picture a scene may carry: embedded, as a data: URL.
const EMBEDDED_PICTURE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i;
// Anything that names another place to fetch from.
const ELSEWHERE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)/i;

// The example agents are given: a small scene that loads as it is.
export const SCENE_EXAMPLE =
  '{"metadata":{"version":4.6,"type":"Object"},"geometries":[{"uuid":"g1","type":"BoxGeometry","width":1,"height":1,"depth":1}],' +
  '"materials":[{"uuid":"m1","type":"MeshStandardMaterial","color":"#3b6fd6"}],' +
  '"object":{"type":"Scene","children":[{"type":"Mesh","name":"Crate","geometry":"g1","material":"m1","position":[0,0.5,0]}]}}';

// What a scene is made of. `named` are its objects with a name, which people
// pin spots on and agents name: a uuid when the source gives one.
export interface SceneObject {
  name: string;
  type: string;
  uuid?: string;
}

export interface SceneFacts {
  objects: number; // all told, the root included
  meshes: number;
  lights: number;
  cameras: number;
  geometries: number;
  materials: number;
  textures: number;
  animations: number;
  named: SceneObject[];
}

type Json = Record<string, unknown>;

const object = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const quoted = (value: unknown) => `"${clip(String(value), 40)}"`;
const some = (names: string[]) => `${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}`;

// How an object is called in a refusal: by its name, or its type and place.
const called = (node: Json, path: string) => (typeof node.name === 'string' && node.name ? `Object ${quoted(node.name)}` : `The ${String(node.type ?? 'object')} at ${path}`);
const which = (part: Json, kind: string, i: number) => `${kind} ${typeof part.uuid === 'string' ? quoted(part.uuid) : i + 1}`;

// Scenes read lately, by their source: the same scene is read again each time
// a block is drawn or listed, and its pins placed.
const read = new Map<string, { json: Json; facts: SceneFacts }>();

// Reads a scene's source and checks it, saying what to change when it can't
// be kept: its JSON, its shape, its references, and what it would fetch.
export function readScene(source: string): { json: Json; facts: SceneFacts } {
  const known = read.get(source);
  if (known) return known;
  if (!source.trim()) throw new BoardError('A scene needs its three.js JSON, as Object3D.toJSON() writes it.');
  if (source.length > MAX_SCENE) {
    throw new BoardError(
      `A scene holds up to ${MAX_SCENE.toLocaleString('en-US')} characters; this one has ${source.length.toLocaleString('en-US')}. Use parametric geometries (BoxGeometry and the like) rather than vertex arrays, and keep pictures small.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new BoardError(`The scene isn't valid JSON: ${(error as Error).message.replace(/\.$/, '')}.`);
  }
  const json = object(parsed);
  if (!json) throw new BoardError('The scene is JSON but not a three.js scene: it is an object with object (its root) and the geometries and materials that uses.');
  const facts = checkScene(json);
  if (read.size >= 16) read.delete(read.keys().next().value!);
  const result = { json, facts };
  read.set(source, result);
  return result;
}

function checkScene(json: Json): SceneFacts {
  const type = object(json.metadata)?.type;
  if (type !== undefined && type !== 'Object') {
    throw new BoardError(`The scene's metadata says it is ${quoted(type)}; a scene is "Object", as Object3D.toJSON() writes it.`);
  }
  outsideFetches(json);

  const geometries = new Set<string>();
  list(json.geometries).forEach((value, i) => {
    const geometry = object(value);
    if (!geometry || typeof geometry.uuid !== 'string' || !geometry.uuid) throw new BoardError(`Geometry ${i + 1} needs a uuid: meshes name their geometry by it.`);
    if (!GEOMETRY_TYPES.includes(geometry.type as string)) {
      throw new BoardError(`${which(geometry, 'Geometry', i)} has type ${quoted(geometry.type)}: a geometry is one of ${some(GEOMETRY_TYPES)} or BufferGeometry.`);
    }
    for (const [field, n] of Object.entries({ ...geometry, ...object(geometry.options) })) {
      const most = /detail/i.test(field) ? MAX_DETAIL : /segments|steps/i.test(field) ? MAX_SEGMENTS : Infinity;
      if (typeof n === 'number' && n > most) throw new BoardError(`${which(geometry, 'Geometry', i)} asks for ${n} ${field}; at most ${most} are drawn.`);
    }
    geometries.add(geometry.uuid);
  });

  const materials = new Set<string>();
  list(json.materials).forEach((value, i) => {
    const material = object(value);
    if (!material || typeof material.uuid !== 'string' || !material.uuid) throw new BoardError(`Material ${i + 1} needs a uuid: meshes name their material by it.`);
    if (SHADERS.has(material.type as string)) {
      throw new BoardError(`${which(material, 'Material', i)} is a ${material.type}: the board doesn't run shader code. Use MeshStandardMaterial or another built-in material.`);
    }
    if (!MATERIAL_TYPES.includes(material.type as string)) {
      throw new BoardError(`${which(material, 'Material', i)} has type ${quoted(material.type)}: a material is one of ${some(MATERIAL_TYPES)}.`);
    }
    for (const field of COLOUR_FIELDS) {
      const colour = material[field];
      const fine = colour === undefined || (Number.isInteger(colour) && (colour as number) >= 0 && (colour as number) <= 0xffffff) || (typeof colour === 'string' && HEX_COLOUR.test(colour));
      if (!fine) throw new BoardError(`${which(material, 'Material', i)} has ${field} ${JSON.stringify(colour)}: a colour is "#ff8800", or a number (0xff8800 is 16746496).`);
    }
    materials.add(material.uuid);
  });

  // Pictures come with the scene.
  for (const value of list(json.images)) {
    const image = object(value);
    for (const url of [image?.url].flat()) {
      if (typeof url === 'string' && !EMBEDDED_PICTURE.test(url)) {
        throw new BoardError(`The scene's picture ${quoted(url)} isn't embedded, and the board fetches nothing from elsewhere: give it as a data: URL (data:image/png;base64,…).`);
      }
    }
  }

  // Its objects, from the root down, each once.
  const root = object(json.object);
  if (!root) throw new BoardError('The scene has no object, its root: e.g. { "type": "Scene", "children": [ … ] }.');
  const facts: SceneFacts = {
    objects: 0,
    meshes: 0,
    lights: 0,
    cameras: 0,
    geometries: geometries.size,
    materials: materials.size,
    textures: list(json.textures).length,
    animations: list(json.animations).length,
    named: [],
  };
  const stack: { node: unknown; path: string; depth: number }[] = [{ node: root, path: 'object', depth: 0 }];
  while (stack.length > 0) {
    const { node: value, path, depth } = stack.pop()!;
    const node = object(value);
    if (!node) throw new BoardError(`${path} isn't an object: each child is { "type": …, … }.`);
    if (depth > MAX_DEPTH) throw new BoardError(`The scene nests objects more than ${MAX_DEPTH} deep.`);
    if (++facts.objects > MAX_OBJECTS) throw new BoardError(`A scene holds up to ${MAX_OBJECTS.toLocaleString('en-US')} objects.`);
    const type = node.type as string;
    if (!OBJECT_TYPES.includes(type)) {
      throw new BoardError(`${called(node, path)} has type ${quoted(type)}: an object is one of Mesh, Group, Scene, a light (PointLight, DirectionalLight…) or a camera.`);
    }
    for (const field of ['position', 'scale', 'rotation']) {
      const triple = node[field];
      if (triple !== undefined && !(Array.isArray(triple) && triple.length >= 3 && triple.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v)))) {
        throw new BoardError(`${called(node, path)} has ${field} ${clip(JSON.stringify(triple), 40)}: it is [x, y, z].`);
      }
    }
    if (type === 'InstancedMesh' && !(Number.isInteger(node.count) && (node.count as number) >= 0 && (node.count as number) <= MAX_INSTANCES)) {
      throw new BoardError(`${called(node, path)} has count ${clip(JSON.stringify(node.count), 20)}: an InstancedMesh draws from 0 to ${MAX_INSTANCES.toLocaleString('en-US')} copies.`);
    }
    if (DRAWN_WITH_GEOMETRY.has(type) && !geometries.has(node.geometry as string)) {
      throw new BoardError(`${called(node, path)} uses geometry ${quoted(node.geometry)}, which isn't among the scene's geometries.`);
    }
    for (const name of [node.material].flat()) {
      if (name !== undefined && !materials.has(name as string)) {
        throw new BoardError(`${called(node, path)} uses material ${quoted(name)}, which isn't among the scene's materials.`);
      }
    }
    if (type.includes('Mesh')) facts.meshes++;
    if (type.endsWith('Light') || type === 'LightProbe') facts.lights++;
    if (type.endsWith('Camera')) facts.cameras++;
    if (typeof node.name === 'string' && node.name.trim() && depth > 0) {
      facts.named.push({ name: node.name, type, ...(typeof node.uuid === 'string' && node.uuid ? { uuid: node.uuid } : {}) });
    }
    if (node.children !== undefined && !Array.isArray(node.children)) throw new BoardError(`${called(node, path)} has children that aren't a list.`);
    const children = list(node.children); // pushed last first, so they are read in the order the source gives them
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], path: `${path}.children[${i}]`, depth: depth + 1 });
  }
  return facts;
}

// Refuses anything in the scene that names somewhere to fetch from: ObjectLoader
// fetches pictures by their url, and nothing else here should name a place.
function outsideFetches(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === 'string') {
      if (ELSEWHERE.test(next)) throw new BoardError(`The scene names ${quoted(next)}, and the board fetches nothing from elsewhere: a scene brings what it uses with it.`);
    } else if (next && typeof next === 'object') {
      stack.push(...Object.values(next));
    }
  }
}

// A named object by its uuid, or else by its name.
export function findObject(facts: SceneFacts, uuid: string | undefined, name: string | undefined): SceneObject | undefined {
  return (uuid ? facts.named.find((o) => o.uuid === uuid) : undefined) ?? (name !== undefined ? facts.named.find((o) => o.name === name) : undefined);
}

// ---- how a scene reads ---------------------------------------------------------

const count = (n: number, word: string, words = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : words}`;

// "14 objects: 12 meshes, 2 lights; 2 geometries, 4 materials"
export function sceneMakeUp(facts: SceneFacts): string {
  const within = [count(facts.meshes, 'mesh', 'meshes'), facts.lights && count(facts.lights, 'light'), facts.cameras && count(facts.cameras, 'camera')];
  const uses = [count(facts.geometries, 'geometry', 'geometries'), count(facts.materials, 'material'), facts.textures && count(facts.textures, 'texture'), facts.animations && count(facts.animations, 'animation')];
  return `${count(facts.objects, 'object')}: ${within.filter(Boolean).join(', ')}; ${uses.filter(Boolean).join(', ')}`;
}

// Its named objects, as agents read them: "Crate" (Mesh), "Lamp" (Group), … and 8 more.
export function namedObjects(facts: SceneFacts, most = 24): string {
  const shown = facts.named.slice(0, most).map((o) => `"${clip(o.name, 50)}" (${o.type})`);
  return `${shown.join(', ')}${facts.named.length > most ? `, and ${facts.named.length - most} more` : ''}`;
}

// The next number for a spot pinned on a scene: one past its spots so far,
// so a spot keeps its number when another is unpinned.
export function nextSpot(pins: Pin[], blockId: string): number {
  return Math.max(0, ...pins.flatMap((p) => (p.blockId === blockId && p.anchor.kind === 'spot' ? [p.anchor.n] : []))) + 1;
}

// A spot's quote: spot 2 on "Crate".
export const spotQuote = (n: number, name?: string) => `spot ${n}${name ? ` on "${clip(name, 60)}"` : ''}`;

// The source as people edit it: laid out, when it came on one line.
export function editableSource(source: string): string {
  if (source.includes('\n')) return source;
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}
