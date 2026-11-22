import { useLayoutEffect, useRef, useState } from 'react';
import { reducedMotion } from './dockMotion';

// The ball of yarn that marks the threads is in one place at a time: in the
// floating bar, its threads button (chatBar.tsx), or on a board's Home, at
// the top of the yarn, where the strands that run past the top unwind from it
// (timeline.tsx). As a view switch swaps one for the other, the ball coming
// flies in from where the ball going was, growing into the big one or
// shrinking into the button, so it reads as one ball moving. A picture of
// each rides one layer over the page from the one place to the other, the
// going one's fading as the coming one's shows, and lands on the ball coming,
// which is hidden until then (`data-ball-moving`, chatBar.css and
// timeline.css). The layer follows where the ball coming is on each frame,
// as the bar it lands in may still be making room for it. Only the layer
// moves, by transform and opacity: nothing is laid out again for it.
//
// Nothing flies with reduced motion, nor when no ball was on screen as the
// view changed: the page opening, the bar docked in the conversation, a
// thread open on Home, whose bar has no ball and whose yarn none at its top.

export type BallPlace = 'bar' | 'yarn';

interface Picture {
  circle: DOMRect; // where the ball itself is, its circle
  node: HTMLElement; // a copy of what draws it, the count with it, placed from the circle's corner
}

const FLIGHT_MS = 480;
const FLIGHT_EASE = 'cubic-bezier(0.45, 0, 0.2, 1)'; // off gently, then a long landing
const SWELL = 0.06; // as it lands, it swells this much and settles

let here: { place: BallPlace; whole: HTMLElement } | null = null; // the ball on screen, as last drawn
let flying = 0; // the latest flight, so an earlier one's end doesn't end it
let layer: HTMLElement | null = null;

// The ball's circle: the first circle drawn in its picture (the threads icon's,
// the YarnBall's), measured as it is on screen.
function circleOf(whole: HTMLElement): DOMRect | null {
  const circle = whole.querySelector('svg > circle')?.getBoundingClientRect();
  return circle && circle.width > 0 ? circle : null;
}

function pictureOf(whole: HTMLElement): Picture | null {
  const circle = whole.isConnected ? circleOf(whole) : null;
  if (!circle) return null;
  const box = whole.getBoundingClientRect();
  const node = whole.cloneNode(true) as HTMLElement;
  // Its own names for what it draws by (a clip): the one it was copied from may be gone.
  const ids = new Map<string, string>();
  for (const el of node.querySelectorAll('[id]')) {
    ids.set(el.id, `${el.id}-moving`);
    el.id = `${el.id}-moving`;
  }
  for (const el of node.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const named = /^url\(#(.+)\)$/.exec(attr.value)?.[1];
      if (named && ids.has(named)) el.setAttribute(attr.name, `url(#${ids.get(named)})`);
    }
  }
  node.removeAttribute('id');
  node.style.position = 'absolute';
  node.style.left = `${box.left - circle.left}px`;
  node.style.top = `${box.top - circle.top}px`;
  node.style.margin = '0';
  return { circle, node };
}

const onScreen = (r: DOMRect) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;

function land(token: number): void {
  if (token !== flying) return;
  layer?.remove();
  layer = null;
  delete document.documentElement.dataset.ballMoving;
}

function fly(from: Picture, whole: HTMLElement, token: number): void {
  const to = pictureOf(whole);
  if (!to || !onScreen(from.circle) || !onScreen(to.circle)) return land(token);
  const size = to.circle.width;
  const flight = document.createElement('div');
  flight.className = 'ball-travel';
  flight.inert = true;
  flight.setAttribute('aria-hidden', 'true');
  flight.style.width = flight.style.height = `${size}px`;
  const going = document.createElement('div');
  going.style.transform = `scale(${size / from.circle.width})`;
  going.append(from.node);
  const coming = document.createElement('div');
  coming.append(to.node);
  flight.append(going, coming);
  layer?.remove();
  layer = flight;
  document.body.append(flight);
  // The going ball's picture fades as the coming one's shows, on the way.
  // Their counts, drawn beside the button and knotted on the big ball, go and
  // come only near each end, where they are near their own size.
  going.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_MS * 0.45, fill: 'both' });
  coming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FLIGHT_MS * 0.45, delay: FLIGHT_MS * 0.15, fill: 'both' });
  from.node.querySelector('.chat-count')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_MS * 0.2, fill: 'both' });
  to.node.querySelector('.chat-count')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FLIGHT_MS * 0.25, delay: FLIGHT_MS * 0.75, fill: 'both' });
  // The flight's clock, eased: where along it the ball is, on each frame.
  const clock = flight.animate([{ opacity: 1 }, { opacity: 1 }], { duration: FLIGHT_MS, easing: FLIGHT_EASE, fill: 'both' });
  const [fx, fy, fk] = [from.circle.left + from.circle.width / 2, from.circle.top + from.circle.height / 2, from.circle.width / size];
  const place = () => {
    if (token !== flying) return;
    const along = clock.effect?.getComputedTiming().progress ?? 1;
    const t = Math.min(1, (Number(clock.currentTime) || 0) / FLIGHT_MS);
    const target = circleOf(whole) ?? to.circle;
    const swell = 1 + SWELL * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.7) / 0.3)));
    const k = (fk + (target.width / size - fk) * along) * swell;
    const cx = fx + (target.left + target.width / 2 - fx) * along;
    const cy = fy + (target.top + target.height / 2 - fy) * along;
    flight.style.transform = `translate(${cx - (size * k) / 2}px, ${cy - (size * k) / 2}px) scale(${k})`;
    if (clock.playState !== 'finished') requestAnimationFrame(place);
  };
  place();
  clock.finished.then(
    () => land(token),
    () => land(token),
  );
}

// A ball of yarn that marks the threads (`place`, none for a button going
// that is not one), drawn by `whole` while `shown`. Made as a view switch
// takes the other one away, it flies in from where that one was: a picture
// of it is taken as this one is drawn, before the page changes, and the
// flight sets off once this one is shown.
export function useBall(place: BallPlace | null, whole: () => HTMLElement | null | undefined, shown: boolean): void {
  const [from] = useState(() => (place && here && here.place !== place && !reducedMotion() ? pictureOf(here.whole) : null));
  const claim = useRef({ token: 0, flown: false });
  // At once, before this one is first drawn: it hides until the flight lands,
  // and lets go if it goes before it is shown.
  useLayoutEffect(() => {
    if (!from) return;
    const mine = { token: ++flying, flown: false };
    claim.current = mine;
    document.documentElement.dataset.ballMoving = place!;
    return () => {
      if (!mine.flown) land(mine.token);
    };
  }, []);
  useLayoutEffect(() => {
    const el = whole();
    if (!place || !shown || !el) return;
    const me = { place, whole: el };
    here = me;
    const mine = claim.current;
    if (from && mine.token && !mine.flown) {
      mine.flown = true;
      fly(from, el, mine.token);
    }
    return () => {
      if (here === me) here = null;
    };
  }, [place, shown]);
}
