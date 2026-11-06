import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openCommand, openUrl } from '../src/platform/openUrl';
import { home, osHome } from '../src/platform/paths';
import { batchArgument, batchCommandLine, execProgram, isBatchFile, launchOf, runProgram } from '../src/platform/run';
import { interruptSelf, stopSignals } from '../src/platform/stop';
import { which } from '../src/platform/which';
import { removeScratch, WINDOWS } from './platform';

// Starting programs, opening the browser and finding the home folder on
// Windows, through the platform layer's `os` parameter, so they run on every
// system. The last block starts real .cmd files, and runs on Windows only.

// ---- a model of what Windows does with the line ------------------------------------------

// The program's own reading of a command line (the Microsoft C runtime's,
// which Node, Rust and most programs share): what argv comes of `line`.
function argvOf(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= n) return args;
    let arg = '';
    let quoted = false;
    while (i < n && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      if (line[i] === '\\') {
        let slashes = 0;
        while (line[i] === '\\') (slashes++, i++);
        if (line[i] === '"') {
          arg += '\\'.repeat(slashes >> 1);
          if (slashes & 1) (arg += '"', i++);
        } else arg += '\\'.repeat(slashes);
      } else if (line[i] === '"') {
        if (quoted && line[i + 1] === '"') (arg += '"', (i += 2));
        else (quoted = !quoted, i++);
      } else arg += line[i++];
    }
    args.push(arg);
  }
}

// What cmd.exe leaves outside quotes in the line it reads: it toggles on each
// `"` it sees (a caret before one, outside quotes, makes it a plain character, which
// this line never has). Anything but a space out there would be read as cmd.exe's own.
function outsideQuotes(line: string): string {
  let inside = false;
  let outside = '';
  for (const char of line) {
    if (char === '"') inside = !inside;
    else if (!inside) outside += char;
  }
  return outside;
}

const EXPANDS_NOTHING = '%%cd:~,%'; // how a % is written: %cd:~,% is always empty

// The line as the batch file ends up seeing it: cmd.exe has expanded the empty variables.
const afterCmd = (line: string): string => line.replaceAll(EXPANDS_NOTHING, '%');

const NASTY = [
  'plain',
  'two words',
  '',
  ' ',
  'http://127.0.0.1:4545/mcp?agent=A%20B&x=1',
  '"quoted"',
  'say "hi" & calc',
  'a" & echo PWNED & "b',
  'a|b',
  'a<b>c',
  'a^b',
  '(x)',
  '!x!',
  'a;b',
  'x,y',
  "it's",
  '`id`',
  '$HOME',
  '*',
  '?',
  '100%',
  '%PATH%',
  'trailing\\',
  'two\\\\',
  'back\\"slash',
  'C:\\Program Files\\x y\\',
  '\\\\server\\share\\',
  'Authorization: Bearer abc.def-ghi_jkl',
  '--flag=value with space',
  'ünï ☃',
];

