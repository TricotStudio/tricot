import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { needsYouTitle } from '../src/core/approvals';
import { NAME_LIMIT, TabTitleStore, tabTitle, type TitleParts } from '../src/web/shared/tabTitle';

const plain: TitleParts = { replies: 0, needsYou: '', hidden: false };
const title = (parts: Partial<TitleParts>) => tabTitle({ ...plain, ...parts });
const claude = needsYouTitle(['Claude']);

describe("The tab's title", () => {
  it('names the page before the brand, and Home by the brand alone', () => {
    assert.equal(title({}), 'Tricot');
    assert.equal(title({ page: 'Tricot roadmap' }), 'Tricot roadmap · Tricot');
    assert.equal(title({ page: 'Connectors' }), 'Connectors · Tricot');
  });

  it('keeps a name as it is written, on one line', () => {
    assert.equal(title({ page: 'Q3 · “Launch” <b>&amp;</b> 🧶 Ünïcode' }), 'Q3 · “Launch” <b>&amp;</b> 🧶 Ünïcode · Tricot');
    assert.equal(title({ page: '  Q3\n\tplan  ' }), 'Q3 plan · Tricot');
    assert.equal(title({ page: 'خطة الربع' }), 'خطة الربع · Tricot');
  });

  it('is the brand alone for an empty name', () => {
    assert.equal(title({ page: '' }), 'Tricot');
    assert.equal(title({ page: ' \n ' }), 'Tricot');
    assert.equal(title({ page: '', hidden: true, needsYou: claude, replies: 1 }), '(1) ⏸ Claude needs you');
  });

  it('clips a very long name, keeping its start and the brand after it', () => {
    const long = `Roadmap ${'x'.repeat(300)}`;
    const shown = title({ page: long });
    assert.ok(shown.startsWith('Roadmap xxx'));
    assert.ok(shown.endsWith('… · Tricot'));
    assert.equal(shown.length, NAME_LIMIT + ' · Tricot'.length);
    assert.equal(title({ page: 'x'.repeat(NAME_LIMIT) }), `${'x'.repeat(NAME_LIMIT)} · Tricot`);
  });

  it('counts replies in front while the tab is in the background', () => {
    assert.equal(title({ page: 'Tricot roadmap', replies: 2, hidden: true }), '(2) Tricot roadmap · Tricot');
    assert.equal(title({ page: 'Tricot roadmap', replies: 0, hidden: true }), 'Tricot roadmap · Tricot');
  });

  it("says who needs the person, with the page's name, while the tab is in the background", () => {
    assert.equal(title({ page: 'Tricot roadmap', needsYou: claude, hidden: true }), '⏸ Claude needs you · Tricot roadmap');
    assert.equal(title({ page: 'Tricot roadmap', needsYou: needsYouTitle(['Claude', 'Codex']), hidden: true }), '⏸ Claude and Codex need you · Tricot roadmap');
    assert.equal(title({ needsYou: claude, hidden: true }), '⏸ Claude needs you');
    assert.equal(title({ page: 'Connectors', needsYou: claude, hidden: true }), '⏸ Claude needs you · Connectors');
  });

  it('puts the count before who needs the person when both apply', () => {
    assert.equal(title({ page: 'Tricot roadmap', replies: 2, needsYou: claude, hidden: true }), '(2) ⏸ Claude needs you · Tricot roadmap');
  });

  it('is plain again once the tab is looked at', () => {
    assert.equal(title({ page: 'Tricot roadmap', replies: 2, needsYou: claude, hidden: false }), 'Tricot roadmap · Tricot');
    assert.equal(title({ needsYou: claude, hidden: false }), 'Tricot');
  });
});

describe("The tab's title, as the page holds it", () => {
  it('is made again from every part on each change, and tells who listens', () => {
    const store = new TabTitleStore();
    const written: string[] = [];
    const stop = store.subscribe(() => written.push(store.title()));
    store.set({ page: 'Tricot roadmap' });
    store.set({ hidden: true });
    store.set({ replies: 1 });
    store.set({ needsYou: claude });
    store.set({ needsYou: '' });
    store.set({ replies: 0 });
    store.set({ hidden: false });
    stop();
    store.set({ page: 'Elsewhere' });
    assert.deepEqual(written, [
      'Tricot roadmap · Tricot',
      'Tricot roadmap · Tricot',
      '(1) Tricot roadmap · Tricot',
      '(1) ⏸ Claude needs you · Tricot roadmap',
      '(1) Tricot roadmap · Tricot',
      'Tricot roadmap · Tricot',
      'Tricot roadmap · Tricot',
    ]);
  });

  it("shows a board's new name after a rename while the tab was in the background, never the old one", () => {
    const store = new TabTitleStore();
    const written: string[] = [];
    store.subscribe(() => written.push(store.title()));
    store.set({ page: 'Tricot roadmap' });
    store.set({ hidden: true });
    store.set({ needsYou: claude });
    store.set({ replies: 2 });
    store.set({ page: 'Tricot plan' }); // renamed while away
    assert.equal(store.title(), '(2) ⏸ Claude needs you · Tricot plan');
    // Answered in the terminal, then the tab is looked at.
    store.set({ needsYou: '' });
    assert.equal(store.title(), '(2) Tricot plan · Tricot');
    store.set({ hidden: false });
    store.set({ replies: 0 });
    assert.equal(store.title(), 'Tricot plan · Tricot');
    const afterRename = written.slice(written.indexOf('(2) ⏸ Claude needs you · Tricot plan'));
    assert.ok(!afterRename.some((t) => t.includes('Tricot roadmap')), afterRename.join('\n'));
  });

  it('is plain again when a page gives its parts back, as it leaves', () => {
    const store = new TabTitleStore();
    store.set({ page: 'Tricot roadmap', hidden: true, replies: 3 });
    store.set({ page: undefined, replies: 0 });
    assert.equal(store.title(), 'Tricot');
    store.set({ page: 'Connectors', hidden: false });
    assert.equal(store.title(), 'Connectors · Tricot');
  });
});
