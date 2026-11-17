import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as corePages from '../src/core/pages';
import { flags, linkTo, onBoard, pageAt, type BoardRoute, type PageRoute } from '../src/core/pages';

// The table of the core's pages (src/core/pages.ts): every link is built from it, and the page reads the address it opens
// with it. These tests keep the addresses links have always had, keep a page built without a part from reading any of
// its pages (their addresses are written out here, as a part's table builds them),
// and keep the page from writing an address of its own. A board's address is its id and then a piece that the core reads
// itself (the Sketchbook's pages, the Files, a pin) or a registered view does.

const board = (boardId: string, more: Omit<BoardRoute, 'page' | 'boardId'> = {}): PageRoute => ({ page: 'board', boardId, ...more });
const landing = (boardId: string): PageRoute => board(boardId, { landing: true });

describe('The table of the core pages', () => {
  it('opens the page each link is to, whatever is in its values', () => {
    const id = 'a/b ?#é';
    assert.deepEqual(pageAt(linkTo.home()), { page: 'home' });
    assert.deepEqual(pageAt(linkTo.newBoard()), { page: 'home' });
    assert.deepEqual(pageAt(linkTo.connectors()), { page: 'connectors', from: undefined });
    assert.deepEqual(pageAt(linkTo.connectors(id)), { page: 'connectors', from: id });
    assert.deepEqual(pageAt(linkTo.board(id)), landing(id), "a board's own address lands on the registry's default view");
    assert.deepEqual(pageAt(linkTo.board(id, 'scratch')), board(id, { view: 'scratch' }));
    assert.deepEqual(pageAt(linkTo.board(id, 'files')), board(id, { view: 'files' }));
    assert.deepEqual(pageAt(linkTo.page(id, 'p 1/2')), board(id, { view: 'scratch', pageId: 'p 1/2' }));
    assert.deepEqual(pageAt(linkTo.pin(id, 'p/1?')), board(id, { pinId: 'p/1?' }), 'a pin opens where the registry lands, then moves to its page or the board context');
    assert.deepEqual(pageAt(linkTo.files(id)), board(id, { view: 'files' }));
    assert.deepEqual(pageAt(linkTo.files(id, 'src/a b.ts')), board(id, { view: 'files', file: 'src/a b.ts' }));
    assert.deepEqual(pageAt(linkTo.files(id, 'src/a.ts', true)), board(id, { view: 'files', file: 'src/a.ts', pair: true }));
    assert.deepEqual(pageAt(linkTo.files(id, 'src/a.ts', false, 12)), board(id, { view: 'files', file: 'src/a.ts', line: 12 }), 'a file at a line, from a search of the files');
    assert.deepEqual(pageAt('#/b/x/files?path=&pair'), board('x', { view: 'files' }), 'a file path that is empty is no file, and pairs on nothing');
  });

  it('builds the addresses links have always had', () => {
    assert.equal(linkTo.home(), '#/');
    assert.equal(linkTo.newBoard(), '#/?new');
    assert.equal(linkTo.connectors(), '#/connectors');
    assert.equal(linkTo.connectors('my board'), '#/connectors?from=my%20board');
    assert.equal(linkTo.board('my board'), '#/b/my%20board');
    assert.equal(linkTo.board('x', 'scratch'), '#/b/x/sketchbook');
    assert.equal(linkTo.board('x', 'files'), '#/b/x/files');
    assert.equal(linkTo.page('x', 'y'), '#/b/x/sketchbook/y');
    assert.equal(linkTo.pin('x', 'y'), '#/b/x/overview/p/y');
    assert.equal(linkTo.files('x'), '#/b/x/files');
    assert.equal(linkTo.files('x', 'src/a b.ts'), '#/b/x/files?path=src%2Fa%20b.ts');
    assert.equal(linkTo.files('x', 'src/a.ts', true), '#/b/x/files?path=src%2Fa.ts&pair');
    assert.equal(linkTo.files('x', 'src/a.ts', false, 12), '#/b/x/files?path=src%2Fa.ts&line=12');
    assert.equal(linkTo.context('x'), '#/b/x/overview/context');
    assert.equal(linkTo.askAgents('x'), '#/b/x/overview/context?ask');
  });

  it("lands a board's own address, and any address no piece reads, on the registry's default view", () => {
    assert.deepEqual(pageAt(linkTo.board('x')), landing('x'), "the board's own address, as Home, the board switcher and `tricot` link it");
    assert.deepEqual(pageAt(onBoard('#/b/old-name', 'x')), landing('x'), "a renamed board's, at its new id");
    for (const hash of ['#/b/x/', '#/b/x/nowhere', '#/b/x/filesx', '#/b/x/sketchbookx/', '#/b/x/overview/p/']) {
      assert.deepEqual(pageAt(hash), hash === '#/b/x/sketchbookx/' ? board('x', { view: 'scratch' }) : landing('x'), hash);
    }
    assert.deepEqual(pageAt('#/b/x/sketchbook/'), board('x', { view: 'scratch' }), 'the Sketchbook, with no page named');
    assert.deepEqual(pageAt('#/b/x/files/'), board('x', { view: 'files' }), 'and the Files, with anything under them');
    assert.deepEqual(pageAt('#/b/x/sketchbook/y/more'), board('x', { view: 'scratch', pageId: 'y' }));
    assert.deepEqual(pageAt('#/b/x/files?path=a%2Fb&pair&more'), board('x', { view: 'files', file: 'a/b', pair: true }));
    assert.deepEqual(pageAt('#/b/x%2Fy/sketchbook'), board('x/y', { view: 'scratch' }), 'the id as one piece');
  });

  it('opens Home for any other address', () => {
    for (const hash of ['', '#', '#/', '#/?new', '#/nowhere', '#/b/', '#/b', '#/connector']) assert.deepEqual(pageAt(hash), { page: 'home' }, hash);
  });

  it('carries a flag the page reads once, on the address it opens', () => {
    assert.ok(flags.newBoard.test(linkTo.newBoard()));
    assert.ok(flags.ask.test(linkTo.askAgents('x')));
    assert.ok(!flags.ask.test(linkTo.context('x')) && !flags.newBoard.test(linkTo.home()));
    assert.equal(linkTo.askAgents('x').replace(flags.ask, ''), linkTo.context('x'), 'taking it off leaves the page it opened');
  });

  it("moves an address to its board's new id, and keeps the rest of it", () => {
    assert.equal(onBoard('#/b/old-name/d/1', 'new name'), '#/b/new%20name/d/1');
    assert.equal(onBoard('#/b/old-name', 'new'), '#/b/new');
    assert.equal(onBoard('#/b/old-name/overview/p/7', 'new'), '#/b/new/overview/p/7');
    assert.equal(onBoard('#/b/old-name/overview/decisions?group=day', 'new'), '#/b/new/overview/decisions?group=day');
    assert.equal(onBoard('#/connectors?from=old', 'new'), '#/connectors?from=old');
  });
});

