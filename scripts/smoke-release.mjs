// The release check on a clean machine, scripted: what a person gets from
// `npm install -g tricot`, before it is published.
//
//   node scripts/smoke-release.mjs [--tarball tricot-x.y.z.tgz] [--port 5055] [--keep]
//
// It builds and packs the package (or takes a tarball), checks what ships
// (nothing private, nothing missing), installs it globally into a prefix of
// its own with a fresh home, data folder, npm cache and temp folder, all under
// .review/smoke/, offline (so it fails if the package needs anything from the
// registry), and runs the installed `tricot` there without a terminal (so the
// first-run question about live steps isn't asked) and without opening a
// browser. Then, in headless Chrome with a fresh profile: the name, the
// first-run page ("What are you working on?") and the Source link at its
// foot, a sentence sent; a stand-in agent connects through the server's own
// MCP endpoint, finds the thread and posts the first decision on it, and the
// page shows it. Screenshots of the first-run page and the first question go
// to .review/smoke/shots/. Everything it started is stopped at the end, pass
// or fail. The scratch folder stays for
// a look, and is wiped at the next run's start unless --keep.
//
// It never publishes, never touches ~/.tricot, the person's own npm, Chrome
// profile or agent settings, and never listens on 4545.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const { values } = parseArgs({
  options: {
    tarball: { type: 'string' },
    // Not 5000, which macOS keeps for AirPlay.
    port: { type: 'string', default: '5055' },
    keep: { type: 'boolean', default: false },
  },
});
const port = Number(values.port);
if (port === 4545) throw new Error('4545 is the port of your own board: pick another with --port.');

const scratch = path.join(root, '.review/smoke');
const dirs = {
  home: path.join(scratch, 'home'),
  project: path.join(scratch, 'home/my-project'),
  prefix: path.join(scratch, 'prefix'),
  data: path.join(scratch, 'data'),
  tmp: path.join(scratch, 'tmp'),
  chrome: path.join(scratch, 'chrome-profile'),
  shots: path.join(scratch, 'shots'),
};
if (!values.keep) rmSync(scratch, { recursive: true, force: true });
// The data folder is Tricot's to make, as on a machine that never ran it.
for (const [name, dir] of Object.entries(dirs)) if (name !== 'data') mkdirSync(dir, { recursive: true });

