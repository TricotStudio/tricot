// npm, for the update tests, never the real one. Run as
// `node fakeNpm.mjs <config.json> …npm's arguments`, the config being
// { prefix, pkg, log, fail?, delayMs? }:
//   prefix -g                 prints `prefix`
//   install -g tricot@<v>     writes <v> into <pkg>/package.json, as installing
//                             it would, after `delayMs` (a slow download);
//                             exits 243 when <v> is `fail`
//   install -g <dir>/tricot-<v>.tgz   the same, from a release's file, which
//                             must be there (else exits 254, as npm's ENOENT)
// Every call's arguments go to `log`, a JSON array a line.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [configFile, ...args] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
appendFileSync(config.log, `${JSON.stringify(args)}\n`);

if (args[0] === 'prefix' && args[1] === '-g' && args.length === 2) {
  console.log(config.prefix);
  process.exit(0);
}
const install = args[0] === 'install' && args[1] === '-g' && args.length === 3;
const spec = install ? (/^tricot@(\d+\.\d+\.\d+)$/.exec(args[2]) ?? /^\/.*\/tricot-(\d+\.\d+\.\d+)\.tgz$/.exec(args[2])) : null;
if (!spec) {
  console.error(`fake npm: unexpected ${JSON.stringify(args)}`);
  process.exit(2);
}
if (args[2].startsWith('/') && !existsSync(args[2])) {
  console.error(`npm error code ENOENT: no such file ${args[2]}`);
  process.exit(254);
}
if (config.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.delayMs);
if (config.fail === spec[1]) {
  console.error('npm error code EACCES (a stand-in failure)');
  process.exit(243);
}
writeFileSync(path.join(config.pkg, 'package.json'), `${JSON.stringify({ name: 'tricot', version: spec[1] })}\n`);
console.log('added 1 package in 1s');
