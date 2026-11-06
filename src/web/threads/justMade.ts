import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { cardsFromYourThreads } from '../../core/threadList';
import { boardKey, type Board } from '../../core/types';

// "Just made": a decision or task an agent made from a conversation you are
// part of (core/threadList.ts) stays lit on its tab until you've seen it,
// rather than for a moment, since you were likely reading the conversation
// when it landed. Seen is: opened, or in view while you're looking at the
// board, which is whenever the conversation's panel is closed, and with it
// open, once you move over or scroll the board. Then it fades as any change
// does. Only what lands while the page is open counts; what came while you
// were away is the inbox's "new".

const LOOK = 'tricot:look-at-board';
const LOOKING_MS = 3000; // a move over the board counts as looking for this long
let lookedAt = 0;
let listening = false;

const board = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.board-layout > :first-child'));

function listen(): void {
  if (listening) return;
  listening = true;
  const onActivity = (e: Event) => {
    if (!board(e.target)) return;
    lookedAt = Date.now();
    window.dispatchEvent(new Event(LOOK));
  };
  for (const type of ['pointermove', 'wheel', 'scroll', 'keydown']) document.addEventListener(type, onActivity, { capture: true, passive: true });
}

function lookingAtBoard(): boolean {
  return !document.querySelector('.thread-dock') || Date.now() - lookedAt < LOOKING_MS;
}

// The board is looked at again, e.g. as the panel closes: what's lit in view is seen.
export function lookAtBoard(): void {
  window.dispatchEvent(new Event(LOOK));
}

// How long a seen one takes to fade, as a change's flash does (styles.css).
const FADE_MS = 1800;

export interface JustMade {
  held: ReadonlySet<string>; // lit until seen
  fading: ReadonlySet<string>; // seen, fading
  seen: (id: string, fade?: boolean) => void;
}

export function useJustMade(board: Board | null, me: string): JustMade {
  // The cards there when the page first had this board (the page moves
  // between boards without starting again).
  const there = useRef<{ board: string; ids: Set<string> } | null>(null);
  const [released, setReleased] = useState<ReadonlySet<string>>(new Set());
  const [fading, setFading] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  if (board && there.current?.board !== boardKey(board)) {
    there.current = { board: boardKey(board), ids: new Set([...board.decisions, ...board.tasks].map((c) => c.id)) };
  }
  const yours = board ? cardsFromYourThreads(board, me) : [];
  const key = yours.filter((id) => !there.current?.ids.has(id) && !released.has(id)).join();
  const held = useMemo<ReadonlySet<string>>(() => new Set(key ? key.split(',') : []), [key]);
  useEffect(() => listen(), []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const seen = useCallback((id: string, fade = true) => {
    setReleased((current) => (current.has(id) ? current : new Set([...current, id])));
    if (!fade) return;
    setFading((current) => new Set([...current, id]));
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setFading((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }, FADE_MS),
    );
  }, []);
  return { held, fading, seen };
}

// Calls `onSeen` once the element is in view (most of it, clear of the chat
// bar floating at the foot) while the person is looking at the board.
export function useSeenOnBoard(ref: RefObject<Element | null>, active: boolean, onSeen: () => void): void {
  const latest = useRef(onSeen);
  latest.current = onSeen;
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    let visible = false;
    const check = () => {
      if (visible && lookingAtBoard()) latest.current();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.at(-1)!.intersectionRatio >= 0.6;
        check();
      },
      { threshold: [0, 0.6, 1], rootMargin: '0px 0px -96px 0px' },
    );
    observer.observe(el);
    window.addEventListener(LOOK, check);
    return () => {
      observer.disconnect();
      window.removeEventListener(LOOK, check);
    };
  }, [ref, active]);
}
