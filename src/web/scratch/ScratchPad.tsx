import { useCallback, useEffect, useMemo, useState } from 'react';
import { pagesOf } from '../../core/scratchPad';
import { boardKey, type Board, type ScratchPage } from '../../core/types';
import { CanvasView } from '../canvas';
import { api } from '../shared/api';
import { Icon } from '../shared/components';
import { askToConfirm } from '../shared/confirm';
import { useReadOnly } from '../shared/hooks';
import { go, linkTo, replaceAddress } from '../shared/pages';
import { PageMaker } from './pageMaker';
import { PagesMenu } from './pagesMenu';
import './scratch.css';

// The Sketchbook (the Scratch pad before, as the code still calls it):
// the board's pages, each a canvas of its own for an idea being explored.
// The page shown fills the tab; its Pages button, first in the
// canvas's top-left group, names it and lists the others, to open, rename,
// arrange, delete and add (pagesMenu.tsx). Under it, on a page an
// agent made, who made it and at whose ask (pageMaker.tsx). The pages,
// their names and their order are the board's; the page last shown is
// remembered in this browser, for the next visit.

const NEW_TITLE = 'Untitled page';
const ERROR_MS = 4000;

interface Props {
  board: Board;
  name: string;
  pageId?: string; // the page the address names
  newItems: ReadonlySet<string>;
  changed: ReadonlySet<string>; // pages with changes this person hasn't seen
  onSeeItem: (id: string) => void;
}

// The page last shown on a board, kept in this browser if it can be.
function readLast(key: string): string | null {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? null : (JSON.parse(stored) as string);
  } catch {
    return null;
  }
}

function writeLast(key: string, id: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(id));
  } catch {
    // Not remembered; fine.
  }
}

export function ScratchPad({ board, name, pageId, newItems, changed, onSeeItem }: Props) {
  const readOnly = useReadOnly();
  const lastKey = `tricot:scratch-page:${boardKey(board)}`;
  // A page this person just made, until the board has it.
  const [made, setMade] = useState<ScratchPage | null>(null);
  // The pages as a move put them, until the board's pages change.
  const [moved, setMoved] = useState<{ from: ScratchPage[] | undefined; order: string[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The page whose Pages button takes the focus once it is drawn: one opened from the menu.
  const [focusOn, setFocusOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (made && board.pages?.some((p) => p.id === made.id)) setMade(null);
  }, [made, board.pages]);

  // In the order people arranged them (by rank: core/scratchPad.ts).
  const pages = useMemo(() => {
    const held = pagesOf(board);
    const all = made && !held.some((p) => p.id === made.id) ? [...held, made] : held;
    if (!moved || moved.from !== board.pages) return all;
    const at = new Map(moved.order.map((id, i) => [id, i]));
    return [...all].sort((a, b) => (at.get(a.id) ?? Infinity) - (at.get(b.id) ?? Infinity));
  }, [board, made, moved]);

  // The page shown: the one the address names, else the one last shown here,
  // else the first.
  const asked = pageId ? pages.find((p) => p.id === pageId) : undefined;
  const last = readLast(lastKey);
  const current = asked ?? pages.find((p) => p.id === last) ?? pages[0];

  // The address follows the page shown, which is remembered.
  const currentId = current?.id;
  useEffect(() => {
    if (currentId) {
      if (currentId !== pageId) replaceAddress(linkTo.page(board.id, currentId));
      writeLast(lastKey, currentId);
    } else if (pageId && pageId !== made?.id) replaceAddress(linkTo.board(board.id, 'scratch'));
  }, [currentId, pageId, board.id, lastKey, made]);
  // Opened, a page's own changes (made, renamed) are seen.
  useEffect(() => {
    if (currentId) onSeeItem(currentId);
  }, [currentId, onSeeItem]);
  // Drawn, the page's Pages button has taken the focus, or another page is shown.
  useEffect(() => setFocusOn(null), [currentId]);

  const show = (id: string) => {
    setFocusOn(id);
    go.page(board.id, id);
  };

  const add = async () => {
    try {
      const page = await api.addPage(board.id, name, NEW_TITLE);
      setMade(page);
      setRenaming(page.id);
      go.page(board.id, page.id);
    } catch (e) {
      report(e);
    }
  };

  const rename = (page: ScratchPage, title: string | null) => {
    setRenaming(null);
    const next = title?.trim();
    if (next && next !== page.title) api.renamePage(page.id, name, next).catch(report);
  };

  // Puts a page right after another (or first), here at once, then on the board.
  const move = (id: string, after: string | null) => {
    const others = pages.filter((p) => p.id !== id).map((p) => p.id);
    const order = [...others];
    order.splice(after === null ? 0 : others.indexOf(after) + 1, 0, id);
    if (order.every((pid, i) => pid === pages[i]?.id)) return;
    setMoved({ from: board.pages, order });
    api.movePage(id, name, after).catch((e) => {
      setMoved(null);
      report(e);
    });
  };

  // The page shown, deleted, gives way to the one after it, or before it.
  const remove = async (page: ScratchPage) => {
    const blocks = page.canvas.blocks.length;
    const yes = await askToConfirm({
      title: `Delete “${page.title}”?`,
      detail: blocks
        ? `Its ${blocks} block${blocks === 1 ? '' : 's'}, with their comments and versions, go with it, for good.`
        : 'It has nothing on it. It goes for good.',
      confirmLabel: 'Delete page',
      danger: true,
    });
    if (!yes) return;
    try {
      const at = pages.findIndex((p) => p.id === page.id);
      await api.deletePage(page.id, name);
      if (page.id !== currentId) return;
      const next = pages[at + 1] ?? pages[at - 1];
      if (next) setFocusOn(next.id);
      replaceAddress(next ? linkTo.page(board.id, next.id) : linkTo.board(board.id, 'scratch'));
    } catch (e) {
      report(e);
    }
  };

  const failed = error && (
    <p className="scratch-error error" role="alert">
      {error}
    </p>
  );

  if (!current) {
    return (
      <div className="scratch-pad">
        <div className="scratch-empty">
          <Icon name="canvas" />
          <h2>The sketchbook is empty</h2>
          <p>Start a page to sketch an idea out with agents.</p>
          {!readOnly && (
            <button type="button" className="btn btn-primary" onClick={add}>
              <Icon name="plus" /> New page
            </button>
          )}
        </div>
        {failed}
      </div>
    );
  }

  return (
    <div className="scratch-pad">
      <CanvasView
        key={current.id}
        board={board}
        page={current}
        name={name}
        newItems={newItems}
        onSeeItem={onSeeItem}
        lead={
          <>
            <PagesMenu
              pages={pages}
              current={current}
              changed={changed}
              readOnly={readOnly}
              renaming={renaming === current.id && !readOnly}
              autoFocus={focusOn === current.id}
              onShow={show}
              onAdd={add}
              onStartRename={() => setRenaming(current.id)}
              onRenamed={(title) => rename(current, title)}
              onDelete={remove}
              onMove={move}
            />
            <PageMaker page={current} />
          </>
        }
      />
      {failed}
    </div>
  );
}
