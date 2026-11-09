import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { flags, linkTo, onBoard, pageAt, type PageRoute } from '../src/core/pages';

// One table of the page's addresses (src/core/pages.ts): every link is built
// from it, and the page reads the address it opens with it. These tests keep
// the two sides agreeing, keep the addresses links have always had, and keep
// the page from writing an address of its own.

const board = (boardId: string, more: Partial<Extract<PageRoute, { page: 'board' }>> = {}): PageRoute => ({
  page: 'board',
  boardId,
  view: 'tasks',
  decisionId: undefined,
  taskId: undefined,
  pinId: undefined,
  ...more,
});

describe('The table of pages', () => {
  it('opens the page each link is to, whatever is in its values', () => {
    const id = 'a/b ?#é';
    assert.deepEqual(pageAt(linkTo.home()), { page: 'home' });
    assert.deepEqual(pageAt(linkTo.newBoard()), { page: 'home' });
    assert.deepEqual(pageAt(linkTo.connectors()), { page: 'connectors', from: undefined });
    assert.deepEqual(pageAt(linkTo.connectors(id)), { page: 'connectors', from: id });
    assert.deepEqual(pageAt(linkTo.board(id)), board(id), 'a board opens on its tasks');
    for (const view of ['decisions', 'canvas', 'tasks'] as const) assert.deepEqual(pageAt(linkTo.board(id, view)), board(id, { view }));
    assert.deepEqual(pageAt(linkTo.task(id, 't 1/2')), board(id, { taskId: 't 1/2' }));
    assert.deepEqual(pageAt(linkTo.decision(id, 'd?1')), board(id, { decisionId: 'd?1' }));
    assert.deepEqual(pageAt(linkTo.askAgents(id)), board(id, { view: 'canvas' }));
    assert.deepEqual(pageAt(linkTo.pin(id, 'p/1?')), board(id, { view: 'canvas', pinId: 'p/1?' }), 'a pin opens on the Board Context');
  });

  it('builds the addresses links have always had', () => {
    assert.equal(linkTo.home(), '#/');
    assert.equal(linkTo.newBoard(), '#/?new');
    assert.equal(linkTo.connectors(), '#/connectors');
    assert.equal(linkTo.connectors('my board'), '#/connectors?from=my%20board');
    assert.equal(linkTo.board('my board'), '#/b/my%20board');
    assert.equal(linkTo.board('x', 'decisions'), '#/b/x/decisions');
    assert.equal(linkTo.askAgents('x'), '#/b/x/canvas?ask');
    assert.equal(linkTo.task('x', 'y'), '#/b/x/t/y');
    assert.equal(linkTo.decision('x', 'y'), '#/b/x/d/y');
    assert.equal(linkTo.pin('x', 'y'), '#/b/x/canvas/p/y');
  });

  it('opens Home for any other address', () => {
    for (const hash of ['', '#', '#/', '#/?new', '#/nowhere', '#/b/', '#/connector']) assert.deepEqual(pageAt(hash), { page: 'home' }, hash);
  });

  it('carries a flag the page reads once, on the address it opens', () => {
    assert.ok(flags.newBoard.test(linkTo.newBoard()));
    assert.ok(flags.ask.test(linkTo.askAgents('x')));
    assert.ok(!flags.ask.test(linkTo.board('x', 'canvas')) && !flags.newBoard.test(linkTo.home()));
    assert.equal(linkTo.askAgents('x').replace(flags.ask, ''), linkTo.board('x', 'canvas'), 'taking it off leaves the page it opened');
  });

  it("moves an address to its board's new id, and keeps the rest of it", () => {
    assert.equal(onBoard('#/b/old-name/d/1', 'new name'), '#/b/new%20name/d/1');
    assert.equal(onBoard('#/b/old-name', 'new'), '#/b/new');
    assert.equal(onBoard('#/b/old-name/canvas/p/7', 'new'), '#/b/new/canvas/p/7');
    assert.equal(onBoard('#/connectors?from=old', 'new'), '#/connectors?from=old');
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
