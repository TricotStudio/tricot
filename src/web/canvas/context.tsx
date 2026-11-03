import { createContext, useContext, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Block, BlockVersion, Board, Decision, Pin, Task } from '../../core/types';
import type { BlockPatch, PinPart } from '../api';

// A part of a block being pinned, while its prompt is open. `quote` is what
// the prompt shows; `cells` are the cells first picked, which the prompt can
// widen to their rows or columns.
export interface PinDraft {
  blockId: string;
  part: PinPart;
  quote: string;
  cells?: { rows: [number, number]; columns: [number, number] };
}

// What canvas nodes need from the canvas around them, passed by context so
// node objects stay plain data.
export interface CanvasContextValue {
  board: Board; // for the tasks and decisions pins link to
  decision?: Decision;
  task?: Task; // the card whose canvas this is, if any: comments on its parts go in its discussion
  me?: string; // the viewer, on the board context only, where blocks show whose they are
  readOnly: boolean; // an archived board: look, don't touch
  highlightOption: string | null;
  autoEditId: string | null;
  clearAutoEdit: () => void;
  // Changes a block as the viewer last saw it (its rev), so a change made
  // meanwhile refuses it. With `again`, a refused change is made again on the
  // block as it is now (a tick on a note's task): null when there's nothing left to do.
  updateBlock: (block: Block, patch: BlockPatch, again?: (latest: Block) => BlockPatch | null) => void;
  restoreBlock: (block: Block, rev: number) => Promise<boolean>; // false if refused (and reported)
  deleteVersions: (block: Block, rev?: number) => Promise<boolean>; // an earlier version, or all of them, with Undo; false if refused (and reported)
  openLink: (block: Block, open: boolean) => void; // show a link in place for everyone, or fold it back
  openOverlay: (blockId: string, options?: { version?: BlockVersion; pinId?: string }) => void; // the block's overlay: an image at full size (at an earlier version if given), a Google Doc's editor (at a thread)
  newItems: ReadonlySet<string>; // changed by others since the viewer last looked
  seeItem: (id: string) => void;
  resize: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  setSize: (id: string, size: { w: number; h: number }) => void; // a block's new size, keeping its top left
  renameGroup: (id: string, title: string) => void;
  relabelLink: (id: string, label: string) => void;
  removeItem: (id: string) => void;
  perform: (action: (actor: string) => Promise<unknown>) => void; // something a person does to the board as themselves, its refusal shown (a table's Make a chart)
  pins: ReadonlyMap<string, Pin[]>; // the canvas's pins, by block
  draft: PinDraft | null;
  startPin: (draft: PinDraft) => void;
  focusPin: string | null; // a pin just shown from a comment about it, highlighted for a moment
  thread: string | null; // the pin whose comment thread is open, on the board context
  openThread: (pinId: string) => void;
  // On the board context, unless read-only: ask agents to sync these blocks
  // (Sync this), or select them for the bar to sync (Sync group).
  syncBlocks?: (ids: string[]) => void;
  selectBlocks?: (ids: string[]) => void;
}

export const CanvasContext = createContext<CanvasContextValue | null>(null);

export function useCanvas(): CanvasContextValue {
  const value = useContext(CanvasContext);
  if (!value) throw new Error('useCanvas outside a canvas');
  return value;
}

// Text that turns into an input on double-click and commits on Enter or blur.
// `display`, when given, is shown in place of the plain value, e.g. with pins.
export function EditableText(props: {
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
  className?: string;
  display?: ReactNode;
}) {
  const { value, placeholder, onCommit, className = '', display } = props;
  const { readOnly } = useCanvas();
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);

  if (readOnly) return <span className={`editable ${className}`}>{display ?? value}</span>;
  if (!editing) {
    return (
      <span
        className={`editable ${className}`}
        onDoubleClick={(e) => {
          e.stopPropagation();
          cancelled.current = false;
          setEditing(true);
        }}
        title="Double-click to edit"
      >
        {value ? (display ?? value) : <span className="placeholder">{placeholder}</span>}
      </span>
    );
  }

  const finish = (input: HTMLInputElement) => {
    setEditing(false);
    if (!cancelled.current && input.value !== value) onCommit(input.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') {
      cancelled.current = true;
      e.currentTarget.blur();
    }
  };
  return (
    <input
      autoFocus
      className={`editable-input nodrag ${className}`}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => finish(e.currentTarget)}
      onKeyDown={onKeyDown}
    />
  );
}
