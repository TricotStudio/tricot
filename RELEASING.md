# Releasing Tricot

Tricot ships on npm as `tricot` (people run `npm install -g tricot`, then `tricot`), through a Homebrew tap (`brew install tricotstudio/tap/tricot`), and as a file on each GitHub release, for networks that block the npm registry. Its source is public at https://github.com/TricotStudio/tricot, and the tap is https://github.com/TricotStudio/homebrew-tap. A person tags, pushes and approves; agents never do.

A release goes in this order: tag the version, push the tag (the release workflow then makes the GitHub release, with the package attached, stages that same file on npm, and makes the Homebrew bottle of it), then approve it on npm and update the Homebrew formula. Those last two can go in either order: the formula takes the files on the GitHub release, so Homebrew doesn't wait for npm's approval. It does wait for the bottle, which the workflow attaches a few minutes after the package.

The GitHub release is the one source. The workflow builds and checks the package once and attaches it there, and npm and Homebrew serve that same file, so what people install is the same byte for byte, whichever way they install it. Homebrew's bottle is that package already installed, and the script that writes the formula checks that every file in it is the release's (but for the node line Homebrew writes at the top of the scripts, and the scripts that build the package, which Homebrew leaves out of package.json).

## Before a release

1. The version is in `package.json`. For a later release, `npm version <x.y.z>` sets it and makes the commit and its tag.
2. `npm test` and `npm run typecheck` pass. The CI workflow (`.github/workflows/ci.yml`) runs both on every pull request and every push to `main`.
3. `npm run smoke:release` passes. It builds and packs the package, checks what ships (nothing private, nothing missing), installs it globally into `.review/smoke/` with a fresh home and data folder, offline, runs that `tricot` on port 5055, and in headless Chrome goes through the first run with a stand-in agent. It needs Chrome (or `CHROME_PATH`). Its screenshots are in `.review/smoke/shots/`.
4. The build lists any library whose licence needs a look ("Licence to look at"), and stops at one that can't ship in Tricot, which is Apache-2.0: code under the GPL or the AGPL, and, while #86 stands, code under the Eclipse Public License. That is why the web page leaves out Mermaid's ELK layout and its elkjs (#86): diagrams are drawn with Mermaid's dagre layout instead (`scripts/elkLeftOut.ts`). `THIRD_PARTY_NOTICES.md` is written by the build and ships in the package, beside `LICENSE` and `NOTICE`.

5. The data version covers what the release adds. A release that adds a block kind or a value of an enum a board holds needs a migration (`src/core/store/migrations.ts`), so an older Tricot is told the data is from a newer one and not left to fail on it; `test/dataShape.test.ts` fails until there is one, and `npx tsx test/dataShape.ts --write` takes the new snapshot once there is. After the tag, `node scripts/db-fixture.mjs v<version>` makes that release's database fixture in `test/fixtures/`, and its version goes in `RELEASES` in `test/releasedData.test.ts`, so every later release is tested on boards it saved.

## Tag and push to GitHub

The tag is `v<version>`. `npm version` makes it; otherwise tag the release commit yourself with `git tag -a v<version> -m "Tricot <version>"`.

Push `main` and the release's tag, and nothing else. Never `git push --all` or `--mirror`: the branches agents work on stay on this machine.

```sh
git remote add origin https://github.com/TricotStudio/tricot.git   # once, if origin isn't set
git push -u origin main         # the first time; after that, git push origin main
git push origin v<version>      # the tag; this starts the release workflow
```

## The GitHub release

Pushing the tag runs the release workflow (`.github/workflows/release.yml`) on GitHub. It checks that the tag is `v` followed by the version in `package.json`, runs `npm ci`, the typecheck and the tests, packs the package with `npm pack` (as `npm publish` would), and runs the clean-machine check on that very file (`npm run smoke:release -- --tarball tricot-<version>.tgz`, with the runner's own Chrome). When all of that passes, it makes the GitHub release for the tag, titled "Tricot <version>", with `tricot-<version>.tgz` attached and short notes: the `releaseNotes` in `package.json` when there are some (the same text the update notice shows), otherwise "Tricot <version>.", followed by the two ways to install it. If the release already exists, it attaches the package to it, replacing an older copy, and keeps any notes someone wrote there. A version with a hyphen, such as `0.2.0-beta.1`, is marked as a pre-release. Then a second job downloads that same file from the release and stages it on npm, where it waits for your approval (next section). A third job, which neither waits for npm nor makes npm wait, makes the Homebrew bottle and attaches it to the release too (the Homebrew section). The workflow holds no secrets. Its first job, which builds, tests and makes the release, uses the repository's own `GITHUB_TOKEN`, allowed to write releases and nothing more, as does the bottle job. The second job can only read the repository, and it runs none of the package's code (no checkout, no `npm ci`, no scripts, no tests). It is the only one that gets GitHub's identity token for the run, which npm exchanges for a short-lived one that can only stage `tricot`.

The update notice's "What's new in <version>" link opens that release (`https://github.com/TricotStudio/tricot/releases/tag/v<version>`, built from `repository` in `package.json`), and its file is what people on networks that block the npm registry install:

```sh
npm install -g https://github.com/TricotStudio/tricot/releases/download/v<version>/tricot-<version>.tgz
```

Tricot bundles everything it needs, so npm fetches nothing else.

The update check reads this release too (`src/install/updates.ts`): once it is published with its file, Tricot offers it to everyone, before npm approves it. An npm install updates from the release's own file, checked against the checksum GitHub shows for it, so it doesn't wait for npm. A Homebrew install can't update until the formula is, and an `npx tricot` until npm has the version: their Update stops short, harmlessly, and leaves the old version running. So approve on npm and update the formula soon after the release. The notice shows the first paragraph of the release's notes, so editing them on GitHub changes what it says.

If the workflow fails before the release, there is no release and npm has nothing yet. If only its npm job fails, the release is there and npm has nothing yet. If only its bottle job fails, the release is there and npm gets the version, but the Homebrew formula can't be written yet (the Homebrew section says what to do). A job that failed by chance can be re-run from the run's page on GitHub: "Re-run failed jobs" re-runs just the npm job when only it failed, which takes the release's file again without rebuilding it. A re-run doesn't stage the version twice. A fix in the code needs a new commit and the tag moved onto it (`git tag -fa v<version> -m "Tricot <version>"`, then `git push -f origin v<version>`), which is fine as long as npm hasn't published that version. If npm has it staged, reject the staged one first (below), so that the new build is staged in its place.

Tricot 0.1.0 came before the workflow: its GitHub release was made by hand, with the package published on npm attached.

## Publish to npm

npm gets the file on the GitHub release, not a second build of it. Once the release is made, the release workflow's npm job downloads that file from it and sends it to npm as a staged version: npm holds it until you approve it with your two-factor code, so nothing reaches `npm install -g tricot` before you do.

The workflow needs no npm token or secret, because npm trusts it as `tricot`'s trusted publisher, and it can only stage. The npm job installs npm 11.21.1 first, since staging this way needs npm 11.15.0 or later and Node 22 comes with npm 10. npm uploads the file unchanged (it builds nothing and runs none of the package's scripts) and adds provenance by itself: a signed record, shown on the package's page on npmjs.com, that this file was built by the release workflow from the tagged commit of TricotStudio/tricot.

### Once: make the release workflow tricot's trusted publisher

On npmjs.com, signed in to the account that owns `tricot`, open the package's settings, find "Trusted Publisher" and choose GitHub Actions. Fill in:

- Organization or user: `TricotStudio`
- Repository: `tricot`
- Workflow filename: `release.yml` (the name only, not its path)
- Environment name: leave it empty

Under "Allowed actions", staging (`npm stage publish`) is always allowed. Leave direct `npm publish` off, and `npm dist-tag` too, so the workflow can only stage. Every field is case-sensitive, and npm doesn't check them when you save: a mistake only shows when the workflow stages, as an ENEEDAUTH or 404 error in its npm job.

npm expires a new trusted publisher that hasn't been used within 2 days, so add it shortly before pushing the next version's tag. If it lapses, delete it and add it again.

npm also requires `repository.url` in `package.json` to match the GitHub repository exactly, case included. It does (`git+https://github.com/TricotStudio/tricot.git`); keep it that way.

### Each release: approve it

When the release workflow has finished, the version is staged. The npm job's notice, on the run's page, gives the id and the file's shasum. Approve it on npmjs.com (the package's Staged Packages tab), or from a terminal signed in to npm (`npm login`, once per machine):

