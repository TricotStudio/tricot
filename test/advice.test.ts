import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decisionAdvice, duplicateAdvice, peopleTextAdvice, replacedImageNotice, similarTitles, titleWords } from '../src/core/advice';
import type { Actor, Block } from '../src/core/types';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const planner: Actor = { kind: 'agent', name: 'Planner' };
const sam: Actor = { kind: 'human', name: 'Sam' };

let next = 0;
function image(title: string | undefined, author: Actor): Block {
  const at = '2026-10-30T00:00:00.000Z';
  return { id: `b${++next}`, rev: 1, type: 'image', assetId: 'x.png', title, x: 0, y: 0, w: 1, h: 1, author, createdAt: at, updatedBy: author, updatedAt: at };
}

describe('Advice', () => {
  it('reads a title as its words, without punctuation or version words', () => {
    assert.deepEqual([...titleWords('Connect screen (mock, v2) — FINAL draft')], ['connect', 'screen']);
    assert.deepEqual([...titleWords('Revised: Plan v10 copy')], ['plan']);
    assert.deepEqual([...titleWords('Step 2')], ['step', '2'], 'plain numbers say which, not which version');
  });

  it('matches titles that name the same thing', () => {
    const same: [string, string][] = [
      ['Connect screen (mock)', 'Connect screen v2'],
      ['Connect screen', 'Updated connect screen, dark mode'], // contains
      ['Retry flow for API calls', 'Retry flow for API requests'], // 4 of 6 words: Jaccard 0.67
      ['Latest: Signup form', 'signup-form'],
    ];
    for (const [a, b] of same) assert.ok(similarTitles(a, b), `"${a}" ~ "${b}"`);
    const different: [string, string][] = [
      ['Connect screen', 'Settings screen'],
      ['Option A layout', 'Option B layout'],
      ['Mock', 'Mock v2'], // nothing left once version words go
      ['Retry flow', 'Error states'],
      ['Retry flow for jobs', 'Retry flow for the API'], // 3 of 6 words: Jaccard 0.5
    ];
    for (const [a, b] of different) assert.ok(!similarTitles(a, b), `"${a}" !~ "${b}"`);
  });

  it("points an agent at its own earlier version of a block, not people's", () => {
    const mine = image('Connect screen (mock)', claude);
    const theirs = image('Connect screen', sam);
    const others = image('Connect screen', planner);
    const added = image('Connect screen v2', claude);
    const advice = duplicateAdvice(added, [mine, theirs, others, added], claude);
    assert.deepEqual(advice, [
      `You already have image "Connect screen (mock)" [id: ${mine.id}] here. If this is a new version of it, update that block instead and remove this one with remove_item.`,
    ]);
    assert.deepEqual(duplicateAdvice(added, [theirs, others, added], claude), []);
    assert.deepEqual(duplicateAdvice(image(undefined, claude), [mine], claude), [], 'untitled blocks are skipped');
    const note: Block = { ...mine, id: 'n1', type: 'note', text: 'x' } as Block;
    assert.deepEqual(duplicateAdvice(added, [note, added], claude), [], 'only blocks of the same type');

    const two = duplicateAdvice(added, [mine, image('Connect screen v1', claude), added], claude);
    assert.match(two[0], /^You already have image "Connect screen v1" \[id: \w+\] and image "Connect screen \(mock\)" \[id: \w+\] here\. If this is a new version of one of them, update that one instead/);
  });

  it('asks for a look at boxes pinned on a replaced image', () => {
    assert.equal(replacedImageNotice(0), '');
    assert.equal(replacedImageNotice(1), '1 box is pinned on this image: check it still points at the right part.');
    assert.equal(replacedImageNotice(2), '2 boxes are pinned on this image: check they still point at the right parts.');
  });

  describe('writing to people', () => {
    const flags = (text: string) => peopleTextAdvice(text, 'note');

    it('says nothing about a plain, readable message', () => {
      assert.deepEqual(flags(''), []);
      assert.deepEqual(flags(undefined as unknown as string), []);
      assert.deepEqual(flags('Sam, the retry change is ready to review. I added a screenshot of the new settings page to its canvas.'), []);
    });

    it('nudges a note that opens with a label or a commit fragment', () => {
      for (const [text, opener] of [
        ['Built: images can be replaced in place.', 'Built:'],
        ['Done: the header search is now just the icon.', 'Done:'],
        ['**Ready for review:** the board switcher is in.', 'Ready for review:'],
        ['  Building: the map as its own component.', 'Building:'],
        ['Committed as `2b688fa`, with the map\'s Table / Map switch.', 'Committed as …'],
        ['Committed as 3f16e19, on its own, per your "commit them" on T90.', 'Committed as …'],
      ]) {
        const advice = flags(text);
        assert.equal(advice.length, 1, text);
        assert.match(advice[0], new RegExp(`^This note opens with a label \\("${opener}"\\)\\. Start with a sentence that says what it means for the person`), text);
      }
    });

    it('leaves alone a short reply, a label deeper in the text and a hash inside a sentence', () => {
      assert.deepEqual(flags('Done.'), [], 'a short answer to a direct question');
      assert.deepEqual(flags('Done, and it is on the canvas.'), []);
      assert.deepEqual(flags('Sam, that is done: the header search is now just the icon.'), []);
      assert.deepEqual(flags('The map shipped. Status: waiting on your review.'), [], 'only an opener counts');
      assert.deepEqual(flags('Built a first version. It is on the canvas.'), [], 'no colon, so a sentence');
      assert.deepEqual(flags('I committed it as 3f16e19, on its own, as you asked.'), []);
      assert.deepEqual(flags('Your last commit, 3f16e19, already has it.'), []);
      assert.deepEqual(flags('Committed it on its own, as you asked.'), []);
    });

    it('nudges a raw id, but not one in code', () => {
      const advice = flags('Posted it for you [id: 4kx9a2], have a look.');
      assert.equal(advice.length, 1);
      assert.match(advice[0], /shows a raw id \("\[id: 4kx9a2\]"\)/);
      assert.equal(flags('Started [thread id: 7j3drncx] for it.').length, 1);
      assert.deepEqual(flags('The tool answers with `[id: 4kx9a2]` at the end.'), []);
      assert.deepEqual(flags('Run this:\n```\nlink [id: 4kx9a2]\n```'), []);
      assert.deepEqual(flags('Card #12 and T5 are linked, and the id: field is optional.'), []);
    });

    it('nudges a test tally, but not other numbers or code', () => {
      for (const [text, quoted] of [
        ['It works. 462/462 tests pass.', '462/462'],
        ['Typecheck clean, 56/56 pass.', '56/56'],
        ['All 133 tests pass.', '133 tests pass'],
        ['Tests pass, 73/73.', '73/73'],
        ['Done in 3 files; 102 tests green.', '102 tests green'],
      ]) {
        const advice = flags(text);
        assert.equal(advice.length, 1, text);
        assert.match(advice[0], new RegExp(`quotes a test tally \\("${quoted}"\\)`), text);
      }
      assert.deepEqual(flags('The tests pass.'), []);
      assert.deepEqual(flags('I added 12 tests for the parser, and they cover the retry path.'), []);
      assert.deepEqual(flags('You can answer on 10/30 or 11/02.'), [], 'dates');
      assert.deepEqual(flags('Open src/core/12/12 for it, or rate it 10/10.'), [], 'paths and ratings');
      assert.deepEqual(flags('The last line of the run is `462/462 tests pass`.'), [], 'quoted code');
    });

    it('nudges one long paragraph, not a long message with breaks', () => {
      const sentence = 'The retry change touches every call site, so it needs a decision first. ';
      const wall = sentence.repeat(12).trim();
      const advice = flags(wall);
      assert.equal(advice.length, 1);
      assert.match(advice[0], /has a paragraph of 156 words with no line break/);
      assert.deepEqual(flags(`${sentence.repeat(6).trim()}\n\n${sentence.repeat(6).trim()}`), []);
      assert.deepEqual(flags(sentence.repeat(6).trim()), [], 'a paragraph of ordinary length');
      assert.deepEqual(flags(`Here is the patch:\n\`\`\`\n${sentence.repeat(14)}\n\`\`\``), [], 'code is not prose');
    });

    it('nudges praise at the start, not agreement in the middle', () => {
      assert.equal(flags("Great question! Retries don't help here.").length, 1);
      assert.equal(flags("You're absolutely right, that was wrong.").length, 1);
      assert.deepEqual(flags('Good call. Cards mark new things today.'), []);
      assert.deepEqual(flags("You're right, the shots were on #6's canvas."), []);
      assert.deepEqual(flags('That is a great question to put to Legal, so I asked.'), []);
    });

    it('words every nudge as a colleague would, and never says humans', () => {
      const all = [
        ...flags('Built: it is done [id: abc123]. 462/462 tests pass.\n' + 'word '.repeat(140)),
        ...flags('Great question! It is done.'),
      ];
      assert.equal(all.length, 5);
      for (const line of all) {
        assert.match(line, /^This note /);
        assert.doesNotMatch(line, /humans?\b|—/i);
      }
    });

    it('runs on a decision card\'s context', () => {
      const advice = decisionAdvice({ context: 'Built: the retry change. 90/90 tests pass.', options: [{ label: 'A' }, { label: 'B' }], recommend: 'a' });
      assert.equal(advice.length, 2);
      assert.match(advice[0], /^This context opens with a label/);
      assert.match(advice[1], /^This context quotes a test tally/);
    });
  });
});
