import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  getStraightPath,
  useConnection,
  useInternalNode,
  useStore,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { kindOf } from '../../core/blocks/registry';
import { boardCardKinds } from '../../core/cards';
import { atVersion } from '../../core/canvas';
import { placePin } from '../../core/pins';
import { requestOfGroup } from '../../core/requests';
import { threadCards, threadOfGroup } from '../../core/threadSelection';
import type { Block, BlockVersion, Group, Link, Pin } from '../../core/types';
import { RequestCards, RequestChip, ThreadChip } from './askAgents';
import { ActorBadge } from '../shared/components';
import { webKindOf } from './blocks/registry';
import { CanvasContext, EditableText, useCanvas } from './context';
import { VersionBand, VersionChip } from './versions';
import { PinChip, PinStrip } from './pins';

export type BlockNodeType = Node<{ block: Block }, 'block'>;
export type FrameNodeType = Node<{ group: Group; members: number }, 'frame'>;
export type CanvasNode = BlockNodeType | FrameNodeType;
export type LinkEdgeType = Edge<{ link: Link }, 'link'>;

// ---- blocks -----------------------------------------------------------------

const NO_PINS: Pin[] = [];
const MIN_SIZE = { w: 160, h: 90 }; // a block of content's smallest, when its kind says none

export function BlockNode({ id, data, selected }: NodeProps<BlockNodeType>) {
  const { block } = data;
  const canvas = useCanvas();
  const context = canvas.boardContext;
  const connecting = useConnection((c) => c.inProgress);
  const option = canvas.evidence.find((o) => o.id === block.optionId);
  const highlighted = Boolean(canvas.highlightOption && block.optionId === canvas.highlightOption);
  const isNew = canvas.newItems.has(id);
  const [editing, setEditing] = useState(false); // a kind's own editor is open (a link's address)
  const kind = webKindOf(block.type);
  const [resizing, setResizing] = useState(false); // embedded views stop taking the pointer meanwhile
  // An earlier version being looked at: shown in place, read-only, pins left off.
  const [viewing, setViewing] = useState<BlockVersion | null>(null);
  const shown = useMemo(() => (viewing ? atVersion(block, viewing) : block), [viewing, block]);
  const frozen = useMemo(
    () => ({ ...canvas, readOnly: true, draft: null, openOverlay: (blockId: string) => canvas.openOverlay(blockId, { version: viewing ?? undefined }) }),
    [canvas, viewing],
  );
  const { seeItem } = canvas;
  useEffect(() => {
    if (selected && isNew) seeItem(id);
  }, [selected, isNew, seeItem, id]);
  // Where each of the block's pins is now; a part that changed past finding has none.
  const pins = canvas.pins.get(block.id) ?? NO_PINS;
  const placed = useMemo(() => pins.map((pin) => ({ pin, place: placePin(block, pin) })), [pins, block]);
  const wholePins = placed.filter(({ pin, place }) => place && pin.anchor.kind === 'block').map(({ pin }) => pin);
  const pinningWhole = canvas.draft?.blockId === block.id && canvas.draft.part.kind === 'block';
  // With several blocks selected, the selection bar syncs them instead.
  const pickedKey = useStore((s) => s.nodes.filter((n) => n.selected && n.type === 'block').map((n) => n.id).join(','));
  const several = pickedKey.includes(',');
  // What a page's menu does with blocks takes those selected with this one, or this one alone.
  const keeping = several && pickedKey.split(',').includes(block.id) ? pickedKey.split(',') : [block.id];
  // A block's body scrolls its own content under the wheel; a picture, which
  // fits its block, lets the wheel and a pinch pan and zoom the canvas.
  const wheel = kind.still ? '' : ' nowheel';
  const min = kindOf(block.type).minSize ?? MIN_SIZE;
  const classes = [
    'block',
    `block-type-${block.type}`,
    kind.bare && 'is-bare',
    selected && 'is-selected',
    highlighted && 'is-highlighted',
    option && 'is-pinned',
    isNew && 'is-new',
    wholePins.length > 0 && 'is-pin-linked',
    pinningWhole && 'is-pin-draft',
    resizing && 'is-resizing',
    viewing && 'is-viewing-version',
  ];
  const badges = (
    <>
      <VersionChip
        block={block}
        viewing={viewing?.rev ?? null}
        onView={setViewing}
        onDelete={canvas.readOnly ? undefined : (rev) => canvas.deleteVersions(block, rev)}
      />
      {isNew && (
        <span className="block-new" title={`Changed by ${block.updatedBy.name} since you last looked`}>
          new
        </span>
      )}
      {option && (
        <span
          className={`block-pin${option.outdated ? ' is-outdated' : ''}`}
          title={`Evidence for ${option.id}) ${option.label}${option.outdated ? ' (outdated)' : ''}`}
        >
          {option.id}
        </span>
      )}
      {context ? context.slot.blockMarks({ board: canvas.board, name: canvas.viewer, block }) : <ActorBadge actor={block.updatedBy} showName={false} />}
    </>
  );

  return (
    <div className={classes.filter(Boolean).join(' ')} data-pin-draft={pinningWhole ? '' : undefined}>
      <NodeResizer
        isVisible={selected && !canvas.readOnly}
        minWidth={min.w}
        minHeight={min.h}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeStart={() => setResizing(true)}
        onResizeEnd={(_, box) => {
          setResizing(false);
          canvas.resize(id, box);
        }}
      />
      <NodeToolbar isVisible={selected && !canvas.readOnly} position={Position.Top} align="end" className="node-toolbar">
        {canvas.evidence.length > 0 && (
          <select
            value={block.optionId ?? ''}
            onChange={(e) => canvas.updateBlock(block, { optionId: e.target.value || null })}
            title="Pin as evidence for an option"
          >
            <option value="">Not pinned to an option</option>
            {canvas.evidence.map((o) => (
              <option key={o.id} value={o.id}>
                Evidence for {o.id}) {o.label}
                {o.outdated ? ' (outdated)' : ''}
              </option>
            ))}
          </select>
        )}
        {kind.Tools && <kind.Tools block={block} shown={shown} viewing={viewing} editing={editing} setEditing={setEditing} />}
        {context && !several && context.slot.blockTool({ ...context.tools, block })}
        {canvas.keep && (
          <button onClick={() => canvas.keep!.run(keeping)} title={canvas.keep.words.blockTitle(keeping.length)}>
            {canvas.keep.words.label}
          </button>
        )}
        <button onClick={() => canvas.removeItem(id)}>Delete</button>
      </NodeToolbar>

      {kind.bare ? (
        // Drawn whole (a shape, a pen's strokes): its body alone, an earlier version shown in its place.
        <CanvasContext.Provider value={viewing ? frozen : canvas}>
          <div className="block-bare">
            <kind.Body block={shown} selected={selected && !viewing} placed={viewing ? [] : placed} />
          </div>
          {viewing && <VersionBand block={block} version={viewing} onDone={() => setViewing(null)} />}
        </CanvasContext.Provider>
      ) : kind.Card ? (
        <>
          <CanvasContext.Provider value={viewing ? frozen : canvas}>
            <kind.Card
              block={shown}
              editing={editing && !viewing}
              setEditing={setEditing}
              badges={
                <>
                  {!viewing && wholePins.map((pin) => <PinChip key={pin.id} pin={pin} />)}
                  {badges}
                </>
              }
            />
          </CanvasContext.Provider>
          {viewing && <VersionBand block={block} version={viewing} onDone={() => setViewing(null)} />}
        </>
      ) : (
        <>
          <header className="block-head">
            <span className="block-kind">{kindOf(block.type).label}</span>
            {kind.Title ? (
              <kind.Title block={shown} placed={viewing ? [] : placed} frozen={Boolean(viewing)} />
            ) : viewing ? (
              <span className="editable block-title">{shown.title || <span className="placeholder">Untitled</span>}</span>
            ) : (
              <EditableText
                className="block-title"
                value={block.title ?? ''}
                placeholder="Untitled"
                onCommit={(title) => canvas.updateBlock(block, { title })}
              />
            )}
            {kind.Head && <kind.Head block={shown} placed={viewing ? [] : placed} frozen={Boolean(viewing)} />}
            {badges}
          </header>
          {viewing && <VersionBand block={block} version={viewing} onDone={() => setViewing(null)} />}
          {viewing ? (
            <CanvasContext.Provider value={frozen}>
              <div className={`block-body${wheel}`}>
                <kind.Body key={`v${viewing.rev}`} block={shown} selected={false} placed={[]} />
              </div>
            </CanvasContext.Provider>
          ) : (
            <div className={`block-body${wheel}`}>
              <kind.Body block={block} selected={selected} placed={placed} />
              {!kind.ownPins && <PinStrip block={block} placed={placed} />}
            </div>
          )}
        </>
      )}

      {kind.linkable?.(block) !== false && (
        <>
          <Handle type="source" position={Position.Right} className="block-handle" title="Drag to link" />
          <Handle
            type="target"
            position={Position.Left}
            isConnectableStart={false}
            className={`block-target${connecting ? ' is-active' : ''}`}
          />
        </>
      )}
    </div>
  );
}

