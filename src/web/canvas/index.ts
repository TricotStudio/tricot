// The canvas (React Flow): the board context and each card's, its blocks, pins
// and pairing. What the other features use of it; the connectors, its plug-ins,
// reach its files (test/webImports.test.ts).
export { CanvasView } from './CanvasView';
export { Comparison, comparisonData } from './blocks/comparison/comparison';
export { focusBlock, openPin } from './focus';
export { besidePins, PinnedFrom } from './pins';
export { SyncControl } from './sync';
export { UndoToast, useUndoDelete, useUndoShortcut } from './undo';
