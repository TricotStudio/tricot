import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// The Node layers under the server: src/platform (what differs between
// systems, the server's lock, the token a program sends) and src/install
// (updating Tricot). The server, the `tricot` command and updating all build
// on them, so they import nothing from src/server: what they share with the
// server lives down here, and the server re-exports it where its own code
// expects it (server/access.ts re-exports platform/token.ts). AGENTS.md, Layers.

const src = path.resolve(import.meta.dirname, '../src');

interface Import {
  file: string; // the importing file, from src/
  spec: string; // as written
  target: string; // where it reaches, from src/
}

// Every relative import of each TypeScript file under these folders of src/:
// static, type-only, re-exports, side effects and dynamic.
function importsIn(...folders: string[]): Import[] {
  return folders.flatMap((folder) =>
    (readdirSync(path.join(src, folder), { recursive: true, encoding: 'utf8' }) as string[])
      .map((file) => `${folder}/${file.split(path.sep).join('/')}`)
      .filter((file) => /\.tsx?$/.test(file))
      .flatMap((file) => {
        const text = readFileSync(path.join(src, file), 'utf8');
        const specs = [
          ...text.matchAll(/^\s*(?:import|export)\s[^'"`;]*?\sfrom\s+['"]([^'"]+)['"]/gm),
          ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
          ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
        ].map((match) => match[1]);
        return specs.filter((spec) => spec.startsWith('.')).map((spec) => ({ file, spec, target: path.posix.join(path.posix.dirname(file), spec) }));
      }),
  );
}

describe('The platform and updating', () => {
  const imports = importsIn('platform', 'install');

  it('are read from every file of theirs', () => {
    assert.ok(imports.some((im) => im.file === 'platform/lock.ts'), 'reads platform/lock.ts');
    assert.ok(imports.some((im) => im.file === 'install/updates.ts'), 'reads install/updates.ts');
  });

  it('import nothing from the server', () => {
    const upward = imports.filter((im) => im.target === 'server' || im.target.startsWith('server/'));
    assert.deepEqual(
      upward.map((im) => `src/${im.file} imports '${im.spec}'`),
      [],
      'move what both need into src/platform (or src/core), and have the server re-export it',
    );
  });
});

// The files under src/ a module loads when it runs: its relative imports and
// theirs, but type-only ones, which are gone by then.
function loads(file: string): string[] {
  const isFile = (at: string) => statSync(path.join(src, at), { throwIfNoEntry: false })?.isFile() ?? false;
  const seen = new Set([file]);
  for (const at of seen) {
    const text = readFileSync(path.join(src, at), 'utf8');
    const specs = [
      ...[...text.matchAll(/^\s*(?:import|export)\s+(type\s)?[^'"`;]*?\sfrom\s+['"]([^'"]+)['"]/gm)].filter((match) => !match[1]).map((match) => match[2]),
      ...[...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]),
      ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]),
    ];
    for (const spec of specs.filter((s) => s.startsWith('.'))) {
      const target = path.posix.join(path.posix.dirname(at), spec);
      const found = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].find(isFile);
      if (found) seen.add(found);
    }
  }
  return [...seen].filter((at) => at !== file).sort();
}

// The platform and the command's small modules import the route table, so it
// stays as light as what a route is: a connector's routes are gathered by the
// connector registry, never through core/routes.ts. AGENTS.md, REST route.
describe('The route table', () => {
  it('loads nothing but what a route is, so the platform and the command take it without the registry or the store', () => {
    assert.ok(loads('core/connectors/registry.ts').includes('core/connectors/github/routes.ts'), 'follows imports through the files they reach');
    assert.deepEqual(
      loads('core/routes.ts'),
      ['core/route.ts'],
      "keep core/routes.ts to the app's own routes and route.ts's helpers; what needs every connector's asks connectorRoutes() of the connector registry",
    );
  });
});
