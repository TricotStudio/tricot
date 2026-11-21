import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../shared/components';
import { useMenu } from '../shared/hooks';
import { OnTop, usePlace } from '../shared/onTop';

// How long a menu stays drawn once it closes, fading out (canvas.css): inert
// and out of the accessibility tree, so the focus is back on its button at
// once and what was picked runs at once, under it.
const LEAVE_MS = 140;
// Its rows come in one after another, this far apart at most, and all of
// them within STAGGER_MS, however many there are (canvas.css times each one).
const STEP_MS = 16;
const STAGGER_MS = 120;

// What a menu's rows are drawn with: whether it is open (not leaving), how to
// close it, and each row's place in its entrance.
export interface ToolbarMenuApi {
  open: boolean;
  close(refocus: boolean): void;
  enter(row: number): CSSProperties;
}

interface Props {
  icon: IconName; // in the button's round inset
  label: ReactNode; // the button's words
  title: string; // what pointing at the button says
  name?: string; // the button's name for screen readers, when its words don't say enough
  menuLabel: string; // the menu's
  className?: string; // the button's group's, beside toolbar-add
  rows: number; // how many rows rise into the menu, rules included
  autoFocus?: boolean; // the button takes the focus as it is drawn
  onButtonKeyDown?(event: KeyboardEvent<HTMLButtonElement>): void;
  children(menu: ToolbarMenuApi): ReactNode; // the menu's rows, while it is drawn
  after?: ReactNode; // kept beside the button with the menu closed (Add's file pickers)
}

// A button floating in the canvas's top-left group, and the menu it drops:
// Add's (addMenu.tsx), and a Sketchbook page's Pages (scratch/pagesMenu.tsx).
// The button is a pill, its icon in a round inset, then its words and a
// chevron that turns over while the menu is open. The menu is two layers, a
// shell and a core, its rows rising in one after another (canvas.css). It is
// the header's menu (useMenu, as the board's ⋯): arrows move, Escape and a
// click elsewhere close it, and Escape closes it alone, not a form open under
// it. It opens on its first row, or on the one marked data-menu-start (the
// page shown, in Pages). It is drawn on top (shared/onTop.tsx), under its
// button, so a long one isn't covered by the chat bar at the canvas's foot.
export function ToolbarMenu({ icon, label, title, name, menuLabel, className, rows, autoFocus, onButtonKeyDown, children, after }: Props) {
  const { open, setOpen, close, root, button, menu, onKeyDown } = useMenu();
  const leaving = useLeaving(open);
  const drawn = useRef<HTMLDivElement>(null); // the menu while it is drawn, leaving included
  const place = usePlace(open || leaving, button, drawn);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[data-menu-start]')?.focus();
  }, [open, menu]);
  const onMenuKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return onKeyDown(e);
    e.stopPropagation();
    close(true);
  };
  const step = Math.min(STEP_MS, STAGGER_MS / Math.max(1, rows - 1));
  const enter = (row: number) => ({ '--enter-delay': `${Math.round(row * step)}ms` }) as CSSProperties;

  return (
    <div className={className ? `toolbar-add ${className}` : 'toolbar-add'} ref={root}>
      <button
        ref={button}
        type="button"
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={onButtonKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={title}
        autoFocus={autoFocus}
      >
        <span className="toolbar-add-plus" aria-hidden>
          <Icon name={icon} />
        </span>
        <span className="toolbar-add-label">{label}</span>
        <Icon name="chevron-down" className="toolbar-add-chevron" />
      </button>
      {(open || leaving) && (
        <OnTop from={root}>
          <div
            className={`menu-panel add-menu${className ? ` ${className}-menu` : ''}${open ? '' : ' is-leaving'}`}
            role={open ? 'menu' : undefined}
            aria-label={open ? menuLabel : undefined}
            aria-hidden={open ? undefined : true}
            inert={!open}
            ref={(el) => {
              drawn.current = el;
              menu.current = open ? el : null;
            }}
            onKeyDown={open ? onMenuKeyDown : undefined}
            style={place}
          >
            <div className="add-menu-core" role="none">
              {children({ open, close, enter })}
            </div>
          </div>
        </OnTop>
      )}
      {after}
    </div>
  );
}

// Whether the menu that just closed is still drawn, leaving: from the render
// that closes it, so it stays the same element, until LEAVE_MS later. Not
// where motion is reduced: there it goes at once.
function useLeaving(open: boolean): boolean {
  const [was, setWas] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (open !== was) {
    setWas(open);
    setLeaving(!open && !stillMotion());
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(false), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  return leaving;
}

const stillMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