describe('A page built without a part', () => {
  it("reads the core's addresses as it does, and none of a part's: each opens the board's own address, which lands", () => {
    // The addresses a part's table builds (its view, overview, decisions, task and decision).
    for (const hash of [
      '#/b/x/overview',
      '#/b/x/tasks',
      '#/b/x/decisions',
      '#/b/x/overview/status',
      '#/b/x/overview/context',
      '#/b/x/overview/decisions?group=day',
      '#/b/x/t/y',
      '#/b/x/d/y',
      linkTo.context('x'),
      linkTo.askAgents('x'),
    ]) {
      assert.deepEqual(pageAt(hash), landing('x'), hash);
    }
    assert.deepEqual(pageAt(linkTo.page('x', 'y')), board('x', { view: 'scratch', pageId: 'y' }));
    assert.deepEqual(pageAt(linkTo.files('x', 'a.ts')), board('x', { view: 'files', file: 'a.ts' }));
    assert.deepEqual(pageAt(linkTo.pin('x', 'y')), board('x', { pinId: 'y' }));
  });
});

describe('The older addresses', () => {
  it('are gone from the table of the core pages, and so is the name a browser kept for them', () => {
    assert.deepEqual(Object.keys(corePages).filter((name) => /^OLD_/i.test(name)), [], 'no table of older names');
  });
});

describe('The page', () => {
  const web = path.resolve(import.meta.dirname, '../src/web');
  const files = (readdirSync(web, { recursive: true, encoding: 'utf8' }) as string[]).filter((file) => /\.tsx?$/.test(file));
  // Code only: what a comment says about an address is for the reader.
  const codeOf = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('writes no address of its own: each link comes from the table', () => {
    assert.ok(files.length > 100, 'reads the page');
    const own = files.flatMap((file) =>
      codeOf(readFileSync(path.join(web, file), 'utf8'))
        .split('\n')
        .flatMap((line, at) => (/['"`]\/?#\//.test(line) ? [`${file}:${at + 1}: ${line.trim()}`] : [])),
    );
    assert.deepEqual(own, [], "build the address with linkTo (shared/pages.ts, from core/pages.ts), or go there with go");
  });
});