// The clean machine: nothing from this shell's own npm, home or agents. Its
// PATH has the prefix's commands, this Node and npm, and the system's own.
const cleanEnv = {
  PATH: [path.join(dirs.prefix, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  HOME: dirs.home,
  TMPDIR: dirs.tmp,
  TRICOT_DATA_DIR: dirs.data,
  BROWSER: 'none',
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  npm_config_cache: path.join(dirs.home, '.npm'),
  npm_config_userconfig: path.join(dirs.home, '.npmrc'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

const say = (line) => console.log(line);
const fail = (message) => {
  throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  say(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fail(what);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}

// ---- 1. The package, and what ships in it ----------------------------------

// What must ship, and what never may: anything of this repository's own
// tooling, tests, sources, local state, secrets or source maps (which would
// carry the paths of the machine that built it).
const MUST = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'dist/cli/tricot.js', 'dist/cli/command.js', 'dist/web/index.html', 'hooks/tricot-steps.mjs', 'hooks/tricot-describe.mjs', 'hooks/tricot-approve.mjs'];
const NEVER = [/^\.review\//, /^\.claude\//, /^\.impeccable\//, /^\.git\//, /^node_modules\//, /^test\//, /^src\//, /^scripts\//, /^packaging\//, /^dist\/\.notices\//, /(^|\/)\.env/, /\.map$/, /(^|\/)\.DS_Store$/, /\.tmp$/, /(^|\/)token$/, /server\.lock$/, /\.(db|sqlite)(-wal|-shm)?$/];

let tarball = values.tarball && path.resolve(values.tarball);
let files;
if (!tarball) {
  say('Building, then packing (as npm publish would)...');
  run('npm', ['run', 'build'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], { cwd: root }));
  tarball = path.join(scratch, packed.filename);
  files = packed.files.map((f) => f.path);
  say(`Packed ${packed.filename}: ${(packed.size / 1e6).toFixed(2)} MB, ${(packed.unpackedSize / 1e6).toFixed(2)} MB unpacked, ${packed.entryCount} files.`);
} else {
  files = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean).map((f) => f.replace(/^package\//, ''));
}
for (const file of MUST) check(files.includes(file), `the package has ${file}`);
const leaks = files.filter((file) => NEVER.some((pattern) => pattern.test(file)));
check(leaks.length === 0, `the package has nothing private${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
writeFileSync(path.join(scratch, 'files.txt'), `${files.sort().join('\n')}\n`);

// ---- 2. Installed for good, on a clean machine ------------------------------

say(`Installing ${path.basename(tarball)} globally into ${path.relative(root, dirs.prefix)}, offline...`);
const install = spawnSync('npm', ['install', '-g', '--prefix', dirs.prefix, '--offline', tarball], { cwd: dirs.project, env: cleanEnv, encoding: 'utf8' });
if (install.status !== 0) fail(`npm couldn't install it offline, so it needs something from the registry:\n${install.stdout}${install.stderr}`);
say(install.stdout.trim());
const installed = path.join(dirs.prefix, 'lib/node_modules/tricot');
check(existsSync(path.join(dirs.prefix, 'bin/tricot')), 'npm linked the tricot command into the prefix');
check(!existsSync(path.join(installed, 'node_modules')), 'it installed no dependencies: everything is bundled');
const which = run('sh', ['-c', 'command -v tricot'], { env: cleanEnv }).trim();
check(which === path.join(dirs.prefix, 'bin/tricot'), `\`tricot\` is the installed command (${path.relative(root, which)})`);
check(run('tricot', ['--version'], { env: cleanEnv, cwd: dirs.project }).trim() === pkg.version, `tricot --version says ${pkg.version}`);

// ---- 3. Running it -----------------------------------------------------------

const children = [];
let browser;
let tricotLog = '';

async function portAnswers(p) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: p, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitFor(what, test, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    let value;
    try {
      value = await test();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() > until) fail(`Timed out waiting for ${what}.`);
    await sleep(150);
  }
}

// The page, through the Chrome DevTools Protocol, on Node's own WebSocket.
class Page {
  static async open(chromePath) {
    const chrome = spawn(
      chromePath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${dirs.chrome}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--use-mock-keychain',
        '--password-store=basic',
        '--window-size=1440,900',
        'about:blank',
      ],
      { env: cleanEnv, stdio: 'ignore', detached: true },
    );
    children.push(chrome);
    const portFile = path.join(dirs.chrome, 'DevToolsActivePort');
    const devtools = await waitFor('Chrome to start', () => existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0]);
    const targets = await waitFor('a page in Chrome', async () => {
      const list = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json();
      return list.find((t) => t.type === 'page');
    });
    const page = new Page(targets.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return page;
  }

  constructor(url) {
    this.next = 0;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error('Could not reach Chrome.'));
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    };
  }

  send(method, params = {}) {
    const id = ++this.next;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  // Types into the element, as a person would: focus, then text input.
  async type(selector, text) {
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await this.send('Input.insertText', { text });
  }

  async shot(name) {
    await sleep(700); // let entrance motion settle
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(dirs.shots, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    say(`     screenshot: ${path.relative(root, file)}`);
  }

  close() {
    this.socket.close();
  }
}

// A stand-in agent: MCP over Streamable HTTP, as any client speaks it.
class Agent {
  constructor(url) {
    this.url = url;
    this.next = 0;
  }

  async post(body) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.session && { 'Mcp-Session-Id': this.session, 'Mcp-Protocol-Version': this.protocol }),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) fail(`MCP ${body.method}: HTTP ${res.status} ${await res.text()}`);
    this.session ??= res.headers.get('mcp-session-id') ?? undefined;
    if (body.id === undefined) return undefined;
    const text = await res.text();
    const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(text)];
    const reply = messages.find((m) => m.id === body.id);
    if (!reply || reply.error) fail(`MCP ${body.method}: ${JSON.stringify(reply?.error ?? messages)}`);
    return reply.result;
  }

  async connect() {
    const result = await this.post({
      jsonrpc: '2.0',
      id: ++this.next,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-stand-in', version: '1.0.0' } },
    });
    this.protocol = result.protocolVersion;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  async tool(name, args = {}) {
    const result = await this.post({ jsonrpc: '2.0', id: ++this.next, method: 'tools/call', params: { name, arguments: args } });
    const text = result.content.map((c) => c.text ?? '').join('\n');
    if (result.isError) fail(`${name}: ${text}`);
    return text;
  }

  async close() {
    if (this.session) await fetch(this.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.session } }).catch(() => {});
  }
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? fail('No Chrome or Chromium found: set CHROME_PATH.');
}

// `tricot stop`, as a person would stop it. Not spawnSync: while it waits,
// this process couldn't reap the server it started, and `tricot stop` would
// take the unreaped server for one still running.
function stopTricot() {
  return new Promise((resolve) => {
    const stop = spawn('tricot', ['stop'], { env: cleanEnv, cwd: dirs.project });
    let said = '';
    stop.stdout.on('data', (chunk) => (said += chunk));
    stop.stderr.on('data', (chunk) => (said += chunk));
    stop.on('close', (code) => resolve({ code, said: said.trim() }));
  });
}

