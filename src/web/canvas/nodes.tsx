import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
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
import { atVersion } from '../../core/canvas';
import { placePin } from '../../core/pins';
import { requestOfGroup } from '../../core/requests';
import type { Block, BlockVersion, Group, Link, Pin } from '../../core/types';
import { RequestChip } from './askAgents';
import { ActorBadge, Icon } from '../shared/components';
import { OwnerMark, SyncingMark } from './sync';
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

export function BlockNode({ id, data, selected }: NodeProps<BlockNodeType>) {
  const { block } = data;
  const canvas = useCanvas();
  const connecting = useConnection((c) => c.inProgress);
  const option = canvas.decision?.options.find((o) => o.id === block.optionId);
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
  const several = useStore((s) => s.nodes.filter((n) => n.selected && n.type === 'block').length > 1);
  const sync = canvas.me ? canvas.board.syncRequest : undefined;
  const syncing = Boolean(sync?.blockIds?.includes(block.id));
  // A block's body scrolls its own content under the wheel; a picture, which
  // fits its block, lets the wheel and a pinch pan and zoom the canvas.
  const wheel = kind.still ? '' : ' nowheel';
  const classes = [
    'block',
    `block-type-${block.type}`,
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
      {syncing && <SyncingMark by={sync!.by.name} />}
      {canvas.me ? <OwnerMark block={block} me={canvas.me} /> : <ActorBadge actor={block.updatedBy} showName={false} />}
    </>
  );

  return (
    <div className={classes.filter(Boolean).join(' ')} data-pin-draft={pinningWhole ? '' : undefined}>
      <NodeResizer
        isVisible={selected && !canvas.readOnly}
        minWidth={160}
        minHeight={90}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeStart={() => setResizing(true)}
        onResizeEnd={(_, box) => {
          setResizing(false);
          canvas.resize(id, box);
        }}
      />
      <NodeToolbar isVisible={selected && !canvas.readOnly} position={Position.Top} align="end" className="node-toolbar">
        {canvas.decision && canvas.decision.options.length > 0 && (
          <select
            value={block.optionId ?? ''}
            onChange={(e) => canvas.updateBlock(block, { optionId: e.target.value || null })}
            title="Pin as evidence for an option"
          >
            <option value="">Not pinned to an option</option>
            {canvas.decision.options.map((o) => (
              <option key={o.id} value={o.id}>
                Evidence for {o.id}) {o.label}
                {o.outdated ? ' (outdated)' : ''}
              </option>
            ))}
          </select>
        )}
        {kind.Tools && <kind.Tools block={block} shown={shown} viewing={viewing} editing={editing} setEditing={setEditing} />}
        {canvas.syncBlocks && !several && (
          <button
            onClick={() => canvas.syncBlocks!([block.id])}
            title="Ask agents to bring this block up to date with the board, and nothing else"
          >
            Sync this
          </button>
        )}
        <button onClick={() => canvas.removeItem(id)}>Delete</button>
      </NodeToolbar>

      {kind.Card ? (
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

      <Handle type="source" position={Position.Right} className="block-handle" title="Drag to link" />
      <Handle
        type="target"
        position={Position.Left}
        isConnectableStart={false}
        className={`block-target${connecting ? ' is-active' : ''}`}
      />
    </div>
  );
}

// ---- groups -----------------------------------------------------------------

export function FrameNode({ id, data, selected }: NodeProps<FrameNodeType>) {
  const canvas = useCanvas();
  const { selectBlocks } = canvas;
  // Selects the group's blocks, for the selection bar (or, for one, its toolbar) to sync.
  const syncGroup = (event: MouseEvent) => {
    event.stopPropagation(); // a click on the group would select it instead
    selectBlocks!(canvas.board.canvas.blocks.filter((b) => b.groupId === id).map((b) => b.id));
  };
  // On the board context, a group answering a person's request says so, and how it's going.
  const request = canvas.me ? requestOfGroup(canvas.board, id) : undefined;
  const title = (
    <EditableText
      className="frame-title"
      value={data.group.title}
      placeholder="Group name"
      onCommit={(next) => next.trim() && canvas.renameGroup(id, next)}
    />
  );
  return (
    <div className={`frame${selected ? ' is-selected' : ''}${request ? ` is-request is-${request.status}` : ''}`}>
      <NodeResizer
        isVisible={selected && !canvas.readOnly}
        minWidth={240}
        minHeight={140}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_, box) => canvas.resize(id, box)}
      />
      <NodeToolbar isVisible={selected && !canvas.readOnly} position={Position.Top} align="end" className="node-toolbar">
        <button onClick={() => canvas.removeItem(id)} title="Blocks inside stay on the canvas">
          Ungroup
        </button>
      </NodeToolbar>
      <header className="frame-head">
        {request ? (
          <RequestChip
            board={canvas.board}
            request={request}
            name={canvas.me!}
            title={title}
            empty={data.members === 0}
            readOnly={canvas.readOnly}
          />
        ) : (
          title
        )}
        <span className="frame-count">{data.members}</span>
        {selectBlocks && data.members > 0 && (
          <button className="frame-sync nodrag" onClick={syncGroup} title="Select this group's blocks to sync them">
            <Icon name="sync" /> Sync group
          </button>
        )}
      </header>
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
  const scale = 1 / Math.max(Math.abs(dx) / (w / 2), Math.abs(dy) / (h / 2));
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
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={selected ? 'link-path is-selected' : 'link-path'} />
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
