import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { LANE_NAMES, isOrdered, laneOrder, laneTasks, moveFor, spotLabel, type Move } from '../../core/taskOrder';
import { TASK_STATUSES, type Board, type Task, type TaskStatus } from '../../core/types';
import { api } from '../shared/api';
import { Icon } from '../shared/components';
import { go } from '../shared/pages';
import './taskDrag.css';

// Dragging task cards between lanes and within them. A drop does what the
// card's own control does (Mark ready, a review, blocking), with the same
// rules on the server; moves that need a note, a choice or a confirmation ask
// in a popover at the drop. Pointer events, so mouse, pen and touch (after a
// short press) all work; the keyboard picks a card up with Space.

export interface Spot {
  lane: TaskStatus;
  index: number; // in the lane without the card being moved
}

interface Lift {
  task: Task;
  from: Spot;
  over: Spot | null;
  keyboard: boolean;
  height: number;
}

interface Ask {
  task: Task;
  move: Move;
  spot: Spot;
  after: string | null | undefined;
  x: number;
  y: number;
  keyboard: boolean;
}

interface Pending {
  taskId: string;
  spot: Spot;
  placed: boolean;
  expect?: { status: TaskStatus; rank?: number }; // the server's answer, once it comes
}

type Patch = Parameters<typeof api.updateTask>[2];

// Pressing here selects text or works a control, rather than lifting the card.
const NO_DRAG = 'button, select, input, textarea, label, summary, form, [contenteditable], a:not(.task-title), .task-detail, .card-note, .task-waits-q, .task-links, .stale-banner p, .error';
const MOUSE_SLOP = 4; // px before a press becomes a drag
const TOUCH_HOLD = 280; // ms a finger rests before the card lifts
const TOUCH_SLOP = 8; // px a finger may wander before it's a scroll instead
const EDGE = 56; // px from an edge where lanes scroll
const MAX_SPEED = 16; // px per frame

export interface TaskDrag {
  lanes: Record<TaskStatus, Task[]>;
  lanesRef: RefObject<HTMLDivElement | null>;
  dragging: boolean;
  laneState: (lane: TaskStatus) => { className: string; hint?: string };
  slot: (lane: TaskStatus) => { at: number; label: string; height: number } | null;
  cardProps: (task: Task, lane: TaskStatus, index: number) => CardDragProps;
  layer: React.ReactNode; // the popover, the live region and errors
}

export interface CardDragProps {
  className: string;
  tabIndex?: number;
  'aria-describedby'?: string;
  onPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onBlur?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
}