// ---- groups -----------------------------------------------------------------

// How many cards a request or a thread made, which its group shows: the ids it keeps by kind of card (`decisionIds`).
const madeCards = (made: object): number =>
  boardCardKinds().reduce((count, { kind }) => count + ((made as Record<string, string[] | undefined>)[`${kind}Ids`]?.length ?? 0), 0);

export function FrameNode({ id, data, selected }: NodeProps<FrameNodeType>) {
  const canvas = useCanvas();
  const context = canvas.boardContext;
  // A group answering a person's request, on the board context or a Sketchbook
  // page, says so, and how it's going; the cards made for it show in it.
  const request = canvas.owner ? undefined : requestOfGroup(canvas.board, id);
  // Or a group beside the blocks a thread was started about, showing what it made.
  const thread = canvas.owner || request ? undefined : threadOfGroup(canvas.board, id);
  const shown = request ?? (thread ? threadCards(canvas.board, thread) : undefined);
  const cards = shown ? madeCards(shown) : 0;
  const title = (
    <EditableText
      className="frame-title"
      value={data.group.title}
      placeholder="Group name"
      onCommit={(next) => next.trim() && canvas.renameGroup(id, next)}
    />
  );
  return (
    <div className={`frame${selected ? ' is-selected' : ''}${request ? ` is-request is-${request.status}` : ''}${thread ? ' is-thread' : ''}`}>
      <NodeResizer
        isVisible={selected && !canvas.readOnly}
        minWidth={240}
        minHeight={140}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_, box) => canvas.resize(id, box)}
      />
      <NodeToolbar isVisible={selected && !canvas.readOnly} position={Position.Top} align="end" className="node-toolbar">
        {canvas.keep && data.members > 0 && (
          <button
            onClick={() => canvas.keep!.run(canvas.board.pages?.flatMap((p) => p.canvas.blocks).filter((b) => b.groupId === id).map((b) => b.id) ?? [])}
            title={canvas.keep.words.groupTitle}
          >
            {canvas.keep.words.label}
          </button>
        )}
        <button onClick={() => canvas.removeItem(id)} title="Blocks inside stay on the canvas">
          Ungroup
        </button>
      </NodeToolbar>
      <header className="frame-head">
        {request ? (
          <RequestChip
            board={canvas.board}
            request={request}
            name={canvas.viewer}
            title={title}
            empty={data.members === 0 && cards === 0}
            readOnly={canvas.readOnly}
          />
        ) : thread ? (
          <ThreadChip thread={thread} title={title} />
        ) : (
          title
        )}
        {(data.members > 0 || cards === 0) && <span className="frame-count">{data.members}</span>}
        {context && !canvas.readOnly && data.members > 0 && context.slot.groupTool({ ...context.tools, group: data.group })}
      </header>
      {shown && cards > 0 && <RequestCards board={canvas.board} request={shown} />}
    </div>
  );
}

