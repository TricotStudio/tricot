import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canvasDigest } from '../src/core/digest';
import { inlineText, noteText, placePin, quoteAt } from '../src/core/pins';
import { setTask, taskLines } from '../src/core/taskList';
import { Store } from '../src/core/store';
import type { Actor, Board, Pin } from '../src/core/types';
import { DRAFT, rehypePins, type QuotedMark } from '../src/web/canvas/marks';
import { Md, type MdProps } from '../src/web/markdown';
import { RefsProvider } from '../src/web/refs';

const sam: Actor = { kind: 'human', name: 'Sam' };
const agent: Actor = { kind: 'agent', name: 'planner' };

// A board with decision #3 and task T5, for the chips text links to them.
const board = {
  id: 'b1',
  decisions: [{ id: 'd3', number: 3, status: 'decided', question: 'Which provider?' }],
  tasks: [{ id: 't5', number: 5, status: 'todo', title: 'Wire up Stripe' }],
} as unknown as Board;

// Markdown as the board renders it; `inline` as a cell or a caption.
const md = (markdown: string, props: Omit<MdProps, 'children'> = {}) => createElement(Md, { ...props, children: markdown });
const html = (node: ReactNode) => renderToStaticMarkup(node);
const onBoard = (node: ReactNode) => html(createElement(RefsProvider, { board, children: node }));
const full = (markdown: string) => html(md(markdown));
const inline = (markdown: string) => html(md(markdown, { inline: true }));

// Text as it shows, as a person selects it: the markup's words, decoded.
const shown = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

// An item's or a note's words with pins marked, as the canvas draws them.
const marked = (markdown: string, marks: QuotedMark[], opts: { inline?: boolean; chips?: boolean } = {}) =>
  html(md(markdown, { inline: opts.inline, rehypePlugins: [[rehypePins, { marks, chips: opts.chips }]] }));
