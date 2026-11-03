import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CodeError,
  MAX_CODE,
  codeBlockSize,
  codeDigest,
  codeFields,
  codeLanguage,
  codeLineAt,
  codeLineOf,
  codeLines,
  codeSegments,
  findCodeLine,
  languageByPath,
  languageNamed,
  linesText,
  looksBinary,
  readRanges,
  samePath,
  shownText,
} from '../src/core/blocks/code/code';
import { languageOf } from '../src/web/canvas/highlight';

const file = (n: number, line = (i: number) => `const line${i} = ${i};`) => Array.from({ length: n }, (_, i) => line(i + 1)).join('\n') + '\n';

describe('Code blocks: languages', () => {
  it('detects the language from the extension or the file name, and reads names agents give', () => {
    assert.equal(languageByPath('src/core/store.ts')?.name, 'TypeScript');
    assert.equal(languageByPath('App.TSX')?.name, 'TypeScript');
    assert.equal(languageByPath('scripts/demo.mjs')?.name, 'JavaScript');
    assert.equal(languageByPath('main.py')?.name, 'Python');
    assert.equal(languageByPath('docker/Dockerfile')?.name, 'Dockerfile');
    assert.equal(languageByPath('README.md')?.name, 'Markdown');
    assert.equal(languageByPath('.bashrc'), undefined); // a dotfile has no extension
    assert.equal(languageByPath('LICENSE'), undefined);
    assert.equal(languageNamed('typescript')?.name, 'TypeScript');
    assert.equal(languageNamed('ts')?.name, 'TypeScript');
    assert.equal(languageNamed('golang')?.name, 'Go');
    // Given wins over the path; one it doesn't know is kept as given.
    assert.equal(codeLanguage({ path: 'notes.txt', language: 'Python' })?.name, 'Python');
    assert.equal(codeLanguage({ path: 'x', language: 'Elixir' })?.name, 'Elixir');
    assert.equal(codeLanguage({ path: 'x' }), undefined);
  });

  it('colours code as diffs do, by the same table', () => {
    for (const [path, colour] of [['a.ts', 'js'], ['a.jsx', 'js'], ['a.json', 'json'], ['a.less', 'scss'], ['a.svg', 'html'], ['a.rs', 'rust'], ['a.zsh', 'shell']]) {
      assert.equal(languageByPath(path)?.colour, colour, path);
      assert.ok(languageOf(path), path);
    }
    assert.equal(languageOf('README.md'), null); // named, not coloured
    assert.equal(languageOf('Makefile'), null);
  });
});

