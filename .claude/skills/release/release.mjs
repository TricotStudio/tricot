// The release skill's checks (SKILL.md beside it says when to run each), run
// from anywhere in Tricot's repository:
//
//   node release.mjs check                       is main ready: clean, up to date with origin, CI green
//   node release.mjs propose [x.y.z|patch|minor|major]
//                                                the commits since the last tag, the next version, and that it's free
//   node release.mjs notes [--check] [text|-]    check releaseNotes (- reads stdin) and write them into package.json
//   node release.mjs message x.y.z [--trailer "Co-Authored-By: ..."]
//                                                the release commit's message, for git commit -F -
//   node release.mjs verify x.y.z                the release commit and tag are right, before the push
//   node release.mjs published x.y.z [--tap dir] what's out (GitHub release, npm, Homebrew) and what's left
//
// Each line it prints starts with ok, warn (ask the person before going on),
// stop (don't go on) or left (still to do). It exits 1 when anything says stop.
// It reads git, GitHub (through gh) and the npm registry, and writes nothing
// but releaseNotes in package.json (notes without --check) and what
// `git fetch` updates. It never commits, tags, pushes, publishes or approves.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkNotes, compareVersions, githubRepo, NOTES_MAX, parseVersion, preLaunchWarning, pushCommand, releaseCommitMessage, resolveTarget, suggestBump, withReleaseNotes } from './lib.mjs';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: 'boolean', default: false },
    trailer: { type: 'string' },
    tap: { type: 'string' },
  },
});
const [command, ...args] = positionals;

// ---- running things ----------------------------------------------------------

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd: options.cwd ?? root, encoding: 'utf8', input: options.input, maxBuffer: 1e8 });
  return {
    missing: result.error?.code === 'ENOENT',
    status: result.status ?? 1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? result.error?.message ?? '').trim(),
  };
}

const git = (...gitArgs) => run('git', gitArgs);
const firstLine = (text) => text.split('\n').find(Boolean) ?? '';

const lines = [];
function say(level, text) {
  lines.push(level);
  const [head, ...rest] = text.split('\n');
  console.log(`${level.padEnd(5)} ${head}${rest.map((line) => `\n      ${line}`).join('')}`);
}
const ok = (text) => say('ok', text);
const warn = (text) => say('warn', text);
const stop = (text) => say('stop', text);
const left = (text) => say('left', text);

function finish(summary) {
  const stops = lines.filter((l) => l === 'stop').length;
  const warns = lines.filter((l) => l === 'warn').length;
  console.log('');
  if (stops) console.log(`Stopped: ${stops} thing${stops === 1 ? '' : 's'} above must be fixed first.`);
  else if (warns) console.log(`${warns} warning${warns === 1 ? '' : 's'}: show ${warns === 1 ? 'it' : 'them'} to the person and go on only if they say so.${summary ? `\n${summary}` : ''}`);
  else if (summary) console.log(summary);
  process.exit(stops ? 1 : 0);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

// ---- the repository ------------------------------------------------------------

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0) die("This isn't a git repository: run it from Tricot's.");
const root = top.stdout.trim();
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const pkg = readJson('package.json');
if (pkg.name !== 'tricot') die(`This is ${pkg.name ?? 'a package without a name'}, not tricot: run it from Tricot's repository.`);
const slug = githubRepo(pkg.repository) ?? die("package.json's repository isn't on GitHub.");

const lastTag = () => {
  const r = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  return r.status === 0 ? r.out : undefined;
};

function needVersion(text) {
  const version = (text ?? '').replace(/^v/, '');
  if (!parseVersion(version)) die(`Give the version, like: node release.mjs ${command} 0.2.0`);
  return version;
}