// ---- links ------------------------------------------------------------------

// Where the line from a node's centre towards `point` crosses its border, so
// arrows meet blocks at their edges whichever way they are arranged.
function borderPoint(node: InternalNode, point: { x: number; y: number }) {
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const cx = node.internals.positionAbsolute.x + w / 2;
  const cy = node.internals.positionAbsolute.y + h / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // A kind that isn't a box (an ellipse, a diamond) says where its outline is.
  const block = node.type === 'block' ? (node.data as { block?: Block }).block : undefined;
  const outline = block && webKindOf(block.type).edgeScale;
  const scale = outline ? outline(block, w, h, dx, dy) : 1 / Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function centre(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x + (node.measured.width ?? 0) / 2,
    y: node.internals.positionAbsolute.y + (node.measured.height ?? 0) / 2,
  };
}

export function LinkEdge({ id, source, target, markerEnd, data, selected }: EdgeProps<LinkEdgeType>) {
  const canvas = useCanvas();
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (!from || !to) return null;

  const start = borderPoint(from, centre(to));
  const end = borderPoint(to, centre(from));
  const [path, labelX, labelY] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  const label = data?.link.label ?? '';

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`link-path${selected ? ' is-selected' : ''}${data?.link.weight ? ` is-${data.link.weight}` : ''}`} />
      {(label || (selected && !canvas.readOnly) || editing) && (
        <EdgeLabelRenderer>
          <div
            className={`link-label nodrag nopan${selected ? ' is-selected' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onDoubleClick={() => {
              if (canvas.readOnly) return;
              cancelled.current = false;
              setEditing(true);
            }}
          >
            {editing ? (
              <input
                autoFocus
                defaultValue={label}
                placeholder="e.g. contradicts"
                onBlur={(e) => {
                  setEditing(false);
                  if (!cancelled.current && e.currentTarget.value !== label) canvas.relabelLink(id, e.currentTarget.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    cancelled.current = true;
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              label || <span className="placeholder">Double-click to label</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
