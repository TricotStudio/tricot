import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { CHROME, runInChrome } from './mermaidPage';

// The threads side panel scrolls up and down, never sideways, at any width it
// takes (T161): its text wraps, and what can't (code, a table, a decision's
// one-line options) stays inside the message, scrolling in its own box or
// ending in an ellipsis. Laid out by headless Chrome with the board's own
// styles, around a message shaped as threads.tsx and threadWork.tsx draw one.

const web = path.resolve(import.meta.dirname, '../src/web');
const CSS = ['themes/light.css', 'styles.css', 'chatBar.css', 'threads.css', 'delivery.css', 'reactions.css']
  .map((file) => readFileSync(path.join(web, file), 'utf8'))
  .join('\n');

const LINK = 'https://example.com/a/very/long/path/that/never/breaks?with=a-query-string-that-goes-on-and-on-and-on#and-a-fragment-too';
const WORD = 'Supercalifragilisticexpialidocious_and_more_characters_that_never_break_anywhere_at_all';
const LINE = "const conversation = document.querySelector('.threads-conversation'); if (conversation.scrollWidth > conversation.clientWidth) throw new Error('sideways');";
const NAME = 'Alexandra Konstantinopoulou-Vanderbilt of Platform Design'; // names go to 60 characters
const LABEL = `Wrap long links like ${LINK} wherever they come up in a message`;

const MESSAGE = `
<li class="thread-message">
  <span class="actor-mark">A</span>
  <div class="thread-message-main">
    <div class="thread-message-head"><strong>${NAME}</strong><span class="thread-message-time">2 minutes ago</span><span class="tag tag-via">via /a-skill-with-a-rather-long-name-of-its-own</span></div>
    <div class="md">
      <p>See ${LINK} and <code>/Users/someone/Documents/dev/projects/tricot/src/web/canvas/blocks/diagram/mermaidConfig.ts</code> and ${WORD}.</p>
      <pre><code>${LINE}</code></pre>
      <table><thead><tr><th>Box</th><th>Scroll width</th><th>Client width</th><th>Overflows by</th><th>Where it comes from</th></tr></thead>
      <tbody><tr><td>threads-conversation</td><td>612</td><td>360</td><td>252</td><td>a code block with a long line</td></tr></tbody></table>
    </div>
    <ul class="work-cards">
      <li><a class="work-card ref-open" href="#"><span class="work-meta"><span class="work-mark"></span>#12 · open</span><span class="work-title">Should it wrap ${LINK}?</span>
        <span class="work-options"><span class="work-option"><span class="option-letter">a</span><span class="work-option-label">${LABEL}</span></span></span></a></li>
      <li><a class="work-card is-row" href="#"><span class="work-meta"><span class="work-mark"></span>T5</span><span class="work-title">${WORD}</span><span class="work-where">in progress</span></a></li>
    </ul>
    <div class="said-foot"><p class="delivery"><span class="delivery-text">Delivered · Builder is listening</span></p></div>
  </div>
</li>`;

const PAGE_SCRIPT = `
const style = document.createElement('style');
style.textContent = ${JSON.stringify(CSS)};
document.head.append(style);
const results = {};
for (const width of [320, 440]) {
  const dock = document.createElement('aside');
  dock.className = 'thread-dock';
  dock.style.cssText = 'position: relative; width: ' + width + 'px; height: 700px';
  dock.innerHTML = '<div class="threads-conversation"><ol class="thread-messages">' + ${JSON.stringify(MESSAGE)} + '</ol></div>';
  document.body.append(dock);
  const conversation = dock.querySelector('.threads-conversation');
  const main = dock.querySelector('.thread-message-main');
  const box = (el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  const inside = (el) => el.getBoundingClientRect().right <= main.getBoundingClientRect().right + 0.5;
  results[width] = {
    conversation: box(conversation),
    pre: box(dock.querySelector('pre')),
    table: box(dock.querySelector('table')),
    label: box(dock.querySelector('.work-option-label')),
    inside: [...main.querySelectorAll('*')].filter((el) => !el.closest('pre, table') && !inside(el)).map((el) => el.className || el.tagName),
  };
  dock.remove();
}
const out = document.createElement('pre');
out.id = 'results';
out.textContent = JSON.stringify(results);
document.body.append(out);
`;

type Box = { scrollWidth: number; clientWidth: number };
type Laid = { conversation: Box; pre: Box; table: Box; label: Box; inside: string[] };

describe('The threads side panel', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Record<string, Laid>;

  before(async () => {
    results = await runInChrome(PAGE_SCRIPT);
  });

  it('never scrolls sideways, at its narrowest or its widest', () => {
    for (const [width, laid] of Object.entries(results)) {
      assert.ok(laid.conversation.scrollWidth <= laid.conversation.clientWidth, `${width}px: the conversation is ${laid.conversation.scrollWidth}px wide in ${laid.conversation.clientWidth}px`);
      assert.deepEqual(laid.inside, [], `${width}px: everything in the message stays inside it`);
    }
  });

  it('scrolls code and a wide table in their own box, and ends a long option in an ellipsis', () => {
    for (const [width, laid] of Object.entries(results)) {
      assert.ok(laid.pre.scrollWidth > laid.pre.clientWidth, `${width}px: the code block scrolls`);
      assert.ok(laid.table.scrollWidth > laid.table.clientWidth, `${width}px: the table scrolls`);
      assert.ok(laid.label.scrollWidth > laid.label.clientWidth, `${width}px: the option's label is cut short`);
    }
  });
});
