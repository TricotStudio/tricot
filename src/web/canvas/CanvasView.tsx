import {
  createRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useKeyPress,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnBeforeDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { kindOf } from '../../core/blocks/registry';
import { blockName, GROUP_SIZE } from '../../core/canvas';
import { canvasesOf } from '../../core/pins';
import type { Block, Board, BlockVersion, Canvas, Pin, ScratchPage } from '../../core/types';
import { api, type BlockContent, type BlockPatch, type CanvasRef, type Move, type RequestError } from '../shared/api';
import { AddMenu, type AddForm } from './addMenu';
import { PendingRequests } from './askAgents';
import { FOCUS_PIN, showComments } from '../conversation';
import { useFocusBlock } from './focus';
import type { KeptBlocks } from '../shared/boardViews';
import { useBoardViews } from '../shared/boardViewsContext';
import { useReadOnly } from '../shared/hooks';
import type { BlocksClip } from './clip';
import { useTheme } from '../themes';
import { CanvasContext, type CanvasContextValue, type CanvasOwner, type EvidenceOption, type PinDraft } from './context';
import type { AddContext } from './blocks/kind';
import { webKindOf } from './blocks/registry';
import { useBoxLeavesGroups } from './boxSelect';
import { useCopyBlocks } from './copy';
import { drawTools, useDrawing, useDrawKeys, useDrawTools } from './tools';
import { useIntake } from './intake';
import { PanHint } from './panHint';
import { BlockNode, FrameNode, LinkEdge, type CanvasNode, type LinkEdgeType } from './nodes';
import { PinPrompt, PinThread, wordsPressed, wordsReleased } from './pins';
import { setPageSelection } from './pageSelection';
import { useUndoDelete } from './undo';

const nodeTypes = { block: BlockNode, frame: FrameNode };
const edgeTypes = { link: LinkEdge };
const proOptions = { hideAttribution: true }; // React Flow is credited in the README instead
const HOLD_MS = 4000;

type Point = { x: number; y: number };
type NewBlockOptions = { at?: Point; size?: { w: number; h: number }; title?: string; exact?: boolean }; // exact: where it was drawn, not nudged off what is there

function buildNodes(canvas: Canvas): CanvasNode[] {
  const members = new Map<string, number>();
  for (const block of canvas.blocks) {
    if (block.groupId) members.set(block.groupId, (members.get(block.groupId) ?? 0) + 1);
  }
  // Groups come first: React Flow needs parents before their children.
  return [
    ...canvas.groups.map(
      (group): CanvasNode => ({
        id: group.id,
        type: 'frame',
        position: { x: group.x, y: group.y },
        width: group.w,
        height: group.h,
        data: { group, members: members.get(group.id) ?? 0 },
      }),
    ),
    ...canvas.blocks.map(
      (block): CanvasNode => ({
        id: block.id,
        type: 'block',
        position: { x: block.x, y: block.y },
        width: block.w,
        height: block.h,
        parentId: block.groupId,
        dragHandle: webKindOf(block.type).bare ? undefined : '.block-head', // a drawn shape drags from anywhere on it
        data: { block },
      }),
    ),
  ];
}

// The arrowhead is sized in widths of its line, so a heavier line takes fewer, its head still a little larger.
const HEAD = { thin: 16, medium: 11, thick: 8.5 } as const;

function buildEdges(canvas: Canvas): LinkEdgeType[] {
  return canvas.links.map((link) => {
    const head = HEAD[link.weight ?? 'thin'];
    return {
      id: link.id,
      source: link.from,
      target: link.to,
      type: 'link',
      data: { link },
      markerEnd: { type: MarkerType.ArrowClosed, width: head, height: head, color: 'var(--muted)' },
    };
  });
}

interface Props {
  board: Board;
  owner?: CanvasOwner; // a card's canvas (a decision's, a task's); none for the board context and a page
  evidence?: readonly EvidenceOption[]; // what the blocks of a card's canvas can be pinned to as evidence (a decision's options)
  // What an empty canvas says it is for, where it is a card's or the board context's: the page that opens it says (a part's).
  emptyNote?: string;
  page?: ScratchPage; // a page of the Sketchbook: like the board context, it has no card
  name: string;
  highlightOption?: string | null;
  newItems?: ReadonlySet<string>;
  onSeeItem?: (id: string) => void;
  // Under something opened over it (another view of a part's window):
  // it keeps its place, pan and zoom, and takes no keys, pastes or drops
  // meant for what is over it, such as Backspace deleting the blocks
  // selected on it.
  covered?: boolean;
  // What leads its top-left group, before Add: a Sketchbook page's Pages
  // button (scratch/pagesMenu.tsx). It is there on a read-only board too,
  // where Add isn't.
  lead?: ReactNode;
  // What holds it opens a block's full view on it (the Files view): this
  // block's, as soon as it is drawn, and it is told when the person closes it.
  opens?: string;
  paired?: boolean; // and opens it already paired (the Files view's Pair)
  onClosed?: () => void;
}

const NOTHING_NEW: ReadonlySet<string> = new Set();
const NO_EVIDENCE: readonly EvidenceOption[] = [];
// Fitting the canvas to its blocks: on the board context and the Scratch
// pad, the lowest stop clear of the chat bar floating at its foot (chatBar.css).
const FIT = { maxZoom: 1, padding: 0.15 };
const FIT_UNDER_BAR = { maxZoom: 1, padding: { x: 0.15, top: 0.15, bottom: '120px' as const } };
const MULTI_SELECT = ['Meta', 'Control', 'Shift']; // ⇧-click adds a block to the selection too
// A plain drag on the empty canvas draws a selection box (selectionOnDrag), and
// any block the box touches is picked, not only one it covers. The canvas is
// moved with Space held and a drag, the middle or right button's drag (buttons 1
// and 2 of panOnDrag), or by scrolling (panOnScroll). ⇧-drag draws a box from
// anywhere, over a block or a group too, where a plain drag moves the thing.
const PAN_BUTTONS = [1, 2];
const PAN_KEY = 'Space';
const ignore = () => {};
const PROMPT_WIDTH = 380;
const PROMPT_HEIGHT = 230; // about; decides whether it fits under the part or goes above
const THREAD_HEIGHT = 320;
const FOCUS_MS = 2400;

type Place = { left: number; top: number; width: number; above: boolean };

// Where a popover of about `height` goes for what it's about: under it, or
// above it when there's more room there, kept inside the canvas, and clear
// of `foot` at its bottom (the chat bar floating there).
// With `fit`, it goes above only where it fits there, else beside it, to
// its right or left, else under it, over its foot if it must.
function placeBy(root: HTMLElement, around: Element[], height: number, wide = PROMPT_WIDTH, foot = 0, fit = false): Place {
  const rects = around.map((el) => el.getBoundingClientRect());
  const box = {
    left: Math.min(...rects.map((r) => r.left)),
    right: Math.max(...rects.map((r) => r.right)),
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
  const frame = root.getBoundingClientRect();
  const width = Math.min(wide, frame.width - 24);
  const left = Math.max(12, Math.min(box.left - frame.left - 12, frame.width - width - 12));
  const below = box.bottom - frame.top + 10;
  const roomBelow = frame.height - foot - 12 - below;
  const roomAbove = box.top - frame.top - 22;
  if (fit && height > roomBelow && roomAbove < height) {
    const top = Math.max(12, Math.min(box.top - frame.top, frame.height - foot - 12 - height));
    const right = box.right - frame.left + 12;
    if (right + width <= frame.width - 12) return { left: right, width, top, above: false };
    const leftSide = box.left - frame.left - 12 - width;
    if (leftSide >= 12) return { left: leftSide, width, top, above: false };
  }
  const above = height > roomBelow && (fit ? roomAbove >= height : roomAbove > roomBelow);
  // Above, `top` is its bottom edge; below, it moves up as far as it needs to fit.
  const top = above ? box.top - frame.top - 10 : Math.max(12, Math.min(below, frame.height - foot - 12 - height));
  return { left, width, top, above };
}

// The line a page's block menu says under the blocks it acted on (the board
// context's `keep`): about how big, to place it; and how much of the canvas's
// foot the chat bar floating there takes.
const DONE_LINE = { width: 420, height: 40 };
const CHAT_FOOT = 96;

// The prompt goes by the part being pinned. Null until the part is drawn.
function promptPlace(root: HTMLElement, blockId: string): Place | null {
  const node = root.querySelector(`.react-flow__node[data-id="${CSS.escape(blockId)}"]`);
  if (!node) return null;
  const marked = [...node.querySelectorAll('[data-pin-draft]')];
  return placeBy(root, marked.length ? marked : [node], PROMPT_HEIGHT);
}

// A pin's thread goes by its chip. Its height is measured once it's drawn.
function threadPlace(root: HTMLElement, pinId: string, height: number): Place | null {
  const chip = root.querySelector(`[data-chip-pin="${CSS.escape(pinId)}"]`);
  return chip ? placeBy(root, [chip], height) : null;
}

export function CanvasView(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasSurface {...props} />
    </ReactFlowProvider>
  );
}

function CanvasSurface(props: Props) {
  const { board, page, name, emptyNote, evidence = NO_EVIDENCE, highlightOption = null, newItems = NOTHING_NEW, onSeeItem = ignore, covered = false, lead, opens, paired, onClosed } = props;
  const ownerKind = props.owner?.kind;
  const ownerCard = props.owner?.card;
  const owner = useMemo(() => (ownerKind && ownerCard ? { kind: ownerKind, card: ownerCard } : undefined), [ownerKind, ownerCard]);
  const canvas = ownerCard?.canvas ?? page?.canvas ?? board.canvas;
  const underBar = !owner; // the board's own tabs, where the chat bar floats
  const ownerId = ownerCard?.id;
  const pageId = page?.id;
  const ref = useMemo(
    () => (ownerKind && ownerId ? { [`${ownerKind}Id`]: ownerId } : pageId ? { pageId } : { boardId: board.id }) as CanvasRef,
    [board.id, ownerKind, ownerId, pageId],
  );
  const readOnly = useReadOnly();
  const flow = useReactFlow<CanvasNode, LinkEdgeType>();
  const wrapper = useRef<HTMLDivElement>(null);
  const toggles = useRef(new Map<string, RefObject<HTMLButtonElement | null>>()); // the Add menu's item of each kind that opens a form
  const [nodes, setNodes] = useState<CanvasNode[]>(() => buildNodes(canvas));
  // The view fits what the canvas holds as it opens; one that opens empty keeps its place, so the first thing drawn on it stays where it was drawn.
  const [fitOnOpen] = useState(() => canvas.blocks.length + canvas.groups.length > 0);
  const [edges, setEdges] = useState<LinkEdgeType[]>(() => buildEdges(canvas));
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [form, setForm] = useState<AddForm | null>(null); // the Add form that is open, and what it opened with
  const [pinDraft, setPinDraft] = useState<PinDraft | null>(null); // the part being pinned, with its prompt open
  const [promptAt, setPromptAt] = useState<Place | null>(null);
  const [thread, setThread] = useState<string | null>(null); // the pin whose thread is open
  const [threadAt, setThreadAt] = useState<Place | null>(null);
  const [threadHeight, setThreadHeight] = useState(THREAD_HEIGHT);
  const [awaited, setAwaited] = useState<string | null>(null); // a thread just started, open once its pin arrives
  const [focus, setFocus] = useState<string | null>(null); // a pin shown from a comment, highlighted a moment
  const transform = useStore((s) => s.transform);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  // Items the viewer just moved keep their local position briefly, so a
  // change from the server that raced the save doesn't snap them back.
  const holds = useRef(new Map<string, number>());

  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const { remove: removeItems, removed, toast } = useUndoDelete(name, report);
  // A change to a block as the viewer saw it (its rev). Refused because
  // someone changed the block meanwhile, a change that can be made again
  // (`again`) is, once, on the block as the server has it now.
  const changeBlock = useCallback(
    async (block: Block, patch: BlockPatch, again?: (latest: Block) => BlockPatch | null): Promise<void> => {
      try {
        await api.updateBlock(block.id, name, { ...patch, rev: block.rev });
      } catch (error) {
        if (!again || (error as RequestError).status !== 409) throw error;
        const live = await api.board(board.id);
        const latest = canvasesOf(live)
          .flatMap(({ canvas }) => canvas.blocks)
          .find((b) => b.id === block.id);
        const redo = latest && again(latest);
        if (redo) await api.updateBlock(block.id, name, { ...redo, rev: latest.rev });
      }
    },
    [board.id, name],
  );
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const hold = (ids: string[]) => {
    const until = Date.now() + HOLD_MS;
    for (const id of ids) holds.current.set(id, until);
  };

  // Fold server state into local state without fighting the viewer's hands.
  useEffect(() => {
    const now = Date.now();
    setNodes((current) => {
      const local = new Map(current.map((n) => [n.id, n]));
      return buildNodes(canvas).map((node) => {
        const mine = local.get(node.id);
        if (!mine) return node;
        const busy = mine.dragging || mine.resizing || (holds.current.get(node.id) ?? 0) > now;
        if (!busy) return { ...node, selected: mine.selected } as CanvasNode;
        return {
          ...node,
          position: mine.position,
          width: mine.width,
          height: mine.height,
          parentId: mine.parentId,
          selected: mine.selected,
          dragging: mine.dragging,
          resizing: mine.resizing,
        } as CanvasNode;
      });
    });
    setEdges((current) => {
      const selected = new Set(current.filter((e) => e.selected).map((e) => e.id));
      return buildEdges(canvas).map((edge) => (selected.has(edge.id) ? { ...edge, selected: true } : edge));
    });
  }, [canvas]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<LinkEdgeType>[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  // On the board context, the blocks selected are for what a page with parts draws there
  // (shared/boardViews.ts BoardContextSlot): its bar shows for two or more, and
  // a block's toolbar has its button. A Sketchbook page's selection is for its
  // own bar, below.
  const contextSlot = useBoardViews().boardContext();
  const onContext = !owner && !page;
  const editsContext = onContext && !readOnly;
  const picked = useMemo(() => nodes.filter((n) => n.selected && n.type === 'block').map((n) => n.id), [nodes]);
  const selectBlocks = useCallback((ids: string[]) => {
    const wanted = new Set(ids);
    setNodes((ns) => ns.map((n) => (Boolean(n.selected) === wanted.has(n.id) ? n : { ...n, selected: wanted.has(n.id) })));
  }, []);
  const clearSelection = useCallback(() => selectBlocks([]), [selectBlocks]);
  const contextTools = useMemo(() => ({ board, name, select: selectBlocks, report }), [board, name, selectBlocks, report]);

  // On a Sketchbook page, the selection is context for the chat bar
  // (pageSelection.tsx): the blocks selected, and those of a group
  // selected, in canvas order. What the blocks' own menu does with them (the
  // board context's `keep`) says what it did while the same blocks stay selected.
  const choosing = Boolean(page) && !readOnly;
  const chosenKey = useMemo(() => {
    if (!choosing) return '';
    const picked = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    return canvas.blocks
      .filter((b) => picked.has(b.id) || (b.groupId && picked.has(b.groupId)))
      .map((b) => b.id)
      .join(',');
  }, [choosing, nodes, canvas]);
  const chosen = useMemo(() => (chosenKey ? chosenKey.split(',') : []), [chosenKey]);
  // The chat bar over the page reads them, and its chip's ✕ lets go of them.
  const chosenNames = useMemo(() => {
    const ids = new Set(chosen);
    return canvas.blocks.filter((b) => ids.has(b.id)).map((b) => blockName(b, 60)).join('\n');
  }, [chosen, canvas]);
  const selectingOn = page?.id;
  useEffect(() => {
    if (!selectingOn) return;
    setPageSelection(chosen.length ? { pageId: selectingOn, blockIds: chosen, names: chosenNames.split('\n'), clear: clearSelection } : null);
    return () => setPageSelection(null);
  }, [selectingOn, chosen, chosenNames, clearSelection]);
  const [done, setDone] = useState<KeptBlocks | null>(null);
  const [doneAt, setDoneAt] = useState<Place | null>(null);
  const acting = useRef(false);
  useEffect(() => {
    if (done && done.blockIds.join(',') !== chosenKey) setDone(null);
  }, [done, chosenKey]);
  // From a block's or a group's menu, where the page registered one: these blocks, handed to it.
  const keep = contextSlot?.keep;
  const actOnBlocks = useCallback(
    (ids: string[]) => {
      const wanted = new Set(ids);
      const inOrder = canvas.blocks.filter((b) => wanted.has(b.id)).map((b) => b.id);
      if (!page || !keep || acting.current || inOrder.length === 0) return;
      acting.current = true;
      keep
        .run({ ...contextTools, page, blockIds: inOrder })
        .then((result) => {
          setDone(result);
          selectBlocks(result.blockIds);
        }, report)
        .finally(() => {
          acting.current = false;
        });
    },
    [page, keep, canvas, contextTools, report, selectBlocks],
  );

  const absoluteRect = useCallback(
    (id: string) => {
      const node = flow.getInternalNode(id);
      if (!node) return null;
      const { x, y } = node.internals.positionAbsolute;
      return { x, y, w: node.measured.width ?? node.width ?? 0, h: node.measured.height ?? node.height ?? 0 };
    },
    [flow],
  );

  const frameAt = useCallback(
    (point: { x: number; y: number }) => {
      for (const node of flow.getNodes()) {
        if (node.type !== 'frame') continue;
        const r = absoluteRect(node.id);
        if (r && point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) return { id: node.id, ...r };
      }
      return null;
    },
    [flow, absoluteRect],
  );

  // A block dropped with its centre inside a group joins that group.
  const onNodeDragStop = useCallback(
    (_event: unknown, _node: CanvasNode, dragged: CanvasNode[]) => {
      const moves: Move[] = dragged.map((node) => {
        if (node.type !== 'block') return { id: node.id, x: node.position.x, y: node.position.y };
        const r = absoluteRect(node.id)!;
        const frame = frameAt({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
        return frame
          ? { id: node.id, x: r.x - frame.x, y: r.y - frame.y, groupId: frame.id }
          : { id: node.id, x: r.x, y: r.y, groupId: null };
      });
      const byId = new Map(moves.map((m) => [m.id, m]));
      setNodes((ns) =>
        ns.map((n) => {
          const move = byId.get(n.id);
          if (!move || n.type !== 'block') return n;
          return { ...n, parentId: move.groupId ?? undefined, position: { x: move.x, y: move.y } };
        }),
      );
      hold(moves.map((m) => m.id));
      api.moveItems(ref, name, moves).catch(report);
    },
    [absoluteRect, frameAt, ref, name, report],
  );

  const resize = useCallback(
    (id: string, box: { x: number; y: number; width: number; height: number }) => {
      const moves: Move[] = [{ id, x: box.x, y: box.y, w: box.width, h: box.height }];
      // Resizing a group from its top or left edge shifts its children.
      for (const child of flow.getNodes().filter((n) => n.parentId === id)) {
        moves.push({ id: child.id, x: child.position.x, y: child.position.y });
      }
      hold(moves.map((m) => m.id));
      api.moveItems(ref, name, moves).catch(report);
    },
    [flow, ref, name, report],
  );

  // A block's new size from its menu (an image's Natural size), here at once and then saved.
  const setSize = useCallback(
    (id: string, size: { w: number; h: number }) => {
      const node = flow.getNode(id);
      if (!node) return;
      setNodes((ns) => ns.map((n) => (n.id === id ? ({ ...n, width: size.w, height: size.h } as CanvasNode) : n)));
      resize(id, { x: node.position.x, y: node.position.y, width: size.w, height: size.h });
    },
    [flow, resize],
  );

  // A block's overlay: an image's picture at full size, a Google Doc's editor.
  // A kind that has one opens it from its card (canvas.openOverlay), unless it
  // edits and the board is read-only. Closing one that asks puts focus back on the block.
  // Each ask to open it at a pin is counted, so asking for the same pin again opens it again.
  const [overlay, setOverlay] = useState<{ blockId: string; version?: BlockVersion; pinId?: string; pinAsked?: number; paired?: boolean } | null>(null);
  const pinAsks = useRef(0);
  const openOverlay = useCallback(
    (blockId: string, options: { version?: BlockVersion; pinId?: string; paired?: boolean } = {}) => {
      const block = canvas.blocks.find((b) => b.id === blockId);
      const open = block && webKindOf(block.type).overlay;
      if (open && !(readOnly && open.changes)) setOverlay({ blockId, ...options, ...(options.pinId ? { pinAsked: ++pinAsks.current } : {}) });
    },
    [canvas, readOnly],
  );
  const closeOverlay = useCallback(() => {
    const blockId = overlay?.blockId;
    const block = blockId && canvas.blocks.find((b) => b.id === blockId);
    setOverlay(null);
    if (blockId && blockId === opens) onClosed?.();
    if (!blockId || !block || !webKindOf(block.type).overlay?.refocus) return;
    const node = wrapper.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(blockId)}"]`);
    node?.focus({ preventScroll: true });
  }, [overlay, canvas, opens, onClosed]);
  // The block what holds it opens, once it is drawn here (a pin asked for opens it at the pin instead: focus.ts).
  const openedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!opens || openedFor.current === opens || !canvas.blocks.some((b) => b.id === opens)) return;
    openedFor.current = opens;
    if (!overlay) openOverlay(opens, paired ? { paired } : undefined);
  }, [opens, paired, canvas, overlay, openOverlay]);
  // A block that goes while its overlay is open closes it.
  useEffect(() => {
    if (overlay && !canvas.blocks.some((b) => b.id === overlay.blockId)) setOverlay(null);
  }, [overlay, canvas]);
  // Enter, or a tap of Space, on a focused block that has a way to open it (an
  // image at full size). Space held down moves the canvas (with a drag or the
  // wheel), so it opens the block on letting go, and not if it was held.
  const spaceUsed = useRef(false);
  const openFocused = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('react-flow__node')) return;
    const block = canvas.blocks.find((b) => b.id === target.dataset.id);
    const activate = block && webKindOf(block.type).activate;
    if (!block || !activate) return;
    event.preventDefault();
    if (event.key === 'Enter') activate(block, context);
    else if (event.type === 'keyup' && !spaceUsed.current) activate(block, context);
  };
  const onCanvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ') spaceUsed.current = event.repeat;
    if (event.key === 'Enter' || event.key === ' ') openFocused(event);
  };
  const onCanvasKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ') openFocused(event);
  };
  const spaceMoved = () => {
    spaceUsed.current = true;
  };
  const box = useBoxLeavesGroups(nodes);
  const moving = useKeyPress(covered ? null : PAN_KEY); // Space held: a drag moves the canvas, even one that starts on a block or a group

  // Deletion is the server's call: removing a group keeps its blocks, and a
  // block's links go with it (and come back with it on Undo). Local state
  // follows from the change the server sends.
  const onBeforeDelete: OnBeforeDelete<CanvasNode, LinkEdgeType> = useCallback(
    async ({ nodes: doomedNodes, edges: doomedEdges }) => {
      const chosen = new Set(doomedNodes.filter((node) => node.selected).map((node) => node.id));
      const links = doomedEdges.filter((edge) => edge.selected && !chosen.has(edge.source) && !chosen.has(edge.target));
      removeItems([...chosen, ...links.map((edge) => edge.id)]);
      return false;
    },
    [removeItems],
  );

  const onConnect = useCallback(
    ({ source, target }: Connection) => {
      if (source && target && source !== target) api.addLink(name, source, target).catch(report);
    },
    [name, report],
  );

  const viewportCentre = () => {
    const rect = wrapper.current!.getBoundingClientRect();
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  // Centres a new item on `point`, nudging it off any item already starting
  // there, and drops it into the group under the point if there is one.
  const placeAt = (point: { x: number; y: number }, size: { w: number; h: number }, exact = false) => {
    let x = point.x - size.w / 2;
    let y = point.y - size.h / 2;
    const taken = (px: number, py: number) =>
      flow.getNodes().some((n) => {
        const r = absoluteRect(n.id);
        return r && Math.abs(r.x - px) < 24 && Math.abs(r.y - py) < 24;
      });
    for (let i = 0; i < 20 && !exact && taken(x, y); i++) {
      x += 32;
      y += 32;
    }
    const frame = frameAt(point);
    return frame
      ? { x: Math.round(x - frame.x), y: Math.round(y - frame.y), groupId: frame.id }
      : { x: Math.round(x), y: Math.round(y) };
  };

  const addBlock = async (content: BlockContent, options: NewBlockOptions = {}): Promise<Block | undefined> => {
    const { at, title } = options;
    const kind = kindOf(content.type);
    const size = options.size ?? kind.sizeFor?.(content as never, {}) ?? kind.defaultSize;
    try {
      const place = placeAt(at ?? viewportCentre(), size, options.exact);
      const block = await api.addBlock(ref, name, { content, title, ...place, w: size.w, h: size.h });
      webKindOf(content.type).added?.(block, { edit: setAutoEditId });
      return block;
    } catch (e) {
      report(e);
      return undefined;
    }
  };
  const addContext: AddContext = {
    add: async (content, options) => {
      await addBlock(content, options);
    },
    report,
  };

  // The drawing tools (drawTools.ts, draw.tsx): offered while this canvas can
  // be drawn on (editable, uncovered, no full view open), their keys with them.
  const tools = useDrawTools();
  const drawable = !readOnly && !covered && !overlay;
  useEffect(() => (drawable ? drawTools.register() : undefined), [drawable]);
  useDrawKeys(drawable);
  const drawing = useDrawing(tools, drawable, {
    wrapper,
    flow,
    canvas,
    add: addBlock,
    link: (from, to, weight) => void api.addLink(name, from, to, weight).catch(report),
    change: (block, patch) => changeBlock(block, patch),
    move: (moves) => {
      hold(moves.map((m) => m.id));
      api.moveItems(ref, name, moves).catch(report);
    },
    report,
  });
  const drawingNow = drawable && tools.tool !== 'select';
  const toggleOf = (type: string) => {
    let toggle = toggles.current.get(type);
    if (!toggle) toggles.current.set(type, (toggle = createRef<HTMLButtonElement>()));
    return toggle;
  };
  const addGroup = async () => {
    try {
      const { x, y } = placeAt(viewportCentre(), GROUP_SIZE);
      await api.addGroup(ref, name, { title: 'New group', x, y, w: GROUP_SIZE.w, h: GROUP_SIZE.h });
    } catch (e) {
      report(e);
    }
  };

  // Blocks copied from a canvas are made again here, centred on the view; the
  // server makes the copies. A refusal is shown as any other; one that says
  // what was copied is gone (404) lets its words paste as a note instead.
  const pasteBlocks = async ({ ids }: BlocksClip) => {
    try {
      await api.pasteBlocks(ref, name, { ids, at: viewportCentre() });
      return true;
    } catch (e) {
      report(e);
      return (e as RequestError).status !== 404;
    }
  };

  // What is dropped on the canvas or pasted on the page (intake.tsx).
  const { dropProps, overlays } = useIntake({
    wrapper,
    flow,
    context: addContext,
    readOnly: readOnly || covered,
    clips: !overlay,
    openForm: (type, initial) => setForm({ type, initial }),
    pasteBlocks,
  });
  const selected = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);
  useCopyBlocks(canvas, selected, !overlay && !covered);

  // Selecting words in a note pins them: the press begins in the note's words
  // and the selection is there as the button comes up (wordsPressed and
  // wordsReleased, pins.tsx). A press anywhere else pins nothing, whatever the
  // browser holds selected. A press on the empty canvas, which draws a
  // selection box, lets go of words left selected, as a click on a page does,
  // and selects none: a browser would start a selection in the first words on
  // the canvas, in whichever block they are, and Safari's grows over every
  // block as the box is drawn. A double-click's word selection is left alone:
  // double-clicking edits.
  useEffect(() => {
    let pressed: HTMLElement | null = null;
    let onPane = false;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const inCanvas = Boolean(target && wrapper.current?.contains(target));
      pressed = inCanvas ? wordsPressed(event) : null;
      onPane = inCanvas && event.button === 0 && Boolean(target?.classList?.contains('react-flow__pane'));
      const selection = window.getSelection();
      if (onPane && selection && !selection.isCollapsed) selection.removeAllRanges();
    };
    const onPointerUp = () => {
      onPane = false;
    };
    const onSelectStart = (event: Event) => {
      if (onPane) event.preventDefault();
    };
    const onMouseUp = (event: MouseEvent) => {
      const from = pressed;
      pressed = null;
      if (readOnly || !from || event.button !== 0 || event.detail > 1) return;
      if ((event.target as HTMLElement | null)?.closest?.('input, textarea, .pin-prompt')) return;
      if (from.closest('.is-viewing-version')) return; // an earlier version is only for looking at
      const selection = window.getSelection();
      const part = wordsReleased(from, selection);
      if (!part) return;
      selection?.removeAllRanges();
      setPinDraft({ blockId: from.dataset.blockId!, part, quote: part.quote });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('selectstart', onSelectStart, true);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
      document.removeEventListener('selectstart', onSelectStart, true);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [readOnly]);

  // The prompt follows its part as the canvas pans and zooms.
  useLayoutEffect(() => {
    setPromptAt(pinDraft && wrapper.current ? promptPlace(wrapper.current, pinDraft.blockId) : null);
  }, [pinDraft, transform, canvas]);

  // A part whose block is gone has nothing to pin.
  useEffect(() => {
    if (pinDraft && !canvas.blocks.some((b) => b.id === pinDraft.blockId)) setPinDraft(null);
  }, [pinDraft, canvas]);

  const closePin = useCallback(() => setPinDraft(null), []);

  // A pin's thread follows its chip, like the prompt; it closes when the pin goes.
  useLayoutEffect(() => {
    setThreadAt(thread && wrapper.current ? threadPlace(wrapper.current, thread, threadHeight) : null);
  }, [thread, transform, canvas, threadHeight]);
  useEffect(() => {
    if (thread && !canvas.pins.some((p) => p.id === thread)) setThread(null);
    if (awaited && canvas.pins.some((p) => p.id === awaited)) {
      setThread(awaited);
      setAwaited(null);
    }
  }, [thread, awaited, canvas]);
  const closeThread = useCallback(() => setThread(null), []);

  // What a page's block menu did goes under the blocks it acted on (or above
  // or beside them) as the canvas pans and zooms, while they stay selected. It
  // hides while blocks are dragged, or a part's prompt or thread is open.
  const showDone = Boolean(done) && !pinDraft && !thread && !overlay && !nodes.some((n) => n.dragging);
  useLayoutEffect(() => {
    const root = wrapper.current;
    if (!showDone || !done || !root) return setDoneAt(null);
    const around = done.blockIds.flatMap((id) => root.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`) ?? []);
    setDoneAt(around.length ? placeBy(root, around, DONE_LINE.height, DONE_LINE.width, CHAT_FOOT, true) : null);
  }, [showDone, done, transform, nodes]);
  const openThread = useCallback(
    (pinId: string) => {
      setPinDraft(null);
      setThread((open) => (open === pinId ? null : pinId));
      onSeeItem(pinId);
    },
    [onSeeItem],
  );

  // A comment's quote shows its part: the block comes into view and the part
  // is highlighted for a moment. Parts of a document its connector edits (words in a Google Doc) open the editor there.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const pin = canvas.pins.find((p) => p.id === (event as CustomEvent<string>).detail);
      if (!pin) return;
      const block = canvas.blocks.find((b) => b.id === pin.blockId);
      if (block && webKindOf(block.type).opensOnPin?.(block, pin)) openOverlay(block.id, { pinId: pin.id });
      void flow.fitView({ nodes: [{ id: pin.blockId }], duration: 400, maxZoom: 1, padding: 0.3 });
      setFocus(null);
      requestAnimationFrame(() => setFocus(pin.id)); // again from the start, if it was already showing
    };
    window.addEventListener(FOCUS_PIN, onFocus);
    return () => window.removeEventListener(FOCUS_PIN, onFocus);
  }, [canvas, flow, openOverlay]);
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => setFocus(null), FOCUS_MS);
    return () => clearTimeout(timer);
  }, [focus]);
  // A block opened from search comes into view, selected, once it is drawn.
  const showBlock = useCallback(
    (id: string) => {
      if (!flow.getInternalNode(id)?.measured.width) return false;
      void flow.fitView({ nodes: [{ id }], duration: 400, maxZoom: 1, padding: 0.3 });
      selectBlocks([id]);
      return true;
    },
    [flow, selectBlocks],
  );
  // A pin opened from its address (an item of what needs the viewer, a
  // notification) opens its thread: in its block's full view, at its part (a
  // website's element, on its page), when the kind opens there or that view
  // is open already; else by its chip, out from under another block's full
  // view, shown as a comment's quote shows it once its block is drawn.
  // Opened, its replies are seen.
  const showPin = useCallback(
    (pin: Pin) => {
      const block = canvas.blocks.find((b) => b.id === pin.blockId);
      if (!block) return true;
      const drawn = Boolean(flow.getInternalNode(block.id)?.measured.width);
      const bring = () => void flow.fitView({ nodes: [{ id: block.id }], duration: 400, maxZoom: 1, padding: 0.3 });
      if (webKindOf(block.type).opensOnPin?.(block, pin) || (overlay?.blockId === block.id && !overlay.version)) {
        if (drawn) bring(); // for when the full view closes
        onSeeItem(pin.id);
        openOverlay(block.id, { pinId: pin.id });
        return true;
      }
      if (!drawn) return false;
      bring();
      onSeeItem(pin.id);
      setOverlay(null);
      setFocus(null);
      requestAnimationFrame(() => setFocus(pin.id));
      if (pin.discussion) {
        setPinDraft(null);
        setThread(pin.id);
      }
      return true;
    },
    [canvas, flow, onSeeItem, openOverlay, overlay],
  );
  useFocusBlock(canvas, showBlock, showPin);

  // A comment from the prompt shows where it went: in the card's discussion,
  // or the board context pin's thread, opened.
  const commented = useCallback((pin: Pin, comment: { id: string }) => {
    if (pin.discussion?.thread) setAwaited(pin.id);
    else showComments([comment.id]);
  }, []);
  const pins = useMemo(() => {
    const byBlock = new Map<string, Pin[]>();
    for (const pin of canvas.pins) byBlock.set(pin.blockId, [...(byBlock.get(pin.blockId) ?? []), pin]);
    return byBlock;
  }, [canvas]);

  const context: CanvasContextValue = useMemo(
    () => ({
      board,
      owner,
      evidence,
      viewer: name,
      readOnly,
      highlightOption,
      autoEditId,
      clearAutoEdit: () => setAutoEditId(null),
      updateBlock: (block, patch, again) => void changeBlock(block, patch, again).catch(report),
      restoreBlock: (block, rev) =>
        api.restoreBlock(block.id, name, rev, block.rev).then(
          () => true,
          (e) => {
            report(e);
            return false;
          },
        ),
      deleteVersions: (block, rev) =>
        (rev === undefined ? api.deleteEarlierVersions(block.id, name) : api.deleteVersion(block.id, name, rev)).then(
          ({ deleted }) => {
            removed([deleted]);
            return true;
          },
          (e) => {
            report(e);
            return false;
          },
        ),
      // How a link shows is not an edit to it, so it goes without a rev and can't conflict.
      openLink: (block, open) => void api.updateBlock(block.id, name, { open }).catch(report),
      openOverlay,
      newItems,
      seeItem: onSeeItem,
      resize,
      setSize,
      renameGroup: (id, title) => void api.renameGroup(id, name, title).catch(report),
      relabelLink: (id, label) => void api.relabelLink(id, name, label).catch(report),
      removeItem: (id) => removeItems([id]),
      perform: (action) => void action(name).catch(report),
      pins,
      draft: pinDraft,
      startPin: (draft) => {
        if (readOnly) return;
        setThread(null);
        setPinDraft(draft);
      },
      focusPin: focus,
      thread,
      openThread,
      boardContext: contextSlot && onContext ? { slot: contextSlot, tools: contextTools } : undefined,
      keep: choosing && keep ? { words: keep, run: actOnBlocks } : undefined,
    }),
    [board, owner, evidence, page, readOnly, highlightOption, autoEditId, name, report, resize, newItems, onSeeItem, pins, pinDraft, focus, thread, openThread,
      contextSlot, onContext, contextTools, choosing, keep, actOnBlocks, removeItems, removed, setSize, openOverlay, changeBlock],
  );

  // The Add button and the form it opened, floating on the canvas.
  const adding = (
    <>
      <AddMenu owner={ownerKind} context={addContext} toggleOf={toggleOf} setForm={setForm} addGroup={addGroup} />
      {form &&
        (() => {
          const entry = webKindOf(form.type).menu;
          if (!entry || !('Form' in entry)) return null;
          return (
            <entry.Form key={form.initial ?? ''} initial={form.initial} toggle={toggleOf(form.type)} context={addContext} close={() => setForm(null)} />
          );
        })()}
    </>
  );

  // Add floats in the canvas's top-left group, after what leads it. There,
  // its menu and forms drop from under it, where the canvas is wide enough
  // for them (canvas.css).
  const addsHere = !readOnly;
  const empty = canvas.blocks.length === 0 && canvas.groups.length === 0;
  const note = emptyNote ?? (page ? `A canvas for “${page.title}”, to think it through with agents.` : undefined);
  const threadPin = thread ? canvas.pins.find((p) => p.id === thread) : undefined;
  const overlaid = overlay ? canvas.blocks.find((b) => b.id === overlay.blockId) : undefined;
  const Overlay = overlaid && webKindOf(overlaid.type).overlay;

  return (
    <CanvasContext.Provider value={context}>
      <div
        ref={wrapper}
        className={readOnly ? 'canvas is-read-only' : drawingNow ? `canvas is-drawing draws-${tools.tool === 'shape' ? tools.shape : tools.tool}` : 'canvas'}
        {...dropProps}
        onKeyDown={onCanvasKeyDown}
        onKeyUp={onCanvasKeyUp}
        onPointerDownCapture={(event) => {
          spaceMoved();
          if (!moving && drawing.press(event)) return;
          box.onPointerDownCapture(event);
        }}
        onPointerUpCapture={box.onPointerUpCapture}
        onPointerCancelCapture={box.onPointerCancelCapture}
        onWheelCapture={spaceMoved}
      >
        <ReactFlow<CanvasNode, LinkEdgeType>
          nodes={box.nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onBeforeDelete={onBeforeDelete}
          onConnect={onConnect}
          isValidConnection={(c) => c.source !== c.target}
          colorMode={theme.base}
          fitView={fitOnOpen}
          fitViewOptions={underBar ? FIT_UNDER_BAR : FIT}
          minZoom={0.15}
          maxZoom={4}
          panOnScroll
          panOnDrag={PAN_BUTTONS}
          panActivationKeyCode={covered ? null : PAN_KEY}
          selectionOnDrag={!drawingNow}
          selectionMode={SelectionMode.Partial}
          zoomOnDoubleClick={false}
          multiSelectionKeyCode={MULTI_SELECT}
          nodesDraggable={!readOnly && !moving && !drawingNow}
          nodesConnectable={!readOnly}
          deleteKeyCode={readOnly || covered ? null : ['Backspace', 'Delete']}
          proOptions={proOptions}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} fitViewOptions={underBar ? FIT_UNDER_BAR : FIT} />
          <PanHint />
          {(lead !== undefined || addsHere) && (
            <Panel position="top-left" className="canvas-toolbar is-add">
              {lead}
              {addsHere && (lead === undefined ? adding : <div className="canvas-toolbar-add">{adding}</div>)}
            </Panel>
          )}
          {(error || editsContext || toast) && (
            <Panel position="bottom-center" className="canvas-bottom">
              {error && (
                <div className="canvas-error" role="alert">
                  {error}
                </div>
              )}
              {toast}
              {/* Above the chat bar, which floats over the canvas's foot (threads.tsx). */}
              {contextSlot && editsContext && picked.length > 1 && contextSlot.selection({ ...contextTools, blockIds: picked })}
              {editsContext && <PendingRequests board={board} name={name} />}
            </Panel>
          )}
        </ReactFlow>
        {drawing.preview}
        {pinDraft && promptAt && (
          <PinPrompt
            draft={pinDraft}
            block={canvas.blocks.find((b) => b.id === pinDraft.blockId)}
            name={name}
            style={{ left: promptAt.left, top: promptAt.top, width: promptAt.width }}
            above={promptAt.above}
            onChange={setPinDraft}
            onClose={closePin}
            onCommented={commented}
          />
        )}
        {threadPin && threadAt && (
          <PinThread
            key={threadPin.id}
            pin={threadPin}
            block={canvas.blocks.find((b) => b.id === threadPin.blockId)}
            name={name}
            style={{ left: threadAt.left, top: threadAt.top, width: threadAt.width }}
            above={threadAt.above}
            onClose={closeThread}
            onHeight={setThreadHeight}
          />
        )}
        {showDone && done && doneAt && done.notice({ style: { left: doneAt.left, top: doneAt.top, maxWidth: doneAt.width }, above: doneAt.above })}
        {overlay && overlaid && Overlay && !(readOnly && Overlay.changes) && (
          <Overlay.Component
            key={overlaid.id}
            block={overlaid}
            name={name}
            version={overlay.version}
            pinId={overlay.pinId}
            pinAsked={overlay.pinAsked}
            paired={overlay.paired}
            onClose={closeOverlay}
          />
        )}
        {overlays}
        {empty && (
          <div className="canvas-empty">
            {note && <p>{note}</p>}
            {!readOnly && (
              <p className="muted small">
                Add a block above, paste a screenshot, a web address or some text, or drop an image, a code file, a link or some text. Drag from
                a block's right edge to link it. Agents add blocks with <code>add_block</code>.
              </p>
            )}
          </div>
        )}
      </div>
    </CanvasContext.Provider>
  );
}
