import { useCallback, useEffect, useRef, useState } from 'react';
import type { Block, BlockVersion, VersionSummary } from '../../core/types';
import { api } from '../shared/api';
import { Icon, timeAgo } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { useCanvas } from './context';

// A block keeps what it showed before each change. Its header shows which
// version it is at once there are earlier ones; they open from there, one at a
// time, to look at in place and bring back. People can delete earlier ones,
// one at a time (the × on a row) or all at once, with Undo; the current one
// goes only with the block. `onDelete` is left out where nothing can change.
export function VersionChip(props: {
  block: Block;
  viewing: number | null;
  onView: (version: BlockVersion | null) => void;
  onDelete?: (rev?: number) => Promise<boolean>; // one rev, or all earlier ones; false if refused
}) {
  const { block, viewing, onView, onDelete } = props;
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const refocus = useRef<number | null>(null); // the row a deleted one was, for keyboard focus to stay there

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);

  // Listed afresh on opening, and as the block moves on or loses versions while open.
  useEffect(() => {
    if (!open) return;
    let current = true;
    api.blockVersions(block.id).then(
      (list) => current && (setVersions(list.versions), setError(null)),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [open, block.id, block.rev, block.versionCount]);

  // A version being looked at that someone deleted goes back to the latest:
  // checked when the block's versions change, not on every look.
  useEffect(() => {
    if (viewing === null) return;
    let current = true;
    api.blockVersions(block.id).then(
      (list) => current && !list.versions.some((v) => v.rev === viewing) && onView(null),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [block.id, block.versionCount]);

  // After a row is deleted, keyboard focus moves to the row that took its place.
  useEffect(() => {
    if (refocus.current === null || !menu.current) return;
    const rows = [...menu.current.querySelectorAll<HTMLElement>('.version-delete')];
    (rows[Math.min(refocus.current, rows.length - 1)] ?? menu.current.querySelector<HTMLElement>('.version-item'))?.focus();
    refocus.current = null;
  }, [versions]);

  const view = (rev: number) => {
    if (rev === block.rev) {
      onView(null);
      setOpen(false);
      return;
    }
    api.blockVersion(block.id, rev).then(
      (version) => {
        onView(version);
        setOpen(false);
      },
      (e: Error) => setError(e.message),
    );
  };

  const earlier = versions?.filter((v) => v.rev !== block.rev).length ?? 0;
  const remove = async (rev?: number) => {
    if (!onDelete || busy) return;
    const row = menu.current ? [...menu.current.querySelectorAll('.version-delete')].indexOf(document.activeElement as Element) : -1;
    setBusy(true);
    const done = await onDelete(rev);
    setBusy(false);
    if (!done) return;
    if (viewing !== null && (rev === undefined || rev === viewing)) onView(null);
    if (rev === undefined || earlier === 1) {
      // None left, so the chip goes: focus stays on the block.
      root.current?.closest<HTMLElement>('.react-flow__node')?.focus();
      setOpen(false);
      return;
    }
    if (row >= 0) refocus.current = row;
    setVersions((list) => list && list.filter((v) => v.rev !== rev));
  };

  if (!block.versionCount) return null;
  return (
    <span className="block-version-wrap nodrag nopan" ref={root} onDoubleClick={(e) => e.stopPropagation()}>
      <button
        className={`block-version${viewing !== null ? ' is-viewing' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`Version ${block.rev}. ${block.versionCount} earlier ${block.versionCount === 1 ? 'version' : 'versions'}: click to see them`}
      >
        v{viewing ?? block.rev}
      </button>
      {open && (
        <div className="menu-panel version-menu nowheel" role="menu" aria-label="Earlier versions of this block" ref={menu}>
          <p className="version-menu-title">Earlier versions of this block</p>
          {versions?.map((v) => {
            const current = v.rev === block.rev;
            const shown = viewing === null ? current : v.rev === viewing;
            return (
              <div key={v.rev} className="version-row" role="none">
                <button
                  role="menuitem"
                  className={`menu-item version-item${shown ? ' is-shown' : ''}`}
                  aria-current={shown || undefined}
                  title={v.change ? `${v.by.name} ${v.change}` : undefined}
                  onClick={() => view(v.rev)}
                >
                  <strong>
                    v{v.rev} · {current ? 'now' : timeAgo(v.at)}
                  </strong>
                  <span>{v.by.name}</span>
                </button>
                {onDelete && !current && (
                  <button
                    role="menuitem"
                    className="version-delete"
                    disabled={busy}
                    aria-label={`Delete version ${v.rev}`}
                    title={`Delete v${v.rev}`}
                    onClick={() => void remove(v.rev)}
                  >
                    <Icon name="x" />
                  </button>
                )}
              </div>
            );
          })}
          {onDelete && earlier > 0 && (
            <div className="version-menu-foot" role="none">
              <span>{earlier} earlier</span>
              <button role="menuitem" className="version-delete-all" disabled={busy} onClick={() => void remove()}>
                {earlier === 1 ? 'Delete the earlier version' : 'Delete all earlier versions'}
              </button>
            </div>
          )}
          <p className="version-menu-note">
            {versions || error ? 'Click one to view it; Restore makes it current.' : 'Loading…'}
            {onDelete && earlier > 0 && (
              <span aria-hidden="true">
                {' '}
                <Icon name="x" /> deletes it.
              </span>
            )}
          </p>
          {error && (
            <p className="menu-error error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </span>
  );
}

// Across a block showing an earlier version, read-only, until the person
// brings it back or returns to the latest.
export function VersionBand(props: { block: Block; version: BlockVersion; onDone: () => void }) {
  const { block, version, onDone } = props;
  const canvas = useCanvas();
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    const restored = await canvas.restoreBlock(block, version.rev);
    setBusy(false);
    if (restored) onDone();
  };
  return (
    <div className="version-band nodrag" role="status">
      <span title={`Made ${timeAgo(version.at)} by ${version.by.name}. Read-only.`}>Viewing v{version.rev}</span>
      <span className="version-band-actions">
        {!canvas.readOnly && (
          <button className="btn btn-small" disabled={busy} onClick={restore} title={`Make v${version.rev} the current version; v${block.rev} is kept`}>
            Restore
          </button>
        )}
        <button className="btn btn-small btn-quiet" onClick={onDone}>
          Back to latest
        </button>
      </span>
    </div>
  );
}