async function main() {
  check(!(await portAnswers(port)), `nothing is listening on port ${port} yet`);
  say(`Starting the installed tricot on port ${port}, without a terminal or a browser...`);
  const tricot = spawn('tricot', ['--port', String(port), '--no-open'], { cwd: dirs.project, env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  children.push(tricot);
  tricot.stdout.on('data', (chunk) => (tricotLog += chunk));
  tricot.stderr.on('data', (chunk) => (tricotLog += chunk));
  const base = `http://127.0.0.1:${port}`;
  const info = await waitFor('/api/info to answer', async () => (await fetch(`${base}/api/info`)).json());
  check(info.app === 'tricot' && info.version === pkg.version, `/api/info answers: tricot ${info.version}`);
  check(info.mcpUrl === `${base}/mcp`, `its MCP endpoint is ${info.mcpUrl}`);
  const repository = pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
  check(Boolean(repository) && info.source === repository, `it names its source: ${info.source}`);
  check(tricotLog.includes(`Tricot is running: ${base}`), 'it says where it runs');
  check(!/show what your agents are doing/.test(tricotLog), "it didn't ask about live steps (no terminal)");
  check(tricotLog.includes(`Boards in: ${dirs.data}`), 'it keeps boards in the scratch data folder');

  browser = await Page.open(chromePath());
  await browser.send('Page.navigate', { url: `${base}/` });
  await waitFor('the name question', () => browser.eval(`!!document.querySelector('.gate-card input')`));
  await browser.type('.gate-card input', 'Sam');
  await browser.eval(`document.querySelector('.gate-card button').click()`);
  const heading = await waitFor('the first-run page', () => browser.eval(`document.querySelector('.first-run h1')?.textContent`));
  check(heading === 'What are you working on?', `the first-run page asks "${heading}"`);
  await waitFor('the connect line under the field', () => browser.eval(`!!document.querySelector('.first-connect, .first-agent')`));
  check(await browser.eval(`document.querySelector('.first-connect')?.textContent.includes('No agent connected yet') ?? false`), 'it says no agent is connected yet, with the command to connect one');
  const source = await waitFor('the Source link at the foot of Home', () => browser.eval(`document.querySelector('.home-foot-about a')?.href`));
  check(source === info.source, `the foot of Home links to its source (${source})`);
  await browser.shot('first-run.png');

  const sentence = 'A pricing page for the Pro plan';
  await browser.type('.first-ask-field', sentence);
  await browser.eval(`document.querySelector('.first-ask-send').click()`);
  const hash = await waitFor('the new project to open', () => browser.eval(`location.hash.startsWith('#/b/') && location.hash`));
  check(Boolean(hash), `sending made the project and opened it (${hash})`);

  const agent = new Agent(`${base}/mcp?agent=Stand-in`);
  const hello = await agent.connect();
  check(hello.serverInfo?.name !== undefined, `a stand-in agent connected over MCP (${hello.serverInfo?.name}, protocol ${hello.protocolVersion})`);
  const boards = await agent.tool('list_boards');
  const boardId = /\[id: ([^\]]+)\]/.exec(boards)?.[1] ?? fail(`No board in list_boards:\n${boards}`);
  const board = await agent.tool('get_board', { board_id: boardId });
  const threadId = /\[thread id: ([^\]]+)\]/.exec(board)?.[1] ?? fail(`No thread on the board:\n${board}`);
  check(board.includes(sentence), `the agent finds the board and the sentence on thread ${threadId}`);
  const question = 'Which pricing should the Pro plan page lead with?';
  const posted = await agent.tool('post_decision', {
    board_id: boardId,
    thread_id: threadId,
    question,
    context: 'The page leads with one price; the other shows on a toggle.',
    options: [
      { label: 'Monthly', description: 'Lead with the monthly price.' },
      { label: 'Yearly', description: 'Lead with the yearly price and its saving.' },
    ],
    recommend: 'b',
    recommendation_reason: 'Most buyers of a Pro plan pay yearly.',
    area: 'Pricing',
  });
  check(/\[id: [^\]]+\]/.test(posted), 'the agent posted the first decision on the thread');
  await waitFor('the question on the page', () => browser.eval(`document.body.innerText.includes(${JSON.stringify(question)})`));
  check(true, 'the page shows the question');
  await browser.shot('first-question.png');
  await agent.close();
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`\n${error instanceof Error ? error.message : error}`);
  if (tricotLog) console.error(`\ntricot said:\n${tricotLog}`);
} finally {
  browser?.close();
  if (existsSync(path.join(dirs.prefix, 'bin/tricot'))) {
    const stopped = await stopTricot();
    const ok = stopped.code === 0 && /Tricot stopped\./.test(stopped.said);
    say(`${ok ? 'ok  ' : 'FAIL'} tricot stop: ${stopped.said}`);
    if (!ok) failed = true; // after a passing run it was running, so it must stop
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM'); // its whole process group
      } catch {
        // already gone
      }
    }
  }
  await sleep(500);
  const stillUp = await portAnswers(port);
  say(stillUp ? `FAIL port ${port} still answers` : `ok   everything stopped; port ${port} is free`);
  writeFileSync(path.join(scratch, 'tricot.log'), tricotLog);
  if (stillUp) failed = true;
}
say(failed ? '\nThe smoke run failed.' : `\nThe smoke run passed: ${results.length} checks. Scratch folder: ${path.relative(root, scratch)}`);
process.exitCode = failed ? 1 : 0;
