import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openCommand } from '../src/platform/openUrl';
import { batchArgument, batchCommandLine } from '../src/platform/run';

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
  it('refuses a word with a line break or NUL, which cmd.exe cannot be given in any quoting', () => {
    for (const word of ['a\nb', 'a\rb', 'a\0b']) assert.throws(() => batchArgument(word), /line break/);
    assert.throws(() => batchCommandLine('C:\\x.cmd', ['ok', 'a\nb']), /line break/);
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
});

describe('Opening the browser', () => {
  it("opens nothing on Windows that isn't a web address: the call would run a file", () => {
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\System32\\calc.exe', 'javascript:alert(1)', 'ms-settings:network', '', 'not a url']) {
      assert.equal(openCommand(url, {}, 'win32'), undefined, url);
    }
  });
});
