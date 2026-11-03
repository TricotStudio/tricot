import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { CHROME, runInChrome } from './mermaidPage';

const OUTSIDE = 'http://127.0.0.1:9/pixel.png';

// Diagrams that try to show a picture from another site, and ordinary ones
// whose line breaks, Markdown and KaTeX must still draw.
const DIAGRAMS = {
  node: `flowchart LR\n  A["<img src='${OUTSIDE}'> Signup"] --> B`,
  edge: `flowchart LR\n  A -->|"<img src=${OUTSIDE}>"| B`,
  svg: `flowchart LR\n  A["<svg><image href='${OUTSIDE}'/></svg>"] --> B`,
  sequence: `sequenceDiagram\n  Alice->>Bob: <img src='${OUTSIDE}'> hi`,
  init: `%%{init: {"dompurifyConfig": {"FORBID_TAGS": []}}}%%\nflowchart LR\n  A["<img src='${OUTSIDE}'>"] --> B`,
  frontMatter: `---\nconfig:\n  dompurifyConfig:\n    FORBID_TAGS: []\n---\nflowchart LR\n  A["<img src='${OUTSIDE}'>"] --> B`,
  breaks: 'flowchart LR\n  A["Ship?<br/>yes or no"] -->|"after<br/>review"| B["one<br>two"]',
  markdown: 'flowchart LR\n  A["`**Stripe** _Elements_`"] --> B',
  katex: 'flowchart LR\n  A["$$x^2$$"] --> B',
};

// Draws each diagram with the board's settings and reports, for each, what
// its SVG holds and whether a picture was ever put in the page while drawing
// (where a browser would fetch it).
const PAGE_SCRIPT = `
import mermaid from 'mermaid';
import { mermaidConfig } from './src/web/canvas/blocks/diagram/mermaidConfig';
const diagrams = ${JSON.stringify(DIAGRAMS)};
let pictures = 0;
new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.addedNodes)
      if (node instanceof Element && (node.matches('img, image') || node.querySelector('img, image'))) pictures++;
}).observe(document, { subtree: true, childList: true });
(async () => {
  mermaid.initialize(mermaidConfig('light', 'sans-serif'));
  const results = { secure: mermaid.mermaidAPI.getSiteConfig().secure, mermaidSecure: mermaid.mermaidAPI.defaultConfig.secure };
  let n = 0;
  for (const [name, source] of Object.entries(diagrams)) {
    pictures = 0;
    try {
      const { svg } = await mermaid.render('d' + ++n, source);
      results[name] = { img: /<img\\b/i.test(svg), image: /<image\\b/i.test(svg), pictures, breaks: (svg.match(/<br\\s*\\/?>/g) || []).length, strong: /<strong>/.test(svg), katex: /class="katex/.test(svg) };
    } catch (error) {
      results[name] = { error: String(error) };
    }
  }
  const out = document.createElement('pre');
  out.id = 'results';
  out.textContent = JSON.stringify(results);
  document.body.append(out);
})();
`;

type Drawn = { img: boolean; image: boolean; pictures: number; breaks: number; strong: boolean; katex: boolean; error?: string };

describe('Labels in a diagram', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Record<string, Drawn> & { secure: string[]; mermaidSecure: string[] };

  before(async () => {
    results = await runInChrome(PAGE_SCRIPT);
  });

  it('never hold a picture from another site, in a node, on an arrow or in a message', () => {
    for (const name of ['node', 'edge', 'svg', 'sequence'] as const) {
      const drawn = results[name];
      assert.equal(drawn.error, undefined, name);
      assert.deepEqual([drawn.img, drawn.image, drawn.pictures], [false, false, 0], `${name}: no picture, not even while drawing`);
    }
  });

  it("can't be given one back by the diagram's own settings", () => {
    for (const name of ['init', 'frontMatter'] as const) {
      assert.deepEqual([results[name].img, results[name].pictures], [false, 0], name);
    }
    for (const key of [...results.mermaidSecure, 'dompurifyConfig']) assert.ok(results.secure.includes(key), `${key} stays secure`);
  });

  it('still draw line breaks, Markdown and KaTeX', () => {
    assert.equal(results.breaks.breaks, 3);
    assert.ok(results.markdown.strong);
    assert.ok(results.katex.katex);
  });
});
