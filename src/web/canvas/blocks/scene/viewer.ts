// A 3D scene drawn with three.js, for a scene block. This module and three.js
// load only when a scene block comes on screen (scene.tsx imports it then),
// so the board's own bundle doesn't carry them.
//
// The scene's source is read by ObjectLoader and nothing else: it is data,
// checked before it was kept (core/blocks/scene/scene.ts), and anything in it
// that would fetch from elsewhere is given an empty picture instead. The
// scene sits untransformed in the view, so a point in the view is a point in
// the scene's own coordinates, which spots are pinned in.

import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  LoadingManager,
  MathUtils,
  type Mesh,
  NeutralToneMapping,
  type Object3D,
  ObjectLoader,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { COLOUR_FIELDS, HEX_COLOUR } from '../../../../core/blocks/scene/scene';
import type { SceneView } from '../../../../core/types';

export type Vec3 = [number, number, number];

// Where a new view looks from: in front, to the right and a little above.
const FROM: Vec3 = [0.85, 0.6, 1.3];

// What a fetch the scene shouldn't make gets instead: an empty picture.
const NOTHING = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Too many triangles to cast a ray through for each spot as the view settles:
// spots on such a scene show whether or not something is in front of them.
const MAX_OCCLUSION_TRIANGLES = 300_000;

export interface Projected {
  x: number; // in CSS pixels from the canvas's top left
  y: number;
  behind: boolean; // behind the camera, or hidden by the scene
}

// A spot as the view finds it: a point, in the coordinates of the named
// object it is on (by uuid, or else name), or of the scene.
export interface Located {
  point: Vec3;
  object?: string;
  name?: string;
}

// What a click lands on: the point, in the scene and in the named object's
// own coordinates, and that object.
export interface Picked {
  world: Vec3;
  local: Vec3;
  object?: { uuid: string; name: string };
}

export class WebGLMissing extends Error {}

