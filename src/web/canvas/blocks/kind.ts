// What the canvas needs of a kind of block to show it and let people make one:
// the web half of the kind (its core half, core/blocks/<type>/, says what it
// is). The canvas asks these and never switches on a block's type. A kind's
// web folder is the whole of it here, and web/canvas/blocks/registry.ts lists
// them. Internal, like the core half: nothing is loaded from outside.

import type { ComponentType, DragEvent, ReactNode, RefObject } from 'react';
import type { Block, BlockVersion, Decision, Pin } from '../../../core/types';
import type { BlockContent } from '../../api';
import type { CanvasContextValue, PinDraft } from '../context';
import type { PlacedPin } from '../pins';

export interface Point {
  x: number;
  y: number;
}

export interface BodyProps<B extends Block = Block> {
  block: B;
  selected: boolean;
  placed: PlacedPin[]; // where each pin on the block is now
}

// A block that draws itself whole, header and all (a link's card).
export interface CardProps<B extends Block = Block> {
  block: B; // as it is shown: an earlier version, when one is being looked at
  editing: boolean;
  setEditing: (editing: boolean) => void;
  badges: ReactNode;
}

export interface TitleProps<B extends Block = Block> {
  block: B;
  placed: PlacedPin[];
  frozen: boolean; // an earlier version is shown: nothing is editable
}

export interface ToolsProps<B extends Block = Block> {
  block: B;
  shown: B; // as it is shown: an earlier version, when one is being looked at
  viewing: BlockVersion | null;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}

// What an entry on the Add menu can ask of the canvas.
export interface AddContext {
  decision?: Decision;
  add(content: BlockContent, options?: { at?: Point; size?: { w: number; h: number }; title?: string }): Promise<void>;
  report(error: unknown): void;
}

export interface FormProps {
  initial?: string; // what the form opens with, e.g. a pasted address
  toggle: RefObject<HTMLElement | null>; // its button on the toolbar
  context: AddContext;
  close(): void;
}

// A kind's entry on the Add menu: one click adds a block, opens a small form,
// or picks files (which `files` of the kind then adds).
export type AddEntry = { label: string; only?: 'decision' } & (
  | { add(): { content: BlockContent; title?: string } } // a click adds this
  | { Form: ComponentType<FormProps>; toggles?: true; paste?: (text: string) => string | null } // a click opens it (and, with toggles, closes it again); paste says what a pasted text fills in, if it does
  | { pick: { accept: string } } // a click picks files, with this for the file picker
);

// Files the canvas hands a kind to make blocks of: those it picked, dropped
// on the canvas, or pasted on the page.
export interface FileHandling {
  accepts(file: File): boolean;
  paste?: true; // files pasted on the page are added too
  add(files: File[], context: AddContext, at?: Point): Promise<void>;
  // While files are dragged over the canvas: what dropping them will make.
  useDrop?(enabled: boolean): { onDragEnter(event: DragEvent): void; onDragLeave(event: DragEvent): void; clear(): void; overlay: ReactNode };
}

// A window a block opens over the canvas: an image at full size, a Google
// Doc's editor. It is opened with canvas.openOverlay(blockId, options) and
// closed with onClose.
export interface OverlayProps<B extends Block = Block> {
  block: B; // as the board has it now
  name: string; // the viewer
  version?: BlockVersion; // an earlier version, when one is being looked at
  pinId?: string; // the pin whose thread to open at
  onClose(): void;
}

export interface Overlay<B extends Block = any> {
  Component: ComponentType<OverlayProps<B>>;
  readonly changes?: true; // it edits, so it doesn't open on a read-only board
  readonly refocus?: true; // closing it puts the focus back on the block
}

export interface WebBlockKind<B extends Block = any> {
  readonly type: B['type'];
  readonly Body: ComponentType<BodyProps<B>>;
  readonly Card?: ComponentType<CardProps<B>>;
  readonly Title?: ComponentType<TitleProps<B>>; // in place of the editable title (a code block's path)
  readonly Head?: ComponentType<TitleProps<B>>; // beside the title (a diff's totals, a chart's switch)
  readonly Tools?: ComponentType<ToolsProps<B>>; // in the block's toolbar when it is selected
  readonly ownPins?: true; // its body draws its own pins, so the strip under it isn't added
  readonly still?: true; // its body doesn't scroll, so the wheel and a pinch pan and zoom the canvas
  readonly menu?: AddEntry;
  readonly files?: FileHandling;
  readonly overlay?: Overlay<B>;
  // In the prompt for pinning a part of it: how much of it the pin takes (a table's cells, rows or columns).
  readonly PinScope?: ComponentType<{ draft: PinDraft; block: B; onChange(draft: PinDraft): void }>;
  // Whether showing this pin's comment (from a comment about it) opens the block's overlay at it.
  opensOnPin?(block: B, pin: Pin): boolean;
  // Enter or Space on the block, once it has focus.
  activate?(block: B, canvas: CanvasContextValue): void;
  // The block as it was just added by this viewer: opens it for typing, say.
  added?(block: B, canvas: { edit(id: string): void }): void;
}