export function useTaskDrag(board: Board, name: string, readOnly: boolean): TaskDrag {
  const [lift, setLiftState] = useState<Lift | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const liftRef = useRef<Lift | null>(null);
  const setLift = (next: Lift | null) => {
    liftRef.current = next;
    setLiftState(next);
  };

  // The lanes as shown: the board's order, with a move on its way to the
  // server already in place.
  const lanes = useMemo(() => {
    const moving = pending && board.tasks.find((t) => t.id === pending.taskId);
    const rest = moving ? board.tasks.filter((t) => t !== moving) : board.tasks;
    const result = Object.fromEntries(TASK_STATUSES.map((s) => [s, laneTasks(rest, s)])) as Record<TaskStatus, Task[]>;
    if (pending && moving) {
      const lane = pending.spot.lane;
      const shown: Task = { ...moving, status: lane };
      if (pending.placed) result[lane].splice(pending.spot.index, 0, shown);
      else result[lane] = laneOrder([...result[lane], { ...shown, rank: undefined, updatedAt: new Date().toISOString() }]);
    }
    return result;
  }, [board.tasks, pending]);
  const lanesNow = useRef(lanes);
  lanesNow.current = lanes;

  // The move stays in place until the board shows it.
  useEffect(() => {
    if (!pending?.expect) return;
    const task = board.tasks.find((t) => t.id === pending.taskId);
    if (!task || (task.status === pending.expect.status && task.rank === pending.expect.rank)) setPending(null);
  }, [board.tasks, pending]);
  useEffect(() => {
    if (!pending?.expect) return;
    const timer = setTimeout(() => setPending(null), 4000);
    return () => clearTimeout(timer);
  }, [pending]);

  // After a keyboard move the card is drawn in its new lane; focus follows it.
  useEffect(() => {
    if (!focusId) return;
    document.querySelector<HTMLElement>(`[data-task-card="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: false });
    setFocusId(null);
  }, [focusId, lanes]);

  const announce = useCallback((text: string) => {
    setMessage('');
    requestAnimationFrame(() => setMessage(text));
  }, []);

  const without = (lane: TaskStatus, taskId: string) => lanesNow.current[lane].filter((t) => t.id !== taskId);

  // What dropping at a spot does, for the slot and for screen readers.
  const describe = (task: Task, from: Spot, spot: Spot): { move: Move | null; text: string } => {
    if (spot.lane === from.lane && (!isOrdered(spot.lane) || spot.index === from.index)) {
      return { move: null, text: `Back where it was, in ${LANE_NAMES[spot.lane]}` };
    }
    const move = moveFor(task, spot.lane);
    if (!move.allowed) return { move: null, text: `${LANE_NAMES[spot.lane]}: ${move.reason}` };
    const label = move.kind === 'reorder' ? (spot.index < from.index ? 'Move up' : 'Move down') : move.label;
    return { move, text: move.placed ? `${label} · ${spotLabel(spot.lane, spot.index)}` : label };
  };

  // ---- sending a move -------------------------------------------------------

  const send = (task: Task, move: Move, spot: Spot, after: string | null | undefined, extra: Patch = {}) => {
    const patch: Patch = { ...(move.to !== task.status ? { status: move.to } : {}), ...(after !== undefined ? { after } : {}), ...extra };
    setError(null);
    setPending({ taskId: task.id, spot, placed: move.placed });
    api.updateTask(task.id, name, patch).then(
      (saved) => setPending((p) => (p?.taskId === task.id ? { ...p, expect: { status: saved.status, rank: saved.rank } } : p)),
      (e: Error) => {
        setPending((p) => (p?.taskId === task.id ? null : p));
        setError(`Couldn't move T${task.number}: ${e.message}`);
        announce(`Couldn't move T${task.number}: ${e.message}`);
      },
    );
  };

  const drop = (current: Lift, at: { x: number; y: number }) => {
    const { task, from, over, keyboard } = current;
    setLift(null);
    const { move, text } = over ? describe(task, from, over) : { move: null, text: '' };
    if (keyboard && !move?.asks) setFocusId(task.id);
    if (!over) return announce(`Cancelled. T${task.number} is back in ${LANE_NAMES[from.lane]}.`);
    if (!move) return announce(over.lane === from.lane ? `T${task.number} is back where it was.` : `Can't drop there. ${text}.`);
    const after = move.placed ? (without(over.lane, task.id)[over.index - 1]?.id ?? null) : undefined;
    if (move.asks) {
      setAsk({ task, move, spot: over, after, x: at.x, y: at.y, keyboard });
      return;
    }
    announce(`Dropped T${task.number}: ${text}.`);
    send(task, move, over, after);
  };

  const cancel = (current: Lift) => {
    setLift(null);
    if (current.keyboard) setFocusId(current.task.id);
    announce(`Cancelled. T${current.task.number} is back in ${LANE_NAMES[current.from.lane]}.`);
  };

  // ---- pointer --------------------------------------------------------------

  const pointer = useRef<{
    task: Task;
    from: Spot;
    el: HTMLElement;
    id: number;
    touch: boolean;
    startX: number;
    startY: number;
    x: number;
    y: number;
    started: boolean;
    timer?: ReturnType<typeof setTimeout>;
    ghost?: HTMLElement;
    offsetX: number;
    offsetY: number;
    frame?: number;
  } | null>(null);

  // Which lane, and where in it, a point is over.
  const hitTest = (x: number, y: number, current: Lift): Spot | null => {
    const root = lanesRef.current;
    if (!root) return null;
    let best: { el: HTMLElement; d: number } | null = null;
    for (const el of root.querySelectorAll<HTMLElement>('[data-lane]')) {
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d <= 24 && (!best || d < best.d)) best = { el, d };
    }
    if (!best) return null;
    const lane = best.el.dataset.lane as TaskStatus;
    if (!isOrdered(lane)) return { lane, index: lane === current.from.lane ? current.from.index : 0 };
    let index = 0;
    for (const card of best.el.querySelectorAll<HTMLElement>('[data-task-card]')) {
      if (card.dataset.taskCard === current.task.id) continue;
      const r = card.getBoundingClientRect();
      if (r.top + r.height / 2 < y) index++;
    }
    return { lane, index };
  };

  const updateOver = (x: number, y: number) => {
    const current = liftRef.current;
    if (!current || current.keyboard) return;
    const over = hitTest(x, y, current);
    const same = over?.lane === current.over?.lane && over?.index === current.over?.index;
    if (!same) setLift({ ...current, over });
  };

  const placeGhost = () => {
    const p = pointer.current;
    if (!p?.ghost) return;
    // Kept on screen sideways: on a phone the card is as wide as the screen.
    const left = Math.max(4, Math.min(p.x - p.offsetX, innerWidth - p.ghost.offsetWidth - 4));
    p.ghost.style.transform = `translate(${left}px, ${p.y - p.offsetY}px)`;
  };

  // Scrolls the lanes sideways, the lane under the pointer, or the page when
  // the lanes are stacked, while the pointer is near an edge.
  const autoScroll = () => {
    const p = pointer.current;
    const root = lanesRef.current;
    if (!p?.started || !root) return;
    const speed = (distance: number) => Math.ceil(MAX_SPEED * Math.min(1, (EDGE - distance) / EDGE));
    let moved = false;
    const box = root.getBoundingClientRect();
    if (root.scrollWidth > root.clientWidth) {
      const before = root.scrollLeft;
      if (p.x < box.left + EDGE) root.scrollLeft -= speed(p.x - box.left);
      else if (p.x > box.right - EDGE) root.scrollLeft += speed(box.right - p.x);
      moved ||= root.scrollLeft !== before;
    }
    const lane = liftRef.current?.over?.lane;
    const cards = lane ? root.querySelector<HTMLElement>(`[data-lane="${lane}"] .lane-cards`) : null;
    if (cards && cards.scrollHeight > cards.clientHeight + 1) {
      const r = cards.getBoundingClientRect();
      const before = cards.scrollTop;
      if (p.y < r.top + EDGE && p.y > r.top - EDGE) cards.scrollTop -= speed(p.y - r.top);
      else if (p.y > r.bottom - EDGE && p.y < r.bottom + EDGE) cards.scrollTop += speed(r.bottom - p.y);
      moved ||= cards.scrollTop !== before;
    }
    const page = document.scrollingElement;
    if (page && page.scrollHeight > innerHeight + 1) {
      const before = page.scrollTop;
      if (p.y < EDGE) page.scrollTop -= speed(p.y);
      else if (p.y > innerHeight - EDGE) page.scrollTop += speed(innerHeight - p.y);
      moved ||= page.scrollTop !== before;
    }
    if (moved) updateOver(p.x, p.y);
    p.frame = requestAnimationFrame(autoScroll);
  };

  const begin = () => {
    const p = pointer.current;
    if (!p || p.started) return;
    p.started = true;
    const rect = p.el.getBoundingClientRect();
    p.offsetX = p.startX - rect.left;
    p.offsetY = p.startY - rect.top;
    // The card as it looks, tilted, with what dropping does beneath it: the
    // slot itself is mostly under the card.
    const ghost = document.createElement('div');
    ghost.className = 'task-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.width = `${rect.width}px`;
    const clone = p.el.cloneNode(true) as HTMLElement;
    // A clone loses the pickers' current values.
    const selects = p.el.querySelectorAll('select');
    clone.querySelectorAll('select').forEach((s, i) => (s.value = selects[i]?.value ?? s.value));
    clone.classList.add('task-ghost-card');
    clone.removeAttribute('tabindex');
    clone.removeAttribute('data-task-card');
    const label = document.createElement('div');
    label.className = 'task-ghost-label';
    ghost.append(clone, label);
    document.body.appendChild(ghost);
    p.ghost = ghost;
    placeGhost();
    document.body.classList.add('is-task-dragging');
    getSelection()?.removeAllRanges();
    if (p.touch) navigator.vibrate?.(10);
    const next: Lift = { task: p.task, from: p.from, over: p.from, keyboard: false, height: rect.height };
    setLift(next);
    updateOver(p.x, p.y);
    p.frame = requestAnimationFrame(autoScroll);
  };

  const finish = () => {
    const p = pointer.current;
    pointer.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.frame) cancelAnimationFrame(p.frame);
    p.ghost?.remove();
    document.body.classList.remove('is-task-dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKey, true);
    if (p.started) {
      // The press that ended a drag isn't a click on whatever is under it.
      const swallow = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 80);
    }
  };

  // Listeners on window, read through refs, so they always see the current drag.
  const handlers = useRef({ move: (_: PointerEvent) => {}, up: (_: PointerEvent) => {}, cancel: () => {}, key: (_: KeyboardEvent) => {} });
  handlers.current.move = (e) => {
    const p = pointer.current;
    if (!p || e.pointerId !== p.id) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const distance = Math.hypot(p.x - p.startX, p.y - p.startY);
    if (!p.started) {
      if (p.touch) {
        if (distance > TOUCH_SLOP) finish(); // a scroll, not a drag
      } else if (distance > MOUSE_SLOP) begin();
      return;
    }
    placeGhost();
    updateOver(p.x, p.y);
  };
  handlers.current.up = (e) => {
    const p = pointer.current;
    if (!p || e.pointerId !== p.id) return;
    const current = liftRef.current;
    finish();
    if (p.started && current && !current.keyboard) drop(current, { x: e.clientX, y: e.clientY });
  };
  handlers.current.cancel = () => {
    const current = liftRef.current;
    const started = pointer.current?.started;
    finish();
    if (started && current) cancel(current);
  };
  handlers.current.key = (e) => {
    if (e.key !== 'Escape' || !pointer.current?.started) return;
    e.preventDefault();
    e.stopPropagation();
    handlers.current.cancel();
  };
  const onMove = useStable((e: PointerEvent) => handlers.current.move(e));
  const onUp = useStable((e: PointerEvent) => handlers.current.up(e));
  const onCancel = useStable(() => handlers.current.cancel());
  const onKey = useStable((e: KeyboardEvent) => handlers.current.key(e));
  // Once a finger has lifted a card, it moves the card rather than the page,
  // and holding it doesn't open the link menu.
  const onTouchMove = useStable((e: TouchEvent) => {
    if (pointer.current?.started && e.cancelable) e.preventDefault();
  });
  const onContextMenu = useStable((e: Event) => {
    if (pointer.current?.touch) e.preventDefault();
  });

  useEffect(() => () => finish(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, task: Task, from: Spot) => {
    if (readOnly || ask || liftRef.current || pointer.current) return;
    if (e.button !== 0 || !e.isPrimary) return;
    if (!(e.target instanceof Element) || e.target.closest(NO_DRAG)) return;
    const touch = e.pointerType === 'touch';
    pointer.current = {
      task,
      from,
      el: e.currentTarget,
      id: e.pointerId,
      touch,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      started: false,
      offsetX: 0,
      offsetY: 0,
    };
    if (touch) pointer.current.timer = setTimeout(begin, TOUCH_HOLD);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKey, true);
  };

  // ---- keyboard -------------------------------------------------------------

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, task: Task, from: Spot) => {
    if (readOnly || e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return;
    const current = liftRef.current;
    if (!current) {
      if (e.key === 'Enter') {
        e.preventDefault();
        go.task(board.id, task.id);
      } else if (e.key === ' ' && !ask && !pointer.current) {
        e.preventDefault();
        setLift({ task, from, over: from, keyboard: true, height: e.currentTarget.getBoundingClientRect().height });
        announce(
          `Picked up T${task.number}, ${spotLabel(from.lane, from.index)}. Arrow keys move it, Space drops it, Escape cancels.`,
        );
      }
      return;
    }
    if (!current.keyboard || current.task.id !== task.id) return;
    const over = current.over ?? current.from;
    const laneIndex = TASK_STATUSES.indexOf(over.lane);
    let next: Spot | null = null;
    const spotIn = (lane: TaskStatus, index: number): Spot => {
      if (!isOrdered(lane)) return { lane, index: lane === current.from.lane ? current.from.index : 0 };
      return { lane, index: Math.max(0, Math.min(index, without(lane, task.id).length)) };
    };
    switch (e.key) {
      case 'ArrowUp':
        next = spotIn(over.lane, over.index - 1);
        break;
      case 'ArrowDown':
        next = spotIn(over.lane, over.index + 1);
        break;
      case 'ArrowLeft':
        next = laneIndex > 0 ? spotIn(TASK_STATUSES[laneIndex - 1], over.index) : over;
        break;
      case 'ArrowRight':
        next = laneIndex < TASK_STATUSES.length - 1 ? spotIn(TASK_STATUSES[laneIndex + 1], over.index) : over;
        break;
      case ' ':
      case 'Enter': {
        e.preventDefault();
        const slot = document.querySelector('[data-drop-slot]')?.getBoundingClientRect();
        const card = e.currentTarget.getBoundingClientRect();
        const box = slot ?? card;
        drop(current, { x: box.left + box.width / 2, y: box.bottom });
        return;
      }
      case 'Escape':
        e.preventDefault();
        cancel(current);
        return;
      case 'Tab':
        cancel(current);
        return;
      default:
        return;
    }
    e.preventDefault();
    setLift({ ...current, over: next });
    announce(describe(task, current.from, next).text);
  };

  // What dropping here does, under the lifted card.
  useEffect(() => {
    const label = pointer.current?.ghost?.querySelector<HTMLElement>('.task-ghost-label');
    if (!label || !lift || lift.keyboard) return;
    const home = !lift.over || (lift.over.lane === lift.from.lane && (!isOrdered(lift.over.lane) || lift.over.index === lift.from.index));
    const { move, text } = lift.over && !home ? describe(lift.task, lift.from, lift.over) : { move: null, text: '' };
    label.textContent = text;
    label.dataset.state = home ? 'none' : move ? 'go' : 'off';
  });

  // The slot in view as the keyboard moves it.
  useEffect(() => {
    if (!lift?.keyboard) return;
    document.querySelector('[data-drop-slot]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [lift]);

  // ---- what the view draws --------------------------------------------------

  const laneState = (lane: TaskStatus) => {
    // While a drop asks, only where it's going stands out.
    if (ask) return { className: ask.spot.lane === lane ? ' is-drop-target' : '' };
    const current = lift;
    if (!current) return { className: '' };
    if (lane === current.from.lane) {
      const moving = current.over?.lane === lane && isOrdered(lane) && current.over.index !== current.from.index;
      return { className: moving ? ' is-drop-target' : '' };
    }
    const move = moveFor(current.task, lane);
    if (!move.allowed) return { className: ' is-drop-off', hint: move.reason };
    return { className: current.over?.lane === lane ? ' is-drop-target' : '' };
  };

  const slot = (lane: TaskStatus) => {
    if (ask) {
      if (ask.spot.lane !== lane) return null;
      const label = describe(ask.task, { lane: ask.task.status, index: -1 }, ask.spot).text;
      return { at: ask.spot.index, label, height: 56 };
    }
    if (!lift?.over || lift.over.lane !== lane) return null;
    const { move, text } = describe(lift.task, lift.from, lift.over);
    if (!move) return null;
    const home = lane === lift.from.lane;
    const at = home && lift.over.index >= lift.from.index ? lift.over.index + 1 : lift.over.index;
    return { at, label: text, height: Math.max(56, Math.min(lift.height, 120)) };
  };

  const cardProps = (task: Task, lane: TaskStatus, index: number): CardDragProps => {
    if (readOnly) return { className: '' };
    const from = { lane, index };
    let className = '';
    if (lift?.task.id === task.id) {
      if (lift.keyboard) className = ' is-lifted';
      else {
        const elsewhere = lift.over?.lane === lane && isOrdered(lane) && lift.over.index !== lift.from.index;
        className = elsewhere ? ' is-drag-source is-collapsed' : ' is-drag-source';
      }
    } else if (pending?.taskId === task.id) className = ' is-moving';
    return {
      className,
      tabIndex: 0,
      'aria-describedby': 'task-drag-help',
      onPointerDown: (e) => onPointerDown(e, task, from),
      onKeyDown: (e) => onKeyDown(e, task, from),
      onBlur: () => {
        const current = liftRef.current;
        if (current?.keyboard && current.task.id === task.id) requestAnimationFrame(() => liftRef.current === current && cancel(current));
      },
      onDragStart: (e) => e.preventDefault(),
    };
  };

  const closeAsk = (sent: boolean) => {
    if (!ask) return;
    if (!sent) announce(`Cancelled. T${ask.task.number} stays in ${LANE_NAMES[ask.task.status]}.`);
    if (ask.keyboard || !sent) setFocusId(ask.task.id);
    setAsk(null);
  };

  const layer = (
    <>
      <p id="task-drag-help" hidden>
        Press Space to pick the card up, the arrow keys to move it, Space to drop it and Escape to cancel. Enter opens it.
      </p>
      <div className="drag-live" aria-live="assertive" aria-atomic="true">
        {message}
      </div>
      {error && (
        <p className="drag-error" role="alert">
          {error}
          <button className="btn btn-quiet btn-small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {ask && (
        <DropAsk
          key={`${ask.task.id}:${ask.spot.lane}`}
          ask={ask}
          onCancel={() => closeAsk(false)}
          onSend={(extra) => {
            announce(`T${ask.task.number}: ${describe(ask.task, { lane: ask.task.status, index: -1 }, ask.spot).text}.`);
            send(ask.task, ask.move, ask.spot, ask.after, extra);
            closeAsk(true);
          }}
        />
      )}
    </>
  );

  return { lanes, lanesRef, dragging: Boolean(lift || ask), laneState, slot, cardProps, layer };
}

// A function whose identity never changes, for adding and removing listeners.
function useStable<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useRef((...args: A) => ref.current(...args)).current;
}

// The slot a card would drop into, saying what dropping does.
export function DropSlot({ label, height }: { label: string; height: number }) {
  return (
    <div className="drop-slot" data-drop-slot style={{ minHeight: height }}>
      {label}
    </div>
  );
}

// The question a drop asks before it does anything: the review's choice, the
// note blocking or sending back needs, or a confirmation to reopen done work.
function DropAsk({ ask, onCancel, onSend }: { ask: Ask; onCancel: () => void; onSend: (extra: Patch) => void }) {
  const { task, move } = ask;
  const [note, setNote] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const label = `T${task.number}`;
  const builder = task.claimedBy?.name ?? 'The agent';

  // At the drop, kept on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(12, Math.min(ask.x + 12, innerWidth - width - 12));
    const top = Math.max(12, Math.min(ask.y - 24, innerHeight - height - 12));
    setPlace({ left, top });
  }, [ask.x, ask.y]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onCancel();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), onCancel());
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onCancel]);

  const needsNote = move.note === 'required';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (needsNote && !note.trim()) return;
    onSend(note.trim() ? { note } : {});
  };

  const to = LANE_NAMES[move.to];
  let title: string;
  let lead: string | undefined;
  let placeholder = '';
  let action = '';
  switch (move.kind) {
    case 'approve':
      title = `${label} to Done?`;
      lead = 'Dropping a card from review into Done approves it.';
      break;
    case 'send-back':
      title = `${label} needs changes`;
      lead = move.to === 'todo' ? `It goes back to To do, still ${builder}'s.` : `It goes back to ${builder}, with your note.`;
      placeholder = `What needs changing? ${builder} gets this note.`;
      action = 'Send back';
      break;
    case 'block':
      title = "What's in the way?";
      lead = `${label} moves to Blocked until it's cleared.`;
      placeholder = "What's blocking it?";
      action = 'Block';
      break;
    default: // reopen
      title = `Reopen ${label}?`;
      lead =
        move.to === 'todo'
          ? 'It goes back to To do, where agents pick it up.'
          : move.to === 'backlog'
            ? 'It goes back to the backlog.'
            : `It goes back to ${to}.`;
      placeholder = needsNote ? "What's in the way?" : "What's left to do? Optional. Agents read it.";
      action = 'Reopen';
  }

  return (
    <form
      ref={ref}
      className="drop-ask"
      role="dialog"
      aria-label={title}
      style={place ? { left: place.left, top: place.top } : { left: ask.x, top: ask.y, visibility: 'hidden' }}
      onSubmit={submit}
    >
      <h4>{title}</h4>
      {lead && <p className="drop-ask-lead">{lead}</p>}
      {move.kind === 'approve' ? (
        <div className="drop-ask-actions">
          {task.noCommit ? (
            <button type="button" autoFocus className="btn btn-small btn-approve" onClick={() => onSend({})} title={`Nothing to commit: ${task.noCommit.reason}`}>
              <Icon name="check" /> Looks good
            </button>
          ) : (
            <>
              <button
                type="button"
                autoFocus
                className="btn btn-small btn-approve"
                onClick={() => onSend({ approveCommit: true })}
                title={`Approve it, and ask ${task.claimedBy?.name ?? 'the agent'} to commit the work`}
              >
                <Icon name="check" /> Looks good, commit it
              </button>
              <button type="button" className="btn btn-small" onClick={() => onSend({})} title="Approve it without a commit">
                Looks good
              </button>
            </>
          )}
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <textarea
            autoFocus
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            required={needsNote}
          />
          <div className="drop-ask-actions drop-ask-row">
            <button className="btn btn-small btn-primary" disabled={needsNote && !note.trim()}>
              {action}
            </button>
            <button type="button" className="btn btn-quiet btn-small" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </form>
  );
}
