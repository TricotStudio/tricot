// Where the lens menu (lenses.tsx) goes: fixed by the chip that opens it, and
// inside the window. It starts at the chip's left edge, and moves left as far
// as the window's right edge needs: the threads panel sits against it, so a
// chip there has less room to its right than the menu is wide. On a window
// narrower than the menu, the menu narrows to fit. It opens under the chip,
// or over it when only that side has room; with room on neither, on the
// roomier side, where it scrolls. Pure, so the test reads it without a page.

export const LENS_MENU_WIDTH = 380;
export const EDGE = 8; // the least room between the menu and the window's edge
const GAP = 8; // between the chip and the menu
const INSET = 6; // the menu starts this far left of the chip, so its pills line up with it

export interface LensMenuPlace {
  left: number;
  width: number;
  top?: number; // under the chip
  bottom?: number; // over it, from the window's foot, so the menu grows upward
  maxHeight: number;
}

// `menu` is the size it would take: its full width and height, though it may
// be drawn narrower or shorter.
export function lensMenuPlace(
  chip: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  view: { width: number; height: number },
): LensMenuPlace {
  const width = Math.max(0, Math.min(menu.width, view.width - 2 * EDGE));
  const left = Math.max(EDGE, Math.min(chip.left - INSET, view.width - EDGE - width));
  const top = Math.max(EDGE, chip.bottom + GAP);
  const below = Math.max(0, view.height - EDGE - top);
  const bottom = Math.max(EDGE, view.height - chip.top + GAP);
  const above = Math.max(0, view.height - EDGE - bottom);
  if (menu.height <= below || below >= above) return { left, width, top, maxHeight: below };
  return { left, width, bottom, maxHeight: above };
}
