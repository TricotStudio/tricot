import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { canvasDigest } from '../src/core/digest';
import {
  DiffError,
  diffDigest,
  findLine,
  focusFirst,
  hunkRows,
  initiallyOpen,
  isGenerated,
  listedFirst,
  matchFocus,
  parsePatch,
  readPatch,
  splitRows,
  type DiffFile,
} from '../src/core/blocks/diff/diff';
import { placePin } from '../src/core/pins';
import { Store } from '../src/core/store';
import type { Actor, Block } from '../src/core/types';
import { highlightLine, languageOf } from '../src/web/canvas/highlight';
import { eventsOf, versionsOf } from './tables';

// Real git output (git diff -M), with: a binary file, an added file, a
// deleted file, a file with three hunks, a renamed file with a change, and a
// file that loses its final newline.
const PATCH = String.raw`diff --git a/logo.png b/logo.png
index 86b57cf..d048457 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..68dcbfc
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,4 @@
+export const added = 'yes';
+export function twice(n: number) {
+  return n * 2;
+}
diff --git a/src/gone.py b/src/gone.py
deleted file mode 100644
index e9c6243..0000000
--- a/src/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-def gone():
-    return None
diff --git a/src/many.ts b/src/many.ts
index 8b2034d..dad624c 100644
--- a/src/many.ts
+++ b/src/many.ts
@@ -2,7 +2,7 @@ line 1
 line 2
 line 3
 line 4
-line 5
+line five
 line 6
 line 7
 line 8
@@ -28,6 +28,7 @@ line 27
 line 28
 line 29
 line 30
+line 30b
 line 31
 line 32
 line 33
@@ -52,7 +53,6 @@ line 51
 line 52
 line 53
 line 54
-line 55
 line 56
 line 57
 line 58
diff --git a/src/old-name.js b/src/new-name.js
similarity index 94%
rename from src/old-name.js
rename to src/new-name.js
index 31ec2b5..b2378b8 100644
--- a/src/old-name.js
+++ b/src/new-name.js
@@ -7,7 +7,7 @@ const value6 = 6;
 const value7 = 7;
 const value8 = 8;
 const value9 = 9;
-const value10 = 10;
+const value10 = 100;
 const value11 = 11;
 const value12 = 12;
 const value13 = 13;
diff --git a/src/tail.txt b/src/tail.txt
index a763886..3db2aff 100644
--- a/src/tail.txt
+++ b/src/tail.txt
@@ -1,2 +1,2 @@
 first
-last
+last
\ No newline at end of file
`;

const agent: Actor = { kind: 'agent', name: 'Claude' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };

const byPath = (files: DiffFile[], file: string) => files.find((f) => f.path === file)!;