describe('Starting a .cmd file on Windows', () => {
  it('writes one word of the line cmd.exe is given, in quotes whatever it holds', () => {
    assert.equal(batchArgument('plain'), '"plain"');
    assert.equal(batchArgument('two words'), '"two words"');
    assert.equal(batchArgument(''), '""', 'an empty word stays a word');
    assert.equal(batchArgument('a&b|c<d>e^f(g)h!i'), '"a&b|c<d>e^f(g)h!i"', 'inside quotes none of them means anything to cmd.exe');
    assert.equal(batchArgument('"q"'), '"""q"""', 'a quote is written twice, which keeps cmd.exe inside its quotes');
    assert.equal(batchArgument('a" & calc & "b'), '"a"" & calc & ""b"');
    assert.equal(batchArgument('100%'), '"100%%cd:~,%"', 'a % would expand a variable even in quotes');
    assert.equal(batchArgument('a\\b'), '"a\\b"', 'a backslash alone is a backslash');
    assert.equal(batchArgument('x\\'), '"x\\\\"', 'backslashes at the end are doubled, or they would escape the closing quote');
    assert.equal(batchArgument('a\\"b'), '"a\\\\""b"', 'and before a quote');
    assert.equal(batchArgument('a\\\\"b'), '"a\\\\\\\\""b"');
  });

  it('refuses a word with a line break or NUL, which cmd.exe cannot be given in any quoting', () => {
    for (const word of ['a\nb', 'a\rb', 'a\0b']) assert.throws(() => batchArgument(word), /line break/);
    assert.throws(() => batchCommandLine('C:\\x.cmd', ['ok', 'a\nb']), /line break/);
  });

  it('puts the file and every word in quotes, in one line for cmd.exe to take the outer quotes off', () => {
    assert.equal(batchCommandLine('C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd', ['mcp', 'add', 'x y']), '""C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd" "mcp" "add" "x y""');
  });

  it('keeps, for any words at all, nothing but spaces outside the quotes and a % only in the form that expands to nothing, and gives the program back each word', () => {
    // A fixed sequence of random words from the characters that matter.
    const alphabet = ['a', 'b', ' ', '"', '"', '\\', '\\', '%', '&', '|', '<', '>', '^', '(', ')', '!', "'", 'é', ',', ';', '=', '*', '?', '\t', '$', '`'];
    let seed = 1234567;
    const next = (limit: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % limit);
    const cases = [...NASTY];
    for (let i = 0; i < 4000; i++) cases.push(Array.from({ length: next(14) }, () => alphabet[next(alphabet.length)]).join(''));
    for (let i = 0; i < cases.length; i += 3) {
      const words = cases.slice(i, i + 3);
      const line = batchCommandLine('C:\\Program Files\\nodejs\\npm.cmd', words);
      assert.equal(line[0], '"');
      assert.equal(line.at(-1), '"');
      const inner = line.slice(1, -1); // what cmd.exe takes the outer quotes off to
      assert.equal(outsideQuotes(inner).replaceAll(' ', ''), '', `words outside quotes in ${JSON.stringify(words)}: ${inner}`);
      assert.equal(inner.replaceAll(EXPANDS_NOTHING, '').includes('%'), false, `a bare % in ${JSON.stringify(words)}: ${inner}`);
      assert.deepEqual(argvOf(afterCmd(inner)), ['C:\\Program Files\\nodejs\\npm.cmd', ...words], `the program reads something else from ${inner}`);
      // And once more as the batch file's own `%*` passes it on: still every word in quotes.
      assert.equal(outsideQuotes(afterCmd(inner)).replaceAll(' ', ''), '');
    }
  });

  it('starts a .cmd or .bat through cmd.exe, with the line as it is, and any other program as it is', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const url = 'http://127.0.0.1:4545/mcp?agent=Claude&token=a%2Fb';
    const launch = launchOf('C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd', ['mcp', 'add', url, 'Say "hi" & more'], {}, 'win32', cmd);
    assert.deepEqual(launch, {
      command: cmd,
      args: ['/d', '/e:ON', '/v:OFF', '/s', '/c', '""C:\\Users\\Sam\\AppData\\Roaming\\npm\\claude.cmd" "mcp" "add" "http://127.0.0.1:4545/mcp?agent=Claude&token=a%%cd:~,%2Fb" "Say ""hi"" & more""'],
      verbatim: true,
    });
    assert.equal(launchOf('D:\\tools\\setup.BAT', [], {}, 'win32', cmd).verbatim, true, 'whatever the case');
    assert.deepEqual(launchOf('C:\\Program Files\\nodejs\\node.exe', ['-e', 'a "b"'], {}, 'win32', cmd), { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['-e', 'a "b"'], verbatim: false });
    for (const os of ['darwin', 'linux'] as const) assert.deepEqual(launchOf('claude', ['a b', '&'], {}, os), { command: 'claude', args: ['a b', '&'], verbatim: false }, 'nothing changes elsewhere');
    assert.equal(isBatchFile('x.cmd'), true);
    assert.equal(isBatchFile('x.exe'), false);
    assert.equal(isBatchFile('x.cmd.exe'), false);
  });

  describe('finding the program', () => {
    let scratch: string;
    let bin: string;
    before(() => {
      scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-launch-'));
      bin = path.join(scratch, 'bin');
      mkdirSync(bin);
      for (const name of ['npm.cmd', 'npm', 'tool.exe', 'old.bat', 'plain']) {
        writeFileSync(path.join(bin, name), '');
        chmodSync(path.join(bin, name), 0o755); // which looks for a file that runs
      }
    });
    after(() => removeScratch(scratch));

    it('finds `npm` as npm.cmd on the PATH, and so starts it through cmd.exe', () => {
      const launch = launchOf('npm', ['--version'], { PATH: bin }, 'win32', 'cmd.exe');
      assert.equal(launch.command, 'cmd.exe');
      assert.equal(launch.args.at(-1), batchCommandLine(path.join(bin, 'npm.cmd'), ['--version']));
    });

    it('finds a program under the name the PATH variable has on Windows, which a copy of the environment keeps', () => {
      assert.equal(which('npm', { Path: bin }, 'win32'), path.join(bin, 'npm.cmd'));
      assert.equal(which('tool', { PATH: bin }, 'win32'), path.join(bin, 'tool.exe'));
      assert.equal(which('old', { PATH: bin }, 'win32'), path.join(bin, 'old.bat'), '.bat too');
      assert.equal(which('npm', { Path: bin }, 'linux'), undefined, 'the name is not matched loosely elsewhere');
      assert.equal(launchOf('tool', [], { Path: bin }, 'win32').command, path.join(bin, 'tool.exe'));
    });

    it("adds the extension to a path that hasn't one, and leaves what it can't find as it was", () => {
      assert.equal(launchOf(path.join(bin, 'tool'), ['x'], {}, 'win32').command, path.join(bin, 'tool.exe'));
      assert.deepEqual(launchOf('nothing-like-it', ['x'], { PATH: bin }, 'win32'), { command: 'nothing-like-it', args: ['x'], verbatim: false });
    });
  });
});