export class SceneViewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly light = new DirectionalLight(0xffffff, 1.6);
  private readonly fill = new HemisphereLight(0xffffff, 0x8d8d86, 0.6);
  private readonly raycaster = new Raycaster();
  private root: Object3D | null = null;
  private triangles = 0;
  private home: SceneView | null = null; // the fitted view, which Reset goes back to
  private radius = 1;
  private frame = 0;
  private tween = 0;
  private hidden = new Map<string, boolean>(); // spots something stands in front of, as the view last settled
  private disposed = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  // onFrame: after each frame drawn, to move what is drawn over the canvas.
  // onSettle: once the view stops moving.
  constructor(
    private readonly host: HTMLElement,
    private readonly onFrame: () => void,
    private readonly onSettle: () => void,
  ) {
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      throw new WebGLMissing('WebGL is off or unavailable in this browser.');
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.domElement.className = 'scene-canvas';
    host.prepend(this.renderer.domElement);

    // Soft studio light all round, a light from where the viewer is, and a
    // little from above: shapes read on either theme, and no side goes black.
    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.add(this.fill, this.light, this.light.target);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.enableZoom = false; // until the block is selected: the wheel pans the canvas meanwhile
    this.controls.addEventListener('change', () => this.render());
    this.resize();
  }

  // Reads a scene's source and shows it: framed whole the first time, or
  // from `keep` (where it was being seen from). Throws what ObjectLoader says
  // when it can't make the scene.
  async show(source: string, keep?: SceneView): Promise<void> {
    const manager = new LoadingManager();
    manager.setURLModifier((url) => (url.startsWith('data:image/') ? url : NOTHING));
    const root = await new ObjectLoader(manager).parseAsync(prepared(source));
    if (this.disposed) return release(root);
    if (this.root) {
      this.scene.remove(this.root);
      release(this.root);
    }
    this.root = root;
    this.scene.add(root);
    // A scene's own background colour, if it has one; else the block's surface shows through.
    this.scene.background = root instanceof Scene && root.background instanceof Color ? root.background : null;

    // Its own lights, if it has any; else even light from the viewer's side.
    let lights = 0;
    let camera: PerspectiveCamera | undefined;
    this.triangles = 0;
    root.traverse((part) => {
      if ((part as { isLight?: boolean }).isLight) lights++;
      if ((part as PerspectiveCamera).isPerspectiveCamera) camera ??= part as PerspectiveCamera;
      const geometry = (part as Mesh).isMesh ? (part as Mesh).geometry : undefined;
      if (geometry) this.triangles += (geometry.index ? geometry.index.count : (geometry.getAttribute('position')?.count ?? 0)) / 3;
    });
    this.fill.visible = this.light.visible = lights === 0;
    this.scene.environmentIntensity = lights === 0 ? 0.75 : 0.35;

    root.updateWorldMatrix(true, true);
    const sphere = new Box3().setFromObject(root).getBoundingSphere(new Sphere());
    this.radius = sphere.radius > 0 && Number.isFinite(sphere.radius) ? sphere.radius : 1;
    this.home = camera ? viewFrom(camera, sphere.center) : this.fitted(sphere.center);
    this.camera.near = this.radius / 100;
    this.camera.far = this.radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.radius * 0.1;
    this.controls.maxDistance = this.radius * 12;
    this.setView(keep ?? this.home, false);
  }

  get shown(): boolean {
    return this.root !== null;
  }

  // The whole scene in view, from in front, to the right and a little above.
  private fitted(centre: Vector3): SceneView {
    const eye = new Vector3(...FROM).normalize().multiplyScalar(this.fitDistance()).add(centre);
    return { eye: eye.toArray() as Vec3, target: centre.toArray() as Vec3 };
  }

  // How far the camera stands to see the whole scene, whichever way the block is longer.
  private fitDistance(): number {
    const vertical = (this.camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    return (this.radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.08;
  }

  view(): SceneView {
    const round = (v: Vector3) => v.toArray().map((n) => Number(n.toPrecision(6))) as Vec3;
    return { eye: round(this.camera.position), target: round(this.controls.target) };
  }

  // Turns to a view: at once, or over a moment.
  setView(view: SceneView, animate = true): void {
    cancelAnimationFrame(this.tween);
    this.tween = 0;
    const [eye, target] = [new Vector3(...view.eye), new Vector3(...view.target)];
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.camera.position.copy(eye);
      this.controls.target.copy(target);
      this.controls.update();
      this.render();
      return;
    }
    const [fromEye, fromTarget] = [this.camera.position.clone(), this.controls.target.clone()];
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 320);
      const eased = 1 - (1 - t) ** 3;
      this.camera.position.lerpVectors(fromEye, eye, eased);
      this.controls.target.lerpVectors(fromTarget, target, eased);
      this.controls.update();
      this.render();
      this.tween = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.tween = requestAnimationFrame(step);
  }

  reset(): void {
    if (this.home) this.setView(this.home);
  }

  // A view of a spot pinned without one (by an agent): from outside the
  // scene, through the spot towards its middle.
  viewOf(spot: Vec3): SceneView {
    const target = new Vector3(...spot);
    const centre = this.home ? new Vector3(...this.home.target) : new Vector3();
    const out = target.clone().sub(centre);
    if (out.lengthSq() < 1e-12) out.set(...FROM);
    const eye = out.normalize().add(new Vector3(0, 0.35, 0)).normalize().multiplyScalar(this.fitDistance() * 0.8).add(target);
    return { eye: eye.toArray() as Vec3, target: spot };
  }

  // Turns by a step from the keyboard: round the scene, up and down, or nearer.
  turn(left: number, up: number): void {
    this.controls.rotateLeft(left);
    this.controls.rotateUp(up);
    this.controls.update();
  }

  zoom(nearer: boolean): void {
    if (nearer) this.controls.dollyIn(1.2);
    else this.controls.dollyOut(1.2);
    this.controls.update();
  }

  // Whether the wheel and a pinch zoom the scene (once its block is selected).
  set zoomable(value: boolean) {
    this.controls.enableZoom = value;
  }

  // What is under a place on the canvas (fractions of its width and height
  // from its top left): the point, and the named object it is on, the
  // nearest named one holding what was hit. Null off the scene.
  pick(x: number, y: number): Picked | null {
    if (!this.root) return null;
    this.raycaster.setFromCamera(new Vector2(x * 2 - 1, -y * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObject(this.root, true).find((h) => (h.object as Mesh).isMesh);
    if (!hit) return null;
    let named: Object3D | null = hit.object;
    while (named && named !== this.root && !named.name.trim()) named = named.parent;
    const on = named && named !== this.root ? named : null;
    const world = hit.point.toArray() as Vec3;
    if (!on) return { world, local: world };
    return { world, local: on.worldToLocal(hit.point.clone()).toArray() as Vec3, object: { uuid: on.uuid, name: on.name } };
  }

  // Where a spot is in the scene now: on its object, wherever that has moved.
  locate(spot: Located): Vec3 | null {
    if (!this.root) return null;
    if (spot.name === undefined) return spot.point;
    const on = (spot.object && this.root.getObjectByProperty('uuid', spot.object)) || this.root.getObjectByName(spot.name);
    return on ? (on.localToWorld(new Vector3(...spot.point)).toArray() as Vec3) : null;
  }

  // Where a point of the scene is drawn on the canvas.
  project(point: Vec3, key?: string): Projected {
    const at = new Vector3(...point).project(this.camera);
    const { clientWidth: width, clientHeight: height } = this.renderer.domElement;
    const behind = at.z > 1 || (key !== undefined && this.hidden.get(key) === true);
    return { x: ((at.x + 1) / 2) * width, y: ((1 - at.y) / 2) * height, behind };
  }

  // Which spots something in the scene stands in front of, worked out once
  // the view stops moving (a ray each).
  occlude(spots: { key: string; point: Vec3 }[]): void {
    this.hidden.clear();
    if (!this.root || this.triangles > MAX_OCCLUSION_TRIANGLES) return;
    const eye = this.camera.position;
    for (const { key, point } of spots) {
      const to = new Vector3(...point);
      const distance = eye.distanceTo(to);
      this.raycaster.set(eye, to.clone().sub(eye).normalize());
      this.raycaster.far = distance;
      const first = this.raycaster.intersectObject(this.root, true).find((h) => (h.object as Mesh).isMesh);
      this.hidden.set(key, Boolean(first && first.distance < distance - this.radius * 0.02));
    }
    this.raycaster.far = Infinity;
  }

  // Fits the drawing to the canvas's size, sharp at the board's zoom.
  resize(zoom = 1): void {
    const { clientWidth: width, clientHeight: height } = this.host;
    if (!width || !height) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * Math.max(zoom, 1), 3));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  // Draws on the next frame (once, however often it is asked).
  render(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      // Easing to a stop asks for frames as it goes; once the view is still, it settles.
      const moving = this.controls.update() || this.tween !== 0;
      if (moving) clearTimeout(this.settleTimer);
      else this.settleSoon();
      // The light comes from just above and left of the viewer, so the side in view is lit.
      const offset = new Vector3(-0.6, 0.9, 0.3).multiplyScalar(this.radius * 2).applyQuaternion(this.camera.quaternion);
      this.light.position.copy(this.camera.position).add(offset);
      this.light.target.position.copy(this.controls.target);
      this.renderer.render(this.scene, this.camera);
      this.onFrame();
    });
  }

  private settleSoon(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => !this.disposed && this.onSettle(), 150);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.tween);
    clearTimeout(this.settleTimer);
    this.controls.dispose();
    if (this.root) release(this.root);
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // browsers keep few WebGL contexts: give this one back now
    this.renderer.domElement.remove();
  }
}

