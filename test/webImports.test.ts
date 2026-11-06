import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// The page's folders (src/web/<feature>/) import one another one way, and
// these tests keep them to it. They read every import in src/web as the files
// have it, so a feature added tomorrow is held to the same rules:
//
// - shared/ is what every feature builds on, and imports no feature;
// - a feature reaches another only through that one's index.ts, the list of
//   what it lets the others use, and never a file inside it, stylesheets
//   included;
// - no features reach each other, however far round: a feature can be read
//   and changed knowing what it affects, and a feature's index never waits on
//   one that waits on it as the page loads.
//
// The page's own files at the top of src/web (main.tsx, App.tsx, styles.css
// and the styles it lists, in styles/) put the app together: they take each
// feature through its index too, and nothing imports them.
//
// One pair may reach into each other, file by file: the canvas and the
// connectors. A connector draws on the canvas (its context, its pins and
// pairing, the marks of links), and the canvas finds the connectors through
// their registry, as it does its own kinds of block (CONTRIBUTING.md). Making
// that one way means the page handing the connectors to the canvas as it
// starts, which changes how the canvas finds them, so it is its own piece of
// work. Through their indexes the two would load each other half-made, so
// they keep to files, and the rest of the page sees them as one feature.

const web = path.resolve(import.meta.dirname, '../src/web');
const PAIR = ['canvas', 'connectors'];
const APP = '(the app)';

interface Import {
  file: string; // the importing file, from src/web
  spec: string; // as written
  target: string; // the file it reaches, from src/web
}

// Where a file belongs: its feature's folder, or the app's own files.
function areaOf(file: string): string {
  const [first, ...rest] = file.split('/');
  return rest.length === 0 || first === 'styles' ? APP : first;
}

const isIndex = (file: string) => /^[^/]+\/index\.tsx?$/.test(file);

