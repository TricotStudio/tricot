#!/usr/bin/env node
// A stand-in for Claude Code in its full-screen renderer, with nothing to
// install (the T185 spike's used Ink; this draws what Ink would). What
// matters for the host is that it
//  - asks the terminal its background colour at startup, with device
//    attributes after (as Claude Code's "auto" theme does), and shows what
//    it heard;
//  - draws its whole window on the alternate screen, with the mouse (SGR),
//    bracketed paste and focus reports on, in truecolour and 256 colours,
//    with wide characters;
//  - shows the last key it got, what was pasted, and what you typed, reading
//    each key in what one read brings, as a terminal app does (keys typed
//    fast, or a focus report and a key, often come together);
//  - adds a line for Ctrl+J and Option+Enter, as Claude Code does, and with
//    --keys, asks for the keyboard protocols as Claude Code does (T191):
//    --keys=kitty as in a terminal it knows speaks them (Ghostty, iTerm2,
//    kitty, WezTerm): on its screen CSI < u, CSI > 5 u (keys told apart) and
//    CSI > 4;2 m (modifyOtherKeys), then CSI ? u, showing the answer;
//    --keys=ask as in one it doesn't know: CSI ? u first, and the same only
//    if it was answered. Shift+Enter then comes as CSI 13;2u (or
//    CSI 27;2;13~) and adds a line; it puts both back as it leaves.
// Ctrl+C twice quits (exit 0); X quits with --exit=N's code.
//
// For the scratch run, it can also do what Claude Code's hooks do: run the
// commands in --settings (Tricot's session hooks) for a step (--step-after=ms,
// "Running npm test") and a request for permission (--approve-after=ms), as
// Claude Code would, with the event as JSON on their input; A typed asks for
// permission too, for the next of two commands each time. It rings the
// bell with --bell-after=ms, and sends a notification with --notify-after=ms.
import { spawn } from 'node:child_process';

const out = process.stdout;
const inp = process.stdin;
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const name = arg('name', 'Claude (stand-in)');
const exitCode = Number(arg('exit', '0'));
const keysMode = arg('keys', ''); // '', 'kitty' or 'ask'
const settingsAt = process.argv.indexOf('--settings');
const settings = settingsAt > 0 ? JSON.parse(process.argv[settingsAt + 1]) : {};
inp.setRawMode(true);

const log = [];
let input = '';
let last = 'none yet';
let theme = 'asking…';
let tick = 0;
let ctrlC = false;
let waiting = '';
let keyboard = ''; // what it asked of the keyboard, and what the terminal said
let pushed = false;
const steps =['Reading the board', 'Planning the work', 'Editing host.ts', 'Listening on the board'];

function ask(query, re, ms) {
  return new Promise((resolve) => {
    let buf = '';
    const on = (d) => {
      buf += d.toString('latin1');
      // Up to the device attributes, which a terminal answers last: stopping at
      // the answer asked for would leave them to come in as a key.
      if (/\x1b\[\?[\d;]*c/.test(buf)) {
        inp.off('data', on);
        clearTimeout(t);
        resolve(re.exec(buf));
      }
    };
    const t = setTimeout(() => {
      inp.off('data', on);
      resolve(null);
    }, ms);
    inp.on('data', on);
    out.write(query);
  });
}

// Runs the session's hooks for an event, as Claude Code does: each command
// with the event as JSON on its input; resolves with what they printed.
function hook(event, payload) {
  const commands = (settings.hooks?.[event] ?? []).flatMap((entry) => entry.hooks ?? []).map((h) => h.command);
  return Promise.all(
    commands.map(
      (command) =>
        new Promise((resolve) => {
          const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
          let said = '';
          child.stdout.on('data', (d) => (said += d));
          child.on('close', () => resolve(said));
          child.on('error', () => resolve(''));
          child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'stand-in-session', cwd: process.cwd(), ...payload }));
        }),
    ),
  );
}