// What the npm registry has for tricot: { versions, latest }, or { missing }
// when it has no tricot at all, or { error }.
async function npmRecord() {
  try {
    const res = await fetch('https://registry.npmjs.org/tricot', {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { missing: true, versions: {} };
    if (!res.ok) return { error: `the registry answered ${res.status}` };
    const doc = await res.json();
    return { versions: doc.versions ?? {}, latest: doc['dist-tags']?.latest };
  } catch (error) {
    return { error: error.message };
  }
}

// ---- check: is main ready? -------------------------------------------------------

function check() {
  const branch = git('symbolic-ref', '--short', '-q', 'HEAD').out;
  if (branch === 'main') ok("You're on main.");
  else stop(`You're on ${branch || 'a detached HEAD'}, not main: releases are made from main (git switch main).`);

  const dirty = git('status', '--porcelain').out;
  if (!dirty) ok('Nothing is uncommitted.');
  else {
    const list = dirty.split('\n');
    stop(`There are uncommitted changes; the release commit should hold only the version and its notes:\n${list.slice(0, 10).join('\n')}${list.length > 10 ? `\n… and ${list.length - 10} more` : ''}`);
  }

  if (git('remote', 'get-url', 'origin').status !== 0) {
    stop("There's no remote named origin to push to (RELEASING.md says how to add it).");
  } else {
    const fetched = git('fetch', '--quiet', 'origin');
    if (fetched.status !== 0) stop(`Couldn't fetch from origin: ${firstLine(fetched.err)}`);
    else ok('Fetched origin.');
  }

  const originMain = git('rev-parse', '-q', '--verify', 'refs/remotes/origin/main').out;
  let ahead = 0;
  if (!originMain) warn("origin has no main yet: the push will make it.");
  else {
    const [behind, aheadCount] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD').out.split(/\s+/).map(Number);
    ahead = aheadCount;
    if (behind && ahead) stop(`main and origin/main have gone different ways (${behind} commits only there, ${ahead} only here): sort that out first.`);
    else if (behind) stop(`main is ${behind} commit${behind === 1 ? '' : 's'} behind origin/main: git pull --ff-only, then check again.`);
    else if (ahead) {
      const subjects = git('log', '--format=- %s', 'origin/main..HEAD').out;
      warn(`main has ${ahead} commit${ahead === 1 ? '' : 's'} origin doesn't have yet. ${ahead === 1 ? 'It goes' : 'They go'} out with the release when you push, and CI hasn't run on ${ahead === 1 ? 'it' : 'them'} (the Release workflow runs the tests on the tag):\n${subjects}`);
    } else ok('main is the same as origin/main.');
  }

  const ciPage = `https://github.com/${slug}/actions/workflows/ci.yml`;
  const ci = run('gh', ['run', 'list', '--repo', slug, '--workflow', 'ci.yml', '--branch', 'main', '-L', '1', '--json', 'databaseId,status,conclusion,headSha,url']);
  if (ci.missing) warn(`gh isn't installed, so CI can't be checked from here: look at ${ciPage}.`);
  else if (ci.status !== 0) warn(`GitHub didn't say how CI went on main (${firstLine(ci.err)}): look at ${ciPage}.`);
  else {
    const [last] = JSON.parse(ci.out || '[]');
    if (!last) warn(`CI hasn't run on main yet: look at ${ciPage}.`);
    else if (last.status !== 'completed') stop(`CI is still running on main (${last.url}). Wait for it (gh run watch ${last.databaseId} --repo ${slug} --exit-status), then check again.`);
    else if (last.conclusion !== 'success') stop(`The last CI run on main ended in ${last.conclusion} (${last.url}): fix main first.`);
    else if (originMain && last.headSha !== originMain) warn(`The last CI run passed, but on an older commit than origin/main's (${last.url}).`);
    else ok(`CI passed on main (${last.url}).`);
  }

  const tag = lastTag();
  if (!tag) warn('There is no v* tag yet, so every commit counts as new.');
  else if (tag !== `v${pkg.version}`) warn(`package.json says ${pkg.version}, but the last tag is ${tag}: an earlier release may be unfinished.`);
  else ok(`The last release is ${tag}, and package.json says ${pkg.version}.`);

  if (!existsSync(path.join(root, 'node_modules'))) warn('node_modules is missing: the tests need npm ci first.');
  finish(ahead ? '' : 'main is ready for a release.');
}

// ---- propose: the next version -----------------------------------------------------

async function propose(wanted) {
  const current = pkg.version;
  const tag = lastTag();
  const log = git('log', '--no-merges', '--format=%s%x1f%b%x1e', tag ? `${tag}..HEAD` : 'HEAD');
  const commits = log.out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, body = ''] = entry.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
  console.log(`package.json says ${current}; the last tag is ${tag ?? '(none)'}.`);
  if (commits.length === 0) {
    stop(`Nothing has changed since ${tag}: there is nothing to release.`);
    return finish();
  }
  const suggestion = suggestBump(commits, current);
  console.log(`\n${commits.length} commit${commits.length === 1 ? '' : 's'} since ${tag ?? 'the start'} (newest first), with what each reads as:`);
  for (const c of suggestion.commits) console.log(`  ${c.kind.padEnd(5)}  ${c.subject}`);
  const { readAs } = suggestion;
  if (readAs) console.log(`\nOn the commits alone: ${readAs.kind}, because ${readAs.reason}.\nSuggested: ${suggestion.kind}. ${suggestion.reason}\n`);
  else console.log(`\nSuggested: ${suggestion.kind}, because ${suggestion.reason}.\n`);

  const target = resolveTarget(current, wanted, suggestion.kind);
  if (target.error) {
    stop(target.error);
    return finish();
  }
  const version = target.version;
  const offLine = preLaunchWarning(current, version);
  if (offLine) warn(offLine);
  if (tag && parseVersion(tag.slice(1)) && compareVersions(version, tag.slice(1)) <= 0) stop(`${version} isn't after the last tag, ${tag}.`);
  if (git('rev-parse', '-q', '--verify', `refs/tags/v${version}`).status === 0) stop(`There is already a tag v${version} here.`);
  else ok(`There's no tag v${version} here.`);
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/v${version}`);
  if (remote.status !== 0) warn(`Couldn't ask origin about v${version}: ${firstLine(remote.err)}`);
  else if (remote.out) stop(`origin already has a tag v${version}.`);
  else ok(`origin has no tag v${version}.`);
  const npm = await npmRecord();
  if (npm.error) warn(`Couldn't ask npm whether it has tricot ${version}: ${npm.error}.`);
  else if (npm.versions[version]) stop(`npm already has tricot ${version}, and npm never takes a version twice: pick another.`);
  else {
    ok(npm.missing ? "npm has no tricot yet." : `npm doesn't have tricot ${version} (its latest is ${npm.latest}).`);
    if (npm.latest && parseVersion(npm.latest) && compareVersions(version, npm.latest) <= 0) warn(`npm's latest is ${npm.latest}, after ${version}.`);
  }
  finish(`Next version: ${version}`);
}

// ---- notes: releaseNotes in package.json ----------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function notes(textArgs) {
  if (textArgs.length === 0) {
    console.log(pkg.releaseNotes ? `releaseNotes now: ${pkg.releaseNotes}` : 'package.json has no releaseNotes.');
    return;
  }
  const text = textArgs.length === 1 && textArgs[0] === '-' ? readStdin() : textArgs.join(' ');
  const { flat, errors, warnings } = checkNotes(text);
  console.log(`${flat}\n(${flat.length} of at most ${NOTES_MAX} characters)\n`);
  for (const e of errors) stop(e);
  for (const w of warnings) warn(w);
  if (errors.length === 0 && flags.check) ok('They can be written as they are.');
  if (errors.length === 0 && !flags.check) {
    const file = path.join(root, 'package.json');
    writeFileSync(file, withReleaseNotes(readFileSync(file, 'utf8'), flat));
    ok('Wrote them to releaseNotes in package.json.');
  }
  finish();
}

