// Writes the Homebrew formula for a version of tricot that has its GitHub release:
// packaging/homebrew/Formula/tricot.rb, which goes to the tap repository
// (TricotStudio/homebrew-tap on GitHub) so people can `brew install tricotstudio/tap/tricot`.
// RELEASING.md says when.
//
//   node scripts/homebrew-formula.mjs [version]                 once the GitHub release v<version> is out (default: package.json's version)
//   node scripts/homebrew-formula.mjs --tarball tricot-x.y.z.tgz
//                                                               to try it on a local npm pack (a path or a file:// URL)
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
// The formula's livecheck follows GitHub's latest release rather than the
// tags: a tag comes before its release (the workflow takes a while, and can
// fail), and the formula's file is only there once the release is.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tarball: { type: 'string' },
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
// way githubRepo in src/server/updates.ts reads it (that one is TypeScript,
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
const releaseUrl = (version) => `https://github.com/${repo}/releases/download/v${version}/${asset(version)}`;
const noRelease = (version) =>
  `There's no GitHub release v${version} with ${asset(version)} yet. Push the tag and let the release workflow finish (RELEASING.md), then run this again.`;

// The package.json inside a tarball.
function packageJsonIn(tarball) {
  const read = spawnSync('tar', ['-xzOf', '-', 'package/package.json'], { input: tarball, encoding: 'utf8', maxBuffer: 1e7 });
  if (read.status !== 0) fail(`That isn't an npm tarball with a package.json: ${read.stderr}`);
  return JSON.parse(read.stdout);
}

let tarball;
let version = positionals[0];
let release;
const local = values.tarball;
if (local) {
  tarball = readFileSync(local.startsWith('file:') ? fileURLToPath(local) : path.resolve(local));
} else {
  version ??= project.version;
  const api = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
  const meta = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'tricot-homebrew-formula' } });
  if (meta.status === 404) fail(noRelease(version));
  if (!meta.ok) fail(`GitHub's API answered ${meta.status} for the release v${version} (${api}).`);
  release = (await meta.json()).assets?.find((a) => a.name === asset(version));
  if (!release) fail(noRelease(version));
  const res = await fetch(releaseUrl(version));
  if (res.status === 404) fail(noRelease(version));
  if (!res.ok) fail(`Couldn't fetch ${releaseUrl(version)}: ${res.status}.`);
  tarball = Buffer.from(await res.arrayBuffer());
}

const pkg = packageJsonIn(tarball);
version ??= pkg.version;
if (pkg.name !== 'tricot' || pkg.version !== version) fail(`That tarball is ${pkg.name} ${pkg.version}, not tricot ${version}.`);
const sha256 = createHash('sha256').update(tarball).digest('hex');

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

const formula = `${
  local
    ? `# sha256 of a local npm pack (${path.basename(local)}), not of the GitHub release's file:
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

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tricot --version")

    port = free_port
    pid = spawn bin/"tricot", "--port", port.to_s, "--no-open", "--no-hooks", "--no-update-check",
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
console.log(`Wrote the formula for tricot ${version} (sha256 ${sha256}) to ${path.relative(root, values.out)}.`);
console.log(local ? `From a local tarball: run this again once the GitHub release v${version} is out.` : 'Next: copy it to Formula/tricot.rb in TricotStudio/homebrew-tap, commit and push (RELEASING.md).');
