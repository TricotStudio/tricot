// The `tricot` executable: wires the command (main.ts) to this terminal and
// this machine's browser, and runs the agent `tricot claude` starts in this
// terminal (terminal.ts). Built to dist/cli/command.js, which the package's
// `bin` (bin.ts, dist/cli/tricot.js) loads once it has checked the Node.js version.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUrl } from '../platform/openUrl';
import { interruptSelf, stopSignals } from '../platform/stop';
import { runCaptured } from './connectAgent';
import { yesNoAsker } from './confirm';
import { runCli, runUntilCtrlC, type CliContext } from './main';
import { runSwitcher, switcherProblem } from './switcher/run';
import { runInTerminal, terminalKeys } from './terminal';

const entry = fileURLToPath(import.meta.url);
// dist/cli/command.js once built, src/cli/tricot.ts from source: either way the
// package folder is two levels up.
const root = path.resolve(path.dirname(entry), '../..');

// The keys of this terminal, when it is one both ways: the board picker, the
// Yes / No questions and the agents run together draw on it as they go.
const keys = process.stdin.isTTY && process.stdout.isTTY ? terminalKeys() : undefined;

const out = (line: string) => console.log(line);

const context: CliContext = {
  env: process.env,
  root,
  entry,
  out,
  err: (line) => console.error(line),
  open: (url) => openUrl(url, process.env, (unopened) => console.log(`Open ${unopened} in your browser.`)),
  cwd: process.cwd(),
  launch: runInTerminal,
  exec: runCaptured,
  // A yes/no question is the Yes / No pair on a terminal, and a line (with [y/N]
  // after it) where stdin is a terminal and stdout is piped: piped in, the
  // command can't be answered.
  ...(process.stdin.isTTY && { ask: yesNoAsker(keys) }),
  // The board picker draws as it goes, so it needs a terminal to draw on too,
  // as do several agents run in it together (tricot claude codex).
  ...(keys && { keys, host: { problem: () => switcherProblem(), run: runSwitcher } }),
  // Ctrl+C read as a key, while the board's terminal asks Yes or No: it stops Tricot all the same.
  interrupt: () => interruptSelf(),
};

// Ctrl+C at a yes/no question stops the command quietly (confirm.ts, main.ts).
const { exitCode, server } = await runUntilCtrlC(() => runCli(process.argv.slice(2), context), out);

if (server) {
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  for (const signal of stopSignals()) process.on(signal, shutdown);
  // A board an agent command started stops when no agent command needs it
  // (server/leases.ts), and any board stops when a person asks it to over
  // HTTP (server/stopRoutes.ts), which is how it is stopped gently on Windows.
  void server.unused.then(shutdown);
} else {
  process.exitCode = exitCode;
}
