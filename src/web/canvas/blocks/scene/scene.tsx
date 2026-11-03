// How a 3D scene block is drawn: the scene, which people turn by dragging
// (or with the arrow keys) and zoom once the block is selected, and the spots
// pinned on it, numbered. Clicking an object pins a spot on it, with the view
// it was seen from; double-clicking edits the scene's JSON, as a diagram's
// source is edited. three.js comes with viewer.ts, loaded once a scene block
// is on screen; where WebGL isn't available, the block says what the scene
// is made of instead.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { useStore } from '@xyflow/react';
import { editableSource, findObject, nextSpot, readScene, sceneMakeUp, spotQuote, type SceneFacts } from '../../../../core/blocks/scene/scene';
import type { Block, Pin, SceneView } from '../../../../core/types';
import { useCanvas } from '../../context';
import { DRAFT, useClickPick, type PlacedPin } from '../../pins';
import { dragged, draftOf, selecting, useLongEdit } from '../interaction';
import type { SceneViewer, Vec3 } from './viewer';
import './scene.css';

export type SceneBlock = Extract<Block, { type: 'scene' }>;

// three.js and the viewer, fetched once, the first time a scene is on screen.
let viewerModule: Promise<typeof import('./viewer')> | undefined;
function loadViewer() {
  viewerModule ??= import('./viewer').catch((error: unknown) => {
    viewerModule = undefined; // a failed fetch is tried again next time
    throw error;
  });
  return viewerModule;
}

// Where each scene was last seen from, so it comes back that way when it
// comes on screen again, or is drawn again after an edit.
const lastViews = new Map<string, SceneView>();

// Each scene block's editor, for its toolbar's Edit button to open.
const editors = new Map<string, () => void>();
export const editScene = (blockId: string) => editors.get(blockId)?.();

function factsOf(source: string): SceneFacts | null {
  try {
    return readScene(source).facts;
  } catch {
    return null;
  }
}

