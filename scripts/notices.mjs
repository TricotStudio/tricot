// Third-party notices: THIRD_PARTY_NOTICES.md, shipped in the package beside
// LICENSE. The package's two bundles hold other people's work: the web page
// (dist/web, built by Vite) and the command with its server
// (dist/cli, built by esbuild). Their MIT, BSD, ISC and Apache
// licences, and the font's OFL, ask that every copy carry their notices, and
// the minified bundles drop the comments that did, so this file carries them
// instead: each one's name, version, licence and full licence text.
//
// It is made from the bundlers' own account of what went in, not from a list
// kept by hand. Each build records the files in its output (recordBundle: the
// modules in Vite's chunks, see vite.config.ts, and the inputs in esbuild's
// metafile, see build-cli.mjs) in dist/.notices/<build>.json, which doesn't
// ship. The command's build runs last and writes the notices from both
// (writeNotices). A library under a licence that isn't known to sit well in
// an AGPL-3.0-only program, or that comes without its licence text, stops the
// build until someone has looked at it (FLAGGED). One under a licence known
// not to (INCOMPATIBLE) stops it until it is left out.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const NOTICES_FILE = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
export const LISTS_DIR = path.join(ROOT, 'dist/.notices');

// Each bundle, and how the notices name where a library is.
export const BUILDS = {
  web: 'the web page',
  cli: 'the command',
};

// Licences whose code can be bundled into an AGPL-3.0-only program, its
// notices kept. OFL-1.1 is the font's: it may be bundled with any software.
export const COMPATIBLE = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

// Bundled files that aren't from npm but sit in this repository, under a
// licence of their own kept beside them. A bundled file whose folder holds a
// licence and isn't listed here stops the build.
const VENDORED = {
  'src/web/fonts/CalSans-latin.woff2': {
    name: 'Cal Sans',
    version: 'latin subset',
    license: 'OFL-1.1',
    source: 'https://github.com/calcom/font',
    texts: ['src/web/fonts/OFL.txt'],
  },
};

// Copies of the licences of libraries bundled inside a package (inlinedIn)
// that aren't installed here on their own: scripts/licences/<name>@<version>/
// holds the name, version, license and repository from its package.json and
// its licence files, as published. fastdom publishes its licence only in its
// README, so its LICENSE here is that section, word for word.
export const LICENCES_DIR = path.join(ROOT, 'scripts/licences');

// Libraries inside a package that its source map can't name: Mermaid's parser
// carries vscode-uri, whose own files show there only as webpack://LIB/src/
// (path-browserify, inside vscode-uri, the map does name).
const ALSO_INSIDE = { '@mermaid-js/parser': ['vscode-uri'] };

// Libraries let through for now although their licence needs a decision, by
// name, with why in a line. Each is said again on every build, so it isn't
// forgotten until it is settled. None is waiting now.
export const FLAGGED = {};

// Licences known not to mix with AGPL-3.0-only, which FLAGGED can't let
// through: the Eclipse Public License, 1.0 and 2.0. EPL-2.0 code may also be
// offered under the GPL as a Secondary License, which a package says as
// "EPL-2.0 OR GPL-2.0-or-later" (with an exception, sometimes); that one a
// person can look at. Without such an alternative, as with elkjs, which
// Mermaid's ELK layout uses, the library can't ship (#86, see
// scripts/elkLeftOut.ts).
export const INCOMPATIBLE = new Set(['EPL-1.0', 'EPL-2.0']);

// Whether an SPDX expression can't be met without one of those licences.
export function licenceRefused(expression, refused = INCOMPATIBLE) {
  const ids = expression.replace(/[()]/g, ' ').split(/\s+/).map((id) => id.replace(/\+$/, ''));
  if (!ids.some((id) => refused.has(id))) return false;
  return !licenceAllowed(expression, { has: (id) => !refused.has(id) });
}

// A licence's own files in a package: LICENSE, LICENCE.md, COPYING, NOTICE,
// MIT-LICENSE, THIRD-PARTY-LICENSE, OFL.txt and the like, but not a script
// that happens to be named after one (cytoscape's license-update.mjs).
const LICENCE_FILE = /^(?:(?:un)?licen[sc]e|copying|copyright|notice|ofl)(?:[.\-_].*)?$|^.+[.\-_]licen[sc]e(?:\.[a-z]+)?$/i;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|map)$/i;
// Licences before notices (an Apache NOTICE file), each kind in name order.
const fileOrder = (name) => (/notice/i.test(name) ? 1 : 0);

export function licenceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name) && !CODE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => fileOrder(a) - fileOrder(b) || a.localeCompare(b));
}

