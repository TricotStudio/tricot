import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ScratchPage } from '../../core/types';
import { ToolbarMenu, type ToolbarMenuApi } from '../canvas';
import { Icon, type IconName } from '../shared/components';

const PAGE_TYPE = 'application/x-tricot-page'; // what a page's row carries while it is dragged

// Where a dragged row would land: above or below the row it is over.
type DropAt = { id: string; after: boolean };

interface Props {
  pages: ScratchPage[]; // in the board's order
  current: ScratchPage; // the page shown
  changed: ReadonlySet<string>; // pages with changes this person hasn't seen
  readOnly: boolean;
  renaming: boolean; // the page shown is being renamed, on the button
  autoFocus: boolean; // the button takes the focus as it is drawn (a page was just opened from it)
  onShow(id: string): void;
  onAdd(): void;
  onStartRename(): void;
  onRenamed(title: string | null): void; // null: the name is kept as it was
  onDelete(page: ScratchPage): void; // the page shown; asks first
  onMove(id: string, after: string | null): void; // puts a page right after another, or first
}

// A Sketchbook page's Pages, first in the canvas's top-left group, before
// Add: it names the page shown, and its menu (the canvas's ToolbarMenu, as
// Add's) lists the board's pages in their order, the one shown marked, each
// with a dot for changes this person hasn't seen, and opens the one picked.
// The button has a dot too when a page not shown has them. Under the pages,
// what is done to the page shown, Rename page and Delete page (which asks
// first), then New page: the list stays one row a page for the arrow keys,
// and a page is deleted where what goes with it is in view. A page is moved
// by dragging its row, or with Alt (Option) and the up and down arrows. The
// page shown is renamed on the button itself, its name a field there: from
// Rename page, F2 on the button, or as soon as a new page is made. Enter or a
// click away keeps the name, Escape puts it back. On a read-only board the
// menu only lists the pages.
export function PagesMenu(props: Props) {
  const { pages, current, changed, readOnly, renaming, autoFocus, onShow, onAdd, onStartRename, onRenamed, onDelete, onMove } = props;
  // The button takes the focus back when renaming ends from the keyboard.
  const [refocus, setRefocus] = useState(false);
  const [drag, setDrag] = useState<{ id: string; at?: DropAt } | null>(null);
  // A page just moved from the keyboard: its row keeps the focus, though it is drawn again.
  const moved = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = moved.current;
    moved.current = null;
    if (id) document.querySelector<HTMLElement>(`.toolbar-pages [data-page="${CSS.escape(id)}"]`)?.focus();
  }, [pages]);

  if (renaming) {
    return (
      <PageName
        page={current}
        onDone={(title, keyboard) => {
          setRefocus(keyboard);
          onRenamed(title);
        }}
      />
    );
  }

  // Dropped above a row, the page goes after the page before that one; below it, right after it.
  const dropOn = (at: DropAt, id: string) => {
    if (at.id === id) return;
    if (at.after) return onMove(id, at.id);
    const others = pages.filter((p) => p.id !== id);
    const i = others.findIndex((p) => p.id === at.id);
    onMove(id, i > 0 ? others[i - 1].id : null);
  };
  const moveByKey = (event: KeyboardEvent<HTMLButtonElement>, page: ScratchPage) => {
    if (readOnly || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const neighbour = pages[pages.indexOf(page) + step];
    if (!neighbour) return;
    moved.current = page.id;
    dropOn({ id: neighbour.id, after: step > 0 }, page.id);
  };
  const dragProps = (page: ScratchPage) =>
    readOnly
      ? {}
      : {
          draggable: true,
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.setData(PAGE_TYPE, page.id);
            event.dataTransfer.effectAllowed = 'move';
            setDrag({ id: page.id });
          },
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!drag || !event.dataTransfer.types.includes(PAGE_TYPE)) return;
            event.preventDefault();
            event.stopPropagation(); // not a drop on the canvas under the menu
            event.dataTransfer.dropEffect = 'move';
            const box = event.currentTarget.getBoundingClientRect();
            const at = { id: page.id, after: event.clientY > box.top + box.height / 2 };
            if (drag.at?.id !== at.id || drag.at.after !== at.after) setDrag({ ...drag, at });
          },
          onDrop: (event: DragEvent) => {
            if (!drag) return;
            event.preventDefault();
            event.stopPropagation();
            if (drag.at) dropOn(drag.at, drag.id);
            setDrag(null);
          },
          onDragEnd: () => setDrag(null),
        };

  // The pages, then the rule, Rename page, Delete page and New page.
  const rows = ({ open, close, enter }: ToolbarMenuApi) => {
    const item = { role: open ? 'menuitem' : undefined, tabIndex: -1, type: 'button' as const };
    const action = (row: number, icon: IconName, label: string, run: () => void): ReactNode => (
      <button {...item} className="menu-item is-line add-menu-item" style={enter(row)} onClick={run}>
        <span className="add-menu-row">
          <Icon name={icon} className="add-menu-icon" />
          {label}
        </span>
      </button>
    );
    return (
      <>
        {pages.map((page, row) => {
          const shown = page.id === current.id;
          const at = drag?.at?.id === page.id && drag.id !== page.id ? drag.at : undefined;
          const classes = ['pages-menu-row', drag?.id === page.id && 'is-dragged', at && (at.after ? 'drop-after' : 'drop-before')].filter(Boolean);
          return (
            <div key={page.id} role="none" className={classes.join(' ')} {...dragProps(page)}>
              <button
                {...item}
                className="menu-item is-line add-menu-item pages-menu-page"
                data-page={page.id}
                data-menu-start={shown ? '' : undefined}
                aria-current={shown ? 'page' : undefined}
                title={readOnly ? page.title : `${page.title}. Drag to move it.`}
                style={enter(row)}
                onClick={() => {
                  close(true);
                  if (!shown) onShow(page.id);
                }}
                onKeyDown={(event) => moveByKey(event, page)}
              >
                <span className="add-menu-row">
                  <span className="pages-menu-mark">{shown && <Icon name="check" />}</span>
                  <span className="pages-menu-title">{page.title}</span>
                  {!shown && changed.has(page.id) && <span className="new-dot" aria-label="Has changes" />}
                </span>
              </button>
            </div>
          );
        })}
        {!readOnly && (
          <>
            <div role="separator" className="menu-rule add-menu-rule" style={enter(pages.length)} />
            {action(pages.length + 1, 'edit', 'Rename page', () => {
              close(false); // the name's field takes the focus
              onStartRename();
            })}
            {action(pages.length + 2, 'trash', 'Delete page…', () => {
              close(true);
              onDelete(current);
            })}
            {action(pages.length + 3, 'plus', 'New page', () => {
              close(false);
              onAdd();
            })}
          </>
        )}
      </>
    );
  };

  const unseen = pages.some((p) => p.id !== current.id && changed.has(p.id));
  return (
    <ToolbarMenu
      icon="pages"
      label={
        <>
          <span className="toolbar-pages-title">{current.title}</span>
          {unseen && <span className="new-dot" />}
        </>
      }
      title={readOnly ? "The Sketchbook's pages" : "The Sketchbook's pages. F2 renames this one."}
      name={`Pages: ${current.title}${unseen ? '. Another page has changes.' : ''}`}
      menuLabel="Pages"
      className="toolbar-pages"
      rows={pages.length + (readOnly ? 0 : 4)}
      autoFocus={autoFocus || refocus}
      onButtonKeyDown={(event) => {
        if (event.key !== 'F2' || readOnly) return;
        event.preventDefault();
        onStartRename();
      }}
    >
      {rows}
    </ToolbarMenu>
  );
}

