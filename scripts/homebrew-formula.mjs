// Writes the Homebrew formula for a version of tricot that has its GitHub release:
// packaging/homebrew/Formula/tricot.rb, which goes to the tap repository
// (TricotStudio/homebrew-tap on GitHub) so people can `brew install tricotstudio/tap/tricot`.
// RELEASING.md says when.
//
//   node scripts/homebrew-formula.mjs [version]                 once the GitHub release v<version> is out, with its bottle (default: package.json's version)
//   node scripts/homebrew-formula.mjs [version] --no-bottle     the formula without its bottle block: what the bottle is built from (.github/workflows/bottle.yml)
//   node scripts/homebrew-formula.mjs --tarball tricot-x.y.z.tgz [--bottle tricot-x.y.z.all.bottle.tar.gz]
//                                                               to try it on a local npm pack and bottle (paths or file:// URLs)
//
// The formula installs tricot-<version>.tgz from the GitHub release v<version>,
// the file the release workflow built and checked, and the very file npm has:
// the release is the one source, so Homebrew and npm install the same bytes,
// and Homebrew needn't wait for npm. This fetches that file and checks that it
// is that version of tricot, that its sha256 is the digest GitHub gives for it,
// and, once npm has the version, that it is the file npm has (its sha512
// against the registry's integrity), then writes the formula with its sha256.
// With --tarball the sha256 is the local file's, which needn't match the
// release's, so the formula says so in a comment, and this is to be run again
// once the release is out.
//
// The formula also names a bottle, tricot-<version>.all.bottle.tar.gz on the
// same release, so that `brew install` unpacks a file instead of building
// from source, which makes Homebrew check that Xcode or the Command Line Tools
// are recent for a package that has nothing to compile (T203). The bottle
// workflow builds it from the formula this writes with --no-bottle, and
// attaches it to the release. This fetches it too, checks its sha256 against
// GitHub's digest, and checks that the package inside is the release's file:
// every file the same byte for byte, but for the node line Homebrew puts at the
// top of the scripts that start with one, and the scripts that build the
// package, which it takes out of package.json. A release without its bottle
// stops here, unless --no-bottle says to write the formula without it, which
// makes Homebrew build from source (and need a recent Xcode or Command Line
// Tools). The GITHUB_TOKEN or GH_TOKEN of the environment, when there is one,
// goes to GitHub's API only, so that a CI runner isn't turned away by its limit.
//
// The formula's livecheck follows GitHub's latest release rather than the
// tags: a tag comes before its release (the workflow takes a while, and can
// fail), and the formula's file is only there once the release is.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tarball: { type: 'string' },
    bottle: { type: 'string' },
    'no-bottle': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(root, 'packaging/homebrew/Formula/tricot.rb') },
  },
});

// Homebrew's own rules for a description: no article first, no name of the
// formula, under 80 characters. So not package.json's sentence as it is.
const DESC = 'Shared planning board where humans and agents make decisions together';

function fail(message) {
  console.error(message);
  process.exit(1);
}

