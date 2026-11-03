import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { canvasDigest } from '../src/core/digest';
import { linkSource, sourceKind } from '../src/core/sources';
import { Store } from '../src/core/store';
import type { Actor, Block } from '../src/core/types';
import { eventsOf } from './tables';

const DOC = '1hS7zXbq0aT3vYk2mWQeR9uLpN4cJ6dFgH8iK0lM2nOp';

describe('Link sources', () => {
  it('recognises Google Docs, Sheets and Slides, and shows them through their preview', () => {
    const doc = linkSource(`https://docs.google.com/document/d/${DOC}/edit?tab=t.0#heading=h.1`)!;
    assert.equal(doc.kind, 'Google Docs');
    assert.equal(doc.name, 'Google Doc');
    assert.equal(doc.site, 'Google');
    assert.equal(doc.embed?.url, `https://docs.google.com/document/d/${DOC}/preview`);
    assert.match(doc.embed!.blocked, /^Google won't show this inside the board in this browser\. Open it in Google, or publish it/);

    const sheet = linkSource(`https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=0`)!;
    assert.equal(sheet.kind, 'Google Sheets');
    assert.equal(sheet.mark, 'google-sheets');
    assert.equal(sheet.embed?.url, `https://docs.google.com/spreadsheets/d/${DOC}/preview`);
    const slides = linkSource(`https://docs.google.com/presentation/d/${DOC}/edit#slide=id.p`)!;
    assert.equal(slides.kind, 'Google Slides');
    assert.equal(slides.embed?.url, `https://docs.google.com/presentation/d/${DOC}/preview`);

    // A second signed-in account, and files published to the web.
    assert.equal(linkSource(`https://docs.google.com/document/u/1/d/${DOC}/edit`)?.embed?.url, `https://docs.google.com/document/d/${DOC}/preview`);
    assert.equal(linkSource(`https://docs.google.com/document/d/e/2PACX-${DOC}/pub`)?.embed?.url, `https://docs.google.com/document/d/e/2PACX-${DOC}/pub?embedded=true`);
    assert.equal(
      linkSource(`https://docs.google.com/spreadsheets/d/e/2PACX-${DOC}/pubhtml`)?.embed?.url,
      `https://docs.google.com/spreadsheets/d/e/2PACX-${DOC}/pubhtml?widget=true&headers=false`,
    );

    // Other Google apps, and ids too short to be one, stay plain.
    assert.equal(linkSource(`https://docs.google.com/forms/d/${DOC}/viewform`), null);
    assert.equal(linkSource('https://docs.google.com/document/d/short/edit'), null);
    assert.equal(linkSource('https://docs.google.com/document/'), null);
    assert.equal(linkSource('https://docs.google.com/constructor/d/1234567890abc'), null);
  });

  it('recognises Figma files, designs and prototypes, embedding the whole address', () => {
    const url = 'https://www.figma.com/design/aBcD1234eFgH5678iJkL90/Onboarding?node-id=12-34&t=x';
    const design = linkSource(url)!;
    assert.equal(design.kind, 'Figma');
    assert.equal(design.name, 'Figma design');
    assert.equal(design.embed?.url, `https://www.figma.com/embed?embed_host=tricot&url=${encodeURIComponent(url)}`);
    assert.equal(linkSource('https://figma.com/file/aBcD1234/Old-file')?.name, 'Figma file');
    assert.equal(linkSource('https://www.figma.com/proto/aBcD1234/Flow?node-id=1-2')?.name, 'Figma prototype');
    assert.equal(linkSource('https://www.figma.com/community/file/836596421863073964/mobile-ui-kit')?.name, 'Figma community file');
    assert.equal(linkSource('https://www.figma.com/community/file/not-a-number'), null);
    assert.equal(linkSource('https://www.figma.com/files/recents'), null);
    assert.equal(linkSource('https://www.figma.com/design/'), null);
    assert.equal(linkSource('https://www.figma.com/pricing'), null);
  });

  it('recognises YouTube videos, shorts and youtu.be links, keeping the start time', () => {
    const watch = linkSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1')!;
    assert.equal(watch.kind, 'YouTube');
    assert.equal(watch.name, 'YouTube video');
    assert.equal(watch.embed?.url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    assert.deepEqual(watch.embed?.size, { w: 560, h: 400 });
    assert.equal(linkSource('https://youtu.be/dQw4w9WgXcQ?t=1m30s')?.embed?.url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90');
    assert.equal(linkSource('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42')?.embed?.url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42');
    assert.equal(linkSource('https://www.youtube.com/live/dQw4w9WgXcQ')?.embed?.url, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    // Shorts are upright, so they open upright.
    const short = linkSource('https://youtube.com/shorts/aBcDeFgHiJk')!;
    assert.equal(short.embed?.url, 'https://www.youtube-nocookie.com/embed/aBcDeFgHiJk');
    assert.ok(short.embed!.size.h > short.embed!.size.w);

    assert.equal(linkSource('https://www.youtube.com/watch?v=tooShort'), null);
    assert.equal(linkSource('https://www.youtube.com/watch'), null);
    assert.equal(linkSource('https://www.youtube.com/@channel'), null);
    assert.equal(linkSource('https://youtu.be/'), null);
  });

  it('recognises Loom share links, with or without the title before the id', () => {
    const id = '5c1e0a7d93b24f6e8a0d2b4c6e8f1a3b';
    const share = linkSource(`https://www.loom.com/share/${id}?sid=abc`)!;
    assert.equal(share.kind, 'Loom');
    assert.equal(share.embed?.url, `https://www.loom.com/embed/${id}`);
    assert.equal(linkSource(`https://www.loom.com/share/Weekly-demo-${id}`)?.embed?.url, `https://www.loom.com/embed/${id}`);
    assert.equal(linkSource('https://www.loom.com/share/not-a-video'), null);
    assert.equal(linkSource('https://www.loom.com/pricing'), null);
  });

  it('reads GitHub pull requests, issues and repositories as owner/repo and number, with no embed', () => {
    const pull = linkSource('https://github.com/microsoft/TypeScript/pull/58000/files')!;
    assert.deepEqual(
      { kind: pull.kind, what: pull.what, ref: pull.ref, name: pull.name, mark: pull.mark, embed: pull.embed },
      { kind: 'GitHub', what: 'pull request', ref: 'microsoft/TypeScript #58000', name: 'microsoft/TypeScript #58000', mark: 'github-pull', embed: undefined },
    );
    assert.equal(sourceKind(pull), 'GitHub pull request');
    const issue = linkSource('https://github.com/acme/api-client/issues/142')!;
    assert.equal(sourceKind(issue), 'GitHub issue');
    assert.equal(issue.ref, 'acme/api-client #142');
    const repo = linkSource('https://github.com/acme/api-client.git')!;
    assert.equal(sourceKind(repo), 'GitHub repository');
    assert.equal(repo.ref, 'acme/api-client');
    // A page inside a repository still belongs to it.
    const file = linkSource('https://github.com/acme/api-client/blob/main/src/retry.ts')!;
    assert.equal(sourceKind(file), 'GitHub');
    assert.equal(file.ref, 'acme/api-client');

    // GitHub's own pages and people's profiles are not repositories.
    for (const url of ['https://github.com/orgs/acme/repositories', 'https://github.com/settings/profile', 'https://github.com/octocat', 'https://github.com/', 'https://github.com/acme/..']) {
      assert.equal(linkSource(url), null, url);
    }
  });

  it('leaves every other address plain', () => {
    for (const url of [
      'https://example.com/document/d/1hS7zXbq0aT3vYk2mWQe/edit',
      `https://docs.google.com.evil.example/document/d/${DOC}/edit`,
      `https://evil.example/?next=https://docs.google.com/document/d/${DOC}/edit`,
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://gist.github.com/octocat/abc123',
      'ftp://github.com/acme/api-client',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      assert.equal(linkSource(url), null, url);
    }
  });
});

describe('Links open in place', () => {
  const sam: Actor = { kind: 'human', name: 'Sam' };
  const agent: Actor = { kind: 'agent', name: 'planner' };
  let dir: string;
  let store: Store;
  let boardId: string;
  const docUrl = `https://docs.google.com/document/d/${DOC}/edit`;
  const link = (block: Block) => {
    assert.equal(block.type, 'link');
    return block as Extract<Block, { type: 'link' }>;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-sources-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Launch' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('grows the block to the embedded view and folds it back, quietly and without a new rev', async () => {
    const doc = store.addBlock({ boardId }, { title: 'Launch plan', content: { type: 'link', url: docUrl } }, agent);
    // A recognised link starts wider, to say what it is and carry its buttons (a Google Doc's two); others are as before.
    assert.deepEqual({ w: doc.w, h: doc.h }, { w: 480, h: 90 });
    const plain = store.addBlock({ boardId }, { content: { type: 'link', url: 'https://example.com' } }, agent);
    assert.deepEqual({ w: plain.w, h: plain.h }, { w: 300, h: 90 });

    const events = eventsOf(store, boardId).length;
    const opened = link(store.updateBlock(doc.id, { open: true }, sam));
    assert.equal(opened.open, true);
    assert.deepEqual({ w: opened.w, h: opened.h }, linkSource(docUrl)!.embed!.size);
    assert.equal(opened.rev, 1);
    assert.equal(eventsOf(store, boardId).length, events);
    assert.match(canvasDigest(store.getBoard(boardId), store.getCanvas({ boardId }).canvas), /- link "Launch plan" \(Google Docs, open in place\) → https:\/\/docs\.google\.com\//);

    // It stays open for everyone, across a restart.
    await store.flush();
    const reloaded = new Store(dir);
    reloaded.load();
    assert.equal(link(reloaded.getCanvas({ boardId }).canvas.blocks.find((b) => b.id === doc.id)!).open, true);

    const folded = link(store.updateBlock(doc.id, { open: false }, sam));
    assert.equal(folded.open, undefined);
    assert.equal('open' in folded, false);
    assert.deepEqual({ w: folded.w, h: folded.h }, { w: 480, h: 90 });
    assert.equal(store.updateBlock(doc.id, { open: false }, sam).rev, 1);
  });

  it('keeps a block opened bigger, and grows its group around it', () => {
    const group = store.addGroup({ boardId }, { title: 'Sources', w: 420, h: 200 }, sam);
    const video = store.addBlock(
      { boardId },
      { content: { type: 'link', url: 'https://youtu.be/dQw4w9WgXcQ' }, groupId: group.id, w: 900, h: 100 },
      sam,
    );
    const opened = store.updateBlock(video.id, { open: true }, sam);
    assert.deepEqual({ w: opened.w, h: opened.h }, { w: 900, h: 400 });
    const after = store.getCanvas({ boardId }).canvas.groups[0];
    assert.ok(after.w >= opened.x + opened.w && after.h >= opened.y + opened.h);
  });

  it('opens only links that can be embedded', () => {
    const pull = store.addBlock({ boardId }, { content: { type: 'link', url: 'https://github.com/o/r/pull/7' } }, sam);
    assert.throws(() => store.updateBlock(pull.id, { open: true }, sam), /can't open in place: only links to Google Docs, Sheets and Slides, Figma, YouTube and Loom do/);
    const plain = store.addBlock({ boardId }, { content: { type: 'link', url: 'https://example.com' } }, sam);
    assert.throws(() => store.updateBlock(plain.id, { open: true }, sam), /can't open in place/);
    const note = store.addBlock({ boardId }, { content: { type: 'note', text: 'Hi' } }, sam);
    assert.throws(() => store.updateBlock(note.id, { open: true }, sam), /A note block has no open/);

    // Opening while changing the address goes by the new address, and refuses before changing anything.
    assert.throws(() => store.updateBlock(plain.id, { url: 'https://github.com/o/r', open: true }, sam), /can't open in place/);
    assert.equal(link(store.getCanvas({ boardId }).canvas.blocks.find((b) => b.id === plain.id)!).url, 'https://example.com/');
    assert.equal(link(store.updateBlock(plain.id, { url: docUrl, open: true }, sam)).open, true);
  });

  it('folds an open link whose address changes to one that cannot open in place', () => {
    const doc = store.addBlock({ boardId }, { content: { type: 'link', url: docUrl } }, sam);
    store.updateBlock(doc.id, { open: true }, sam);
    const moved = link(store.updateBlock(doc.id, { url: 'https://example.com/plan' }, sam));
    assert.equal(moved.open, undefined);
    assert.deepEqual({ w: moved.w, h: moved.h }, { w: 300, h: 90 });
    assert.equal(moved.rev, 2);
  });
});