```sh
npm stage list tricot                   # what is staged, with each one's id and shasum
npm stage approve <id> --otp=<code>     # releases it; the code is from your authenticator
```

Before approving, check that the shasum npm shows is the one in the workflow's notice, which is the release file's SHA-1 (`shasum tricot-<version>.tgz` on a downloaded copy gives the same). If it isn't, reject it with `npm stage reject <id> --otp=<code>` and re-run the workflow's npm job from the run's page, which stages the release's file in its place. npm keeps one staged version per version number, so the workflow leaves an existing one alone and says so.

A version with a hyphen, such as `0.2.0-beta.1`, is staged under the `next` tag instead of `latest`, so that `npm install -g tricot` keeps installing the last full release.

Once it's approved, check it: `npm view tricot` shows the version, and `npm install -g tricot && tricot --version` works on a machine that never had it.

### If the workflow can't stage it

Publish the release's file by hand: in an empty folder, signed in to npm (`npm login`), download it and publish it as it is. npm asks for your two-factor code, or stages it for approval as above.

```sh
v=0.2.0                                     # the version being released
curl -fLO https://github.com/TricotStudio/tricot/releases/download/v$v/tricot-$v.tgz
npm publish tricot-$v.tgz --access public
```

## Homebrew

Once: create a public repository named `homebrew-tap` under Tricot Studio on GitHub (`TricotStudio/homebrew-tap`; Homebrew finds `tricotstudio/tap` by that name, as GitHub ignores case). A person does this, not an agent.