// "owner/repo" from package.json's repository, when it is on GitHub, read the
// way githubRepo in src/install/updates.ts reads it (that one is TypeScript,
// which plain node doesn't import).
function githubRepo(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (typeof url !== 'string') return undefined;
  const match = /^(?:github:|(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

const project = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = githubRepo(project.repository) ?? fail("package.json's repository isn't on GitHub, and the formula installs the GitHub release's file.");
const asset = (version) => `tricot-${version}.tgz`;
const bottleAsset = (version) => `tricot-${version}.all.bottle.tar.gz`;
const releaseDir = (version) => `https://github.com/${repo}/releases/download/v${version}`;
const releaseUrl = (version) => `${releaseDir(version)}/${asset(version)}`;
const noRelease = (version) =>
  `There's no GitHub release v${version} with ${asset(version)} yet. Push the tag and let the release workflow finish (RELEASING.md), then run this again.`;
const noBottle = (version) =>
  `The GitHub release v${version} has no ${bottleAsset(version)} yet. The release workflow's bottle job makes it: let that finish and run this again. If it failed, the Bottle workflow can be run on its own for this tag (RELEASING.md). Without a bottle, Homebrew builds from source and stops on an Xcode or Command Line Tools that aren't recent, so only pass --no-bottle to write the formula that way on purpose.`;

// The package.json inside a tarball.
function packageJsonIn(tarball) {
  const read = spawnSync('tar', ['-xzOf', '-', 'package/package.json'], { input: tarball, encoding: 'utf8', maxBuffer: 1e7 });
  if (read.status !== 0) fail(`That isn't an npm tarball with a package.json: ${read.stderr}`);
  return JSON.parse(read.stdout);
}

// What a bottle holds: the keg Homebrew pours, tricot/<version>/, whose copy of
// the package (libexec/lib/node_modules/tricot) is the release's file. Every
// file is the same byte for byte, but for the first line of the scripts that
// start with a node shebang (Homebrew writes there where node is, as a
// placeholder it fills in when it pours, whatever the prefix) and package.json
// (below). Returns what's wrong, a sentence each, or nothing when it is right.
const BOTTLE_SHEBANG = '#!@@HOMEBREW_PREFIX@@/opt/node/bin/node';
function bottleProblems(bottle, tarball, version) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-bottle-'));
  try {
    const unpack = (archive, name) => {
      const dir = path.join(scratch, name);
      mkdirSync(dir);
      const result = spawnSync('tar', ['-xzf', '-', '-C', dir], { input: archive, encoding: 'utf8', maxBuffer: 1e7 });
      return result.status === 0 ? dir : undefined;
    };
    const filesIn = (dir) => readdirSync(dir, { recursive: true }).filter((entry) => lstatSync(path.join(dir, entry)).isFile());
    const released = unpack(tarball, 'release');
    const bottled = unpack(bottle, 'bottle');
    if (!released || !bottled) return [`${bottleAsset(version)} isn't a .tar.gz archive.`];
    const keg = path.join(bottled, 'tricot', version);
    if (!lstatSync(path.join(keg, 'INSTALL_RECEIPT.json'), { throwIfNoEntry: false })?.isFile()) {
      return [`It isn't a Homebrew bottle of tricot ${version}: tricot/${version}/INSTALL_RECEIPT.json isn't in it.`];
    }
    const inside = path.join(keg, 'libexec/lib/node_modules/tricot');
    const found = new Set(lstatSync(inside, { throwIfNoEntry: false })?.isDirectory() ? filesIn(inside) : []);
    const problems = [];
    for (const file of filesIn(path.join(released, 'package'))) {
      if (!found.delete(file)) {
        problems.push(`${file} is in the release's file but not in the bottle.`);
        continue;
      }
      const want = readFileSync(path.join(released, 'package', file));
      const have = readFileSync(path.join(inside, file));
      if (want.equals(have)) continue;
      if (file === 'package.json') {
        // Before it packs the package to install it, Homebrew writes package.json
        // again without the scripts that build it (prepare, prepack, postpack).
        try {
          const wanted = JSON.parse(want.toString());
          for (const script of ['prepare', 'prepack', 'postpack']) delete wanted.scripts?.[script];
          if (isDeepStrictEqual(wanted, JSON.parse(have.toString()))) continue;
        } catch {}
        problems.push("package.json isn't the release's, even without the scripts that build it.");
        continue;
      }
      const wantEnd = want.subarray(0, 2).toString() === '#!' ? want.indexOf('\n') : -1;
      const haveEnd = have.indexOf('\n');
      const sameBody = wantEnd >= 0 && haveEnd >= 0 && want.subarray(wantEnd).equals(have.subarray(haveEnd));
      if (!sameBody || have.subarray(0, haveEnd).toString() !== BOTTLE_SHEBANG) problems.push(`${file} isn't the release's file's.`);
    }
    for (const file of found) problems.push(`${file} is in the bottle but not in the release's file.`);
    return problems;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const fileFromArg = (arg) => readFileSync(arg.startsWith('file:') ? fileURLToPath(arg) : path.resolve(arg));
if (values.bottle && values['no-bottle']) fail('--bottle names a bottle and --no-bottle says to write none: pick one.');

let tarball;
let bottle;
let bottleRelease;
let version = positionals[0];
let release;
const local = values.tarball;
if (local) {
  tarball = fileFromArg(local);
  if (values.bottle) bottle = fileFromArg(values.bottle);
} else {
  if (values.bottle) fail('--bottle goes with --tarball: without it, the bottle is the one on the GitHub release.');
  version ??= project.version;
  const api = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
  // A token isn't needed, but a CI runner shares its address with many others, and GitHub limits what an address may ask for without one.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const meta = await fetch(api, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'tricot-homebrew-formula', ...(token && { authorization: `Bearer ${token}` }) },
  });
  if (meta.status === 404) fail(noRelease(version));
  if (!meta.ok) fail(`GitHub's API answered ${meta.status} for the release v${version} (${api}).`);
  const assets = (await meta.json()).assets ?? [];
  release = assets.find((a) => a.name === asset(version));
  if (!release) fail(noRelease(version));
  if (!values['no-bottle']) {
    bottleRelease = assets.find((a) => a.name === bottleAsset(version));
    if (!bottleRelease) fail(noBottle(version));
  }
  const download = async (name) => {
    const url = `${releaseDir(version)}/${name}`;
    const res = await fetch(url);
    if (res.status === 404) fail(name === asset(version) ? noRelease(version) : noBottle(version));
    if (!res.ok) fail(`Couldn't fetch ${url}: ${res.status}.`);
    return Buffer.from(await res.arrayBuffer());
  };
  tarball = await download(asset(version));
  if (bottleRelease) bottle = await download(bottleAsset(version));
}

const pkg = packageJsonIn(tarball);
version ??= pkg.version;
if (pkg.name !== 'tricot' || pkg.version !== version) fail(`That tarball is ${pkg.name} ${pkg.version}, not tricot ${version}.`);
const sha256 = createHash('sha256').update(tarball).digest('hex');
const bottleSha256 = bottle && createHash('sha256').update(bottle).digest('hex');

if (bottle) {
  const problems = bottleProblems(bottle, tarball, version);
  if (problems.length) {
    fail(`${bottleAsset(version)} isn't a bottle of this release's file:\n${problems.slice(0, 8).map((p) => `  ${p}`).join('\n')}${problems.length > 8 ? `\n  … and ${problems.length - 8} more` : ''}`);
  }
  console.log(`${bottleAsset(version)} holds the release's file as it is, but for the node line at the top of its scripts.`);
}

if (bottleRelease) {
  if (bottleRelease.digest?.startsWith('sha256:')) {
    if (bottleRelease.digest !== `sha256:${bottleSha256}`) fail(`The bottle fetched isn't the one on the GitHub release v${version} (sha256 ${bottleSha256}, GitHub says ${bottleRelease.digest}).`);
    console.log(`Its sha256 matches the digest GitHub gives for ${bottleAsset(version)} on the release v${version}.`);
  } else {
    console.log(`GitHub gives no sha256 digest for ${bottleAsset(version)}, so that check is skipped.`);
  }
}

if (release) {
  if (release.digest?.startsWith('sha256:')) {
    if (release.digest !== `sha256:${sha256}`) fail(`The file fetched isn't the one on the GitHub release v${version} (sha256 ${sha256}, GitHub says ${release.digest}).`);
    console.log(`Its sha256 matches the digest GitHub gives for ${asset(version)} on the release v${version}.`);
  } else {
    console.log(`GitHub gives no sha256 digest for ${asset(version)}, so that check is skipped.`);
  }
  const meta = await fetch(`https://registry.npmjs.org/tricot/${version}`);
  if (meta.status === 404) {
    console.log(`tricot ${version} isn't on npm yet, so there is no npm record to check it against; Homebrew can go first.`);
  } else if (!meta.ok) {
    fail(`The npm registry answered ${meta.status} for tricot ${version}.`);
  } else {
    const { dist } = await meta.json();
    const sha512 = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (!dist?.integrity) fail(`npm gives no integrity for tricot ${version} to check the file against.`);
    if (dist.integrity !== sha512) fail(`The GitHub release's file isn't the one npm has for tricot ${version} (integrity ${sha512}, npm says ${dist.integrity}).`);
    console.log(`It is the file npm has for tricot ${version}: its sha512 matches npm's integrity.`);
  }
}

// The cellar is :any_skip_relocation, which is what `brew bottle` says of this
// bottle: Tricot is plain JavaScript, so there is no binary to relocate, and
// the node line at the top of its scripts is text, filled in on every pour.
const bottleBlock = bottle
  ? `
  bottle do
    root_url "${releaseDir(version)}"
    sha256 cellar: :any_skip_relocation, all: "${bottleSha256}"
  end
`
  : '';

// The flag that skips Tricot's first-run question was --no-hooks up to 0.1.3 and
// is --no-ask after it. The formula's test starts the very release it installs,
// so it names the flag that release has.
function skipFirstRunQuestion(version) {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
  return major > 0 || minor > 1 || (minor === 1 && patch > 3) ? '--no-ask' : '--no-hooks';
}

const formula = `${
  local
    ? `# sha256 of a local npm pack (${path.basename(local)})${values.bottle ? ` and of a local bottle (${path.basename(values.bottle)})` : ''}, not of the GitHub release's file${values.bottle ? 's' : ''}:
# run scripts/homebrew-formula.mjs again once the GitHub release v${version} is out.
`
    : ''
}class Tricot < Formula
  desc "${DESC}"
  homepage "${pkg.homepage ?? 'https://tricotstudio.com'}"
  url "${releaseUrl(version)}"
  sha256 "${sha256}"
  license "${pkg.license}"

  livecheck do
    url :stable
    strategy :github_latest
  end
${bottleBlock}
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tricot --version")

    port = free_port
    pid = spawn bin/"tricot", "--port", port.to_s, "--no-open", "${skipFirstRunQuestion(version)}", "--no-update-check",
                "--data", testpath/"boards"
    begin
      info = shell_output("curl --silent --retry 15 --retry-connrefused --retry-delay 1 http://127.0.0.1:#{port}/api/info")
      assert_equal "tricot", JSON.parse(info)["app"]
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
`;

mkdirSync(path.dirname(values.out), { recursive: true });
writeFileSync(values.out, formula);
console.log(`Wrote the formula for tricot ${version} (sha256 ${sha256}${bottle ? `, bottle sha256 ${bottleSha256}` : ', no bottle'}) to ${path.relative(root, values.out)}.`);
if (local) console.log(`From local files: run this again once the GitHub release v${version} is out.`);
else if (!bottle) console.log('No bottle: Homebrew builds this from source, and stops on an Xcode or Command Line Tools that are not recent. Run the Bottle workflow for this tag, then this script again, to fix that.');
else console.log('Next: copy it to Formula/tricot.rb in TricotStudio/homebrew-tap, commit and push (RELEASING.md).');
