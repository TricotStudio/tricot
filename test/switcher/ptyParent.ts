// A process that starts an agent (sleep) in a pseudo-terminal through the
// helper named, says the agent's pid, and waits to be killed: the pty
// test kills it with SIGKILL and checks the agent goes too.
import { findPtyHelper, spawnPty, type PtyHelper } from '../../src/cli/switcher/pty';

const helper = findPtyHelper({ ...process.env, TRICOT_PTY: process.argv[2] }) as PtyHelper;
const pty = spawnPty('/bin/sleep', ['60'], { cols: 40, rows: 10, helper });
const pid = await pty.ready;
process.stdout.write(`${pid}\n`);
setInterval(() => {}, 1_000);
