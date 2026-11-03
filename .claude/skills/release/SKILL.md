---
name: release
description: Stages a new Tricot release with the person, step by step. Checks main is clean, up to date and green on CI, proposes the next version from the commits since the last tag, writes the update notice's release notes, makes the "Tricot x.y.z" commit and its tag, hands over the push, watches the Release workflow, walks the person through approving on npm, and updates the Homebrew formula and tap. Use when someone asks to release, ship, cut or stage a new version of Tricot.
argument-hint: "[x.y.z | patch | minor | major] [release task, e.g. T170]"
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/release.mjs *) Bash(git status *) Bash(git log *) Bash(git diff *) Bash(git show *) Bash(git fetch *) Bash(git ls-remote *) Bash(gh run list *) Bash(gh run view *) Bash(gh run watch *) Bash(gh release view *) Bash(npm run typecheck) Bash(npm test)
---

# Release Tricot

You are staging a release of Tricot with the person, in nine steps. The arguments may give a version (0.2.0) or a kind of bump (patch, minor or major), and a release task for board notes (T170). With no version, suggest one. Arguments: $ARGUMENTS

RELEASING.md explains the machinery. The helper beside this file, `node ${CLAUDE_SKILL_DIR}/release.mjs`, does the checks, with one command for each step below. Every line it prints starts with `ok`, `warn`, `stop` or `left` (still to do).

## Rules