// ---- message: the release commit's ------------------------------------------------------

function message(version) {
  process.stdout.write(releaseCommitMessage(version, pkg.releaseNotes, flags.trailer));
}

// ---- verify: the release commit and tag, before the push ------------------------------

function verify(version) {
  const tag = `v${version}`;
  if (pkg.version === version) ok(`package.json says ${version}.`);
  else stop(`package.json says ${pkg.version}, not ${version}.`);
  const lock = existsSync(path.join(root, 'package-lock.json')) ? readJson('package-lock.json') : undefined;
  if (lock && lock.version === version && lock.packages?.['']?.version === version) ok(`package-lock.json says ${version}.`);
  else stop(`package-lock.json doesn't say ${version}: npm version ${version} --no-git-tag-version sets both.`);
  const { errors } = checkNotes(pkg.releaseNotes);
  if (pkg.releaseNotes && errors.length === 0) ok(`releaseNotes: ${pkg.releaseNotes}`);
  else stop(`releaseNotes aren't ready: ${errors[0] ?? 'there are none'}`);

  const branch = git('symbolic-ref', '--short', '-q', 'HEAD').out;
  if (branch !== 'main') stop(`You're on ${branch || 'a detached HEAD'}, not main.`);
  const subject = git('log', '-1', '--format=%s').out;
  if (subject === `Tricot ${version}`) ok(`The last commit is "${subject}".`);
  else stop(`The last commit is "${subject}", not "Tricot ${version}".`);
  const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').out.split('\n').filter(Boolean).sort();
  if (files.join(' ') === 'package-lock.json package.json') ok('It changes package.json and package-lock.json, and nothing else.');
  else stop(`It changes ${files.join(', ') || 'nothing'}, not just package.json and package-lock.json.`);
  if (git('status', '--porcelain').out) stop('Something is still uncommitted.');
  else ok('Nothing is uncommitted.');

  const type = git('cat-file', '-t', `refs/tags/${tag}`);
  if (type.status !== 0) stop(`There's no tag ${tag}: git tag -a ${tag} -m "Tricot ${version}".`);
  else {
    if (type.out !== 'tag') stop(`${tag} is a lightweight tag; it should be annotated (git tag -a).`);
    else {
      const tagSubject = git('tag', '-l', '--format=%(contents:subject)', tag).out;
      if (tagSubject === `Tricot ${version}`) ok(`${tag} is an annotated tag, "Tricot ${version}".`);
      else warn(`${tag}'s message is "${tagSubject}", not "Tricot ${version}".`);
    }
    if (git('rev-parse', `${tag}^{commit}`).out === git('rev-parse', 'HEAD').out) ok(`${tag} is on the release commit.`);
    else stop(`${tag} isn't on the last commit.`);
  }
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (remote.status === 0 && remote.out) warn(`origin already has ${tag}: it was pushed before.`);
  finish(`Ready. The person runs the push (the ! runs it in their session):\n  ! ${pushCommand(version)}`);
}