function after(option, run) {
  const ms = Number(arg(option, ''));
  if (Number.isFinite(ms) && ms > 0) setTimeout(run, ms);
}

async function start() {
  const bg = await ask('\x1b]11;?\x1b\\\x1b[c', /\x1b\]11;([^\x07\x1b]*)/, 5000);
  theme = bg ? `background ${bg[1]}` : 'no answer about colours';
  out.write(`\x1b]0;${name}\x07\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h`);
  if (keysMode) await askKeyboard();
  inp.on('data', onKey);
  setInterval(() => {
    tick++;
    if (tick % 2 === 0 && log.length < 400) log.push({ n: log.length + 1, text: steps[log.length % steps.length] });
    draw();
  }, 350);
  process.on('SIGWINCH', draw);
  draw();
  after('bell-after', () => out.write('\x07'));
  after('notify-after', () => out.write(`\x1b]9;${name} needs your attention\x07`));
  after('step-after', () => void hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_standin_1', tool_input: { command: 'npm test', description: 'Run the tests' } }));
  after('approve-after', () => void askApproval({ command: 'npm test', description: 'Run the tests' }));
}

// A request for permission, through the session's hooks, as Claude Code
// makes one: --approve-after, or A typed (the next of these each time).
const REQUESTS = [
  { command: 'rm -rf dist && npm run build', description: 'Rebuild the web bundle after the CSS change' },
  { command: 'git push --force origin main', description: 'Publish the release' },
];
let asked = 0;
async function askApproval(input = REQUESTS[asked++ % REQUESTS.length]) {
  waiting = `waiting for approval on the board: ${input.command}`;
  draw();
  const said = await hook('PermissionRequest', { tool_name: 'Bash', tool_input: input, permission_suggestions: [] });
  const decision = said.map((s) => s.trim()).find(Boolean);
  const answer = decision ? JSON.parse(decision).hookSpecificOutput?.decision : undefined;
  waiting = answer ? `approval: ${answer.behavior ?? 'answered'}${answer.message ? ` (${answer.message})` : ''}` : 'approval: asked in the terminal';
  log.push({ n: log.length + 1, text: waiting });
  draw();
}

