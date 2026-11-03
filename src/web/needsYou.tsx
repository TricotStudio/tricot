import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Need, NeedKind } from '../core/needs';
import { Icon } from './components';
import { useDismiss } from './hooks';
import { DismissNeed, needHash, StatusSquare, urgent } from './needs';
import { openThread } from './threads';

// A board's "Needs you", at the right of its tabs row beside Activity: one
// amber pill for how much here waits on the viewer, with what holds agents up
// (a blocking question, blocked work) called out as urgent. It opens those
// cards grouped by what they need, each one click from its card. The same set
// Home and the bell's Everywhere tab list (core/needs.ts), one entry per card.

const GROUP: Record<NeedKind, string> = {
  blocking: 'Blocking',
  asked: 'Asked of you',
  review: 'To review',
  confirm: 'To confirm',
  blocked: 'Blocked',
  open: 'Open questions',
  reply: 'Replies to you',
  thread: 'Threads waiting on you',
};

// The kinds present, in the order the needs came (most urgent first).
function byKind(needs: Need[]): [NeedKind, Need[]][] {
  const groups = new Map<NeedKind, Need[]>();
  for (const need of needs) groups.set(need.kind, [...(groups.get(need.kind) ?? []), need]);
  return [...groups.entries()];
}

// A row opens its card by its link; a thread waiting on you opens in the
// conversation docked on the right, on the tab it was started from.
function openNeed(e: MouseEvent, need: Need, close: () => void): void {
  close();
  const target = need.target;
  if (target.kind !== 'thread') return;
  e.preventDefault();
  openThread(target.id, undefined, { boardId: need.boardId, view: target.view });
}

export function NeedsYou({ needs, name }: { needs: Need[]; name: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  // Everything handled elsewhere while it was open: it doesn't reopen later.
  useEffect(() => {
    if (needs.length === 0) setOpen(false);
  }, [needs.length]);
  if (needs.length === 0) return <span className="needs-none">Nothing needs you</span>;
  const pressing = needs.filter(urgent);
  const label = `${needs.length} need${needs.length === 1 ? 's' : ''} you${pressing.length ? `, ${pressing.length} urgent` : ''}`;
  return (
    <div className="needs-summary" ref={root}>
      <button
        className="needs-pill"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={() => setOpen(!open)}
        title={pressing.length ? `${pressing.map((n) => n.ref).join(', ')} holding agents up` : undefined}
      >
        <span className="needs-pill-count">{needs.length}</span>
        {needs.length === 1 ? 'needs you' : 'need you'}
        {pressing.length > 0 && <span className="tag tag-blocking">{pressing.length} urgent</span>}
        <Icon name="chevron-down" />
      </button>
      {open && (
        <div className="needs-panel" role="dialog" aria-label={label}>
          {byKind(needs).map(([kind, items]) => (
            <section key={kind} className="needs-group">
              <h3 className={`needs-group-head${urgent(items[0]) ? ' is-urgent' : ''}`}>
                {GROUP[kind]} <span className="needs-group-count">{items.length}</span>
              </h3>
              <ol className="needs-items">
                {items.map((need) => (
                  <li key={need.key} className="need-line">
                    <a className="needs-item" href={needHash(need)} onClick={(e) => openNeed(e, need, close)}>
                      <StatusSquare square={need.square} />
                      <span className="needs-item-title">
                        {need.ref && <span className="need-ref">{need.ref}</span>} {need.title}
                      </span>
                      <span className="btn btn-small needs-item-act">{need.action}</span>
                    </a>
                    <DismissNeed name={name} row={{ ...need, items: [{ key: need.key, at: need.at }] }} />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
