#!/usr/bin/env node
// A stand-in for Codex (ratatui and crossterm), from the T185 spike: what
// matters for the host is that it
//  - asks the terminal at startup, as crossterm does: the kitty keyboard's
//    flags with device attributes after them, then the cursor's position,
//    each waiting for an answer (and saying so on screen when none came);
//  - draws on the alternate screen, with bracketed paste, focus reports and
//    the mouse on (SGR), in truecolour;
//  - keeps its last frame and writes only the cells that changed, repainting
//    whole only when its size really changes;
//  - reads each key in what one read brings, as crossterm does.
// Ctrl+C twice quits (exit 0); X quits with --exit=N's code; B rings the bell.
// It writes nothing anywhere but its terminal.
const out = process.stdout;
const inp = process.stdin;
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const name = arg('name', 'Codex (stand-in)');
const exitCode = Number(arg('exit', '3'));
inp.setRawMode(true);
let W = out.columns;
let H = out.rows;
let prev = null;
const events = [];
const t0 = Date.now();
let probe = 'probing…';
let tick = 0;
const log = [];
const steps = ['Running npm test', 'Reading src/server', 'Applying patch', 'Waiting for approval'];

function ask(query, re, ms) {
  return new Promise((resolve) => {
    let buf = '';
    const on = (d) => {
      buf += d.toString('latin1');
      const m = re.exec(buf);
      if (m) {
        inp.off('data', on);
        clearTimeout(t);
        resolve(m);
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

async function start() {
  const tq = Date.now();
  const kitty = await ask('\x1b[?u\x1b[c', /\x1b\[\?(\d+)u|\x1b\[\?[\d;]*c/, 2000);
  const pos = await ask('\x1b[6n', /\x1b\[(\d+);(\d+)R/, 2000);
  probe = `probes: kitty=${kitty ? (kitty[1] ? 'yes' : 'no') : 'TIMEOUT'} pos=${pos ? `${pos[1]},${pos[2]}` : 'TIMEOUT'} in ${Date.now() - tq}ms`;
  out.write(`\x1b]0;${name}\x07\x1b[?1049h\x1b[?2004h\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l`);
  inp.on('data', onKey);
  setInterval(() => {
    tick++;
    if (tick % 3 === 0) log.push(`${String(log.length + 1).padStart(3)} ${steps[log.length % steps.length]}`);
    draw();
  }, 250);
  process.on('SIGWINCH', () => draw());
  draw();
}

// The keys in one read, as crossterm reads them: a paste, a mouse report, a
// sequence, Esc and a key (Alt), a control key, or one character. Keys typed
// fast, or a focus report and a key, often come in one read.
const KEYS = /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[<[\d;]*[Mm]|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1bO.|\x1b[\s\S]?|[\s\S]/g;

let ctrlC = false;
function onKey(d) {
  for (const [s] of d.toString('latin1').matchAll(KEYS)) {
    let e;
    if (s === '\x03') {
      if (ctrlC) return quit(0);
      ctrlC = true;
      e = 'Ctrl+C (again to quit)';
      setTimeout(() => (ctrlC = false), 2000);
    } else if (s === 'X') return quit(exitCode);
    else if (s === 'B') {
      out.write('\x07');
      e = 'rang';
    } else if (s === '\x1b') e = 'Esc';
    else if (s.startsWith('\x1b[200~')) e = `paste ${JSON.stringify(s.slice(6).replace(/\x1b\[201~$/, '')).slice(0, 40)}`;
    else if (s.startsWith('\x1b[<')) e = `mouse ${s.slice(3)}`.slice(0, 40);
    else if (s === '\x1b[I' || s === '\x1b[O') e = s === '\x1b[I' ? 'focus in' : 'focus out';
    else e = `key ${[...Buffer.from(s, 'latin1')].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
    events.unshift(e);
  }
  events.length = Math.min(events.length, 3);
  draw();
}

function quit(code) {
  out.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l');
  process.exit(code);
}

function frame() {
  const g = Array.from({ length: H }, () => Array(W).fill('| '));
  const put = (y, x, text, sgr = '') => {
    for (const ch of text) {
      if (y < 0 || y >= H || x >= W) return;
      if (x >= 0) g[y][x] = `${sgr}|${ch}`;
      x++;
    }
  };
  for (let x = 0; x < W; x++) put(0, x, ' ', `48;2;${Math.round(40 + (180 * x) / W)};60;${Math.round(220 - (160 * x) / W)}`);
  put(0, 1, ` >_ ${name}  ${W}x${H} `, '1;38;2;255;255;255;48;2;40;60;220');
  const area = Math.max(0, H - 6);
  log.slice(-area).forEach((l, i) => put(1 + i, 1, `• ${l}`, i % 2 ? '38;5;117' : '38;5;221'));
  put(H - 5, 0, '─'.repeat(W), '38;5;240');
  put(H - 4, 1, probe, '38;5;245');
  put(H - 3, 1, `events: ${events.join(' | ') || 'none'}`, '38;5;250');
  put(H - 2, 1, `› type here  (${((Date.now() - t0) / 1000).toFixed(1)}s)`, '1');
  put(H - 1, 1, 'esc interrupt · ctrl+c quit', '2');
  return g;
}

function draw() {
  if (out.columns !== W || out.rows !== H) {
    W = out.columns;
    H = out.rows;
    prev = null;
    out.write('\x1b[2J');
  }
  const g = frame();
  let s = '\x1b[?2026h';
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (prev && prev[y] && prev[y][x] === g[y][x]) {
        x++;
        continue;
      }
      s += `\x1b[${y + 1};${x + 1}H`;
      let cur = null;
      while (x < W && !(prev && prev[y] && prev[y][x] === g[y][x])) {
        const [sgr, ch] = g[y][x].split('|');
        if (sgr !== cur) {
          s += `\x1b[0${sgr ? `;${sgr}` : ''}m`;
          cur = sgr;
        }
        s += ch;
        x++;
      }
    }
  }
  s += '\x1b[0m\x1b[?2026l';
  prev = g;
  out.write(s);
}

start();
