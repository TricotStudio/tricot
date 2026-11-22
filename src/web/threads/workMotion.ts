import { flushSync } from 'react-dom';
import { pace, reducedMotion } from './dockMotion';

// Work on a board's Home (timelineWork.tsx) unfolding from its rail and
// folding back into it, in the dock's family (dockMotion.ts), at its pace; the
// choreography is in timeline.css. One view transition carries it, as it
// carries the bar docking: Work keeps its name across the change, so the
// rail's sheet grows into the panel's, or the panel's closes into the rail,
// from the top right corner the two share, the transition drawing the sheet
// while it changes size. Unfolding sets off at once, and the panel's head and
// groups rise in as it lands. Folding, the groups fold away first; then the
// sheet closes. Only pictures move, so the conversation under Work is not laid
// out again on any frame. Below 900px, where Work is in the page's flow, and
// in a browser without view transitions, the panel uncovers itself from the
// rail instead, and folds at once when its groups have gone. Reduced motion:
// at once.
//
// The change runs inside, flushed at once, so the transition pictures Work as
// it lands, and the focus is where the change puts it before it is drawn.

export type WorkMove = 'open' | 'close';

// How long the groups take to fold away before the sheet sets off, and how
// long the page keeps its moving state, for the last group's rise to end. At
// full length, like the durations in timeline.css: both are scaled by the
// dock's pace.
const FOLD_FIRST_MS = 130;
const MOVE_MS = 460;
const SHEET = '::view-transition-image-pair(home-work)';

let moving = 0; // the latest move, so an earlier one's end doesn't end it

export function moveWork(direction: WorkMove, change: () => void): void {
  const root = document.documentElement;
  const token = ++moving;
  const mine = () => token === moving;
  // Work's own sheet comes back as the transition's finishes drawing it, a
  // beat before the transition ends, where the two are one.
  const sheetBack = () => {
    if (mine()) delete root.dataset.workBox;
  };
  const end = () => {
    if (!mine()) return;
    delete root.dataset.workMove;
    delete root.dataset.workLeaving;
    delete root.dataset.workPlain;
    delete root.dataset.workBox;
  };
  if (reducedMotion()) {
    end();
    change();
    return;
  }
  const plain = typeof document.startViewTransition !== 'function' || matchMedia('(max-width: 900px)').matches;
  const run = () => {
    if (!mine()) return;
    delete root.dataset.workLeaving;
    root.dataset.workMove = direction;
    const risen = new Promise((done) => setTimeout(done, MOVE_MS * pace()));
    if (plain) {
      root.dataset.workPlain = '';
      flushSync(change);
      void risen.then(end);
      return;
    }
    // Work gives its sheet to the transition once the picture of it as it
    // was is taken: the frame shown as it's taken still has it whole.
    const transition = document.startViewTransition(() => {
      root.dataset.workBox = '';
      flushSync(change);
    });
    transition.ready.then(() => {
      const sheet = document.getAnimations().find((a) => (a.effect as KeyframeEffect | null)?.pseudoElement === SHEET);
      if (sheet) sheet.finished.then(sheetBack, sheetBack);
      else sheetBack();
    }, sheetBack);
    // The change threw: the transition was skipped, the page as it is.
    const landed = transition.finished.finally(sheetBack).catch(() => {});
    void Promise.all([risen, landed]).then(end);
  };
  if (direction === 'close') {
    root.dataset.workLeaving = '';
    setTimeout(run, FOLD_FIRST_MS * pace());
  } else run();
}
