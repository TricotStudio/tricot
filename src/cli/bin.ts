// The package's `bin`, built to dist/cli/tricot.js: checks this Node.js can
// run Tricot, then loads the command (tricot.ts, bundled into
// dist/cli/command.js beside it). The command's bundle imports node:sqlite,
// which an older Node can't load, so the check lives in this small file of
// its own, built for old Node too, and says what to do in a sentence instead
// of a stack trace.
import { nodeTooOld } from './nodeCheck';

const problem = nodeTooOld(process.versions.node);
if (problem) {
  console.error(problem);
  process.exitCode = 1;
} else {
  void import(new URL('./command.js', import.meta.url).href);
}