describe('Opening the browser', () => {
  it('opens an address on Windows with rundll32, which is given it as an argument and never reads it as a command line', () => {
    const url = 'http://127.0.0.1:4545/?token=a%26b#/b/my%20board&x=1';
    assert.deepEqual(openCommand(url, {}, 'win32'), { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
  });

  it('hands over the address as the URL parser writes it, with no space or quote in it', () => {
    const opener = openCommand('http://localhost:4545/b?q="x y"&n=1|2^3<4>#a b', {}, 'win32')!;
    assert.deepEqual(opener.args, ['url.dll,FileProtocolHandler', 'http://localhost:4545/b?q=%22x%20y%22&n=1|2^3%3C4%3E#a%20b']);
    assert.doesNotMatch(opener.args[1], /["\s]/);
  });

  it("opens nothing on Windows that isn't a web address: the call would run a file", () => {
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\System32\\calc.exe', 'javascript:alert(1)', 'ms-settings:network', '', 'not a url']) {
      assert.equal(openCommand(url, {}, 'win32'), undefined, url);
    }
  });

  it('is told when it could not open the address, and opens nothing for BROWSER=none', () => {
    const unopened: string[] = [];
    openUrl('file:///C:/x.exe', {}, (url) => unopened.push(url), 'win32');
    assert.deepEqual(unopened, ['file:///C:/x.exe']);
    openUrl('file:///C:/x.exe', { BROWSER: 'none' }, (url) => unopened.push(url), 'win32');
    assert.equal(unopened.length, 1);
  });

  it('opens as it did on macOS and Linux, and with $BROWSER where it is set', () => {
    const url = 'http://127.0.0.1:4545/?a=1&b=2';
    assert.deepEqual(openCommand(url, {}, 'darwin'), { command: 'open', args: [url] });
    assert.deepEqual(openCommand(url, {}, 'linux'), { command: 'xdg-open', args: [url] });
    assert.deepEqual(openCommand(url, { BROWSER: 'firefox' }, 'linux'), { command: 'firefox', args: [url] });
    assert.deepEqual(openCommand(url, { BROWSER: 'C:\\Browsers\\x.cmd' }, 'win32'), { command: 'C:\\Browsers\\x.cmd', args: [url] });
  });
});

describe('The home folder', () => {
  it("is the environment's HOME on macOS and Linux, where a test or a login can set it", () => {
    assert.equal(home({ HOME: '/elsewhere' }, 'linux'), '/elsewhere');
    assert.equal(home({ HOME: '/elsewhere', USERPROFILE: 'C:\\Users\\sam' }, 'darwin'), '/elsewhere');
    assert.equal(home({}, 'linux'), osHome());
  });

  it('is %USERPROFILE% on Windows, as the server and the agents have it, whatever HOME says', () => {
    // Git Bash sets HOME to /c/Users/sam, or to a folder of its own.
    assert.equal(home({ HOME: '/c/Users/sam', USERPROFILE: 'C:\\Users\\sam' }, 'win32'), 'C:\\Users\\sam');
    assert.equal(home({ HOME: 'D:\\gitbash-home' }, 'win32'), osHome(), 'without USERPROFILE, the operating system says, as the server asks it');
    assert.equal(home({ USERPROFILE: 'C:\\Users\\sam' }, 'win32'), 'C:\\Users\\sam');
  });
});

describe('Stopping on Windows', () => {
  it('also stops a server on Ctrl+Break and when its console window is closed, where Windows has them', () => {
    assert.deepEqual(stopSignals('linux'), ['SIGINT', 'SIGTERM']);
    assert.deepEqual(stopSignals('darwin'), ['SIGINT', 'SIGTERM']);
    assert.deepEqual(stopSignals('win32'), ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  });

  it("calls the handlers for Ctrl+C read as a key on Windows, where a signal to oneself would end the process unsaved", () => {
    let handled = 0;
    const handler = () => handled++;
    process.on('SIGINT', handler);
    try {
      interruptSelf('win32');
    } finally {
      process.off('SIGINT', handler);
    }
    assert.equal(handled, 1);
  });
});

// ---- the real thing, on Windows -------------------------------------------------------------

describe('Starting real .cmd files', { skip: !WINDOWS && 'cmd.exe is Windows only' }, () => {
  let scratch: string;
  let shim: string;
  before(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-cmd-'));
    // What npm writes for a package's bin: a batch file that passes its words on as %*.
    writeFileSync(path.join(scratch, 'show.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    shim = path.join(scratch, 'show tool.cmd');
    writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0show.js" %*\r\n`);
  });
  after(() => removeScratch(scratch));

  const run = (command: string, args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = runProgram(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk));
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, out }));
    });

  it('gives the program each word as it was, whatever it holds', async () => {
    const words = NASTY.filter((word) => /^[\x20-\x7e]*$/.test(word)); // the command line's code page isn't what this tests
    for (let i = 0; i < words.length; i += 4) {
      const some = words.slice(i, i + 4);
      const { code, out } = await run(shim, some);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(out), some);
    }
  });

  it('runs nothing a word says to run', async () => {
    const marker = path.join(scratch, 'pwned.txt');
    const { out } = await run(shim, [`x" & echo PWNED > "${marker}" & "y`, `a & echo PWNED > ${marker}`, `%COMSPEC%`, `^&`]);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(JSON.parse(out), [`x" & echo PWNED > "${marker}" & "y`, `a & echo PWNED > ${marker}`, '%COMSPEC%', '^&']);
  });

  it('finds a program by its name on the PATH, as npm is npm.cmd', async () => {
    const stdout = await new Promise<string>((resolve, reject) => execProgram('npm', ['--version'], {}, (error, text) => (error ? reject(error) : resolve(text))));
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});
