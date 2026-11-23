// The canvas (React Flow): the board context and each card's, its blocks, pins
// and pairing. What the other features use of it; the connectors, its plug-ins,
// reach its files (test/webImports.test.ts).
export { CanvasView } from './CanvasView';
export { useWebBlockKinds } from './blocks/registry';
export { BlockPreview, hasPreview } from './blocks/preview';
export type { OverlayProps, ToolsProps, WebBlockKind } from './blocks/kind';
export { useCanvas } from './context';
// The full view's frame, and the pins under it, for a kind of block another feature adds with a full view of its own.
export { BlockPins } from './pairing/blockPins';
export { PairingShell } from './pairing/shell';
export { focusBlock, openPin } from './focus';
export { coloursOf, highlightLine, type Token } from './highlight';
export { Mermaid } from './blocks/diagram/Mermaid';
export { Code } from './lines';
export { usePageSelection } from './pageSelection';
export { besidePins, PinnedFrom } from './pins';
export { ToolbarMenu, type ToolbarMenuApi } from './toolbarMenu';
export { DrawOptions, DrawToolbar, useDrawTools } from './tools';
export { UndoToast, useUndoDelete, useUndoShortcut } from './undo';