// Every import of a file in src/web, by a file in src/web: static, dynamic,
// re-exports, stylesheets and Vite's import.meta.glob.
function importsOf(file: string, text: string): Import[] {
  const specs = [
    ...text.matchAll(/^\s*(?:import|export)\s[^'"`;]*?\sfrom\s+['"]([^'"]+)['"]/gm),
    ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/\bimport\.meta\.glob\(\s*['"]([^'"]+)['"]/g),
    ...text.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
  return specs
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => ({ file, spec, target: resolveIn(path.dirname(file), spec.split('?')[0]) }))
    .filter(({ target }) => !target.startsWith('..'));
}

// The file an import names, as the bundler finds it: the file, the file with
// a TypeScript extension, or a folder's index. A glob names its folder.
function resolveIn(dir: string, spec: string): string {
  const base = path.posix.join(dir, spec.includes('*') ? path.posix.dirname(spec) : spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    const full = path.join(web, candidate);
    if (existsSync(full) && statSync(full).isFile()) return candidate;
  }
  return existsSync(path.join(web, base)) && statSync(path.join(web, base)).isDirectory() ? `${base}/` : base;
}

function readWeb(): Import[] {
  const files = (readdirSync(web, { recursive: true, encoding: 'utf8' }) as string[]).map((file) => file.split(path.sep).join('/')).filter((file) => /\.(tsx?|css)$/.test(file));
  return files.flatMap((file) => importsOf(file, readFileSync(path.join(web, file), 'utf8')));
}

const pairs = (a: string, b: string) => PAIR.includes(a) && PAIR.includes(b);
// The pair is one feature to the rest of the page.
const node = (area: string) => (PAIR.includes(area) ? PAIR.join('+') : area);

// What breaks the rules, each in a sentence naming the import.
function problemsOf(imports: Import[]): string[] {
  const problems: string[] = [];
  const edges = new Map<string, Map<string, Import>>(); // feature -> feature it imports -> an import that does
  for (const im of imports) {
    const from = areaOf(im.file);
    const to = areaOf(im.target);
    if (from === to) continue;
    const at = `src/web/${im.file} imports '${im.spec}'`;
    if (to === APP) {
      problems.push(`${at}, one of the app's own files: no feature imports them; move what it needs into a feature, or shared/ if every feature may use it.`);
      continue;
    }
    if (from === 'shared') {
      problems.push(`${at}, in ${to}/: shared/ imports no feature. Move what it needs into shared/, or what uses it out to a feature.`);
      continue;
    }
    if (to === 'shared') continue;
    if (pairs(from, to)) continue;
    if (!isIndex(im.target)) {
      const index = path.posix.relative(path.posix.dirname(im.file), to) || '.';
      problems.push(`${at}, a file inside ${to}/: reach ${to} through its index, import { … } from '${index.startsWith('.') ? index : `./${index}`}', and export there what ${from === APP ? 'the app' : from} needs.`);
    }
    if (from !== APP && node(from) !== node(to)) {
      const out = edges.get(node(from)) ?? new Map<string, Import>();
      if (!out.has(node(to))) out.set(node(to), im);
      edges.set(node(from), out);
    }
  }
  for (const im of imports) {
    if (isIndex(im.file) && areaOf(im.target) !== areaOf(im.file)) {
      problems.push(`src/web/${im.file} reaches outside ${areaOf(im.file)}/ ('${im.spec}'): an index lists what its own feature lets the others use.`);
    }
  }
  return [...problems, ...cyclesOf(edges)];
}

// Features that reach each other: each pair that imports the other, and for
// each knot of features that reach one another further round, its shortest
// loop. Each step names an import that makes it.
function cyclesOf(edges: Map<string, Map<string, Import>>): string[] {
  const step = (from: string, to: string) => {
    const im = edges.get(from)!.get(to)!;
    return `    ${from} -> ${to}: src/web/${im.file} imports '${im.spec}'`;
  };
  const say = (loop: string[]) =>
    `Features that reach each other: ${loop.join(' -> ')}. Make it one way: move what the lower one needs from the higher one down to it, or into shared/.\n${loop
      .slice(0, -1)
      .map((from, i) => step(from, loop[i + 1]))
      .join('\n')}`;
  const found: string[] = [];
  const paired = new Set<string>();
  for (const [from, out] of edges) {
    for (const to of out.keys()) {
      if (from < to && edges.get(to)?.has(from)) {
        found.push(say([from, to, from]));
        paired.add(from).add(to);
      }
    }
  }
  // The shortest way back to `start`, breadth first.
  const loopFrom = (start: string): string[] | undefined => {
    const back = new Map<string, string>();
    const queue = [start];
    for (const at of queue) {
      for (const next of edges.get(at)?.keys() ?? []) {
        if (next === start) {
          const loop = [start];
          for (let node: string | undefined = at; node !== start; node = back.get(node!)) loop.splice(1, 0, node!);
          return [...loop, start];
        }
        if (!back.has(next)) {
          back.set(next, at);
          queue.push(next);
        }
      }
    }
    return undefined;
  };
  const knotted = new Set<string>();
  for (const start of [...edges.keys()].sort()) {
    if (knotted.has(start)) continue;
    const loop = loopFrom(start);
    if (!loop) continue;
    loop.forEach((node) => knotted.add(node));
    if (loop.length > 3 || !loop.every((node) => paired.has(node))) found.push(say(loop));
  }
  return found;
}

describe("The page's features", () => {
  const imports = readWeb();

  it('are read from every file of the page', () => {
    assert.ok(imports.length > 500, `read ${imports.length} imports`);
    assert.ok(imports.some((im) => im.file === 'main.tsx' && im.target === 'App.tsx'), 'reads main.tsx');
    assert.ok(imports.some((im) => im.file === 'styles.css' && im.target.startsWith('styles/')), 'reads the stylesheets');
  });

  it('import one another one way: shared/ none, and each feature only through the index of another', () => {
    const problems = problemsOf(imports);
    assert.equal(problems.length, 0, `\n${problems.join('\n\n')}\n`);
  });

  it('are held to it by these rules, which find what breaks them', () => {
    const at = (file: string, target: string, spec = target) => ({ file, spec, target });
    const problems = problemsOf([
      at('shared/hooks.ts', 'board/events.ts', '../board/events'),
      at('home/Home.tsx', 'board/search.tsx', '../board/search'),
      at('home/Home.tsx', 'agents/steps.css', '../agents/steps.css'),
      at('board/heading.tsx', 'home/index.ts', '../home'),
      at('inbox/needs.tsx', 'App.tsx', '../App'),
      at('canvas/sources/sites.tsx', 'connectors/google/marks.tsx', '../../connectors/google/marks'),
      at('connectors/google/docEditor.tsx', 'canvas/pins.tsx', '../../canvas/pins'),
      at('board/index.ts', 'home/index.ts', '../home'),
    ]);
    const says = (words: RegExp) => assert.ok(problems.some((problem) => words.test(problem)), `expected a problem matching ${words}:\n${problems.join('\n')}`);
    says(/shared\/hooks\.ts imports '\.\.\/board\/events', in board\/: shared\/ imports no feature/);
    says(/home\/Home\.tsx imports '\.\.\/board\/search', a file inside board\/: reach board through its index, import \{ … \} from '\.\.\/board'/);
    says(/home\/Home\.tsx imports '\.\.\/agents\/steps\.css', a file inside agents\//);
    says(/inbox\/needs\.tsx imports '\.\.\/App', one of the app's own files/);
    says(/Features that reach each other: (board -> home -> board|home -> board -> home)/);
    says(/board\/index\.ts reaches outside board\//);
    assert.ok(!problems.some((problem) => /sites\.tsx|docEditor\.tsx/.test(problem)), 'the canvas and the connectors reach into each other');
    assert.equal(problems.length, 6, problems.join('\n'));
  });
});