// The package a bundled file comes from: the folder right under the last
// node_modules in its path (two folders for a scoped package), as npm lays
// them out. None for a file of this repository.
export function packageDirOf(file) {
  const parts = path.resolve(ROOT, file).split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return undefined;
  const depth = parts[at + 1].startsWith('@') ? 2 : 1;
  return parts.slice(0, at + 1 + depth).join(path.sep);
}

// Bundler helpers that come into a bundle as virtual modules (Vite's preload
// helper, Rolldown's runtime; build-cli.mjs names esbuild's), named after the
// package whose code they are.
export const HELPER = /^\0(vite|rolldown|esbuild)\//;

// Records what one build put in its bundle: the files it reports, each a
// module or an asset, by path (absolute, or from the repository root).
export function recordBundle(build, files, listsDir = LISTS_DIR) {
  if (!(build in BUILDS)) throw new Error(`Unknown build "${build}".`);
  const packages = new Set();
  const helpers = new Set();
  const vendored = new Set();
  const inlined = new Map();
  for (const file of files) {
    const id = file.split('?')[0];
    const helper = HELPER.exec(id);
    if (helper) {
      helpers.add(realpathSync(path.join(ROOT, 'node_modules', helper[1])));
      continue;
    }
    if (id.startsWith('\0')) continue; // a module the build makes up itself (vite.config.ts's stubs)
    const absolute = path.resolve(ROOT, id);
    const dir = packageDirOf(absolute);
    if (dir) {
      packages.add(realpathSync(dir));
      for (const inside of inlinedIn(absolute)) inlined.set(`${inside.name}@${inside.version ?? ''} in ${inside.in}`, inside);
    } else if (licensedFolder(absolute)) vendored.add(path.relative(ROOT, absolute).split(path.sep).join('/'));
  }
  mkdirSync(listsDir, { recursive: true });
  const record = {
    build,
    packages: [...packages].sort(),
    helpers: [...helpers].sort(),
    inlined: [...inlined.keys()].sort().map((key) => inlined.get(key)),
    vendored: [...vendored].sort(),
  };
  writeFileSync(path.join(listsDir, `${build}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// The source map of a published file: beside it, or where its last line says.
function sourceMapOf(file) {
  let mapFile = `${file}.map`;
  if (!existsSync(mapFile)) {
    let tail;
    try {
      tail = readFileSync(file, 'utf8').slice(-400);
    } catch {
      return undefined;
    }
    const named = /[#@] sourceMappingURL=([^\s'"*]+)\s*(?:\*\/)?\s*$/.exec(tail);
    if (!named || named[1].startsWith('data:')) return undefined;
    mapFile = path.resolve(path.dirname(file), named[1]);
  }
  try {
    return JSON.parse(readFileSync(mapFile, 'utf8'));
  } catch {
    return undefined;
  }
}

// The libraries a package carries inside its own files: bundled by its
// authors before it was published, so no bundler here sees them as packages.
// Its source map, where it ships one, still names each one's files, and the
// version too when the path holds it (pnpm's .pnpm/<name>@<version>/).
export function inlinedIn(file) {
  const dir = packageDirOf(file);
  if (!dir) return [];
  const carrier = readJson(path.join(dir, 'package.json')).name;
  const found = new Map();
  for (const source of sourceMapOf(file)?.sources ?? []) {
    const clean = String(source).replace(/\\/g, '/');
    const name = [...clean.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1)?.[1];
    if (!name || name === '.pnpm' || name === carrier) continue;
    const pnpm = [...clean.matchAll(/\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@([^/_]+)/g)].at(-1);
    const version = pnpm && pnpm[1].replace('+', '/') === name ? pnpm[2] : null;
    found.set(`${name}@${version}`, { name, version, in: carrier });
  }
  return [...found.values()];
}

// Whether a file of this repository sits under a folder with a licence of
// its own, below the repository's LICENSE: someone else's work kept here.
function licensedFolder(file) {
  for (let dir = path.dirname(file); dir.startsWith(ROOT + path.sep); dir = path.dirname(dir)) {
    if (licenceFiles(dir).length) return true;
  }
  return false;
}

// A package's licence as an SPDX expression, from the ways package.json has
// said it, else from its licence file when that is plainly MIT or ISC (khroma
// names none in its package.json).
export function licenceOf(pkg, texts = []) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean);
    return types.length > 1 ? `(${types.join(' OR ')})` : (types[0] ?? 'UNKNOWN');
  }
  const only = texts.length === 1 ? texts[0].text.replace(/\s+/g, ' ') : '';
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/.test(only)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/.test(only)) return 'ISC';
  return 'UNKNOWN';
}

// A bundler's helper is the bundler's own code: its own licence, not those of
// what the bundler itself bundles, which Vite's LICENSE.md goes on to list.
const ownPart = (text) => text.split(/^#+ Licenses of bundled dependencies/m)[0];

// Whether an SPDX expression lets the code in: one side of an OR is enough,
// both sides of an AND are needed. A WITH exception doesn't change it, and
// "MIT+" is MIT or later.
export function licenceAllowed(expression, allowed = COMPATIBLE) {
  const tokens = expression.replace(/[()]/g, (p) => ` ${p} `).split(/\s+/).filter(Boolean);
  let at = 0;
  const one = () => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = either();
      at++; // ")"
      return inner;
    }
    if (tokens[at] === 'WITH') at += 2;
    return token !== undefined && allowed.has(token.replace(/\+$/, ''));
  };
  const both = () => {
    let ok = one();
    while (tokens[at] === 'AND') {
      at++;
      const next = one();
      ok = ok && next;
    }
    return ok;
  };
  const either = () => {
    let ok = both();
    while (tokens[at] === 'OR') {
      at++;
      const next = both();
      ok = ok || next;
    }
    return ok;
  };
  const ok = either();
  return ok && at === tokens.length;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sourceOf(pkg) {
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const url = repository ?? pkg.homepage;
  if (!url) return undefined;
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@github\.com/, 'https://github.com')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^(?!https?:)([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1')
    .replace(/\.git$/, '');
}

// A fence the text can't close: longer than any run of tildes in it.
function fence(text) {
  const longest = Math.max(0, ...(text.match(/~+/g) ?? []).map((run) => run.length));
  return '~'.repeat(Math.max(3, longest + 1));
}

// A package's entry: its name, version, licence, source and licence texts.
// A bundler helper keeps its own licence only (ownPart).
function packageEntry(dir, helper = false) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const texts = licenceFiles(dir).map((name) => {
    const text = readFileSync(path.join(dir, name), 'utf8');
    return { name, text: helper ? ownPart(text) : text };
  });
  const license = licenceOf(pkg, texts);
  const fromFile = !pkg.license && !pkg.licenses && license !== 'UNKNOWN';
  return { name: pkg.name, version: pkg.version, license, fromFile, source: sourceOf(pkg), texts, builds: new Set(), inside: new Set() };
}

// Where to read the licence of a library bundled inside another package:
// the library itself when it is installed here at that version, else its
// copy in scripts/licences.
function licenceCopyOf({ name, version }) {
  const installed = path.join(ROOT, 'node_modules', name);
  if (existsSync(path.join(installed, 'package.json')) && (!version || readJson(path.join(installed, 'package.json')).version === version)) return installed;
  const folder = name.replace('/', '+');
  const copies = existsSync(LICENCES_DIR) ? readdirSync(LICENCES_DIR).filter((d) => (version ? d === `${folder}@${version}` : d.startsWith(`${folder}@`))) : [];
  return copies.length ? path.join(LICENCES_DIR, copies.sort().at(-1)) : undefined;
}

// Everything the bundles hold that came from someone else, from the records
// the builds wrote: one entry per name and version.
export function collectNotices(listsDir = LISTS_DIR) {
  const entries = new Map();
  const problems = [];
  const insides = [];
  const add = (entry, build) => {
    const key = `${entry.name}@${entry.version}`;
    if (!entries.has(key)) entries.set(key, entry);
    entries.get(key).builds.add(build);
    return entries.get(key);
  };
  for (const build of Object.keys(BUILDS)) {
    const file = path.join(listsDir, `${build}.json`);
    if (!existsSync(file)) {
      throw new Error(`There is no record of what ${BUILDS[build]} bundles (${path.relative(ROOT, file)}). Run the whole build, npm run build, so the notices cover both bundles.`);
    }
    const record = readJson(file);
    for (const dir of record.packages) {
      const entry = add(packageEntry(dir), build);
      for (const name of ALSO_INSIDE[entry.name] ?? []) insides.push({ name, version: null, in: entry.name, build });
    }
    for (const dir of record.helpers ?? []) add(packageEntry(dir, true), build);
    for (const inside of record.inlined ?? []) insides.push({ ...inside, build });
    for (const relative of record.vendored) {
      const known = VENDORED[relative];
      if (!known) {
        problems.push(`${relative} is bundled and sits beside a licence of its own: add it to VENDORED in scripts/notices.mjs, with its name and licence.`);
        continue;
      }
      const texts = known.texts.map((name) => ({ name: path.basename(name), text: readFileSync(path.join(ROOT, name), 'utf8') }));
      add({ ...known, texts, builds: new Set(), inside: new Set() }, build);
    }
  }
  // Libraries inside other packages: covered when the same one is bundled on
  // its own, else read from a copy of its licence.
  for (const inside of insides) {
    const same = [...entries.values()].find((e) => e.name === inside.name && (!inside.version || e.version === inside.version));
    if (same) {
      same.builds.add(inside.build);
      continue;
    }
    const dir = licenceCopyOf(inside);
    if (!dir) {
      const spec = `${inside.name}@${inside.version ?? '<version>'}`;
      problems.push(
        `${spec} is bundled inside ${inside.in} (its source map names it), and there is no copy of its licence here. Add one: npm pack ${spec} --ignore-scripts, then keep its licence file and the name, version, license and repository of its package.json in scripts/licences/${spec.replace('/', '+')}/.`,
      );
      continue;
    }
    add(packageEntry(dir), inside.build).inside.add(inside.in);
  }
  const list = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
  const flagged = [];
  for (const entry of list) {
    const what = `${entry.name} ${entry.version} (${entry.license})`;
    if (licenceRefused(entry.license)) {
      problems.push(
        `${what}: its licence doesn't mix with AGPL-3.0-only (the Eclipse Public License, without the GPL as a Secondary License), so it can't ship, even in FLAGGED. Leave it out of the bundle, as scripts/elkLeftOut.ts does elkjs.`,
      );
      continue;
    }
    const issues = [];
    if (!licenceAllowed(entry.license)) issues.push('its licence is not one known to be compatible with AGPL-3.0-only');
    if (!entry.texts.length) issues.push('it comes without its licence text');
    if (!issues.length) continue;
    if (FLAGGED[entry.name]) flagged.push(`${what}: ${FLAGGED[entry.name]}`);
    else problems.push(`${what}: ${issues.join(', and ')}. Look at it, then remove it from the bundle or add it to FLAGGED in scripts/notices.mjs with why.`);
  }
  return { entries: list, problems, flagged };
}

const where = (entry) => {
  const builds = Object.keys(BUILDS)
    .filter((build) => entry.builds.has(build))
    .map((build) => BUILDS[build])
    .join(' and ');
  return entry.inside?.size ? `${builds}, inside ${[...entry.inside].sort().join(' and ')}` : builds;
};

// The notices as Markdown.
export function noticesMarkdown(entries) {
  const has = (name) => entries.some((entry) => entry.name === name);
  const credits = [
    has('@xyflow/react') && 'Canvases are built on React Flow by xyflow (MIT).',
    has('Cal Sans') && 'The wordmark is set in Cal Sans by Cal.com (SIL Open Font License 1.1).',
  ].filter(Boolean);
  const lines = [
    '# Third-party notices',
    '',
    'Tricot is © 2026 Tricot Studio, under the GNU Affero General Public License, version 3 only (see LICENSE), or a commercial licence (see COMMERCIAL.md).',
    '',
    `This package also carries other people's work, each under its own licence: the libraries bundled into the web page (dist/web) and into the command (dist/cli), and the font of the wordmark. Their names, versions and licences follow, and then each one's full licence text.${credits.length ? ` ${credits.join(' ')}` : ''}`,
    '',
    'The build writes this file (scripts/notices.mjs) from what the two bundles hold; it is not edited by hand.',
    '',
    `| Name | Version | Licence | In |`,
    `| --- | --- | --- | --- |`,
    ...entries.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.license} | ${where(entry)} |`),
  ];
  for (const entry of entries) {
    lines.push('', '---', '', `## ${entry.name} ${entry.version}`, '');
    const licence = entry.fromFile ? `${entry.license} (its package.json names none; this is its licence file's)` : entry.license;
    lines.push(`${licence}, in ${where(entry)}.${entry.source ? ` Source: ${entry.source}` : ''}`);
    for (const { name, text } of entry.texts) {
      const body = text.replace(/\r\n?/g, '\n').trimEnd();
      const mark = fence(body);
      lines.push('', `${name}:`, '', `${mark}text`, body, mark);
    }
  }
  return `${lines.join('\n')}\n`;
}

// Writes THIRD_PARTY_NOTICES.md from the builds' records. Throws, after
// writing it, when something needs a person to look at it.
export function writeNotices({ listsDir = LISTS_DIR, out = NOTICES_FILE, log = console } = {}) {
  const { entries, problems, flagged } = collectNotices(listsDir);
  writeFileSync(out, noticesMarkdown(entries));
  for (const line of flagged) log.warn(`Licence to look at: ${line}`);
  if (problems.length) {
    throw new Error(`The third-party notices need a look before this can ship:\n- ${problems.join('\n- ')}`);
  }
  return { file: out, count: entries.length, flagged: flagged.length };
}