// ---- published: what's out, and what's left ---------------------------------------------

async function published(version) {
  const tag = `v${version}`;
  const asset = `tricot-${version}.tgz`;
  const bottleAsset = `tricot-${version}.all.bottle.tar.gz`;
  let bottleDigest; // what GitHub says the release's bottle's sha256 is
  const rel = run('gh', ['release', 'view', tag, '--repo', slug, '--json', 'url,assets,isDraft']);
  if (rel.missing) warn(`gh isn't installed: look for ${asset} and ${bottleAsset} on https://github.com/${slug}/releases/tag/${tag}.`);
  else if (rel.status !== 0) left(`There's no GitHub release ${tag} yet (${firstLine(rel.err)}): the Release workflow makes it once the tag is pushed.`);
  else {
    const info = JSON.parse(rel.out);
    if (info.assets?.some((a) => a.name === asset)) ok(`The GitHub release ${tag} has ${asset} (${info.url}).`);
    else left(`The GitHub release ${tag} has no ${asset} yet (${info.url}).`);
    const bottle = info.assets?.find((a) => a.name === bottleAsset);
    if (bottle) {
      ok(`The GitHub release ${tag} has ${bottleAsset}, the Homebrew bottle.`);
      bottleDigest = typeof bottle.digest === 'string' ? bottle.digest.replace(/^sha256:/, '') : undefined;
    } else {
      left(`The GitHub release ${tag} has no ${bottleAsset} yet. The Release workflow's bottle job makes it, and Homebrew needs it (without it, brew builds from source and wants a recent Xcode). If that job failed, the person runs the Bottle workflow again:\n! gh workflow run bottle.yml --repo ${slug} -f tag=${tag}`);
    }
    if (info.isDraft) warn(`The GitHub release ${tag} is still a draft.`);
  }

  const npm = await npmRecord();
  if (npm.error) warn(`Couldn't ask npm about tricot ${version}: ${npm.error}.`);
  else if (!npm.versions[version]) left(`npm doesn't have tricot ${version} yet: approve the staged publish (npm stage list tricot), or publish it as RELEASING.md says.`);
  else {
    ok(`npm has tricot ${version}.`);
    if (npm.latest === version) ok(`npm's latest is ${version}: npm install -g tricot gets it.`);
    else warn(`npm's latest is ${npm.latest}, not ${version}.`);
  }

  const formulaFile = 'packaging/homebrew/Formula/tricot.rb';
  const formula = readFileSync(path.join(root, formulaFile), 'utf8');
  const bottleSha = /^ {4}sha256 cellar: :any_skip_relocation, all: "([0-9a-f]{64})"$/m.exec(formula)?.[1];
  if (!formula.includes(`/download/${tag}/${asset}"`)) left(`The Homebrew formula is still for an older version: node scripts/homebrew-formula.mjs ${version}.`);
  else if (!bottleSha) left(`The formula for ${version} names no bottle, so Homebrew would build it from source and ask for a recent Xcode: once the release has ${bottleAsset}, node scripts/homebrew-formula.mjs ${version}.`);
  else if (bottleDigest && bottleDigest !== bottleSha) left(`The formula's bottle isn't the release's ${bottleAsset} (sha256 ${bottleSha}, the release's is ${bottleDigest}; the bottle was made again?): node scripts/homebrew-formula.mjs ${version}.`);
  else if (git('status', '--porcelain', '--', formulaFile).out) left(`The formula for ${version} is written but not committed ("Homebrew formula for ${version}").`);
  else {
    ok(`The formula for ${version} is committed here.`);
    git('fetch', '--quiet', 'origin');
    const unpushed = Number(git('rev-list', '--count', 'origin/main..HEAD').out || 0);
    if (unpushed) left(`main has ${unpushed} commit${unpushed === 1 ? '' : 's'} to push: ! git push origin main`);
    else ok('main is pushed.');
  }

  const tap = path.resolve(flags.tap ?? path.join(root, '..', 'homebrew-tap'));
  const tapFormula = path.join(tap, 'Formula', 'tricot.rb');
  if (!existsSync(path.join(tap, '.git'))) warn(`There's no tap checkout at ${tap}: give its folder with --tap.`);
  else if (!existsSync(tapFormula) || readFileSync(tapFormula, 'utf8') !== formula) left(`The tap's Formula/tricot.rb isn't this one yet: copy ${formulaFile} there and commit it ("Update tricot to ${version}").`);
  else if (run('git', ['status', '--porcelain', '--', 'Formula/tricot.rb'], { cwd: tap }).out) left(`The tap's formula is copied but not committed ("Update tricot to ${version}").`);
  else {
    ok(`The tap has the formula for ${version}, committed.`);
    run('git', ['fetch', '--quiet'], { cwd: tap });
    const unpushed = run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: tap });
    if (unpushed.status !== 0) warn(`Couldn't tell whether the tap is pushed: ${firstLine(unpushed.err)}`);
    else if (Number(unpushed.out)) left(`The tap has ${unpushed.out} commit${unpushed.out === '1' ? '' : 's'} to push: ! git -C ${tap} push`);
    else ok('The tap is pushed.');
  }
  const todo = lines.filter((l) => l === 'left').length;
  finish(todo ? `${todo} thing${todo === 1 ? '' : 's'} left.` : `Tricot ${version} is out everywhere.`);
}

// ---- dispatch -------------------------------------------------------------------------------

switch (command) {
  case 'check':
    check();
    break;
  case 'propose':
    await propose(args[0]);
    break;
  case 'notes':
    notes(args);
    break;
  case 'message':
    message(needVersion(args[0]));
    break;
  case 'verify':
    verify(needVersion(args[0]));
    break;
  case 'published':
    await published(needVersion(args[0]));
    break;
  default:
    die('Usage: node release.mjs check | propose [x.y.z|patch|minor|major] | notes [--check] [text|-] | message x.y.z [--trailer line] | verify x.y.z | published x.y.z [--tap dir]');
}
