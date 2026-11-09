import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { CHROME, runInChrome } from './mermaidPage';

// The page asks "Are you sure?" in a dialog of its own, drawn with the theme
// (src/web/shared/confirm.tsx), never with the browser's window.confirm,
// alert or prompt: those are drawn by the browser, unthemed, block the page
// and its live updates while open, and some browsers stop showing them (T262).

const web = path.resolve(import.meta.dirname, '../src/web');
const files = (readdirSync(web, { recursive: true, encoding: 'utf8' }) as string[])
  .map((file) => file.split(path.sep).join('/'))
  .filter((file) => /\.tsx?$/.test(file));

// A file's code without its comments, which may name what they replace.
const code = (file: string) =>
  readFileSync(path.join(web, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe("The page and the browser's own dialogs", () => {
  it('never calls window.confirm, alert or prompt', () => {
    const found: string[] = [];
    for (const file of files) {
      const text = code(file);
      // Named the browser's, however it is reached.
      for (const match of text.matchAll(/\b(?:window|globalThis|self|top|parent)\s*(?:\.\s*|\[\s*['"`])(confirm|alert|prompt)\b/g)) found.push(`${file}: ${match[0]}`);
      // Called bare, which reaches the browser's unless the file has its own by that name.
      for (const name of ['confirm', 'alert', 'prompt']) {
        const own = new RegExp(`(?:const|let|var|function)\\s+${name}\\b|[{,(]\\s*${name}\\s*[,}:)=]`).test(text);
        if (!own && new RegExp(`(?<![\\w.$])${name}\\s*\\(`).test(text)) found.push(`${file}: ${name}(…)`);
      }
    }
    assert.deepEqual(found, [], "ask with askToConfirm from src/web/shared/confirm.tsx instead");
  });

  it('asks before unpinning a part with comments, in the four places that unpin one, with the shared dialog', () => {
    for (const file of ['canvas/pins.tsx', 'canvas/blocks/site/pins.tsx', 'connectors/google/docPins.tsx', 'canvas/pairing/ask.tsx']) {
      assert.match(code(file), /await askToUnpin\(/, file);
    }
  });
});

const pageScript = `
import { askToConfirm, askToUnpin } from './src/web/shared/confirm';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = { steps: {} };
const browserDialogs = [];
for (const name of ['confirm', 'alert', 'prompt']) window[name] = () => { browserDialogs.push(name); return true; };
// What the page under the dialog hears.
const heard = [];
document.addEventListener('keydown', (e) => heard.push('key ' + e.key));
document.addEventListener('mousedown', () => heard.push('mousedown'));

const opener = document.body.appendChild(document.createElement('button'));
opener.textContent = 'Unpin';
const key = (k, extra = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
const dialog = () => document.querySelector('[role="alertdialog"]');
const look = () => {
  const d = dialog();
  return d && {
    title: d.querySelector('h2')?.textContent,
    detail: d.querySelector('p')?.textContent,
    buttons: [...d.querySelectorAll('button')].map((b) => b.textContent + (b.classList.contains('btn-danger') ? ' (danger)' : '')),
    focused: document.activeElement?.textContent,
    modal: d.getAttribute('aria-modal'),
    scrim: d.parentElement.className,
  };
};
// Opens the question from the opener, does something, and says how it was answered.
const ask = async (name, act, options = { title: 'Remove it?', confirmLabel: 'Remove', danger: true }) => {
  opener.focus();
  heard.length = 0;
  const answer = (options.part ? askToUnpin(options.part, options.comments) : askToConfirm(options)).then((yes) => yes);
  await wait(50);
  const shown = look();
  await act();
  const yes = await Promise.race([answer, wait(500).then(() => 'unanswered')]);
  results.steps[name] = { shown, yes, heard: [...heard], open: Boolean(dialog()), focusAfter: document.activeElement === opener ? 'opener' : document.activeElement?.tagName };
};

(async () => {
try {
  await ask('escape', () => key('Escape'));
  await ask('enter', () => key('Enter'));
  await ask('enterConfirm', () => { key('Tab'); key('Enter'); });
  await ask('cancel', () => dialog().querySelectorAll('button')[0].click());
  await ask('confirm', () => dialog().querySelectorAll('button')[1].click());
  await ask('scrim', () => {
    const scrim = dialog().parentElement;
    scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    scrim.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await ask('tab', async () => {
    const order = [document.activeElement.textContent];
    key('Tab'); order.push(document.activeElement.textContent);
    key('Tab'); order.push(document.activeElement.textContent);
    key('Tab', { shiftKey: true }); order.push(document.activeElement.textContent);
    results.tabOrder = order;
    key('Backspace');
    key('Escape');
  });
  await ask('unpin', () => key('Escape'), { part: 'this part', comments: 3 });
  await ask('unpinOne', () => key('Escape'), { part: 'these words', comments: 1 });
  // Asking again while one is open answers the first "no", and leaves one dialog.
  opener.focus();
  const first = askToConfirm({ title: 'First?', confirmLabel: 'Yes' });
  const second = askToConfirm({ title: 'Second?', confirmLabel: 'Yes' });
  await wait(50);
  results.again = { first: await Promise.race([first, wait(200).then(() => 'unanswered')]), dialogs: document.querySelectorAll('[role="alertdialog"]').length, title: dialog()?.querySelector('h2')?.textContent };
  dialog().querySelectorAll('button')[1].click();
  results.again.second = await second;
  results.browserDialogs = browserDialogs;
} catch (error) {
  results.error = String(error && error.stack || error);
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
})();
`;

interface Shown {
  title: string;
  detail?: string;
  buttons: string[];
  focused: string;
  modal: string;
  scrim: string;
}
interface Step {
  shown: Shown | null;
  yes: boolean | 'unanswered';
  heard: string[];
  open: boolean;
  focusAfter: string;
}
interface Results {
  error?: string;
  steps: Record<string, Step>;
  tabOrder: string[];
  again: { first: boolean | 'unanswered'; dialogs: number; title: string; second: boolean };
  browserDialogs: string[];
}

describe('The confirm dialog', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Results;
  before(async () => {
    results = await runInChrome<Results>(pageScript);
    assert.equal(results.error, undefined);
  });

  it('is drawn as the delete dialogs are, a modal over a veil, with the safe button focused', () => {
    const shown = results.steps.escape.shown!;
    assert.equal(shown.title, 'Remove it?');
    assert.deepEqual(shown.buttons, ['Cancel', 'Remove (danger)']);
    assert.equal(shown.focused, 'Cancel', 'focus starts on the safe button');
    assert.equal(shown.modal, 'true');
    assert.equal(shown.scrim, 'delete-scrim');
  });

  it('closes on Escape, Cancel or a press on the veil, answering no, and gives focus back', () => {
    for (const step of ['escape', 'cancel', 'scrim']) {
      assert.equal(results.steps[step].yes, false, step);
      assert.equal(results.steps[step].open, false, step);
      assert.equal(results.steps[step].focusAfter, 'opener', step);
    }
  });

  it('presses the focused button on Enter: Cancel at first, so it keeps things', () => {
    assert.equal(results.steps.enter.yes, false);
    assert.equal(results.steps.enter.open, false);
    assert.equal(results.steps.enter.focusAfter, 'opener');
    assert.equal(results.steps.enterConfirm.yes, true);
    assert.equal(results.steps.confirm.yes, true);
  });

  it('keeps focus and keys to itself while open', () => {
    assert.deepEqual(results.tabOrder, ['Cancel', 'Remove', 'Cancel', 'Remove']);
    assert.equal(results.steps.tab.yes, false);
    for (const [name, step] of Object.entries(results.steps)) assert.deepEqual(step.heard, [], `${name}: the page heard nothing`);
  });

  it('says what unpinning takes with it', () => {
    assert.equal(results.steps.unpin.shown!.title, 'Unpin this part?');
    assert.match(results.steps.unpin.shown!.detail!, /^Its thread of 3 comments is removed/);
    assert.deepEqual(results.steps.unpin.shown!.buttons, ['Cancel', 'Unpin and remove thread (danger)']);
    assert.equal(results.steps.unpinOne.shown!.title, 'Unpin these words?');
    assert.match(results.steps.unpinOne.shown!.detail!, /^Their thread of 1 comment is removed/);
  });

  it('answers an open question no when asked another, showing one at a time', () => {
    assert.equal(results.again.first, false);
    assert.equal(results.again.dialogs, 1);
    assert.equal(results.again.title, 'Second?');
    assert.equal(results.again.second, true);
  });

  it("never opens the browser's own", () => {
    assert.deepEqual(results.browserDialogs, []);
  });
});
