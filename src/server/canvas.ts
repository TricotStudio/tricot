// `npm run canvas` and `npm run canvas:dev`: run Tricot Canvas from source, in
// this terminal: the same server without a part (canvasEdition.ts), serving the
// Canvas page (dist/canvas, from `npm run build`, or Vite's own with --dev).
import { runFromSource } from './runFromSource';

runFromSource({ canvas: true });
