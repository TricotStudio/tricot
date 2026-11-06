import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Clip, WebBlockKind } from '../src/web/canvas/blocks/kind';
import { clipKind, clipOf, dragsLinks, dragsText, typing } from '../src/web/canvas/clip';

// What the canvas makes of a drop or a paste that is not a file (T224): the
// clip read from the clipboard or a drag, the kind that takes it, and the
// drags it promises a block for. The kinds themselves, in the canvas, are
// tried in canvasDrops.test.ts.

const carrying = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? '' });
const kind = (type: string, clips?: WebBlockKind['clips']) => ({ type, clips }) as WebBlockKind;
const takes = (accepts: (clip: Clip) => boolean, fallback?: true): WebBlockKind['clips'] => ({ accepts, fallback, add: async () => {} });

describe('A clip', () => {
  it("is a drag's addresses, one a line, leaving out blank lines and comments, and its text", () => {
    assert.deepEqual(clipOf(carrying({ 'text/uri-list': '# from the bar\r\nhttps://example.com/a\r\n\r\n  https://example.com/b  \n', 'text/plain': 'a' })), {
      links: ['https://example.com/a', 'https://example.com/b'],
      text: 'a',
    });
    assert.deepEqual(clipOf(carrying({})), { links: [], text: '' });
  });

  it('keeps the indentation of text, and loses the blank lines around it', () => {
    assert.equal(clipOf(carrying({ 'text/plain': '\n\n    indented\n  less\n\n \n' })).text, '    indented\n  less');
    assert.equal(clipOf(carrying({ 'text/plain': '   \n ' })).text, '');
  });
});

describe('The kind that takes a clip', () => {
  const specific = kind('link', takes((clip) => clip.links.length > 0));
  const anything = kind('note', takes((clip) => clip.text !== '', true));
  const other = kind('table');

  it('is the specific one over a fallback, whichever comes first', () => {
    const clip = { links: ['https://example.com'], text: 'https://example.com' };
    assert.equal(clipKind([anything, specific, other], clip)?.type, 'link');
    assert.equal(clipKind([specific, anything, other], clip)?.type, 'link');
  });

  it('is the fallback when no specific one takes it, and none when nothing does', () => {
    assert.equal(clipKind([specific, anything, other], { links: [], text: 'words' })?.type, 'note');
    assert.equal(clipKind([specific, anything, other], { links: [], text: '' }), undefined);
  });
});

describe('A drag', () => {
  it('promises a link card when it carries addresses and a note when it carries only words', () => {
    assert.deepEqual([dragsLinks(['text/uri-list', 'text/plain']), dragsText(['text/uri-list', 'text/plain'])], [true, false]);
    assert.deepEqual([dragsLinks(['text/plain', 'text/html']), dragsText(['text/plain', 'text/html'])], [false, true]);
  });

  it('promises neither when it carries files: they are the files\' to add', () => {
    assert.deepEqual([dragsLinks(['Files', 'text/uri-list']), dragsText(['Files', 'text/plain'])], [false, false]);
    assert.deepEqual([dragsLinks([]), dragsText(['text/html'])], [false, false]);
  });
});

describe('Typing', () => {
  const element = (matches: boolean, editable = false) => ({ nodeType: 1, isContentEditable: editable, closest: () => (matches ? {} : null) });

  it('is in an input, a textarea, a select or a text box, and in nothing else', () => {
    assert.equal(typing(element(true) as never), true);
    assert.equal(typing(element(false, true) as never), true);
    assert.equal(typing(element(false) as never), false);
    assert.equal(typing(null), false);
  });

  it('goes by the element a text node is in', () => {
    assert.equal(typing({ nodeType: 3, parentElement: element(true) } as never), true);
    assert.equal(typing({ nodeType: 3, parentElement: element(false) } as never), false);
  });
});
