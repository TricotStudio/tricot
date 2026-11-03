# Releasing Tricot

Tricot ships on npm as `tricot` (people run `npm install -g tricot`, then `tricot`) and through a Homebrew tap (`brew install tricotstudio/tap/tricot`). Its source is public at https://github.com/TricotStudio/tricot, and the tap is https://github.com/TricotStudio/homebrew-tap. A person publishes, tags and pushes; agents never do.

## Before a release

1. The version is in `package.json`. For a later release, `npm version <x.y.z>` sets it and makes the commit and its tag.
2. `npm test` and `npm run typecheck` pass.
3. `npm run smoke:release` passes. It builds and packs the package, checks what ships (nothing private, nothing missing), installs it globally into `.review/smoke/` with a fresh home and data folder, offline, runs that `tricot` on port 5055, and in headless Chrome goes through the first run with a stand-in agent. It needs Chrome (or `CHROME_PATH`). Its screenshots are in `.review/smoke/shots/`.
4. The build lists any library whose licence needs a look ("Licence to look at"), and stops at one that can't ship: code under the Eclipse Public License without the GPL offered beside it. That is why the web page leaves out Mermaid's ELK layout and its elkjs (#86): diagrams are drawn with Mermaid's dagre layout instead (`scripts/elkLeftOut.ts`). `THIRD_PARTY_NOTICES.md` is written by the build and ships in the package.

## Push to GitHub

Push `main` and the release's tag, and nothing else. Never `git push --all` or `--mirror`: the branches agents work on stay on this machine.

```sh
git remote add origin https://github.com/TricotStudio/tricot.git   # once, if origin isn't set
git push -u origin main         # the first time; after that, git push origin main
git push origin v<version>      # the tag that npm version (or git tag) made
```

Push the tag when the version goes out on npm. The update notice's "What's new in <version>" link opens `https://github.com/TricotStudio/tricot/releases/tag/v<version>`, which it builds from `repository` in `package.json`; a GitHub release on that tag, with its notes, is what people find there.

## Publish to npm

Once per machine, sign in to the npm account that owns `tricot` (with two-factor authentication on, `npm publish` asks for a code):

```sh
npm login
```

Then, from a clean checkout of the tagged commit:

```sh
git switch main && git pull               # the commit to release, with nothing uncommitted
git tag -a v0.1.0 -m "Tricot 0.1.0"       # skip if npm version made the tag
git worktree add ../tricot-v0.1.0 v0.1.0  # a clean checkout of exactly that commit
cd ../tricot-v0.1.0
npm ci                                    # dependencies exactly as locked
npm publish --dry-run                     # builds (prepack) and lists what would ship; uploads nothing
npm publish --access public
git push origin v0.1.0
cd - && git worktree remove ../tricot-v0.1.0
```

Check it: `npm view tricot` shows the version, and `npm install -g tricot && tricot --version` works on a machine that never had it.

## Homebrew

Once: create a public repository named `homebrew-tap` under Tricot Studio on GitHub (`TricotStudio/homebrew-tap`; Homebrew finds `tricotstudio/tap` by that name, as GitHub ignores case). A person does this, not an agent.

Each release, after `npm publish`:

```sh
node scripts/homebrew-formula.mjs   # fetches the published tarball, checks it against npm, writes its sha256
```

It writes `packaging/homebrew/Formula/tricot.rb`. Commit it here, copy it to `Formula/tricot.rb` in `TricotStudio/homebrew-tap`, commit and push there (`git push origin main`). Then `brew install tricotstudio/tap/tricot` installs the new version, and `brew test tricot` runs the formula's test. `brew audit --strict --online tricotstudio/tap/tricot` checks it the way Homebrew does; it turns on Homebrew's developer mode, which `brew developer off` turns off again.

The formula in this repository until then was made from a local `npm pack`, and says so in a comment: its sha256 needn't match the published tarball, so run the script after publishing.