### The bottle

`brew install tricotstudio/tap/tricot` should unpack a bottle: the package as Homebrew installs it, ready to use. A formula without a bottle counts as a build from source, and before it builds anything Homebrew checks that Xcode and the Command Line Tools are recent, and stops with "Your Xcode is too outdated" if they are not, though Tricot has nothing to compile (T203). A bottle is poured without those checks, and without running `npm install`. Tricot is plain JavaScript, so its bottle is one file for every macOS and architecture (Homebrew's `all` tag): `tricot-<version>.all.bottle.tar.gz` on the GitHub release, named in the formula by a `bottle do` block whose `root_url` is the release's download folder. (An Intel Mac still needs developer tools of any version, to sign files, and `brew install` still brings node.)

The release workflow's `bottle` job makes it, on a Mac, once the release exists (`.github/workflows/bottle.yml`; it holds no secret, and nothing in it touches the tap or npm). It writes the formula without a bottle block (`node scripts/homebrew-formula.mjs <version> --no-bottle`) into a throwaway tap, builds it the way Homebrew does for a bottle (`brew install --build-bottle`, `brew test`, `brew bottle`), pours the result as someone installing it would (the log must say "Pouring tricot-<version>.all.bottle.tar.gz") and tests that, checks that it holds the release's package, and attaches it to the release.

If the job fails, "Re-run failed jobs" on the run's page tries again. The same workflow also runs on its own for any release, which is how a release from before there were bottles gets one (0.1.3 and earlier): on the Actions page, Bottle, "Run workflow" with the tag, or

```sh
gh workflow run bottle.yml -f tag=v0.1.3
```

### Each version: the formula

Once the GitHub release has its package and its bottle (npm needn't have the version yet):

```sh
node scripts/homebrew-formula.mjs   # fetches the release's package and bottle, checks them against GitHub's digests and npm's record, writes the formula with their sha256
```

The formula installs `tricot-<version>.tgz` from the GitHub release `v<version>`, the same file npm gets, when Homebrew has to build from source (`brew install --build-from-source`), and names the release's bottle for the rest. The script downloads both. It checks that the package is that version of tricot, that its sha256 is the digest GitHub gives for it, and, once npm has the version, that it is the file npm has (its sha512 against npm's integrity). It checks the bottle's sha256 against GitHub's digest too, and that the package inside is the release's file, file by file. If npm doesn't have the version yet, it says so and carries on. If the release isn't there yet, it says so and stops: push the tag, let the release workflow finish, and run it again. The same if the bottle isn't there: the bottle job takes a few minutes after the package, and is run again as above if it failed. `--no-bottle` writes the formula without a bottle, which makes Homebrew build from source and ask for a recent Xcode: only for a release that can't have one. The formula's livecheck follows GitHub's latest release, so `brew livecheck` sees a new version once its release is out, not as soon as it is tagged.

It writes `packaging/homebrew/Formula/tricot.rb`. Commit it here, copy it to `Formula/tricot.rb` in `TricotStudio/homebrew-tap`, commit and push there (`git push origin main`). Then `brew install tricotstudio/tap/tricot` installs the new version (its output says "Pouring tricot-<version>.all.bottle.tar.gz"), and `brew test tricot` runs the formula's test. `brew audit --strict --online tricotstudio/tap/tricot` checks it the way Homebrew does; it turns on Homebrew's developer mode, which `brew developer off` turns off again.

## The /release skill

In Claude Code, `/release` (the project skill in `.claude/skills/release`) walks through all of this with you: it checks that `main` is ready, proposes the version and the release notes, makes the version commit and tag, watches the Release workflow, and updates the Homebrew formula and the tap. It stops for the steps that are yours, the pushes and the npm approval, and gives you each command to run. `/release 0.2.0` or `/release minor` names the version; with nothing after it, it suggests one. Until the public launch it suggests the next 0.1.x whatever the commits call for (#90); at the launch, set `PRE_LAUNCH` to `false` in `.claude/skills/release/lib.mjs`, and it suggests a minor version for new features again.
