import { flushSync } from 'react-dom';

// The chat bar docking into the conversation's panel as it opens, and letting
// go of it as it closes (threads.tsx; the choreography is in chatBar.css).
// One view transition carries it: the bar and its Send keep a shared name
// across the change, so the floating bar morphs into the panel's composer
// (place, width and corners in one motion) while the panel slides in, its
// column growing as the board's narrows, live. The panel's contents rise
// after it lands. Closing, they fade first; then the composer travels back to
// the bottom centre as the panel slides out, and settles with a touch of
// overshoot. Reduced motion is a quick crossfade. A browser without view
// transitions gets the panel's slide, and the bar rising in its new place.
//
// The change runs inside, flushed at once, so the field the bar ends up in
// has the focus and its caret (`placed`) before the new state is drawn.

export type DockMove = 'open' | 'close';

// How long the panel's contents take to fade before it lets go of the bar,
// and how long a move without view transitions keeps the page's moving state
// (the longest animation then, chatBar.css).
const FADE_FIRST_MS = 90;
const PLAIN_MS = 420;
// The transition draws the bar's box while it moves; this is what draws it.
const BOX = '::view-transition-image-pair(chat-bar)';

let moving = 0; // the latest move, so an earlier one's end doesn't end it

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function moveDock(direction: DockMove, change: () => void, placed: () => void): void {
  const root = document.documentElement;
  const token = ++moving;
  const mine = () => token === moving;
  // The bar's own box comes back as the transition's finishes drawing it,
  // just before the transition ends, where the two are one.
  const boxBack = () => {
    if (mine()) delete root.dataset.dockBox;
  };
  const end = () => {
    if (!mine()) return;
    delete root.dataset.dockMove;
    delete root.dataset.dockLeaving;
    delete root.dataset.dockPlain;
    delete root.dataset.dockBox;
    delete root.dataset.dockRest;
  };
  const apply = () => {
    flushSync(change);
    placed();
  };
  const run = () => {
    if (!mine()) return;
    delete root.dataset.dockLeaving;
    root.dataset.dockMove = direction;
    if (typeof document.startViewTransition !== 'function') {
      root.dataset.dockPlain = '';
      apply();
      setTimeout(end, PLAIN_MS);
      return;
    }
    root.dataset.dockBox = '';
    // The box sets off as the bar looks: lit while its field has the focus,
    // at rest once a click elsewhere has taken it.
    if (document.activeElement?.closest('.chat-bar')) delete root.dataset.dockRest;
    else root.dataset.dockRest = '';
    const transition = document.startViewTransition(apply);
    transition.ready.then(() => {
      const box = document.getAnimations().find((a) => (a.effect as KeyframeEffect | null)?.pseudoElement === BOX);
      if (box) box.finished.then(boxBack, boxBack);
      else boxBack();
    }, boxBack);
    transition.finished
      .finally(() => {
        boxBack();
        setTimeout(end, 40);
      })
      .catch(() => {}); // the change threw: the transition was skipped, the page as it is
  };
  if (direction === 'close' && !reducedMotion()) {
    root.dataset.dockLeaving = '';
    setTimeout(run, FADE_FIRST_MS);
  } else run();
}
