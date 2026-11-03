import type { ReactNode } from 'react';
import type { Closure } from '../core/closure';
import { ActorBadge, Icon, timeAgo } from './components';

const LABEL: Record<Closure['kind'], string> = { done: 'Done', decided: 'Decided', retired: 'Retired', dropped: 'Dropped' };

// What a closed card's discussion invites: a note that leaves it as it is.
export const CLOSED_NOTE: Record<Closure['kind'], string> = {
  done: 'Add a note (it stays done)…',
  decided: 'Add a note (it stays decided)…',
  retired: 'Add a note (it stays retired)…',
  dropped: 'Add a note (it stays dropped)…',
};

// The head of a closed card's panel: that it is finished or set aside, who did
// it and when. `children` hold the way back, Reopen or Bring it back, in place
// of the panel's status controls; on an archived board there are none.
export function ClosedBand({ closure, children }: { closure: Closure; children?: ReactNode }) {
  // Who and when wrap as one, so the name never strands at a line's end.
  const by = (
    <span className="closed-by">
      {closure.by && (
        <>
          by <ActorBadge actor={closure.by} />
        </>
      )}
      <span>{timeAgo(closure.at)}</span>
    </span>
  );
  return (
    <div className={`closed-band closed-band-${closure.kind}`}>
      {closure.kind === 'retired' || closure.kind === 'dropped' ? (
        <span className="closed-mark is-retired" aria-hidden />
      ) : (
        <span className="closed-mark" aria-hidden>
          <Icon name="check" />
        </span>
      )}
      <p className="closed-text">
        <strong>{LABEL[closure.kind]}</strong>
        <span className="closed-sep" aria-hidden>
          ·
        </span>
        {closure.kind === 'done' && closure.approved && 'approved '}
        {closure.kind === 'decided' && <>{closure.choice}, </>}
        {closure.kind === 'retired' && 'no longer relevant, '}
        {closure.kind === 'dropped' && "won't be done, "}
        {by}
      </p>
      {children}
    </div>
  );
}
