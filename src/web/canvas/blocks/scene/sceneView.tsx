// A 3D scene's full view, in the pairing shell (canvas/pairing/piece.tsx): the
// scene drawn large, turned by dragging, zoomed with the wheel, its spots
// numbered on it. Viewed on your own, or paired with an agent: click a named
// object to ask the agent to change it, or to leave a note (the spot goes
// where the click landed on it). The agent sends the scene's JSON whole; the
// view draws it anew from where it was being seen, and each spot stays on its
// object, found by its uuid or its name, wherever it has moved. A spot whose
// object went is listed under the scene, with its thread.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { editableSource, findObject, nextSpot, readScene, sceneMakeUp, spotQuote, type SceneFacts } from '../../../../core/blocks/scene/scene';
import type { SceneView as SceneViewpoint } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { useCanvas } from '../../context';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import { pinPart } from '../../../../core/pins';
import { dragged } from '../interaction';
import type { OverlayProps } from '../kind';
import { factsOf, loadViewer, type SceneBlock } from './scene';
import type { SceneViewer, Vec3 } from './viewer';
import './scene.css';
import './sceneView.css';

type Shown = 'loading' | 'shown' | 'no-webgl' | { error: string };
const NOTE_MS = 3600; // how long "only named objects…" stays

interface Spot {
  key: string; // its pin's id, or the draft's anchor
  point: Vec3; // in the coordinates of the object it is on, or of the scene
  object?: string;
  name?: string;
  n: number;
  draft: boolean;
  view?: SceneViewpoint;
}

// Where a marker starts, before the next frame moves it: drawn in place at
// once, so the prompt opened by it is put beside it, not where it starts.
function markerStyle(viewer: SceneViewer | null, spot: Spot): CSSProperties {
  const at = viewer?.shown ? viewer.locate(spot) : null;
  if (!viewer || !at) return { visibility: 'hidden' };
  const drawn = viewer.project(at, spot.key);
  return { transform: `translate(${drawn.x}px, ${drawn.y}px)` };
}

// The name of the object a spot being asked about is on.
const nameOf = (facts: SceneFacts | null, object: string | undefined) => (object !== undefined && facts ? findObject(facts, object, object)?.name : undefined);