const marks = (markup: string) => [...markup.matchAll(/<mark class="pin-mark[^"]*"[^>]*>([^<]*)<\/mark>/g)].map((m) => m[1]);

describe('Markdown on the board', () => {
  describe('in notes, comments, thread messages, context and details', () => {
    it('renders GitHub-style tables, task lists, strikethrough and autolinks', () => {
      assert.equal(
        full('| Provider | Fee |\n|---|--:|\n| **Stripe** | 2.9% |'),
        '<div class="md"><table><thead><tr><th>Provider</th><th style="text-align:right">Fee</th></tr></thead>' +
          '<tbody><tr><td><strong>Stripe</strong></td><td style="text-align:right">2.9%</td></tr></tbody></table></div>',
      );
      assert.match(full('~~Adyen~~ is out'), /<del>Adyen<\/del> is out/);
      assert.match(full('See www.stripe.com and https://stripe.com/docs.'), /<a href="http:\/\/www\.stripe\.com"[^>]*>www\.stripe\.com<\/a> and <a href="https:\/\/stripe\.com\/docs"[^>]*>https:\/\/stripe\.com\/docs<\/a>\./);
    });

    it('draws task lists with read-only boxes, each saying the line it is on', () => {
      const list = full('- [x] Pick a provider\n- [ ] Wire up webhooks');
      assert.match(list, /<ul class="contains-task-list">/);
      assert.match(list, /<li class="task-list-item is-done"><input type="checkbox" disabled="" data-task-line="1" checked=""\/> Pick a provider<\/li>/);
      assert.match(list, /<li class="task-list-item"><input type="checkbox" disabled="" data-task-line="2"\/> Wire up webhooks<\/li>/);
    });

    it('lets a note people can edit tick its boxes, and only then', () => {
      const text = '- [x] Pick a provider\n- [ ] Wire up webhooks';
      const tickable = html(md(text, { onTick: () => {} }));
      assert.match(tickable, /<li class="task-list-item is-done"><input type="checkbox" class="task-box nodrag" checked=""\/> Pick a provider<\/li>/);
      assert.match(tickable, /<li class="task-list-item"><input type="checkbox" class="task-box nodrag"\/> Wire up webhooks<\/li>/);
      assert.doesNotMatch(tickable, /disabled/);
      assert.doesNotMatch(full(text), /task-box/, 'read-only without onTick');
      assert.doesNotMatch(inline('- [ ] Wire up webhooks'), /<input/, 'inline Markdown has no boxes');
    });

    it('numbers the lines of boxes as a tick rewrites them: nested, ordered, quoted, loose, and not in code', () => {
      const text = 'Intro\n\n* [ ] Draft\n  + [x] Outline\n\n1. [x] Review\n\n> - [ ] Quoted\n\n```\n- [ ] not a box\n```\n\n- [ ] Loose\n\n- [X] Shout';
      const lines = [...full(text).matchAll(/data-task-line="(\d+)"/g)].map((m) => Number(m[1]));
      assert.deepEqual(lines, [3, 4, 6, 8, 14, 16]);
      assert.deepEqual(
        taskLines(text).map((t) => t.line),
        lines,
        'the note reads its tasks where the renderer draws them',
      );
      const ticked = lines.reduce((t, line) => setTask(t, line, !taskLines(t).find((x) => x.line === line)!.done)!, text);
      assert.equal(ticked, 'Intro\n\n* [x] Draft\n  + [ ] Outline\n\n1. [ ] Review\n\n> - [x] Quoted\n\n```\n- [ ] not a box\n```\n\n- [x] Loose\n\n- [ ] Shout');
    });

    it('opens links in a new tab, and keeps footnote links on the page', () => {
      assert.match(full('[docs](https://stripe.com/docs)'), /<a href="https:\/\/stripe\.com\/docs" draggable="false" target="_blank" rel="noreferrer">docs<\/a>/);
      const noted = full('Fees vary[^1].\n\n[^1]: By country.');
      assert.match(noted, /<a href="#user-content-fn-1" id="user-content-fnref-1"[^>]*>1<\/a>/);
      assert.doesNotMatch(noted, /href="#[^"]*"[^>]*target=/, 'a footnote link would change the board address in a new tab');
      assert.match(full('[x](javascript:alert(1))'), /<a href=""/, 'unsafe addresses are dropped');
    });

    it('shows raw HTML as the text it is', () => {
      assert.equal(full('a <b>bold</b> <script>x</script>'), '<div class="md"><p>a &lt;b&gt;bold&lt;/b&gt; &lt;script&gt;x&lt;/script&gt;</p></div>');
      assert.equal(inline('a <b>bold</b>'), '<span class="md-inline">a &lt;b&gt;bold&lt;/b&gt;</span>');
    });

    it("shows Tricot's own pictures, and one from another site as a link to it", () => {
      const link = (href: string, words: string) => `<a href="${href}" draggable="false" target="_blank" rel="noreferrer">${words}</a>`;
      assert.equal(full('![Signup](https://x.dev/a.png)'), `<div class="md"><p>${link('https://x.dev/a.png', 'Signup')}</p></div>`);
      assert.equal(full('![](http://x.dev/pixel.gif)'), `<div class="md"><p>${link('http://x.dev/pixel.gif', 'http://x.dev/pixel.gif')}</p></div>`);
      for (const src of ['//x.dev/a.png', 'https://x.dev/api/assets/a1', '/api/assetsa1', 'api/assets/a1', 'x.dev/a.png']) {
        assert.doesNotMatch(full(`![a](${src})`), /<img/, src);
      }

      assert.match(full('![Mockup](/api/assets/a1b2c3)'), /<div class="md"><p><img src="\/api\/assets\/a1b2c3" alt="Mockup"\/><\/p><\/div>$/, 'uploaded to Tricot');
      // Written into the text, it stays a picture. (react-markdown keeps no
      // data: address, so it shows its alt text, and React says so; quietly here.)
      const { error } = console;
      console.error = () => {};
      let written: string;
      try {
        written = full('![Dot](data:image/png;base64,iVBORw0KGgo=)');
      } finally {
        console.error = error;
      }
      assert.match(written, /<img [^>]*alt="Dot"/, 'written into the text');
      assert.doesNotMatch(written, /<a /);

      // A badge, a picture that is already a link, reads as that link.
      assert.equal(full('[![Build](https://x.dev/b.svg)](https://x.dev/ci)'), `<div class="md"><p>${link('https://x.dev/ci', 'Build')}</p></div>`);
      assert.equal(inline('[![Build](https://x.dev/b.svg)](https://x.dev/ci)'), `<span class="md-inline">${link('https://x.dev/ci', 'Build')}</span>`);
    });

    it('links the cards a table or a task list names', () => {
      const markup = onBoard(md('| Task | Why |\n|---|---|\n| T5 | #3 |\n\n- [ ] T5'));
      assert.equal(markup.match(/class="ref-chip ref-task-todo[^"]*"[^>]*>T5<\/a>/g)?.length, 2);
      assert.match(markup, /class="ref-chip ref-decided[^"]*"[^>]*>#3<\/a>/);
    });
  });

  describe('in table cells and captions', () => {
    it('renders bold, italics, links, code, strikethrough and card chips inline', () => {
      assert.equal(
        inline('**Stripe** _Elements_, [docs](https://stripe.com/docs), `npm i stripe` and ~~Adyen~~'),
        '<span class="md-inline"><strong>Stripe</strong> <em>Elements</em>, <a href="https://stripe.com/docs" draggable="false" target="_blank" rel="noreferrer">docs</a>, <code>npm i stripe</code> and <del>Adyen</del></span>',
      );
      assert.match(onBoard(md('Unblocks T5, per **#3**', { inline: true })), /Unblocks <a class="ref-chip ref-task-todo[^>]*>T5<\/a>, per <strong><a class="ref-chip ref-decided[^>]*>#3<\/a><\/strong>/);
    });

    it('keeps block syntax as the text it is: no headings, lists, quotes, tables or code blocks', () => {
      for (const text of ['1. Call Stripe', '- Call Stripe', '# Call Stripe', '> Call Stripe', '---', '```', '[^1]: note']) {
        assert.equal(inline(text), `<span class="md-inline">${text.replace(/>/g, '&gt;')}</span>`, text);
      }
      assert.equal(inline('    indented'), '<span class="md-inline">indented</span>', 'no code block, and no leading spaces, as in a paragraph');
      assert.equal(inline('| a | b |\n|---|---|'), '<span class="md-inline">| a | b |\n|---|---|</span>');
      assert.equal(inline('- [ ] not a box'), '<span class="md-inline">- [ ] not a box</span>');
    });

    it('reads a picture as a link to it', () => {
      assert.equal(inline('![Signup](https://x.dev/a.png)'), '<span class="md-inline"><a href="https://x.dev/a.png" draggable="false" target="_blank" rel="noreferrer">Signup</a></span>');
      assert.match(inline('![](https://x.dev/a.png)'), />https:\/\/x\.dev\/a\.png<\/a>/);
    });

    it('draws a line as a note draws the same line', () => {
      const line = '**Stripe** _Elements_ with [docs](https://stripe.com/docs), `code`, ~~old~~ and www.stripe.com';
      const inNote = full(line).replace(/^<div class="md"><p>|<\/p><\/div>$/g, '');
      assert.equal(inline(line), `<span class="md-inline">${inNote}</span>`);
    });

    it('reads, for finding pinned words, as it shows', () => {
      for (const text of ['**Stripe** Elements', 'Read [the docs](https://stripe.com/docs) first', 'Logo: ![logo](https://x.dev/l.png)', 'Use `npm i` &amp; \\*go\\*', '&copy; 2026']) {
        const loose = (s: string) => s.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
        assert.equal(loose(inlineText(text)), loose(shown(inline(text))), text);
      }
    });
  });
});

describe('Pins on formatted words', () => {
  it('marks "Stripe" inside "**Stripe** Elements"', () => {
    assert.equal(
      marked('**Stripe** Elements', [{ id: 'p1', quote: 'Stripe', suffix: ' Elements' }], { inline: true, chips: false }),
      '<span class="md-inline"><strong><mark class="pin-mark">Stripe</mark></strong> Elements</span>',
    );
  });

  it('marks words across bold, a link, code and a card chip, piece by piece', () => {
    const item = 'Ship **Stripe** via [the docs](https://stripe.com/docs) and `npm i` for T5 today';
    const markup = md(item, { inline: true, rehypePlugins: [[rehypePins, { marks: [{ id: 'p1', quote: 'Stripe via the docs and npm i for T5' }], chips: false }]] });
    const drawn = onBoard(markup);
    assert.deepEqual(marks(drawn), ['Stripe', ' via ', 'the docs', ' and ', 'npm i', ' for ', 'T5']);
    assert.match(drawn, /<code><mark class="pin-mark">npm i<\/mark><\/code>/);
    assert.match(drawn, /class="ref-chip[^>]*><mark class="pin-mark">T5<\/mark><\/a>/, 'the chip keeps its link, its number marked');
    assert.match(drawn, /<\/mark><\/a> today<\/span>$/);
  });

  it('marks the words being pinned in amber, and the one in focus', () => {
    const drawn = marked('**Stripe** Elements', [{ id: DRAFT, quote: 'Elements' }], { inline: true, chips: false });
    assert.match(drawn, /<mark class="pin-mark is-draft" data-pin-draft="true">Elements<\/mark>/);
    const focused = html(md('**Stripe**', { inline: true, rehypePlugins: [[rehypePins, { marks: [{ id: 'p1', quote: 'Stripe' }], focus: 'p1', chips: false }]] }));
    assert.match(focused, /<mark class="pin-mark is-focus">Stripe<\/mark>/);
  });

  it("leaves the chips to the caller when asked, and closes a note's table cell with its chip", () => {
    assert.doesNotMatch(marked('**Stripe** Elements', [{ id: 'p1', quote: 'Stripe' }], { inline: true, chips: false }), /data-chip/);
    const note = marked('| Provider | Fee |\n|---|---|\n| **Stripe** | 2.9% |', [{ id: 'p1', quote: 'Stripe' }]);
    assert.match(note, /<td><strong><mark class="pin-mark">Stripe<\/mark><\/strong><mark data-chip="p1"><\/mark><\/td>/);
  });

  it('finds words quoted with their Markdown as they read', () => {
    const item = 'Read [the docs](https://stripe.com/docs) first';
    assert.deepEqual(marks(marked(item, [{ id: 'p1', quote: '[the docs](https://stripe.com/docs) first' }], { inline: true, chips: false })), ['the docs', ' first']);
    assert.deepEqual(marks(marked('**Stripe** Elements', [{ id: 'p1', quote: '**Stripe** Elements' }], { inline: true, chips: false })), ['Stripe', ' Elements']);
    // Raw HTML shows as written but isn't text pins are found in, as in notes.
    assert.deepEqual(marks(marked('Use <kbd>Ctrl</kbd> C', [{ id: 'p1', quote: '<kbd>Ctrl</kbd> C' }], { inline: true, chips: false })), ['Ctrl', ' C']);
  });
});

describe('Pinning words in formatted tasks, from selecting them to drawing them', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-markdown-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Payments' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  // A note with a task list, what a checklist is now.
  const tasks = (...items: string[]) => {
    const block = store.addBlock({ boardId }, { title: 'Launch', content: { type: 'note', text: items.map((text) => `- [ ] ${text}`).join('\n') } }, sam);
    assert.ok(block.type === 'note');
    return block;
  };
  const blockOf = (id: string) => store.canvasOf(id).canvas.blocks.find((b) => b.id === id)!;
  const task = (title: string) => store.planTasks(boardId, [{ title }], agent)[0];

  // What a person's selection on the rendered note sends: the words (the nth
  // time they show), and the text around them as it shows.
  const select = (text: string, words: string, nth = 1) => {
    const reads = shown(full(text));
    let start = -1;
    for (let i = 0; i < nth; i++) start = reads.indexOf(words, start + 1);
    assert.ok(start >= 0, `"${words}" shows in "${reads}"`);
    return { kind: 'text' as const, ...quoteAt(reads, start, start + words.length)! };
  };
  // The note's words as the canvas draws them, with the pin's marked.
  const drawn = (pin: Pin, text: string) => {
    assert.ok(pin.anchor.kind === 'text');
    return marks(marked(text, [{ id: pin.id, quote: pin.quote, prefix: pin.anchor.prefix, suffix: pin.anchor.suffix }], { chips: false }));
  };

  it('pins the bold word a person selects in a task, and draws it on that word', () => {
    const launch = tasks('Use **Stripe** Elements, not Stripe Checkout');
    const { pin } = store.pinTask(launch.id, select(launch.text, 'Stripe'), { text: 'Prototype Elements' }, sam);
    assert.equal(pin.quote, 'Stripe');
    const place = placePin(blockOf(launch.id), pin);
    assert.ok(place?.kind === 'text');
    assert.equal(noteText(launch.text).slice(place.start, place.end), 'Stripe', 'offsets in the note as it reads');
    assert.deepEqual(drawn(pin, launch.text), ['Stripe']);

    // The second "Stripe", by the words around it.
    const second = store.pinTask(launch.id, select(launch.text, 'Stripe', 2), { text: 'Drop Checkout' }, sam).pin;
    assert.ok(second.anchor.kind === 'text');
    const markup = marked(launch.text, [{ id: second.id, quote: second.quote, prefix: second.anchor.prefix, suffix: second.anchor.suffix }], { chips: false });
    assert.match(markup, /not <mark class="pin-mark">Stripe<\/mark> Checkout/);
  });

  it('pins words across a link and code, which the note reads without their Markdown', () => {
    const launch = tasks('Read [the webhook docs](https://stripe.com/docs/webhooks) before `stripe listen`');
    const { pin } = store.pinTask(launch.id, select(launch.text, 'webhook docs before stripe listen'), { text: 'Set up webhooks' }, sam);
    assert.equal(pin.quote, 'webhook docs before stripe listen');
    assert.ok(placePin(blockOf(launch.id), pin));
    assert.deepEqual(drawn(pin, launch.text), ['webhook docs', ' before ', 'stripe listen']);
  });

  it('lets an agent quote the Markdown it reads', () => {
    const launch = tasks('Read [the webhook docs](https://stripe.com/docs/webhooks) first');
    const pin = store.pin(launch.id, { kind: 'text', quote: '[the webhook docs](https://stripe.com/docs/webhooks)' }, { taskId: task('Webhooks').id }, agent);
    assert.ok(placePin(blockOf(launch.id), pin));
    assert.deepEqual(drawn(pin, launch.text), ['the webhook docs']);
  });

  it('keeps a pin through its words being made bold, ticked, and restored', () => {
    const launch = tasks('Stripe Elements', 'Pricing page');
    const { pin } = store.pinTask(launch.id, select(launch.text, 'Elements'), { text: 'Prototype' }, sam);
    store.updateBlock(launch.id, { text: '- [ ] **Stripe** _Elements_\n- [ ] Pricing page' }, sam);
    const current = blockOf(launch.id);
    assert.ok(current.type === 'note');
    const place = placePin(current, pin);
    assert.ok(place?.kind === 'text');
    assert.equal(noteText(current.text).slice(place.start, place.end), 'Elements');
    assert.deepEqual(drawn(pin, current.text), ['Elements']);
    assert.match(marked(current.text, [{ id: pin.id, quote: pin.quote }], { chips: false }), /<em><mark class="pin-mark">Elements<\/mark><\/em>/);

    store.updateBlock(launch.id, { text: setTask(current.text, 1, true)! }, sam);
    assert.ok(placePin(blockOf(launch.id), pin), 'ticking keeps it');
    const restored = store.restoreBlock(launch.id, 1, sam);
    assert.ok(restored.type === 'note' && restored.text === '- [ ] Stripe Elements\n- [ ] Pricing page');
    assert.deepEqual(placePin(restored, pin), { kind: 'text', start: 7, end: 15 }, 'an earlier version finds it too');
  });

  it('pins formatted table cells as before, quoting their source for agents', () => {
    const fees = store.addBlock(
      { boardId },
      { title: 'Fees', content: { type: 'table', columns: ['Provider', '**Fee**'], rows: [['**Stripe**', '2.9% + [30¢](https://stripe.com/pricing)'], ['Adyen', '~~3%~~ 2.6%']] } },
      sam,
    );
    assert.ok(fees.type === 'table');
    const cell = store.pinTask(fees.id, { kind: 'cells', rows: [0, 0], columns: [1, 1] }, { text: 'Check the fee' }, sam).pin;
    const column = store.pinTask(fees.id, { kind: 'cells', columns: [1, 1] }, { text: 'Compare fees' }, sam).pin;
    assert.deepEqual([cell.quote, column.quote], ['**Stripe** · **Fee**: 2.9% + [30¢](https://stripe.com/pricing)', '**Fee** column']);
    assert.deepEqual(placePin(blockOf(fees.id), cell), { kind: 'cells', rows: [0, 0], columns: [1, 1] });
    store.updateBlock(fees.id, { rows: [['Braintree', '2.6%'], ...fees.rows] }, sam);
    assert.deepEqual(placePin(blockOf(fees.id), cell), { kind: 'cells', rows: [1, 1], columns: [1, 1] }, 'it follows its row down');
    assert.equal(inline('~~3%~~ 2.6%'), '<span class="md-inline"><del>3%</del> 2.6%</span>');
  });

  it('shows agents the Markdown as written, and how far along the tasks are', () => {
    const launch = tasks('Use **Stripe** Elements, see [docs](https://stripe.com/docs)');
    store.pinTask(launch.id, select(launch.text, 'Stripe Elements'), { text: 'Prototype' }, sam);
    const digest = canvasDigest(store.getBoard(boardId), store.getBoard(boardId).canvas);
    assert.match(digest, /0\/1 done\n  - \[ \] Use \*\*Stripe\*\* Elements, see \[docs\]\(https:\/\/stripe\.com\/docs\)/);
    assert.match(digest, /pinned "Stripe Elements" → T1 \(backlog\)/);
  });
});

describe("A note's text as it reads", () => {
  it('drops task boxes, table dashes and raw HTML tags', () => {
    assert.equal(noteText('- [x] Pick **Stripe**\n- [ ] Webhooks'), 'Pick **Stripe**\nWebhooks');
    assert.equal(noteText('| Provider | Fee |\n|---|:--:|\n| Stripe | 2.9% |'), '| Provider | Fee |\n| Stripe | 2.9% |');
    assert.equal(noteText('a <b>bold</b> &amp; &#x27;b&#39;'), "a bold & 'b'");
  });
});
