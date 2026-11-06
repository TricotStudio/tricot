import { useState, useSyncExternalStore } from 'react';
import { motionOf, type BusyState } from '../../core/delivery';
import './stitch.css';

// "The agent is working on it", one small sign wherever an agent's words
// show: the line under a person's message (delivery.tsx), a card's "taking a
// look" pill (looking.tsx), a project's row on the home page (Home.tsx) and
// an ask-agents request (askAgents.tsx). While the agent works, a thread
// knits a row of loops, holds it, then pulls it through, over and over. As
// an agent picks something up ('casting': it has seen a message, or come to
// a card, before its first step), the thread first casts on one loop, a
// quick stroke that rolls straight into the knitting. A stitch that started
// so keeps the same motion as its steps come, so a first step never
// restarts it; where it shows, it stays the same element as the words change.
// Resting (the agent set the work down, or its steps have gone quiet:
// core/delivery.ts deliveryBusy, steps.tsx busyOfPhase), it is a finished
// row, still and grey. When the reply lands under a message, the yarn is
// pulled through and the row unravels. It is drawn, not read: the words say
// the state. It holds still in a hidden tab; with reduced motion it is the
// finished row.

// How long the row takes to unravel when the reply lands, before the line goes.
export const STITCH_EXIT_MS = 320;

// The row of loops, as one thread (a prolate cycloid, x = t - 3 sin t,
// y = -3.4 cos t, smoothed), measured in hundredths (pathLength 100), so one
// dash draws it and pulls it through.
const LOOPS =
  'M4.06 2.4C4.01 2.28 3.87 1.9 3.74 1.7C3.62 1.51 3.45 1.34 3.28 1.22C3.11 1.11 2.92 1.03 2.73 1.01C2.54 0.98 2.34 1.01 2.16 1.07C1.98 1.14 1.79 1.26 1.64 1.41C1.49 1.56 1.34 1.77 1.24 1.99C1.13 2.22 1.05 2.49 1.01 2.78C0.97 3.06 0.96 3.38 1 3.69C1.04 4.01 1.11 4.34 1.23 4.67C1.35 4.99 1.51 5.32 1.71 5.62C1.91 5.92 2.15 6.21 2.42 6.47C2.69 6.72 3 6.96 3.32 7.15C3.65 7.34 4.01 7.5 4.37 7.6C4.74 7.71 5.13 7.78 5.51 7.79C5.88 7.81 6.28 7.78 6.65 7.7C7.02 7.63 7.4 7.5 7.74 7.34C8.08 7.18 8.41 6.97 8.7 6.74C8.99 6.51 9.26 6.23 9.49 5.94C9.71 5.66 9.9 5.33 10.05 5.02C10.2 4.7 10.31 4.36 10.37 4.04C10.44 3.72 10.46 3.4 10.45 3.1C10.44 2.8 10.38 2.51 10.3 2.26C10.21 2.01 10.09 1.78 9.95 1.6C9.82 1.41 9.64 1.26 9.47 1.17C9.3 1.07 9.1 1.01 8.91 1C8.72 0.99 8.52 1.03 8.34 1.11C8.16 1.2 7.98 1.33 7.84 1.5C7.69 1.67 7.56 1.88 7.46 2.12C7.37 2.36 7.3 2.64 7.27 2.94C7.25 3.23 7.26 3.55 7.31 3.87C7.36 4.18 7.45 4.52 7.58 4.84C7.72 5.16 7.89 5.49 8.11 5.78C8.32 6.08 8.57 6.36 8.85 6.61C9.13 6.85 9.45 7.08 9.79 7.25C10.12 7.43 10.49 7.57 10.86 7.66C11.23 7.75 11.62 7.8 12 7.8C12.38 7.8 12.77 7.75 13.14 7.66C13.51 7.57 13.87 7.43 14.21 7.25C14.54 7.08 14.86 6.85 15.14 6.61C15.42 6.36 15.68 6.08 15.89 5.78C16.1 5.49 16.28 5.16 16.41 4.84C16.55 4.52 16.64 4.18 16.69 3.87C16.74 3.55 16.75 3.23 16.72 2.94C16.7 2.64 16.63 2.36 16.53 2.12C16.44 1.88 16.3 1.67 16.16 1.5C16.01 1.33 15.83 1.2 15.65 1.11C15.48 1.03 15.28 0.99 15.09 1C14.9 1.01 14.7 1.07 14.53 1.17C14.35 1.26 14.18 1.41 14.04 1.6C13.9 1.78 13.78 2.01 13.7 2.26C13.62 2.51 13.56 2.8 13.55 3.1C13.53 3.4 13.56 3.72 13.62 4.04C13.69 4.36 13.8 4.7 13.94 5.02C14.09 5.33 14.28 5.66 14.51 5.94C14.73 6.23 15 6.51 15.29 6.74C15.58 6.97 15.92 7.18 16.26 7.34C16.6 7.5 16.97 7.63 17.35 7.7C17.72 7.78 18.11 7.81 18.49 7.79C18.87 7.78 19.26 7.71 19.62 7.6C19.99 7.5 20.35 7.34 20.67 7.15C21 6.96 21.31 6.72 21.58 6.47C21.85 6.21 22.09 5.92 22.29 5.62C22.48 5.32 22.65 4.99 22.76 4.67C22.88 4.34 22.96 4.01 23 3.69C23.03 3.38 23.03 3.06 22.99 2.78C22.95 2.49 22.86 2.22 22.76 1.99C22.65 1.77 22.51 1.56 22.36 1.41C22.2 1.26 22.02 1.14 21.84 1.07C21.66 1.01 21.45 0.98 21.27 1.01C21.08 1.03 20.88 1.11 20.71 1.22C20.54 1.34 20.38 1.51 20.25 1.7C20.12 1.9 19.99 2.28 19.94 2.4';

const subscribe = (onChange: () => void) => {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
};
const hidden = () => document.visibilityState === 'hidden';

// No state, no agent on it: nothing drawn.
export function Stitch({ state, leaving = false }: { state?: BusyState; leaving?: boolean }) {
  const paused = useSyncExternalStore(subscribe, hidden, () => false);
  // How its motion began, kept from render to render (React's way to adjust
  // state as props change): the cast-on stays in its animations while it
  // knits on, so a change from casting to working restarts nothing.
  const [began, setBegan] = useState(() => motionOf(state, undefined));
  const motion = motionOf(state, began);
  if (motion !== began) setBegan(motion);
  if (!state) return null;
  const look = motion ? 'working' : state;
  return (
    <span className={`stitch is-${look}${motion === 'cast' ? ' is-cast-on' : ''}${leaving ? ' is-leaving' : ''}${paused ? ' is-paused' : ''}`} aria-hidden>
      <svg viewBox="0 0 24 8.8">
        <path className="stitch-yarn" d={LOOPS} pathLength={100} />
      </svg>
    </span>
  );
}
