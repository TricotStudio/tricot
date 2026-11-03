import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { findRefs, readRef, refLabel, rehypeRefs, splitRefs, type KnownRef } from '../src/core/refs';

// A board with decisions #3 and #32, and tasks T5 and T35.
const known: KnownRef = (kind, number) => (kind === 'decision' ? [3, 32] : [5, 35]).includes(number);
const labels = (text: string) => findRefs(text, known).map(refLabel);

// Markdown as the UI renders it, with references marked up.
const render = (markdown: string) =>
  renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [[rehypeRefs, { known }]] }, markdown));
const chip = (kind: string, n: number) => `<a data-ref="${kind}:${n}">${kind === 'decision' ? '#' : 'T'}${n}</a>`;

describe('Card references', () => {
  it('finds the decisions and tasks the board has, and leaves other numbers alone', () => {
    assert.deepEqual(labels('Posted as #32; T35 builds on #3, unlike #99 and T42.'), ['#32', 'T35', '#3']);
    assert.deepEqual(findRefs('see T5', known), [{ kind: 'task', number: 5, start: 4, end: 6 }]);
    assert.deepEqual(labels('#0, #03 and T05 are no cards'), []);
  });

  it('takes references at word edges and in punctuation', () => {
    assert.deepEqual(labels('(#3), [T5], "#32", T35\'s plan, #3/#32, T5-T35, #3: done. **#32**'), [
      '#3', 'T5', '#32', 'T35', '#3', '#32', 'T5', 'T35', '#3', '#32',
    ]);
    assert.deepEqual(labels('#3\nT5'), ['#3', 'T5']);
  });

  it('skips references mid-word or inside a longer token', () => {
    assert.deepEqual(labels('AT3 AT5 issue#3 T5a #32px #3a #1a1a18 &#32; ##3 t5 T3_x'), []);
    assert.deepEqual(labels('version #3.5 and T5,5'), []);
    // clip() may have cut T35 down to T3…
    assert.deepEqual(labels('done in T3…'), []);
  });

  it('takes #T5 as task T5, written with a hash, and keeps #3 a decision', () => {
    assert.deepEqual(findRefs('see #T5', known), [{ kind: 'task', number: 5, start: 4, end: 7 }]);
    assert.deepEqual(labels('#T5, T5 and #3; (#T35) "#T5" #T35\'s plan #T5/#3 **#T35**'), [
      'T5', 'T5', '#3', 'T35', 'T5', 'T35', 'T5', '#3', 'T35',
    ]);
    assert.deepEqual(labels('Fixed in #T5.\n#T35 next'), ['T5', 'T35']);
    // The same rules as T5: not mid-word, not a longer token, not a decimal, not clipped.
    assert.deepEqual(labels('issue#T5 A#T5 &#T5 ##T5 #T5a #T5px #T35_x #T05 #T 5 #TT5'), []);
    assert.deepEqual(labels('version #T3.5 and #T5,5, done in #T3…'), []);
    // Upper case only, as T5 is: t5 and #t5 stay text.
    assert.deepEqual(labels('#t5 and #t35'), []);
    assert.deepEqual(labels('#T99 is no card'), []);
  });

  it('cuts a text into plain runs and references', () => {
    assert.deepEqual(splitRefs('#3 then T5.', known), [
      { kind: 'decision', number: 3, start: 0, end: 2 },
      ' then ',
      { kind: 'task', number: 5, start: 8, end: 10 },
      '.',
    ]);
    assert.deepEqual(splitRefs('nothing here #99', known), ['nothing here #99']);
    assert.deepEqual(splitRefs('per #T5', known), ['per ', { kind: 'task', number: 5, start: 4, end: 7 }]);
  });

  it('links references in rendered Markdown, in emphasis, lists and headings', () => {
    assert.equal(render('I posted it as **#32**.'), `<p>I posted it as <strong>${chip('decision', 32)}</strong>.</p>`);
    assert.equal(
      render('- T5 first\n- then #3'),
      `<ul>\n<li>${chip('task', 5)} first</li>\n<li>then ${chip('decision', 3)}</li>\n</ul>`,
    );
    assert.equal(render('## Plan for T35'), `<h2>Plan for ${chip('task', 35)}</h2>`);
    // A # that starts a line is still a heading, and #3 without a space is text.
    assert.equal(render('# Title\n\n#3 is decided'), `<h1>Title</h1>\n<p>${chip('decision', 3)} is decided</p>`);
  });

  it('links #T5 to task 5, keeping the words as written', () => {
    assert.equal(render('Fixed in #T5, with T5.'), `<p>Fixed in <a data-ref="task:5">#T5</a>, with ${chip('task', 5)}.</p>`);
    assert.equal(render('#T35 first'), '<p><a data-ref="task:35">#T35</a> first</p>');
    assert.equal(render('`#T5` and [#T5](https://example.com)'), '<p><code>#T5</code> and <a href="https://example.com">#T5</a></p>');
  });

  it('leaves code, existing links and unknown numbers as written', () => {
    assert.equal(
      render('The colour `#1a1a18` and `#3`, not #3'),
      `<p>The colour <code>#1a1a18</code> and <code>#3</code>, not ${chip('decision', 3)}</p>`,
    );
    assert.equal(render('```\nT5 #32\n```'), '<pre><code>T5 #32\n</code></pre>');
    assert.equal(
      render('[see #3](https://example.com) and <https://example.com/#32>'),
      '<p><a href="https://example.com">see #3</a> and <a href="https://example.com/#32">https://example.com/#32</a></p>',
    );
    assert.equal(render('#99 and T42 are not on the board'), '<p>#99 and T42 are not on the board</p>');
  });

  it('reads a marked-up reference back', () => {
    assert.deepEqual(readRef('task:35'), { kind: 'task', number: 35 });
    assert.equal(readRef('task:x'), null);
    assert.equal(readRef(undefined), null);
  });
});