// The keyboard protocols, on the alternate screen (each screen has its own
// kitty flags), with the terminal's answer to CSI ? u heard whole: up to its
// device attributes, which every terminal answers.
async function askKeyboard() {
  const push = () => {
    out.write('\x1b[<u\x1b[>5u\x1b[>4;2m');
    pushed = true;
  };
  if (keysMode === 'kitty') push();
  const heard = await new Promise((resolve) => {
    let buf = '';
    const on = (d) => {
      buf += d.toString('latin1');
      if (/\x1b\[\?[\d;]*c/.test(buf)) done();
    };
    const done = () => {
      inp.off('data', on);
      clearTimeout(t);
      resolve(buf);
    };
    const t = setTimeout(done, 5000);
    inp.on('data', on);
    out.write('\x1b[?u\x1b[c');
  });
  const answer = /\x1b\[\?(\d+)u/.exec(heard);
  if (answer && !pushed) push();
  keyboard = `keys: ${pushed ? 'kitty 5' : 'plain'}, ${answer ? `answered ?${answer[1]}u` : 'no answer'}`;
}

// The keys in one read: a paste, a mouse report, a sequence, Esc and a key
// (Alt), a control key, or a run of text.
const KEYS = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[<[\d;]*[Mm]|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1bO.|\x1b[\s\S]?|[\x00-\x1f\x7f]|[^\x00-\x1f\x7f\x1b]+/g;
const NEW_LINE = { '\x1b[13;2u': 'Shift+Enter', '\x1b[27;2;13~': 'Shift+Enter', '\n': 'Ctrl+J', '\x1b\r': 'Option+Enter' };

function onKey(d) {
  for (const [key] of d.toString('utf8').matchAll(KEYS)) if (oneKey(key) === 'quit') return;
  draw();
}

function oneKey(s) {
  if (NEW_LINE[s]) {
    input += '\n';
    last = `${NEW_LINE[s]}: a new line ${JSON.stringify(s)}`;
  } else if (s === '\x03' || s === '\x1b[99;5u') {
    if (ctrlC) return quit(0);
    ctrlC = true;
    last = 'Ctrl+C (press again to exit)';
    setTimeout(() => (ctrlC = false), 2000);
  } else if (s === 'X') return quit(exitCode);
  else if (s === 'A') void askApproval();
  else if (s === '\r') {
    log.push({ n: log.length + 1, text: `you said: ${input.replace(/\n/g, '↵')}` });
    input = '';
    last = 'Enter';
  } else if (s === '\x1b' || s === '\x1b[27u') last = 'Esc';
  else if (s === '\x7f') {
    input = input.slice(0, -1);
    last = 'Backspace';
  } else if (s.startsWith('\x1b[200~')) {
    const text = s.slice(6).replace(/\x1b\[201~$/, '');
    input += text.replace(/[\r\n]+/g, ' ');
    last = `paste ${JSON.stringify(text).slice(0, 40)}`;
  } else if (s.startsWith('\x1b[<')) last = `mouse ${s.slice(3)}`.slice(0, 40);
  else if (s === '\x1b[I' || s === '\x1b[O') last = s === '\x1b[I' ? 'focus in' : 'focus out';
  else if (s.startsWith('\x1b')) last = JSON.stringify(s);
  else if (s.charCodeAt(0) < 32) last = `Ctrl+${String.fromCharCode(s.charCodeAt(0) + 64)} (${s.charCodeAt(0).toString(16)})`;
  else {
    input += s;
    last = JSON.stringify(s);
  }
}

function quit(code) {
  out.write(`\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?1004l${pushed ? '\x1b[>4m\x1b[<u' : ''}\x1b[?1049l`);
  process.exit(code);
  return 'quit';
}

function draw() {
  const W = out.columns;
  const H = out.rows;
  const fit = (text, room) => (text.length > room ? text.slice(0, Math.max(0, room)) : text + ' '.repeat(Math.max(0, room - text.length)));
  let s = '\x1b[?2026h\x1b[H';
  const line = (y, body) => (s += `\x1b[${y};1H\x1b[0m${body}\x1b[0m\x1b[K`);
  line(1, `\x1b[1;38;2;217;119;87m✻ ${name}\x1b[0;2m  ${W}x${H} · ${theme}${keyboard ? ` · ${keyboard}` : ''}`);
  const room = Math.max(0, H - 7);
  const shown = log.slice(-room);
  for (let i = 0; i < room; i++) {
    const e = shown[i];
    line(2 + i, e ? `\x1b[32m⏺ \x1b[${e.n % 3 ? 37 : 33}m${String(e.n).padStart(3)} \x1b[38;5;117m${e.text}\x1b[0;2m — 日本語 ok ✅` : '');
  }
  const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[tick % 10];
  line(H - 4, `\x1b[38;2;217;119;87m╭${'─'.repeat(Math.max(0, W - 2))}╮`);
  line(H - 3, `\x1b[38;2;217;119;87m│\x1b[0m ${fit(`${spin} ${waiting || steps[tick % steps.length]}`, W - 4)} \x1b[38;2;217;119;87m│`);
  line(H - 2, `\x1b[38;2;217;119;87m│\x1b[0m \x1b[36m>\x1b[0m ${fit(input.replace(/\n/g, '↵'), W - 6)} \x1b[38;2;217;119;87m│`);
  line(H - 1, `\x1b[38;2;217;119;87m╰${'─'.repeat(Math.max(0, W - 2))}╯`);
  line(H, `\x1b[2m last key: ${fit(last, W - 12)}`.slice(0, W + 8));
  s += `\x1b[${H - 2};${Math.min(W, 6 + input.length)}H\x1b[?2026l`;
  out.write(s);
}

start();