// The scene's source as ObjectLoader takes it: colours written "#3b6fd6" made
// numbers, and an object with no uuid given one (ObjectLoader leaves it unset).
function prepared(source: string): Record<string, unknown> {
  const json = JSON.parse(source) as Record<string, unknown>;
  for (const material of [json.materials].flat() as Record<string, unknown>[]) {
    if (!material || typeof material !== 'object') continue;
    for (const field of COLOUR_FIELDS) {
      const colour = material[field];
      if (typeof colour === 'string' && HEX_COLOUR.test(colour)) material[field] = new Color(colour).getHex();
    }
  }
  const stack = [json.object];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown> | undefined;
    if (!node || typeof node !== 'object') continue;
    if (typeof node.uuid !== 'string') node.uuid = MathUtils.generateUUID();
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return json;
}

// The view from a scene's own camera: where it stands, looking as it looks,
// at the scene's middle's distance.
function viewFrom(camera: PerspectiveCamera, centre: Vector3): SceneView {
  const eye = camera.getWorldPosition(new Vector3());
  const ahead = camera.getWorldDirection(new Vector3());
  const target = eye.clone().add(ahead.multiplyScalar(Math.max(eye.distanceTo(centre), 1e-3)));
  return { eye: eye.toArray() as Vec3, target: target.toArray() as Vec3 };
}

// Frees what the scene took on the graphics card: geometry, materials, textures.
function release(root: Object3D): void {
  root.traverse((part) => {
    const mesh = part as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of [mesh.material].flat()) {
      for (const value of Object.values(material)) {
        if (value && typeof value === 'object' && 'isTexture' in value) (value as { dispose(): void }).dispose();
      }
      material.dispose();
    }
  });
}