// The page shown's name, as a field in the button's place: the button's
// pill and icon, the field growing with the name.
function PageName({ page, onDone }: { page: ScratchPage; onDone(title: string | null, keyboard: boolean): void }) {
  const [length, setLength] = useState(page.title.length);
  const done = useRef(false); // once, however it ends
  const finish = (title: string | null, keyboard: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(title, keyboard);
  };
  return (
    <div className="toolbar-add toolbar-pages">
      <div className="toolbar-add-field toolbar-pages-field">
        <span className="toolbar-add-plus" aria-hidden>
          <Icon name="pages" />
        </span>
        <input
          className="nodrag nopan"
          aria-label="Page name"
          autoFocus
          defaultValue={page.title}
          maxLength={120}
          size={Math.max(12, Math.min(40, length + 2))}
          onFocus={(event) => event.currentTarget.select()}
          onInput={(event) => setLength(event.currentTarget.value.length)}
          onBlur={(event) => finish(event.currentTarget.value, false)}
          onKeyDown={(event) => {
            if (event.key === 'Tab') return;
            event.stopPropagation(); // its keys are the field's, not the canvas's
            if (event.key === 'Enter') {
              event.preventDefault();
              finish(event.currentTarget.value, true);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              finish(null, true);
            }
          }}
        />
      </div>
    </div>
  );
}
