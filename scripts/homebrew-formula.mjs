// Writes the Homebrew formula for a version of tricot that is on npm:
// packaging/homebrew/Formula/tricot.rb, which goes to the tap repository
// (TricotStudio/homebrew-tap on GitHub) so people can `brew install tricotstudio/tap/tricot`.
// RELEASING.md says when.
//
//   node scripts/homebrew-formula.mjs [version]                 after npm publish (default: package.json's version)
//   node scripts/homebrew-formula.mjs --tarball tricot-x.y.z.tgz
//                                                               to try it on a local npm pack (a path or a file:// URL)
//
// The formula installs the npm registry's tarball, as Homebrew's Node formulae
// do. This fetches that tarball, checks it is the one npm has (its sha512
// against the registry's integrity) and that it is that version of tricot,
// and writes the formula with its sha256. With --tarball the sha256 is the
// local file's, which needn't match what npm publish uploads, so the formula
// says so in a comment, and this is to be run again once it is published.
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

const registryUrl = (version) => `https://registry.npmjs.org/tricot/-/tricot-${version}.tgz`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// The package.json inside a tarball.
function packageJsonIn(tarball) {
  const read = spawnSync('tar', ['-xzOf', '-', 'package/package.json'], { input: tarball, encoding: 'utf8', maxBuffer: 1e7 });
  if (read.status !== 0) fail(`That isn't an npm tarball with a package.json: ${read.stderr}`);
  return JSON.parse(read.stdout);
}

let tarball;
let version = positionals[0];
const local = values.tarball;
if (local) {
  tarball = readFileSync(local.startsWith('file:') ? fileURLToPath(local) : path.resolve(local));
} else {
  version ??= JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const meta = await fetch(`https://registry.npmjs.org/tricot/${version}`);
  if (meta.status === 404) fail(`tricot ${version} isn't on npm yet. Publish it first (RELEASING.md), then run this again.`);
  if (!meta.ok) fail(`The npm registry answered ${meta.status} for tricot ${version}.`);
  const { dist } = await meta.json();
  const res = await fetch(registryUrl(version));
  if (!res.ok) fail(`Couldn't fetch ${registryUrl(version)}: ${res.status}.`);
  tarball = Buffer.from(await res.arrayBuffer());
  const sha512 = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (dist?.integrity && dist.integrity !== sha512) fail(`The tarball fetched isn't the one npm has for tricot ${version} (integrity ${sha512}, npm says ${dist.integrity}).`);
}

const pkg = packageJsonIn(tarball);
version ??= pkg.version;
if (pkg.name !== 'tricot' || pkg.version !== version) fail(`That tarball is ${pkg.name} ${pkg.version}, not tricot ${version}.`);
const sha256 = createHash('sha256').update(tarball).digest('hex');

const formula = `${
  local
    ? `# sha256 of a local npm pack (${path.basename(local)}), not of the published tarball:
# run scripts/homebrew-formula.mjs again once tricot ${version} is on npm.
`
    : ''
}class Tricot < Formula
  desc "${DESC}"
  homepage "${pkg.homepage ?? 'https://tricotstudio.com'}"
  url "${registryUrl(version)}"
  sha256 "${sha256}"
  license "${pkg.license}"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tricot --version")

    port = free_port
    pid = spawn bin/"tricot", "--port", port.to_s, "--no-open", "--data", testpath/"boards"
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
console.log(local ? 'From a local tarball: run this again once the version is on npm.' : 'Next: copy it to Formula/tricot.rb in TricotStudio/homebrew-tap, commit and push (RELEASING.md).');