// A patch of one new file with `n` lines, `size` characters each.
function newFile(file: string, n: number, size = 40): string {
  const body = Array.from({ length: n }, (_, i) => `+${String(i).padEnd(size, 'x')}`).join('\n');
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${n} @@\n${body}\n`;
}

describe('Reading a patch', () => {
  it('reads git output: added, deleted, renamed and binary files, and several hunks', () => {
    const { files } = parsePatch(PATCH);
    assert.deepEqual(
      files.map((f) => [f.status, f.path, f.oldPath, f.additions, f.deletions, f.hunks.length]),
      [
        ['binary', 'logo.png', undefined, 0, 0, 0],
        ['added', 'src/added.ts', undefined, 4, 0, 1],
        ['deleted', 'src/gone.py', undefined, 0, 2, 1],
        ['modified', 'src/many.ts', undefined, 2, 2, 3],
        ['renamed', 'src/new-name.js', 'src/old-name.js', 1, 1, 1],
        ['modified', 'src/tail.txt', undefined, 1, 1, 1],
      ],
    );
    // Each line has its numbers on either side.
    const [first, second, third] = byPath(files, 'src/many.ts').hunks.map(hunkRows);
    assert.deepEqual(first[2], { kind: 'context', text: 'line 4', old: 4, new: 4 });
    assert.deepEqual(first[3], { kind: 'del', text: 'line 5', old: 5 });
    assert.deepEqual(first[4], { kind: 'add', text: 'line five', new: 5 });
    assert.deepEqual(second.find((r) => r.kind === 'add'), { kind: 'add', text: 'line 30b', new: 31 });
    assert.deepEqual(third.find((r) => r.kind === 'del'), { kind: 'del', text: 'line 55', old: 55 });
    assert.equal(third.at(-1)!.new, 58);
    assert.equal(byPath(files, 'src/many.ts').hunks[0].header, '@@ -2,7 +2,7 @@ line 1');
  });

  it('keeps "\\ No newline at end of file" with the line it is about', () => {
    const tail = byPath(parsePatch(PATCH).files, 'src/tail.txt');
    assert.deepEqual(tail.hunks[0].lines, [' first', '-last', '+last', '\\ No newline at end of file']);
    assert.deepEqual(hunkRows(tail.hunks[0]).at(-1), { kind: 'note', text: 'No newline at end of file' });
    // Side by side, the removed line and the added one face each other; the note follows the added one.
    assert.deepEqual(
      splitRows(hunkRows(tail.hunks[0])).map(({ left, right }) => [left?.kind, right?.kind]),
      [
        ['context', 'context'],
        ['del', 'add'],
        [undefined, 'note'],
      ],
    );
  });

  it('reads a CRLF patch the same, and skips what git show prints before the files', () => {
    const plain = parsePatch(PATCH).files;
    assert.deepEqual(parsePatch(PATCH.replace(/\n/g, '\r\n')).files, plain);
    const shown = `commit 0be1135\nAuthor: Wassim <w@example.com>\nDate:   Thu Oct 29 2026\n\n    Connectors, starting with Google\n\n ${'src/a.ts | 2 +-'}\n\n${PATCH}`;
    assert.deepEqual(parsePatch(shown).files, plain);
  });

  it('reads plain diff -u output too', () => {
    const plain = '--- notes.txt\t2026-10-30 10:00:00\n+++ notes.txt\t2026-10-30 10:05:00\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
    const [file] = parsePatch(plain).files;
    assert.deepEqual([file.path, file.status, file.additions, file.deletions], ['notes.txt', 'modified', 1, 1]);
  });

  it('refuses anything that is not a unified diff, saying why', () => {
    const refused = (patch: string) => {
      try {
        parsePatch(patch);
      } catch (error) {
        assert.ok(error instanceof DiffError);
        return error.message;
      }
      assert.fail('it was read');
    };
    assert.match(refused('   \n'), /The patch is empty/);
    assert.match(refused('Fixed the retry loop and added a test.'), /isn't a unified diff: it has no "diff --git" or "---"\/"\+\+\+" file headers/);
    assert.match(refused(' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n'), /isn't a unified diff/);
    // Cut off in the middle of a hunk.
    const cut = PATCH.slice(0, PATCH.indexOf(' line 6\n'));
    assert.match(refused(cut), /Hunk 1 of src\/many\.ts \(line \d+ of the patch\) ends early/);
    assert.match(refused('--- a/x\n+++ b/x\n@@ -1 +1 @@ \n-a\n+b\n+c\n'), /Hunk 1 of x \(line 3 of the patch\) has more lines than its header says: line 6 \("\+c"\)/);
    assert.match(refused('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ \n-a\n+b\nnot a diff line\n'), /Hunk 1 of x \(line 3 of the patch\) ends early: line 6 \("not a diff line"\) isn't part of it/);
    assert.match(refused('--- a/x\n+++ b/x\n@@ one @@\n'), /Line 3 of the patch isn't a hunk header/);
    assert.match(refused('diff --cc a.ts\n@@@ -1,1 -1,1 +1,1 @@@\n'), /combined diff, from a merge commit/);
  });

  it('keeps a big patch within the cap: the biggest files lose their changes, keep their counts', () => {
    const patch = newFile('src/small.ts', 10) + newFile('package-lock.json', 400) + newFile('src/big.ts', 200);
    const { files, patch: kept } = readPatch(patch, 12_000);
    assert.deepEqual(
      files.map((f) => [f.path, f.additions, f.hunks.length, f.omitted]),
      [
        ['src/small.ts', 10, 1, undefined],
        ['package-lock.json', 400, 0, true],
        ['src/big.ts', 200, 1, undefined],
      ],
    );
    assert.ok(kept.length <= 12_000, `kept ${kept.length}`);
    assert.match(kept, /diff --git a\/package-lock\.json b\/package-lock\.json\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/package-lock\.json\ndiff --git a\/src\/big\.ts/);
    // What's kept is itself a patch.
    assert.deepEqual(parsePatch(kept).files.map((f) => f.path), ['src/small.ts', 'package-lock.json', 'src/big.ts']);
    assert.equal(readPatch(patch).patch, patch); // under the cap, kept as sent
    assert.match(diffDigest({ patch: kept, files }), /The changes in 1 of the biggest files were left out to fit/);
  });

  it('starts generated files folded, and opens focus files, then the first few small ones', () => {
    for (const file of ['package-lock.json', 'web/yarn.lock', 'Cargo.lock', 'dist/app.js', 'vendor/lib.min.js', 'app.js.map', 'test/__snapshots__/a.snap', 'go.sum']) {
      assert.ok(isGenerated(file), file);
    }
    for (const file of ['src/lock.ts', 'distance.ts', 'src/map.ts', 'README.md']) assert.ok(!isGenerated(file), file);
    const patch = newFile('package-lock.json', 5) + newFile('src/a.ts', 5) + newFile('src/huge.ts', 400) + newFile('src/b.ts', 5) + newFile('src/c.ts', 5) + newFile('src/d.ts', 5);
    const { files } = parsePatch(patch);
    assert.deepEqual([...initiallyOpen(files)], ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.deepEqual([...initiallyOpen(files, ['src/huge.ts'])], ['src/huge.ts', 'src/a.ts', 'src/b.ts']);
    assert.deepEqual(matchFocus(files, ['huge.ts', 'b/src/d.ts', 'nope.ts']), { paths: ['src/huge.ts', 'src/d.ts'], unmatched: ['nope.ts'] });
    assert.deepEqual(focusFirst(files, ['src/d.ts', 'src/huge.ts']).map((f) => f.path), ['src/d.ts', 'src/huge.ts', 'package-lock.json', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
    // The list shows the files to keep and the first others, up to its limit.
    assert.deepEqual(listedFirst(files, new Set(['src/d.ts']), 3).map((f) => f.path), ['package-lock.json', 'src/a.ts', 'src/d.ts']);
  });

  it('finds a pinned line again by its text, nearest where it was', () => {
    const before = parsePatch(PATCH).files;
    assert.deepEqual(findLine(before, 'src/many.ts', 'new', 31, 'line 30b'), { file: 'src/many.ts', line: 31 });
    const moved = parsePatch(PATCH.replace('@@ -28,6 +28,7 @@ line 27', '@@ -28,6 +30,7 @@ line 27')).files;
    assert.deepEqual(findLine(moved, 'src/many.ts', 'new', 31, 'line 30b'), { file: 'src/many.ts', line: 33 });
    assert.deepEqual(findLine(before, 'src/old-name.js', 'old', 10, 'const value10 = 10;'), { file: 'src/new-name.js', line: 10 });
    assert.equal(findLine(before, 'src/many.ts', 'new', 31, 'line 30c'), null);
    assert.equal(findLine(before, 'src/other.ts', 'new', 31, 'line 30b'), null);
  });
});

describe('Colouring code', () => {
  it('never changes the text, whatever it is', () => {
    const lines = [
      "const tmp = `${file}.${process.pid}.tmp`; // atomic",
      'if (!file.endsWith(\'.json\') || !looksLikeBoard(file)) continue;',
      '  "unterminated string \\',
      '/* opens a comment',
      'x = 0o700 + 0x1F + 1_000n + 3.5e-2',
      '<div class="a">&amp; <b>bold</b></div>',
      '\t  \ttabs and spaces  ',
      "fn main<'a>(s: &'a str) -> char { 'x' }",
      'echo "$HOME" # a comment; ${#arr[@]}',
      '',
    ];
    for (const file of ['a.ts', 'a.json', 'a.css', 'a.html', 'a.py', 'a.go', 'a.rs', 'a.sh', 'a.unknown', 'Makefile']) {
      const state = { inComment: false };
      for (const line of lines) {
        const tokens = highlightLine(line, languageOf(file), state);
        assert.equal(tokens.map((t) => t.text).join(''), line, `${file}: ${line}`);
      }
    }
  });

  it('marks keywords, strings, numbers and comments', () => {
    const kinds = (line: string, file: string) =>
      highlightLine(line, languageOf(file))
        .filter((t) => t.kind)
        .map((t) => `${t.kind}:${t.text}`);
    assert.deepEqual(kinds("mkdirSync(dir, { recursive: true, mode: 0o700 }); // safe", 'oauth.ts'), ['kw:true', 'num:0o700', 'com:// safe']);
    assert.deepEqual(kinds("const tmp = `${file}.tmp`;", 'oauth.ts'), ['kw:const', 'str:`${file}.tmp`']);
    assert.deepEqual(kinds('def gone():  # bye', 'gone.py'), ['kw:def', 'com:# bye']);
    assert.deepEqual(kinds('.block { margin: 12px; color: #fff; }', 'a.css'), ['num:12px', 'num:#fff']);
    assert.deepEqual(kinds('<span class="x">', 'a.html'), ['kw:span', 'str:"x"']);
    assert.deepEqual(kinds('const x = 1;', 'README.md'), []);
    // A block comment carries on to the next line.
    const state = { inComment: false };
    highlightLine('/* starts here', languageOf('a.ts'), state);
    assert.deepEqual(highlightLine('still in it */ const y', languageOf('a.ts'), state).map((t) => t.kind), ['com', undefined, 'kw', undefined]);
  });
});

describe('Diff blocks', () => {
  let dir: string;
  let store: Store;
  let taskId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-diff-'));
    store = new Store(dir);
    store.load();
    const board = store.createBoard({ title: 'Connectors' }, wassim);
    taskId = store.planTasks(board.id, [{ title: 'Google connector' }], agent, { ready: true })[0].id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const diffOf = (block: Block) => block as Extract<Block, { type: 'diff' }>;

  it('keeps each patch it replaces as a version, and brings one back', () => {
    const block = store.addBlock({ taskId }, { content: { type: 'diff', patch: PATCH, focus: ['many.ts'] }, title: 'Retry work' }, agent);
    assert.deepEqual(diffOf(block).focus, ['src/many.ts']);
    assert.equal(diffOf(block).files.length, 6);

    const next = PATCH.replace('+line five', '+line 5, reworded');
    const updated = diffOf(store.updateBlock(block.id, { patch: next }, agent, block.rev));
    assert.equal(updated.rev, 2);
    assert.equal(updated.patch, next);
    assert.deepEqual(updated.focus, ['src/many.ts']); // kept, as the new patch still has it
    assert.equal(updated.versionCount, 1);
    const [earlier] = versionsOf(store, block.id);
    assert.equal(earlier.type, 'diff');
    assert.equal((earlier as { patch: string }).patch, PATCH);

    const { board } = store.canvasOf(block.id);
    assert.match(eventsOf(store, board).at(-1)!.summary, /updated diff "Retry work" on the canvas of T1 "Google connector": replaced the patch: now 6 files, \+8 −6/);

    const restored = diffOf(store.restoreBlock(block.id, 1, wassim, updated.rev));
    assert.equal(restored.patch, PATCH);
    assert.deepEqual(restored.files, diffOf(block).files);
    assert.deepEqual(versionsOf(store, block.id).map((v) => (v as { patch: string }).patch), [PATCH, next]);

    assert.throws(() => store.updateBlock(block.id, { patch: 'not a diff' }, agent), /isn't a unified diff/);
    assert.throws(() => store.updateBlock(block.id, { text: 'hello' }, agent), /A diff block has no text/);
  });

  it('pins lines, shows them to agents with what was said, and reports them gone after an update', () => {
    const block = store.addBlock({ taskId }, { content: { type: 'diff', patch: PATCH } }, agent);
    const { pin, comment } = store.pinComment(block.id, { kind: 'line', file: 'many.ts', line: 31 }, 'Why the extra line?', wassim);
    assert.deepEqual(pin.anchor, { kind: 'line', file: 'src/many.ts', line: 31, side: 'new' });
    assert.equal(pin.quote, 'line 30b');
    assert.deepEqual(comment.pin, { id: pin.id, quote: 'src/many.ts:31 · “line 30b”' });
    store.addTaskComment(taskId, 'It keeps the retry count visible.', agent, comment.pin);
    const removed = store.pin(block.id, { kind: 'line', file: 'src/many.ts', line: 5, side: 'old' }, { taskId }, agent);
    assert.equal(removed.quote, 'line 5');

    // A line the patch doesn't show, or on the wrong side, is refused with what it does show.
    assert.throws(
      () => store.pin(block.id, { kind: 'line', file: 'src/many.ts', line: 40 }, { taskId }, agent),
      /src\/many\.ts has no new line 40 in diff of 6 files\. The patch shows its new lines 2–8, 28–34, 53–58\./,
    );
    assert.throws(() => store.pin(block.id, { kind: 'line', file: 'src/gone.py', line: 1 }, { taskId }, agent), /has an old one: pass side "old"/);
    assert.throws(() => store.pin(block.id, { kind: 'line', file: 'nope.ts', line: 1 }, { taskId }, agent), /has no file "nope\.ts"\. Its files: logo\.png/);

    const located = store.canvasOf(block.id);
    const digest = canvasDigest(located.board, located.canvas, undefined, located.task);
    assert.match(digest, /6 files, \+8 −6\.\n  - logo\.png \(binary\)\n  - src\/added\.ts \+4 −0 \(added\)/);
    assert.match(digest, /- src\/old-name\.js → src\/new-name\.js \+1 −1 \(renamed\)/);
    assert.doesNotMatch(digest, /line five/); // the patch itself is get_block's
    assert.match(
      digest,
      /\n  pinned line 31 of src\/many\.ts \("line 30b"\) → 2 comments in the discussion, quoting it \[pin id: \w+\]; answer on the line with comment\(pin_id\)\n    - Wassim \(human\) at [^:]+:[^:]+:[^ ]+: Why the extra line\?\n    - Claude \(agent\) at [^\n]+: It keeps the retry count visible\./,
    );
    assert.match(digest, /\n  pinned old line 5 of src\/many\.ts \("line 5"\) → T1 \(to do\)/);

    // The line goes from the patch: its pin is reported gone, and finds nothing.
    const next = PATCH.replace('+line 30b\n', '').replace('@@ -28,6 +28,7 @@', '@@ -28,6 +28,6 @@').replace('@@ -52,7 +53,6 @@', '@@ -52,7 +52,6 @@');
    store.updateBlock(block.id, { patch: next }, agent);
    assert.match(eventsOf(store, located.board).at(-1)!.summary, /line 31 of src\/many\.ts, commented on, is no longer there/);
    const after = store.canvasOf(block.id);
    assert.equal(placePin(after.canvas.blocks[0], pin), null);
    assert.ok(placePin(after.canvas.blocks[0], removed));
    assert.match(canvasDigest(after.board, after.canvas, undefined, after.task), /pinned line 31 of src\/many\.ts \("line 30b"\) \(no longer there\) → 2 comments/);
  });
});
