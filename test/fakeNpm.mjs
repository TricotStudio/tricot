// npm, for the update tests, never the real one. Run as
// `node fakeNpm.mjs <config.json> …npm's arguments`, the config being
// { prefix, pkg, log, fail?, delayMs? }:
//   prefix -g                 prints `prefix`
//   install -g tricot@<v>     writes <v> into <pkg>/package.json, as installing
//                             it would, after `delayMs` (a slow download);
//                             exits 243 when <v> is `fail`
// Every call's arguments go to `log`, a JSON array a line.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [configFile, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
appendFileSync(config.log, `${JSON.stringify(args)}\n`);

if (args[0] === 'prefix' && args[1] === '-g' && args.length === 2) {
  console.log(config.prefix);
  process.exit(0);
}
const spec = args[0] === 'install' && args[1] === '-g' && args.length === 3 ? /^tricot@(\d+\.\d+\.\d+)$/.exec(args[2]) : null;
if (!spec) {
  console.error(`fake npm: unexpected ${JSON.stringify(args)}`);
  process.exit(2);
}
if (config.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.delayMs);
if (config.fail === spec[1]) {
  console.error('npm error code EACCES (a stand-in failure)');
  process.exit(243);
}
writeFileSync(path.join(config.pkg, 'package.json'), `${JSON.stringify({ name: 'tricot', version: spec[1] })}\n`);
console.log('added 1 package in 1s');
