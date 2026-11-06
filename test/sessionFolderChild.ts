// A process that makes two session folders and ends without cleaning them: one it can't remove (a folder
// inside it that can't be written to) and one it can, so the exit hook of folder.ts has to get past the first.
// Prints where they are; `exit3` ends it with exit code 3.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionFolder } from '../src/cli/agentSessions/folder';

const stuck = sessionFolder('pi');
mkdirSync(path.join(stuck.dir, 'sub'));
writeFileSync(path.join(stuck.dir, 'sub', 'file'), 'x');
chmodSync(path.join(stuck.dir, 'sub'), 0o500);
const fine = sessionFolder('omp');
writeFileSync(path.join(fine.dir, 'file'), 'x');
console.log(JSON.stringify({ stuck: stuck.dir, fine: fine.dir }));
if (process.argv[2] === 'exit3') process.exit(3);
