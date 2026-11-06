// The `tricot` executable: wires the command (main.ts) to this terminal and
// this machine's browser, and runs the agent `tricot claude` starts in this
// terminal (terminal.ts). Built to dist/cli/command.js, which the package's
// `bin` (bin.ts, dist/cli/tricot.js) loads once it has checked the Node.js version.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUrl } from '../platform/openUrl';
import { interruptSelf, stopSignals } from '../platform/stop';
import { runCaptured } from './connectAgent';
import { runCli } from './main';
import { runSwitcher, switcherProblem } from './switcher/run';
import { runInTerminal, terminalKeys } from './terminal';

const entry = fileURLToPath(import.meta.url);
// dist/cli/command.js once built, src/cli/tricot.ts from source: either way the
// package folder is two levels up.
const root = path.resolve(path.dirname(entry), '../..');

// A yes/no question, in a terminal only: piped, the command can't be answered.
// A bare Enter is `fallback` ([Y/n] asks with yes), else no.
async function ask(question: string, fallback = false): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer === '' ? fallback : /^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

const { exitCode, server } = await runCli(process.argv.slice(2), {
  env: process.env,
  root,
  entry,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  open: (url) => openUrl(url, process.env, (unopened) => console.log(`Open ${unopened} in your browser.`)),
  cwd: process.cwd(),
  launch: runInTerminal,
  exec: runCaptured,
  ...(process.stdin.isTTY && { ask }),
  // The board picker draws as it goes, so it needs a terminal to draw on too,
  // as do several agents run in it together (tricot claude codex).
  ...(process.stdin.isTTY && process.stdout.isTTY && { keys: terminalKeys(), host: { problem: () => switcherProblem(), run: runSwitcher } }),
  // Ctrl+C read as a key, while the board's terminal asks y/N: it stops Tricot all the same.
  interrupt: () => interruptSelf(),
});

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
