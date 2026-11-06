import { useCallback, useEffect, useRef, useState } from 'react';
import { dismissable, type Dismissed, type Need, type NeedRow, type NeedsReport, type Square } from '../../core/needs';
import { api } from '../shared/api';
import { seenEverywhere } from './away';
import { onBoardsChanged } from '../live';
import { Icon } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { linkTo } from '../shared/pages';

// What needs the viewer across every board (core/needs.ts): Home's list, its
// bell, and the inbox's Everywhere tab on a board. A board's own "Needs you"
// pill is needsYou.tsx.

// A dismissal tells every list showing needs in this page to read again.
const DISMISSED = 'tricot:needs-dismissed';

// Dismisses a row (or the needs it folds): kept for the person on the server,
// so it holds in their other tabs and browsers.
async function dismiss(name: string, boardId: string, items: { key: string; at: string }[]): Promise<void> {
  await api.dismissNeeds(name, boardId, items);
  window.dispatchEvent(new Event(DISMISSED));
}

// What this person dismissed on each board, by board key, for a board's own
// "Needs you" pill (the report has it already applied). Read as useNeeds does.
export function useDismissed(name: string): Record<string, Dismissed> {
  const [dismissed, setDismissed] = useState<Record<string, Dismissed>>({});
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.dismissedNeeds(name).then(
        (next) => !cancelled && setDismissed(next),
        () => {},
      );
    void load();
    const timer = setInterval(load, 5000);
    window.addEventListener('focus', load);
    window.addEventListener(DISMISSED, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener(DISMISSED, load);
    };
  }, [name]);
  return dismissed;
}

// The ✕ that dismisses a row, none on a decision: that stays until it's acted on.
// Its slot keeps the rows' columns lined up.
export function DismissNeed({ name, row }: { name: string; row: Pick<NeedRow, 'boardId' | 'kind' | 'items'> }) {
  if (!dismissable(row)) return <span className="need-dismiss-slot" aria-hidden />;
  return (
    <button
      className="icon-button need-dismiss"
      title="Dismiss. It comes back if something new happens on it."
      aria-label="Dismiss"
      onClick={() => void dismiss(name, row.boardId, row.items).catch(() => {})}
    >
      <Icon name="x" />
    </button>
  );
}

// Polls while `enabled`, as the board list does, and on coming back to the tab.
export function useNeeds(name: string, enabled = true): { report: NeedsReport | null; error: string | null } {
  const [report, setReport] = useState<NeedsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      api.needs(name, seenEverywhere()).then(
        (next) => {
          if (cancelled) return;
          setReport(next);
          setError(null);
        },
        (e: Error) => !cancelled && setError(e.message),
      );
    void load();
    const timer = setInterval(load, 5000);
    window.addEventListener('focus', load);
    window.addEventListener(DISMISSED, load);
    const stop = onBoardsChanged(load); // a board renamed, archived or deleted here or in another tab
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener(DISMISSED, load);
      stop();
    };
  }, [name, enabled]);
  return { report, error };
}

// Where a row opens: its card, or the view of its board a folded row is about.
export function needHash(row: Need): string {
  const target = row.target;
  if (target.kind === 'decision') return linkTo.decision(row.boardId, target.id);
  if (target.kind === 'task') return linkTo.task(row.boardId, target.id);
  // A thread's row opens the tab it is on, and the dock opens it there (needsYou.tsx).
  return linkTo.board(row.boardId, target.view);
}

// The status square: a decision's status or a task's lane (styles.css, .sq).
export function StatusSquare({ square, label }: { square: Square; label?: string }) {
  return <span className={`sq sq-${square}`} title={label} aria-hidden />;
}

// What holds agents up: a blocking question, blocked work.
export const urgent = (need: Need) => need.kind === 'blocking' || need.kind === 'blocked';

// Home's list: one sheet of rows, each opening its item, the first few shown.
export const NEEDS_SHOWN = 8;

export function NeedsList({ rows, name }: { rows: NeedRow[]; name: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, NEEDS_SHOWN);
  return (
    <>
      <ul className="sheet needs" aria-label="What needs you">
        {shown.map((row) => (
          <li key={row.key} className="need-line">
            <a className="need" href={needHash(row)}>
              <StatusSquare square={row.square} />
              <span className="need-main">
                {row.ref && <span className="need-ref">{row.ref}</span>}
                <span className="need-title">{row.title}</span>
              </span>
              <span className="need-meta">
                <span className={`need-why${urgent(row) ? ' is-urgent' : ''}`}>{row.why}</span>
                <span className="need-board">{row.board}</span>
              </span>
              <span className="btn btn-small need-act">{row.action}</span>
            </a>
            <DismissNeed name={name} row={row} />
          </li>
        ))}
      </ul>
      {rows.length > NEEDS_SHOWN && (
        <button className="home-link needs-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

// The same rows, compact, in a bell's panel.
export function NeedsPanelList({ rows, name, onOpen }: { rows: NeedRow[]; name: string; onOpen: () => void }) {
  return (
    <ol className="inbox-list">
      {rows.map((row) => (
        <li key={row.key} className="need-line">
          <a className="inbox-item need-item" href={needHash(row)} onClick={onOpen}>
            <StatusSquare square={row.square} />
            <span className="inbox-text">
              <span className="inbox-subject">
                {row.ref && <span className="need-ref">{row.ref} </span>}
                {row.title}
              </span>
              <span className="inbox-meta">
                <span className={`need-why${urgent(row) ? ' is-urgent' : ''}`}>{row.why}</span>
                <span className="need-board">{row.board}</span>
              </span>
            </span>
          </a>
          <DismissNeed name={name} row={row} />
        </li>
      ))}
    </ol>
  );
}

// Home's bell: what needs you across every project, its count in amber. A
// board's own inbox stays the board's, with these under Everywhere.
export function NeedsBell({ report, name }: { report: NeedsReport | null; name: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  const total = report?.total ?? 0;
  const label = total ? `Needs you: ${total} across your projects` : 'Nothing needs you right now';
  return (
    <div className="inbox" ref={root}>
      <button
        className={`inbox-button${total ? ' needs-you' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <Icon name="bell" />
        {total > 0 && <span className="inbox-count">{total}</span>}
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label="Needs you, across projects">
          <header className="inbox-head">
            <strong>Needs you, across projects</strong>
          </header>
          {report === null ? (
            <p className="inbox-empty">Loading…</p>
          ) : report.rows.length === 0 ? (
            <p className="inbox-empty">Nothing needs you right now.</p>
          ) : (
            <NeedsPanelList rows={report.rows} name={name} onOpen={close} />
          )}
        </div>
      )}
    </div>
  );
}