// Whether an element is within sight: scenes are drawn only then, and their
// WebGL context given back once they scroll away.
function useOnScreen(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const observer = new IntersectionObserver(([entry]) => setOn(entry.isIntersecting), { rootMargin: '160px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return on && enabled;
}

type Shown = 'waiting' | 'loading' | 'shown' | 'no-webgl' | { error: string };

interface Spot {
  key: string;
  point: Vec3; // in the coordinates of the object it is on, or of the scene
  object?: string;
  name?: string;
  n: number;
  draft: boolean;
  pin?: Pin;
  view?: SceneView;
}

// A step of the arrow keys, round the scene or up and down.
const STEP = Math.PI / 12;

export function SceneBody({ block, selected, placed }: { block: SceneBlock; selected: boolean; placed: PlacedPin[] }) {
  const canvas = useCanvas();
  const edit = useLongEdit(block.id);
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<SceneViewer | null>(null);
  const markers = useRef(new Map<string, HTMLElement>());
  const pressedAt = useRef({ x: 0, y: 0 });
  const pick = useClickPick();
  const [made, setMade] = useState(0); // counts viewers made, so the scene is shown in each
  const [shown, setShown] = useState<Shown>('waiting');
  const onScreen = useOnScreen(stage, !edit.editing);
  const zoom = useStore((s) => s.transform[2]);
  const facts = factsOf(block.scene);
  const viewKey = block.id;

  useEffect(() => {
    editors.set(block.id, edit.start);
    return () => void editors.delete(block.id);
  }, [block.id, edit.start]);

  const draft = draftOf(canvas.draft, block.id, 'spot');
  const next = nextSpot(
    placed.map(({ pin }) => pin),
    block.id,
  );
  const spots: Spot[] = [
    ...placed.flatMap(({ pin, place }) =>
      place?.kind === 'spot' ? [{ key: pin.id, point: [place.x, place.y, place.z] as Vec3, object: place.object, name: place.name, n: place.n, draft: false, pin, view: place.view }] : [],
    ),
    ...(draft ? [{ key: DRAFT, point: [draft.x, draft.y, draft.z] as Vec3, object: draft.object, name: draftName(facts, draft.object), n: next, draft: true, view: draft.view }] : []),
  ];
  const spotsRef = useRef(spots);
  spotsRef.current = spots;

  // Moves each spot's marker to where its point is drawn, after each frame.
  const placeMarkers = useCallback(() => {
    const view = viewer.current;
    if (!view?.shown) return;
    for (const spot of spotsRef.current) {
      const marker = markers.current.get(spot.key);
      const at = view.locate(spot);
      if (!marker || !at) continue;
      const drawn = view.project(at, spot.key);
      marker.style.transform = `translate(${drawn.x}px, ${drawn.y}px)`;
      marker.classList.toggle('is-behind', drawn.behind);
    }
  }, []);

  // Once the view stops moving: which spots the scene hides, and where it was seen from.
  const settled = useCallback(() => {
    const view = viewer.current;
    if (!view?.shown) return;
    view.occlude(spotsRef.current.flatMap((spot) => {
      const point = view.locate(spot);
      return point ? [{ key: spot.key, point }] : [];
    }));
    placeMarkers();
    lastViews.set(viewKey, view.view());
  }, [placeMarkers, viewKey]);

  // The viewer, while the block is on screen.
  useEffect(() => {
    if (!onScreen || !host.current) return;
    const element = host.current;
    let alive = true;
    let mine: SceneViewer | null = null;
    setShown('loading');
    loadViewer().then(
      ({ SceneViewer, WebGLMissing }) => {
        if (!alive) return;
        try {
          mine = new SceneViewer(element, placeMarkers, settled);
        } catch (error) {
          setShown(error instanceof WebGLMissing ? 'no-webgl' : { error: (error as Error).message });
          return;
        }
        viewer.current = mine;
        setMade((n) => n + 1);
      },
      (error: unknown) => alive && setShown({ error: `three.js didn't load (${(error as Error)?.message ?? 'no connection'}).` }),
    );
    return () => {
      alive = false;
      mine?.dispose();
      viewer.current = null;
    };
  }, [onScreen, placeMarkers, settled]);

  // The scene, shown in it: again after each edit, from where it was being seen.
  useEffect(() => {
    const view = viewer.current;
    if (!made || !view) return;
    let alive = true;
    view.show(block.scene, lastViews.get(viewKey)).then(
      () => alive && setShown('shown'),
      (error: unknown) => alive && setShown({ error: (error as Error)?.message || 'three.js could not make it' }),
    );
    return () => {
      alive = false;
    };
  }, [made, block.scene, viewKey]);

  // Its drawing follows the block's size, and stays sharp as the board zooms
  // (once the zoom rests: a new drawing size each frame would stutter).
  useEffect(() => {
    const element = host.current;
    if (!element || shown !== 'shown') return;
    const observer = new ResizeObserver(() => viewer.current?.resize(zoom));
    observer.observe(element);
    const timer = setTimeout(() => viewer.current?.resize(zoom), 200);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [shown, zoom]);

  // The wheel zooms the scene once the block is selected; before, it pans the canvas.
  useEffect(() => {
    if (viewer.current) viewer.current.zoomable = selected;
  }, [selected, shown]);

  // Spots added, moved or edited onto other objects: placed now, and checked for what hides them.
  const spotKeys = spots.map((s) => `${s.key}@${s.point.join(',')}@${s.name ?? ''}`).join(' ');
  useEffect(() => {
    if (shown === 'shown') settled();
  }, [spotKeys, shown, settled, block.scene]);

  // A spot's thread opened, or a comment about it shown: the scene turns to
  // the view it was pinned from.
  const focused = spots.find((s) => !s.draft && (s.key === canvas.thread || s.key === canvas.focusPin));
  useEffect(() => {
    const view = viewer.current;
    if (!focused || !view?.shown) return;
    const at = view.locate(focused);
    if (focused.view) view.setView(focused.view);
    else if (at) view.setView(view.viewOf(at));
  }, [focused?.key, shown]); // only when another spot is focused

  // A spot where a click landed: on the named object it hit, in its coordinates.
  const pinAt = (x: number, y: number) => {
    const view = viewer.current;
    const hit = view?.pick(x, y);
    if (!view || !hit) return false;
    const named = hit.object && facts ? findObject(facts, hit.object.uuid, hit.object.name) : undefined;
    const [px, py, pz] = named ? hit.local : hit.world;
    const object = named ? (named.uuid ?? named.name) : undefined;
    const part = { kind: 'spot' as const, ...(object ? { object } : {}), x: px, y: py, z: pz, view: view.view() };
    canvas.startPin({ blockId: block.id, part, quote: spotQuote(next, named?.name) });
    return true;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const view = viewer.current;
    if (!view?.shown || event.metaKey || event.ctrlKey || event.altKey) return;
    const keys: Record<string, () => unknown> = {
      ArrowLeft: () => view.turn(-STEP, 0),
      ArrowRight: () => view.turn(STEP, 0),
      ArrowUp: () => view.turn(0, -STEP),
      ArrowDown: () => view.turn(0, STEP),
      '+': () => view.zoom(true),
      '=': () => view.zoom(true),
      '-': () => view.zoom(false),
      '0': () => view.reset(),
      Enter: () => !canvas.readOnly && pinAt(0.5, 0.5), // a spot in the middle of the view
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    event.stopPropagation();
    act();
  };

  if (edit.editing) return <SourceEditor block={block} edit={edit} />;

  const ready = shown === 'shown';
  const hint = canvas.readOnly
    ? 'Drag to turn it; select the block to zoom with the wheel. Arrow keys turn it, + and − zoom, 0 resets.'
    : 'Drag to turn it, click an object to comment on a spot of it, double-click to edit its JSON. Select the block to zoom with the wheel. Arrow keys turn it, + and − zoom, 0 resets, Enter pins the middle.';

  return (
    <div
      ref={stage}
      className={`scene-stage nodrag nopan${selected ? ' nowheel' : ''}${ready && !canvas.readOnly ? ' is-pinnable' : ''}`}
      tabIndex={0}
      role="application"
      aria-roledescription="3D scene"
      aria-label={`${facts ? `three.js scene of ${sceneMakeUp(facts)}` : 'three.js scene'}. ${hint}`}
      title={ready ? hint : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        pressedAt.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        // A drag turned the scene: it doesn't also select the block.
        if (dragged(e, pressedAt.current)) return e.stopPropagation();
        if (!ready || canvas.readOnly || selecting(e) || e.detail !== 1 || !host.current) return;
        const rect = host.current.getBoundingClientRect();
        const [x, y] = [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
        // Off the scene, a click selects the block; on it, it pins, once it isn't a double-click.
        if (!viewer.current?.pick(x, y)) return;
        e.stopPropagation();
        pick.later(() => pinAt(x, y));
      }}
      onDoubleClickCapture={pick.cancel}
      onDoubleClick={(e) => {
        e.stopPropagation();
        edit.start();
      }}
    >
      <div ref={host} className="scene-view" />
      {ready && (
        <div className="scene-spots">
          {spots.map((spot) => (
            <SpotMarker
              key={spot.key}
              spot={spot}
              style={markerStyle(viewer.current, spot)}
              focus={spot.key === canvas.focusPin}
              markers={markers.current}
              onOpen={spot.pin?.discussion?.thread ? () => canvas.openThread(spot.pin!.id) : undefined}
            />
          ))}
        </div>
      )}
      {ready && (
        <button
          type="button"
          className="scene-reset"
          title="Reset the view (0)"
          aria-label="Reset the view"
          onClick={(e) => {
            e.stopPropagation();
            viewer.current?.reset();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3.5 6.5A4.75 4.75 0 1 1 3.4 9.6M3.25 3.5v3h3" />
          </svg>
        </button>
      )}
      {!ready && <Standing facts={facts} shown={shown} />}
    </div>
  );
}

// The name of the object a spot being pinned is on.
function draftName(facts: SceneFacts | null, object: string | undefined): string | undefined {
  return object !== undefined && facts ? findObject(facts, object, object)?.name : undefined;
}

// Where a marker starts, before the next frame moves it: drawn in place at
// once, so a prompt opened by it is put beside it.
function markerStyle(viewer: SceneViewer | null, spot: Spot): CSSProperties | undefined {
  const at = viewer?.shown ? viewer.locate(spot) : null;
  if (!viewer || !at) return { visibility: 'hidden' };
  const drawn = viewer.project(at, spot.key);
  return { transform: `translate(${drawn.x}px, ${drawn.y}px)` };
}

// A spot pinned on the scene, numbered as its chip is in the strip under it:
// amber while its prompt is open, blue once linked, faint when something in
// the scene stands in front of it. One with a thread opens it.
function SpotMarker(props: { spot: Spot; style?: CSSProperties; focus: boolean; markers: Map<string, HTMLElement>; onOpen?: () => void }) {
  const { spot, style, focus, markers, onOpen } = props;
  const classes = ['scene-spot', spot.draft ? 'is-draft' : 'is-linked', focus && 'is-focus', onOpen && 'is-open-able'];
  const label = `Spot ${spot.n}${spot.name ? ` on "${spot.name}"` : ''}`;
  return (
    <span
      ref={(element) => {
        if (element) markers.set(spot.key, element);
        else markers.delete(spot.key);
      }}
      className={classes.filter(Boolean).join(' ')}
      style={style}
      data-pin-draft={spot.key === DRAFT ? '' : undefined}
      title={onOpen ? `${label}: open its comments` : label}
      onClick={
        onOpen &&
        ((e) => {
          e.stopPropagation();
          onOpen();
        })
      }
    >
      <span className="scene-spot-n">{spot.n}</span>
    </span>
  );
}

// What the block shows before the scene is drawn, or instead of it.
function Standing({ facts, shown }: { facts: SceneFacts | null; shown: Shown }) {
  const about = facts ? `three.js scene of ${sceneMakeUp(facts)}` : 'three.js scene';
  if (shown === 'no-webgl') {
    return (
      <div className="scene-standing" role="note">
        <p>This browser can't draw 3D scenes: WebGL is off or unavailable.</p>
        <p className="scene-standing-about">{about}</p>
      </div>
    );
  }
  if (typeof shown === 'object') {
    return (
      <div className="scene-standing" role="alert">
        <p className="scene-error">The scene couldn't be drawn: {shown.error}</p>
        <p className="scene-standing-about">Double-click to edit its JSON.</p>
      </div>
    );
  }
  return (
    <div className="scene-standing" aria-busy={shown === 'loading'}>
      <p className="scene-standing-about">{shown === 'loading' ? 'Drawing the scene…' : about}</p>
    </div>
  );
}

// The scene's JSON, edited in place as a diagram's source is: saved when the
// field loses focus, if it reads as a scene; otherwise it stays open, saying
// why, until it is put right or Esc discards the edit.
function SourceEditor({ block, edit }: { block: SceneBlock; edit: ReturnType<typeof useLongEdit> }) {
  const canvas = useCanvas();
  const [error, setError] = useState<string | null>(null);
  const discarding = useRef(false);
  const initial = editableSource(block.scene);
  return (
    <div className="scene-source">
      <textarea
        autoFocus
        spellCheck={false}
        className="block-editor block-editor-code nodrag nowheel"
        defaultValue={initial}
        aria-label="The scene's three.js JSON"
        aria-invalid={error ? true : undefined}
        onChange={() => setError(null)}
        onBlur={(e) => {
          const source = e.currentTarget.value;
          if (discarding.current || source === initial || !source.trim()) {
            edit.cancel(); // closes, saving nothing
            edit.finish(source, block.scene, () => {});
            return;
          }
          try {
            readScene(source);
          } catch (refused) {
            setError((refused as Error).message);
            return;
          }
          edit.finish(source, block.scene, (value) => canvas.updateBlock(block, { scene: value }));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            discarding.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {error && (
        <p className="scene-source-error" role="alert">
          {error} Put it right and click away to save, or press Esc in the field to discard the edit.
        </p>
      )}
    </div>
  );
}