describe('Code blocks: what they hold', () => {
  it('refuses binary and oversize text, and empty text', () => {
    assert.throws(() => codeFields({ path: 'a.bin', text: 'PK\u0003\u0004\u0000\u0000 data' }), /looks like a binary file/);
    assert.ok(looksBinary('\u0001\u0002\u0003\u0004\u0005 abc'));
    assert.ok(!looksBinary('tabs\tand\r\nnewlines and \u001b[31m colours'));
    const big = 'x'.repeat(MAX_CODE) + '\n';
    assert.throws(() => codeFields({ path: 'big.txt', text: big }), (error: Error) => error instanceof CodeError && /1\.0 MB; a code block holds at most 1 MB/.test(error.message));
    // Exactly 1 MB is fine; multibyte characters count as their bytes.
    assert.doesNotThrow(() => codeFields({ path: 'ok.txt', text: 'x'.repeat(MAX_CODE) }));
    assert.throws(() => codeFields({ path: 'e.txt', text: 'é'.repeat(MAX_CODE / 2 + 1) }), /at most 1 MB/);
    assert.throws(() => codeFields({ path: 'e.txt', text: '  \n ' }), /is empty/);
    assert.throws(() => codeFields({ path: 'a\nb', text: 'x' }), /A path is one line/);
  });

  it('numbers an excerpt from start, out of total, and checks its highlight against it', () => {
    const text = file(12);
    const code = codeFields({ path: 'src/server/connectors/oauth.ts', text, start: 120, total: 268, highlight: '123-130', commit: '0be1135' });
    assert.deepEqual(code, { path: 'src/server/connectors/oauth.ts', text, start: 120, total: 268, highlight: [[123, 130]], commit: '0be1135' });
    assert.equal(linesText(code), 'lines 120–131 of 268');
    assert.equal(codeLineAt(code, 120), 'const line1 = 1;');
    assert.equal(codeLineAt(code, 131), 'const line12 = 12;');
    assert.equal(codeLineAt(code, 132), undefined);
    assert.equal(codeLineAt(code, 119), undefined);
    assert.throws(() => codeFields({ path: 'x.ts', text, start: 120, highlight: [[10, 12]] }), /highlight 10–12 is outside the lines of text, which are numbered 120–131 \(from start\)/);
    assert.throws(() => codeFields({ path: 'x.ts', text, start: 120, total: 100 }), /total \(100\) is less than the number of the last line of text \(131\)/);
    assert.throws(() => codeFields({ path: 'x.ts', text, start: 0 }), /start is the line number/);
    // A whole file needs neither; an excerpt without total says so.
    assert.equal(linesText(codeFields({ path: 'x.ts', text })), '12 lines');
    assert.deepEqual(codeFields({ path: 'x.ts', text, total: 12 }), { path: 'x.ts', text });
    assert.equal(linesText(codeFields({ path: 'x.ts', text, start: 40 })), 'lines 40–51');
    assert.deepEqual(codeLines('a\r\nb\r\n'), ['a', 'b']);
  });

  it('reads highlight ranges in either form, joining those that touch', () => {
    assert.deepEqual(readRanges('123-130, 140'), [[123, 130], [140, 140]]);
    assert.deepEqual(readRanges('5–3'), [[3, 5]]);
    assert.deepEqual(readRanges([[123, 130], 140]), [[123, 130], [140, 140]]);
    assert.throws(() => readRanges('lines 3'), /highlight "lines 3" isn't a line or a range of lines/);
    assert.throws(() => readRanges([[1, 2, 3]]), /isn't a line or a range/);
    assert.deepEqual(codeFields({ path: 'x', text: file(20), highlight: [[3, 5], [6, 8], [12, 12]] }).highlight, [[3, 8], [12, 12]]);
  });

  it('keeps what a change leaves out, and drops highlighted lines past new text', () => {
    const before = codeFields({ path: 'x.ts', text: file(50), highlight: [[10, 12], [45, 48]], commit: 'abc1234' });
    const after = codeFields({ text: file(20) }, before);
    assert.deepEqual(after, { path: 'x.ts', text: file(20), highlight: [[10, 12]], commit: 'abc1234' });
    assert.deepEqual(codeFields({ highlight: [], commit: '', language: 'Go' }, before), { path: 'x.ts', text: file(50), language: 'Go' });
    assert.throws(() => codeFields({ commit: 'not a hash!' }, before), /commit is the commit the text is from/);
  });
});

describe('Code blocks: how they show and pin', () => {
  it('shows a long file folded to its highlight with a few lines around, or its first lines', () => {
    const code = codeFields({ path: 'oauth.ts', text: file(268), highlight: [[123, 130]] });
    const segments = codeSegments(code);
    assert.deepEqual(segments, [
      { kind: 'fold', from: 1, to: 119 },
      { kind: 'lines', from: 120, to: 133 },
      { kind: 'fold', from: 134, to: 268 },
    ]);
    assert.equal(shownText(code, segments), 'lines 120–133 of 268');
    // A pinned line further down shows too; a person opens a fold, or all of it.
    assert.deepEqual(
      codeSegments(code, { keep: [200] }).map((s) => `${s.kind} ${s.from}-${s.to}`),
      ['fold 1-119', 'lines 120-133', 'fold 134-198', 'lines 199-201', 'fold 202-268'],
    );
    assert.deepEqual(codeSegments(code, { opened: [[1, 119]] }).map((s) => `${s.kind} ${s.from}-${s.to}`), ['lines 1-133', 'fold 134-268']);
    assert.deepEqual(codeSegments(code, { all: true }), [{ kind: 'lines', from: 1, to: 268 }]);
    assert.equal(shownText(code, codeSegments(code, { all: true })), '268 lines');
    // Nothing highlighted: the first 40 lines.
    const plain = codeFields({ path: 'store.ts', text: file(2537) });
    assert.deepEqual(codeSegments(plain), [
      { kind: 'lines', from: 1, to: 40 },
      { kind: 'fold', from: 41, to: 2537 },
    ]);
    // A short file shows whole.
    assert.deepEqual(codeSegments(codeFields({ path: 'a.ts', text: file(60), highlight: [[30, 30]] })), [{ kind: 'lines', from: 1, to: 60 }]);
    // Sized to what it shows first.
    const size = codeBlockSize(code);
    assert.ok(size.h > 250 && size.h < 400, `${size.h}`);
    assert.equal(codeBlockSize(codeFields({ path: 'a', text: 'x' })).h, 120);
  });

  it('finds a pinned line again by its text, nearest where it was', () => {
    const text = ['a();', 'b();', 'a();', 'c();'].join('\n');
    const code = { text, start: 10 };
    assert.equal(findCodeLine(code, 12, 'a();'), 12);
    assert.equal(findCodeLine(code, 10, 'a();'), 10);
    assert.equal(findCodeLine({ text: `x();\n${text}`, start: 10 }, 10, 'a();'), 11); // moved down a line
    assert.equal(findCodeLine(code, 11, 'gone();'), null);
    assert.equal(codeLineOf(code, 'a()'), 10);
    assert.equal(codeLineOf(code, 'a()', 2), 12);
    assert.equal(codeLineOf(code, 'a()', 3), null);
    assert.ok(samePath('src/core/store.ts', 'store.ts'));
    assert.ok(samePath('store.ts', './src/core/store.ts'));
    assert.ok(samePath('', 'anything.ts'));
    assert.ok(!samePath('src/core/store.ts', 'src/core/pins.ts'));
  });

  it('describes itself to agents compactly, and in full with its text', () => {
    const code = codeFields({ path: 'src/server/connectors/oauth.ts', text: file(12), start: 120, total: 268, highlight: '123-130', commit: '0be1135' });
    assert.equal(
      codeDigest(code),
      ['src/server/connectors/oauth.ts · TypeScript · lines 120–131 of 268 · at 0be1135', 'Highlighted: lines 123–130.', '(get_block for the text)'].join('\n'),
    );
    const full = codeDigest(code, true);
    assert.match(full, /Text \(its first line is line 120\):\n```ts\nconst line1 = 1;\n/);
    assert.ok(full.endsWith('const line12 = 12;\n```'));
  });
});
