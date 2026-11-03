import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { withoutElkLayouts } from '../scripts/elkLeftOut';
import { CHROME, runInChrome } from './mermaidPage';

// The web page leaves out Mermaid's ELK layouts (scripts/elkLeftOut.ts, #86):
// elkjs is under the EPL-2.0. Mermaid 12 lays flowcharts and class, state, ER
// and requirement diagrams out with ELK unless told otherwise, so these draw,
// and so do diagrams that ask for ELK, with dagre instead, and nothing fails.

describe("Mermaid's ELK layouts, left out", () => {
  const chunks = path.resolve(import.meta.dirname, '../node_modules/mermaid/dist/chunks/mermaid.core');

  it('are left out of the Mermaid installed here, which has nothing else that loads ELK', () => {
    let registries = 0;
    for (const name of readdirSync(chunks).filter((file) => file.endsWith('.mjs'))) {
      const file = path.join(chunks, name);
      const code = readFileSync(file, 'utf8');
      const without = withoutElkLayouts(code, file); // throws on a way of loading ELK the rule doesn't know
      if (without === undefined) continue;
      registries++;
      assert.doesNotMatch(without, /elkLayoutLoaders\(\)/, `${name} no longer registers the ELK layouts`);
      assert.doesNotMatch(without, /import\(\s*["']\.\/elk-/, `${name} no longer imports the ELK chunk`);
      assert.match(without, /name: "dagre"/, `${name} keeps dagre`);
    }
    assert.equal(registries, 1, "Mermaid's list of layouts is where the rule expects it");
  });

  it('stops a build that would load ELK in a way it does not know', () => {
    const id = '/x/node_modules/mermaid/dist/chunks/mermaid.core/chunk-NEW.mjs';
    assert.throws(() => withoutElkLayouts('const load = () => import("./elk-ABC123.mjs");', id), /Mermaid has changed/);
    assert.equal(withoutElkLayouts('const load = () => import("./elk-ABC123.mjs");', '/x/src/web/main.tsx'), undefined, 'only in Mermaid');
    assert.equal(withoutElkLayouts('const load = () => import("./dagre-ABC123.mjs");', id), undefined);
  });
});

// Diagrams that get ELK from Mermaid's defaults, and ones that ask for it in
// each way Mermaid reads: front matter, an init directive, an ELK algorithm by
// name, the flowchart-elk type, and a mindmap (whose own layout is cose-bilkent).
const DIAGRAMS = {
  flowchart: 'flowchart LR\n  A[Plan] --> B{Ship?}\n  B -->|yes| C[Release]\n  B -->|no| A',
  state: 'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review\n  Review --> [*]',
  class: 'classDiagram\n  Board <|-- Canvas\n  Board : +string id',
  er: 'erDiagram\n  BOARD ||--o{ TASK : holds',
  frontMatter: '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B\n  A --> C',
  init: '%%{init: {"layout": "elk"}}%%\nflowchart TD\n  A --> B',
  algorithm: '---\nconfig:\n  layout: elk.stress\n---\nflowchart TD\n  A --> B',
  flowchartElk: 'flowchart-elk TD\n  A --> B',
  mindmap: '---\nconfig:\n  layout: elk\n---\nmindmap\n  root((Tricot))\n    Boards\n    Agents',
};

// Draws each diagram with the board's settings, Mermaid's warnings on, and
// reports, for each, whether it drew (its nodes and arrows) and which layout
// Mermaid said it fell back to.
const PAGE_SCRIPT = `
import mermaid from 'mermaid';
import { mermaidConfig } from './src/web/canvas/blocks/diagram/mermaidConfig';
const diagrams = ${JSON.stringify(DIAGRAMS)};
let warnings = [];
const warn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); warn(...args); };
(async () => {
  mermaid.initialize({ ...mermaidConfig('light', 'sans-serif'), logLevel: 'warn' });
  const results = {};
  let n = 0;
  for (const [name, source] of Object.entries(diagrams)) {
    warnings = [];
    try {
      await mermaid.parse(source);
      const { svg } = await mermaid.render('d' + ++n, source);
      const fellBackTo = warnings.map((w) => /Layout algorithm (\\S+) is not registered\\. Using (\\S+) as fallback/.exec(w)).filter(Boolean).map((m) => m[1] + ' -> ' + m[2]);
      const box = document.createElement('div');
      box.innerHTML = svg;
      document.body.append(box);
      const nodes = [...box.querySelectorAll('g.node')];
      // What a pin finds a flowchart's node and arrow by (canvas/blocks/diagram/index.tsx).
      const pinnable = nodes.map((node) => node.id.match(/flowchart-(.+)-\\d+$/)?.[1]).filter(Boolean).sort();
      const arrows = box.querySelectorAll('path[data-edge="true"][data-id]').length;
      box.remove();
      results[name] = { nodes: nodes.length, pinnable, arrows, fellBackTo };
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

type Drawn = { nodes: number; pinnable: string[]; arrows: number; fellBackTo: string[]; error?: string };

describe('A diagram laid out with ELK', { skip: !CHROME && 'needs Chrome or Chromium (set CHROME_PATH)' }, () => {
  let results: Record<keyof typeof DIAGRAMS, Drawn>;

  before(async () => {
    results = await runInChrome(PAGE_SCRIPT);
  });

  it("is drawn with dagre when ELK is only Mermaid's default", () => {
    for (const name of ['flowchart', 'state', 'class', 'er'] as const) {
      assert.equal(results[name].error, undefined, name);
      assert.ok(results[name].nodes > 0, `${name} has its nodes`);
      assert.deepEqual(results[name].fellBackTo, ['elk -> dagre'], name);
    }
  });

  it('is drawn with dagre when it asks for ELK, however it asks, and a mindmap with its own layout', () => {
    const expected = { frontMatter: 'elk -> dagre', init: 'elk -> dagre', algorithm: 'elk.stress -> dagre', flowchartElk: 'elk -> dagre', mindmap: 'elk -> cose-bilkent' };
    for (const [name, fallback] of Object.entries(expected) as [keyof typeof DIAGRAMS, string][]) {
      assert.equal(results[name].error, undefined, name);
      assert.ok(results[name].nodes > 0, `${name} has its nodes`);
      assert.deepEqual(results[name].fellBackTo, [fallback], name);
    }
  });

  it('keeps what a pin finds a node or an arrow by', () => {
    assert.deepEqual(results.flowchart.pinnable, ['A', 'B', 'C']);
    assert.equal(results.flowchart.arrows, 3);
  });
});
