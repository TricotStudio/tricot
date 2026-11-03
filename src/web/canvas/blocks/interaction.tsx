// What the bodies of blocks do alike with the pointer and with their text.

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useCanvas, type PinDraft } from '../context';
import { PinMark } from '../pins';

// Shared editor for long-form text: double-click to edit, blur to save,
// Escape to cancel. New blocks the viewer just created open in edit mode.
export function useLongEdit(blockId: string) {
  const canvas = useCanvas();
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  // The block may render before or after its creator learns its id.
  const { autoEditId, clearAutoEdit } = canvas;
  useEffect(() => {
    if (autoEditId !== blockId) return;
    cancelled.current = false;
    setEditing(true);
    clearAutoEdit();
  }, [autoEditId, clearAutoEdit, blockId]);
  return {
    editing,
    start: () => {
      if (canvas.readOnly) return;
      cancelled.current = false;
      setEditing(true);
    },
    finish: (value: string, previous: string, save: (value: string) => void) => {
      setEditing(false);
      if (!cancelled.current && value !== previous) save(value);
    },
    cancel: () => {
      cancelled.current = true;
    },
  };
}

export const PIN_COMPONENTS = { mark: PinMark };

// Whether a click ended a drag, e.g. selecting words. Such a click, like one
// that picks a part to pin, doesn't also select the block: the person is
// pinning, not arranging.
export function dragged(event: MouseEvent, from: { x: number; y: number }): boolean {
  return Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) > 4;
}

// A click with ⇧, ⌘ or Ctrl held adds the block to the selection, or takes it
// out, wherever on the block it lands: it doesn't pick a part to pin. With ⇧
// the canvas takes the press itself, so there is no press here to drag from.
export function selecting(event: MouseEvent): boolean {
  return event.shiftKey || event.metaKey || event.ctrlKey;
}

// The part being pinned in this block, if it's of the kind asked for.
export function draftOf<K extends PinDraft['part']['kind']>(draft: PinDraft | null, blockId: string, kind: K) {
  return draft?.blockId === blockId && draft.part.kind === kind ? (draft.part as Extract<PinDraft['part'], { kind: K }>) : null;
}