- **Never** run `git push`, `npm publish`, `npm stage approve`, `npm login`, `npm adduser`, `npm dist-tag`, `gh release create|edit|upload|delete`, `gh run rerun`, `gh workflow run`, or any `brew` command (even `brew audit` turns on Homebrew's developer mode for the whole machine). When one of these is needed, show the exact command for the person to run with the `!` prefix, which runs it in their session (in a terminal, without the `!`), and wait for them.
- **Ask first** before every step that changes something: writing the notes, setting the version, the commit, the tag, the formula and the tap. Say what will happen and that nothing leaves the machine, then wait for a yes.
- **A `stop` line ends the release there.** Tell the person in plain words what is wrong and what fixes it, and don't work around it. Show each `warn` line to the person and go on only if they say so.
- Work in the repository's main checkout, on `main`, from its top folder. In an agent worktree, stop and say the release is made from the main checkout.
- Write to the person as a colleague would: what it means for them first, full sentences, no commit hashes. Keep a short list of the nine steps and say where you are.
- If you stop partway, say exactly what is done and how to undo it (see "Stopping partway" at the end).

## 1. Check that main is ready (read-only)

```sh
node ${CLAUDE_SKILL_DIR}/release.mjs check
```

It checks that you are on `main` with nothing uncommitted, fetches `origin`, and checks that `main` is not behind `origin/main`. It asks GitHub how the last CI run on `main` went (`gh run list --workflow ci.yml --branch main -L 1`), and checks that the last `v*` tag matches package.json's version.

- When `main` is ahead of `origin/main`, the person must confirm that those commits are meant to go out with the release.
- When CI is still running, offer to wait (`gh run watch <id> --repo TricotStudio/tricot --exit-status`), then check again.
- When `gh` isn't installed or signed in, the person can look at the CI page and tell you it passed.

## 2. Pick the version

```sh
node ${CLAUDE_SKILL_DIR}/release.mjs propose [what they asked for]
```

It lists the commits since the last tag with what each reads as (`major`, `minor`, `patch` or `none` for docs, tests, CI and release bookkeeping), and suggests a kind of bump: the biggest among them. Then it checks that the version is after package.json's, that no tag for it exists here or on `origin`, and that npm doesn't have it. Its last line is the version.

The suggestion is only a start. Read the subjects, and the bodies when a subject is unclear (`git log --format='%s%n%b' v<last>..HEAD`), and decide:

- **major**: something that worked stops working (a removed MCP tool, a data folder older versions can't open, a dropped Node version). Before 1.0.0, a breaking change bumps the minor version instead (0.1.x to 0.2.0); 1.0.0 is a deliberate choice.
- **minor**: something people can now do, or a visible change to how something works.
- **patch**: only fixes.

Tell the person the version you propose and why, in a sentence or two, with the other choices. Change nothing until they confirm a version. If they give a different one, run `propose <version>` again to check it.

## 3. Write the release notes

`releaseNotes` in package.json is what the update notice shows under "What's new in x.y.z" (src/server/updates.ts, src/web/update.tsx). It is also the top of the GitHub release. The notice joins it into one plain paragraph and cuts it at 280 characters.

Draft it from the commits since the last tag:

- One to three short sentences, in plain words, for people who use Tricot: what they can do now, or what works better.
- Leave out docs, tests, CI and release tooling.
- No commit hashes, no task or decision numbers (T12, #86), no file or function names, no Markdown: it shows as typed.
- Write fresh notes each time: package.json still holds the last release's notes.

Show the draft to the person and let them change it. Check a draft without writing it with `notes --check -`. When they're happy, write it:

```sh
node ${CLAUDE_SKILL_DIR}/release.mjs notes - <<'EOF'
The notes, as agreed.
EOF
```

It refuses empty notes, notes over 280 characters and notes with commit hashes, and warns about Markdown and board numbers.

## 4. Set the version, commit and tag (on this machine only)

Ask: "I'll set the version to x.y.z, run the typecheck and the tests, then commit 'Tricot x.y.z' and tag vx.y.z here. Nothing leaves this machine. Shall I?"

```sh
npm version x.y.z --no-git-tag-version   # package.json and package-lock.json
npm run typecheck
npm test
```

If `node_modules` is missing, ask before running `npm ci`. If the typecheck or the tests fail, stop: show what failed, and offer to undo the version change (`git restore package.json package-lock.json`, which drops the notes too; they are still in the conversation).

Offer `npm run smoke:release`, the clean-machine check. It takes a few minutes and needs Chrome. It is optional here, because the Release workflow runs it on the tag anyway.

Then commit and tag:

```sh
git add package.json package-lock.json
node ${CLAUDE_SKILL_DIR}/release.mjs message x.y.z --trailer "<your usual Co-Authored-By line>" | git commit -F -
git tag -a vx.y.z -m "Tricot x.y.z"
node ${CLAUDE_SKILL_DIR}/release.mjs verify x.y.z
```

- The commit message is "Tricot x.y.z", then the notes.
- The trailer is the one your session's commits use; earlier commits here end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Leave out `--trailer` when the person makes the commit.
- `verify` checks the versions, the notes, that the commit changes only package.json and package-lock.json, and that the tag is annotated and on that commit.

## 5. Hand over the push

You never push. Give the person this command, as it is:

```
! git push origin main && git push origin vx.y.z
```

Tell them that pushing the tag starts the Release workflow on GitHub. Wait for them to say it's pushed; `git ls-remote --tags origin vx.y.z` confirms it.

## 6. Watch the Release workflow (read-only)

```sh
gh run list --repo TricotStudio/tricot --workflow release.yml -L 5 --json databaseId,headBranch,status,conclusion,url
```

The release's run has `headBranch` set to `vx.y.z`. If it isn't listed yet, look again after half a minute. Then watch it:

```sh
gh run watch <id> --repo TricotStudio/tricot --exit-status
```

The workflow takes several minutes, so run the watch in the background if you can.

- **It passed:** the GitHub release is out with `tricot-x.y.z.tgz` (https://github.com/TricotStudio/tricot/releases/tag/vx.y.z). Go on to steps 7 and 8.
- **It failed:** run `gh run view <id> --repo TricotStudio/tricot --log-failed | tail -n 80`. Show the person the few lines that matter, say which step failed and what it means, and stop with a suggestion:
  - **A failure by chance** (network, runner): the person re-runs it, with `! gh run rerun <id> --failed --repo TricotStudio/tricot`, or from the run's page.
  - **A real problem:** it needs a fix on `main`. The tag can move onto the fix only while npm doesn't have x.y.z. Check with `release.mjs published x.y.z`. With the person's yes, run `git tag -fa vx.y.z -m "Tricot x.y.z"` on the fixed commit, and hand over `! git push origin main && git push -f origin vx.y.z`. If npm already has x.y.z, release the next patch version instead.

## 7. The npm approval (the person's)

npm releases a version only when a person approves it, with two-factor authentication. Look at the run's steps (`gh run view <id> --repo TricotStudio/tricot`).

**If one of the steps staged tricot x.y.z on npm,** tell the person to approve it, on npmjs.com or from a terminal:

```
npm stage list tricot                     # the staged versions, each with its id
! npm stage approve <id> --otp=<code>     # the code is from their authenticator
```

You may run `npm stage list tricot` for them, because it changes nothing. Never approve, log in or publish.

**If no step staged it** (an older workflow), the person publishes the GitHub release's file by hand, as RELEASING.md's "Publish to npm" section says. Point them there.

Homebrew doesn't wait for npm, so go on with step 8 while they approve. `release.mjs published x.y.z` says when npm has it.

## 8. Homebrew

Ask first, then write the formula from the GitHub release's file:

```sh
node scripts/homebrew-formula.mjs x.y.z
git diff packaging/homebrew/Formula/tricot.rb
```

The script downloads `tricot-x.y.z.tgz` from the release and checks it against GitHub's digest, and against npm's record once npm has the version. If it stops, show why and stop too: a mismatch means the files differ, and no formula should go out.

Commit it here:

```sh
git add packaging/homebrew/Formula/tricot.rb
git commit -m "Homebrew formula for x.y.z" -m "<your usual Co-Authored-By line>"
```

The tap is a checkout of TricotStudio/homebrew-tap, usually `../homebrew-tap` beside this repository (for Wassim, `~/Documents/dev/projects/homebrew-tap`). If it isn't there, ask the person where it is. Check that it is clean and on `main`, and that it isn't behind its remote (`git -C <tap> status --short`, `git -C <tap> fetch`, `git -C <tap> status -sb`). Then, with the person's yes, copy the formula and commit:

```sh
cp packaging/homebrew/Formula/tricot.rb <tap>/Formula/tricot.rb
git -C <tap> add Formula/tricot.rb
git -C <tap> commit -m "Update tricot to x.y.z" -m "<your usual Co-Authored-By line>"
```

Hand over both pushes:

```
! git push origin main
! git -C <tap> push origin main
```

Don't run `brew`. The person can try it afterwards with `brew upgrade tricotstudio/tap/tricot` and `brew test tricot`.

## 9. Check that it's out

```sh
node ${CLAUDE_SKILL_DIR}/release.mjs published x.y.z --tap <tap>
```

It checks four things and lists what's left:

- the GitHub release has `tricot-x.y.z.tgz`;
- npm has the version, and it is npm's latest;
- the formula is committed and `main` is pushed;
- the tap has the formula, committed and pushed.

Tell the person in a few sentences what is out and what, if anything, is left for them.

## Board notes (optional)

If the `tricot` MCP tools are connected and the person named a release task, post a short comment on it (the `comment` tool) at these points:

- the version is tagged and waiting for the push;
- the workflow passed, or failed and why;
- the version is waiting on the npm approval;
- the release is out everywhere.

Write one or two plain sentences each time. With no board connected, or no task named, skip this.

## Stopping partway

| Where it stopped | What to undo (ask before running it) |
| --- | --- |
| After step 3 (notes written) | `git restore package.json` |
| After `npm version` in step 4 | `git restore package.json package-lock.json` |
| After step 4 (commit and tag, not pushed) | `git tag -d vx.y.z && git reset --keep HEAD~1` |
| After the push | Nothing locally. Never delete a pushed tag or a GitHub release yourself; step 6 says what to do when the workflow fails. |

To pick a release up again, run `release.mjs verify x.y.z`. If it passes, the release is tagged, so go on from step 5. If `origin` has the tag already, go on from step 6, and `release.mjs published x.y.z` shows what's left.