function SceneParts({ block, placed, pointing, chosen, open, pick, openPin }: PieceBodyProps<SceneBlock>) {
  const canvas = useCanvas();
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<SceneViewer | null>(null);
  const markers = useRef(new Map<string, HTMLElement>());
  const pressedAt = useRef({ x: 0, y: 0 });
  const seenFrom = useRef<SceneViewpoint | undefined>(undefined); // where it was being seen from, kept as the agent's change lands
  const [made, setMade] = useState(0);
  const [shown, setShown] = useState<Shown>('loading');
  const [note, setNote] = useState<string | null>(null);
  const facts = factsOf(block.scene);
  // The number the next spot takes: one past every spot on the scene, found or not.
  const next = nextSpot(canvas.pins.get(block.id) ?? [], block.id);

  const draft = chosen?.part.kind === 'spot' ? chosen.part : null;
  const spots: Spot[] = [
    ...placed.flatMap(({ pin, place }) =>
      place?.kind === 'spot' ? [{ key: pin.id, point: [place.x, place.y, place.z] as Vec3, object: place.object, name: place.name, n: place.n, draft: false, view: place.view }] : [],
    ),
    ...(draft ? [{ key: DRAFT_ANCHOR, point: [draft.x, draft.y, draft.z] as Vec3, object: draft.object, name: nameOf(facts, draft.object), n: next, draft: true }] : []),
  ];
  const spotsRef = useRef(spots);
  spotsRef.current = spots;

  // Each spot's marker where its point is drawn, after each frame.
  const placeMarkers = useCallback(() => {
    const view = viewer.current;
    if (!view?.shown) return;
    for (const spot of spotsRef.current) {
      const marker = markers.current.get(spot.key);
      const at = view.locate(spot);
      if (!marker) continue;
      marker.style.visibility = at ? '' : 'hidden';
      if (!at) continue;
      const drawn = view.project(at, spot.key);
      marker.style.transform = `translate(${drawn.x}px, ${drawn.y}px)`;
      marker.classList.toggle('is-behind', drawn.behind);
    }
  }, []);
  // Once the view rests: which spots the scene hides, and where it is seen from.
  const settled = useCallback(() => {
    const view = viewer.current;
    if (!view?.shown) return;
    view.occlude(
      spotsRef.current.flatMap((spot) => {
        const point = view.locate(spot);
        return point ? [{ key: spot.key, point }] : [];
      }),
    );
    placeMarkers();
    seenFrom.current = view.view();
  }, [placeMarkers]);

  // The viewer, for as long as the view is open; the wheel zooms it.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let alive = true;
    let mine: SceneViewer | null = null;
    loadViewer().then(
      ({ SceneViewer, WebGLMissing }) => {
        if (!alive) return;
        try {
          mine = new SceneViewer(element, placeMarkers, settled);
        } catch (error) {
          setShown(error instanceof WebGLMissing ? 'no-webgl' : { error: (error as Error).message });
          return;
        }
        mine.zoomable = true;
        viewer.current = mine;
        setMade((n) => n + 1);
      },
      (error: unknown) => alive && setShown({ error: `three.js didn't load (${(error as Error)?.message ?? 'no connection'}).` }),
    );
    const observer = new ResizeObserver(() => viewer.current?.resize());
    observer.observe(element);
    return () => {
      alive = false;
      observer.disconnect();
      mine?.dispose();
      viewer.current = null;
    };
  }, [placeMarkers, settled]);

  // The scene in it: again as each change lands, from where it was being seen.
  useEffect(() => {
    const view = viewer.current;
    if (!made || !view) return;
    let alive = true;
    view.show(block.scene, seenFrom.current).then(
      () => {
        if (!alive) return;
        setShown('shown');
        view.resize();
        settled();
      },
      (error: unknown) => alive && setShown({ error: (error as Error)?.message || 'three.js could not make it' }),
    );
    return () => {
      alive = false;
    };
  }, [made, block.scene, settled]);

  // Spots added, moved or asked about: placed now, and checked for what hides them.
  const spotKeys = spots.map((s) => `${s.key}@${s.point.join(',')}@${s.name ?? ''}`).join(' ');
  useEffect(() => {
    if (shown === 'shown') settled();
  }, [spotKeys, shown, settled]);

  // A spot's thread opened (here, or from the session's list): the scene turns to where it was pinned from.
  const focused = spots.find((s) => !s.draft && s.key === open);
  useEffect(() => {
    const view = viewer.current;
    if (!focused || !view?.shown) return;
    const at = view.locate(focused);
    if (focused.view) view.setView(focused.view);
    else if (at) view.setView(view.viewOf(at));
  }, [focused?.key, shown]); // only when another spot opens

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  // Pairing, a click (not a drag, which turns it) on a named object asks about a spot on it.
  const onClick = (event: MouseEvent) => {
    const view = viewer.current;
    if (!pointing || !view?.shown || !host.current || dragged(event, pressedAt.current)) return;
    const rect = host.current.getBoundingClientRect();
    const hit = view.pick((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    if (!hit) return;
    const named = hit.object && facts ? findObject(facts, hit.object.uuid, hit.object.name) : undefined;
    if (!named) return setNote('That part has no name, so there is nothing to ask about it by: click a named object.');
    const [x, y, z] = hit.local;
    pick({ blockId: block.id, part: { kind: 'spot', object: named.uuid ?? named.name, x, y, z, view: view.view() }, quote: spotQuote(next, named.name) });
  };

  const ready = shown === 'shown';
  return (
    <div className="scene-full-wrap">
      <div
        className={`scene-stage scene-full${pointing ? ' is-pointing' : ''}`}
        onPointerDown={(e) => {
          pressedAt.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={onClick}
        title={pointing ? 'Click a named object to ask about it; drag to turn the scene' : 'Drag to turn it, the wheel zooms'}
      >
        <div ref={host} className="scene-view" />
        {ready && (
          <div className="scene-spots">
            {spots.map((spot) => (
              <span
                key={spot.key}
                ref={(element) => {
                  if (element) markers.current.set(spot.key, element);
                  else markers.current.delete(spot.key);
                }}
                className={`scene-spot ${spot.draft ? 'is-draft' : 'is-linked is-open-able'}${spot.key === open ? ' is-open' : ''}`}
                style={markerStyle(viewer.current, spot)}
                data-pair-anchor={spot.key}
                data-pin-draft={spot.draft ? '' : undefined}
                title={`Spot ${spot.n}${spot.name ? ` on "${spot.name}"` : ''}${spot.draft ? '' : ': open what was said about it'}`}
                onClick={
                  spot.draft
                    ? undefined
                    : (e) => {
                        e.stopPropagation();
                        openPin(spot.key);
                      }
                }
              >
                <span className="scene-spot-n">{spot.n}</span>
              </span>
            ))}
          </div>
        )}
        {ready && (
          <button
            type="button"
            className="scene-reset"
            title="Back to the whole scene"
            aria-label="Reset the view"
            onClick={(e) => {
              e.stopPropagation();
              viewer.current?.reset();
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3.5 6.5A4.75 4.75 0 1 1 3.4 9.6M3.25 3.5v3h3" />
            </svg>
          </button>
        )}
        {!ready && (
          <div className="scene-standing" role={typeof shown === 'object' ? 'alert' : undefined} aria-busy={shown === 'loading'}>
            {shown === 'no-webgl' ? (
              <p>This browser can't draw 3D scenes: WebGL is off or unavailable.</p>
            ) : typeof shown === 'object' ? (
              <p className="scene-error">The scene couldn't be drawn: {shown.error}</p>
            ) : (
              <p className="scene-standing-about">Drawing the scene…</p>
            )}
            {facts && <p className="scene-standing-about">three.js scene of {sceneMakeUp(facts)}</p>}
          </div>
        )}
        {note && (
          <p className="scene-full-note" role="status">
            {note}
          </p>
        )}
      </div>
      {placed.length > 0 && (
        <div className="scene-full-chips">
          {placed.map(({ pin }) => (
            <PairPinChip key={pin.id} pin={pin} open={pin.id === open} part={pinPart(pin, block)} onToggle={() => openPin(pin.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Why typed JSON can't be saved as the scene, if it can't.
function sceneRefused(source: string): string | null {
  if (!source.trim()) return 'A scene needs its JSON: write some, or discard your changes.';
  try {
    readScene(source);
    return null;
  } catch (refused) {
    return `${(refused as Error).message} Put it right, or discard your changes.`;
  }
}

export function SceneFullView({ block, name, version, pinId, onClose }: OverlayProps<SceneBlock>) {
  const facts = factsOf(block.scene);
  const named = facts?.named.length ?? 0;
  const from = facts ? `3D scene · ${named === 1 ? '1 named object' : `${named.toLocaleString('en-US')} named objects`} · ${sceneMakeUp(facts)}` : '3D scene';
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      part="scene"
      className="scene-full-view"
      label={`3D scene ${block.title ?? ''}`.trim()}
      icon={<Icon name="scene" />}
      title={block.title || (facts?.named[0] ? `Scene "${facts.named[0].name}"` : '3D scene')}
      from={from}
      browse={{ label: 'View', hint: 'Turn it and zoom on your own; click a spot to see what was said about it' }}
      it="the scene"
      point="click a named object"
      does="changes the scene"
      example="make it taller, say"
      body={(props) => <SceneParts {...props} />}
      edit={{
        hint: "Edit its three.js JSON by hand (or double-click it while viewing)",
        label: "The scene's three.js JSON",
        code: true,
        of: (scene) => editableSource(scene.scene),
        patch: (scene) => ({ scene }),
        check: sceneRefused,
      }}
      onClose={onClose}
    />
  );
}
