#!/usr/bin/env bash
# The Homebrew bottle of a release, made on the Mac the release is made on and
# attached to the GitHub release: tricot-<version>.all.bottle.tar.gz, next to
# tricot-<version>.tgz. A person runs it, once the Release workflow has attached
# the package to the release (it downloads it): it runs brew, which an agent
# doesn't.
#
#   bash scripts/bottle-on-this-mac.sh 0.0.2
#
# Tricot must not be installed with Homebrew while it runs (brew uninstall
# tricot first; brew install tricotstudio/tap/tricot again once the tap has the
# new formula).
#
# It builds Tricot from the release's own package in a throwaway tap
# (local/bottle), tests it, bottles it, checks the bottle holds that very
# package (scripts/homebrew-formula.mjs), pours it as someone installing it
# would and tests it again, then attaches the bottle to the release. It takes
# the throwaway tap and that Tricot away again at the end, whatever happens.
# Next: node scripts/homebrew-formula.mjs <version> writes the formula with the
# bottle (RELEASING.md).
#
# brew bottle is one of Homebrew's developer commands, which may turn on its
# developer mode for this Mac: `brew developer off` turns it off again.
set -euo pipefail

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Say the release's version, like: bash scripts/bottle-on-this-mac.sh 0.0.2" >&2
  exit 1
fi
TAG="v$VERSION"
REPO=TricotStudio/tricot
TAP=local/bottle

if [ "$(uname -s)" != Darwin ]; then
  echo "A bottle is made on a Mac, as Homebrew's bottle tooling is." >&2
  exit 1
fi
for tool in brew gh node; do
  command -v "$tool" > /dev/null || { echo "This needs $tool on the PATH." >&2; exit 1; }
done
if brew list --formula tricot > /dev/null 2>&1; then
  echo "Tricot is installed with Homebrew on this Mac, and the bottle is built by installing it from a tap of its own." >&2
  echo "Uninstall it first (brew uninstall tricot), then install it again from the tap once its formula has the bottle." >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
export HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_AUTO_UPDATE=1
# Uninstalling Tricot must leave node, which pouring it needs again.
export HOMEBREW_NO_AUTOREMOVE=1
# The formula script reads the release's files from GitHub; a token keeps it clear of the rate limit.
export GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token 2> /dev/null || true)}"

cleanup() {
  brew uninstall --formula "$TAP/tricot" > /dev/null 2>&1 || true
  brew untap "$TAP" > /dev/null 2>&1 || true
}
trap cleanup EXIT
brew untap "$TAP" > /dev/null 2>&1 || true

echo "== The formula, from the release's package, in a throwaway tap"
brew tap-new --no-git "$TAP"
# A recent Homebrew loads formulae from a tap only once told to trust it. This one is ours, for this run.
if brew trust --help > /dev/null 2>&1; then brew trust "$TAP"; fi
formula="$(brew --repository "$TAP")/Formula/tricot.rb"
node "$root/scripts/homebrew-formula.mjs" "$VERSION" --no-bottle --out "$formula"

echo "== Build it, test it, bottle it"
brew install --build-bottle "$TAP/tricot"
brew test "$TAP/tricot"
cd "$work"
brew bottle --no-rebuild "$TAP/tricot"
# brew names it for this Mac, such as tricot--0.0.2.arm64_sequoia.bottle.tar.gz. The
# same file serves as the "all" bottle, as Tricot is the same on every Mac.
made=(tricot--*.bottle.tar.gz)
if [ "${#made[@]}" -ne 1 ] || [ ! -f "${made[0]}" ]; then
  echo "Expected one bottle from brew bottle, found: ${made[*]}" >&2
  exit 1
fi
bottle="tricot-$VERSION.all.bottle.tar.gz"
cp "${made[0]}" "$bottle"

echo "== Check it holds the release's package"
gh release download "$TAG" -R "$REPO" -p "tricot-$VERSION.tgz"
node "$root/scripts/homebrew-formula.mjs" --tarball "tricot-$VERSION.tgz" --bottle "$bottle" --out "$work/formula-check.rb"

echo "== Pour it, as someone installing it would, and test it"
sed "s|^\( *root_url \)\".*\"|\1\"file://$work\"|" "$work/formula-check.rb" > "$formula"
grep -q "root_url \"file://$work\"" "$formula"
brew uninstall --formula "$TAP/tricot"
brew install "$TAP/tricot" 2>&1 | tee pour.log
grep -Eq "Pouring tricot-{1,2}$VERSION\.all\.bottle\.tar\.gz" pour.log
brew test "$TAP/tricot"

echo "== Attach it to the release"
gh release upload "$TAG" -R "$REPO" "$bottle" --clobber
echo "$bottle is on the release $TAG (sha256 $(shasum -a 256 "$bottle" | cut -d' ' -f1))."
echo "Next: node scripts/homebrew-formula.mjs $VERSION writes the formula with it (RELEASING.md)."
