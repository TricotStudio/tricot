// The release skill's pure logic (SKILL.md beside it; release.mjs runs it):
// reading and bumping versions, suggesting the next one from the commits since
// the last tag, checking release notes and writing them into package.json, and
// the release commit's message. Nothing here runs git or touches the network,
// so test/releaseSkill.test.ts covers it all.

// The update notice cuts releaseNotes past this many characters, after
// joining its lines into one paragraph (shortNotes in src/server/updates.ts).
export const NOTES_MAX = 280;

export const BUMPS = ['patch', 'minor', 'major'];
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

// Semver as src/core/version.ts reads it: major.minor.patch, an optional
// pre-release after "-", optional build metadata after "+".
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text) {
  if (typeof text !== 'string') return undefined;
  const match = SEMVER.exec(text);
  if (!match) return undefined;
  const [, major, minor, patch, pre, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: pre ? pre.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
    build: build ?? '',
  };
}

// Semver precedence, as compareVersions in src/core/version.ts: below 0, a is older.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`);
  const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (core !== 0) return Math.sign(core);
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return Math.sign(p - q);
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// The next version of that kind, as `npm version <kind>` makes it: from a
// pre-release, the release it leads to when that is of the kind asked
// (1.2.0-beta.1 with minor is 1.2.0).
export function bumpVersion(current, kind) {
  const v = parseVersion(current);
  if (!v) throw new Error(`Not a version: ${current}`);
  if (!BUMPS.includes(kind)) throw new Error(`Not a kind of bump: ${kind} (patch, minor or major)`);
  const pre = v.pre.length > 0;
  if (kind === 'major') return pre && v.minor === 0 && v.patch === 0 ? `${v.major}.0.0` : `${v.major + 1}.0.0`;
  if (kind === 'minor') return pre && v.patch === 0 ? `${v.major}.${v.minor}.0` : `${v.major}.${v.minor + 1}.0`;
  return pre ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`;
}

// What one commit asks of the version: major (it breaks something), minor (a
// new or changed feature), patch (a fix), or none (docs, tests, CI, release
// bookkeeping). It reads Conventional Commits prefixes when there are any,
// and otherwise the plain-words subjects this repository uses, where a
// subject that isn't a fix or housekeeping reads as a feature. A starting
// point only: SKILL.md has the agent read the subjects and judge.
export function classifyCommit({ subject, body = '' }) {
  const s = subject.trim();
  const conventional = /^(\w+)(?:\([^)]*\))?(!)?:\s/.exec(s);
  if (conventional?.[2] || /^BREAKING[ -]CHANGES?\b/m.test(body) || /\bbreaking\b/i.test(s)) {
    return { kind: 'major', why: 'says it breaks something' };
  }
  if (/^Tricot v?\d+\.\d+\.\d+/.test(s) || /^Homebrew formula for /i.test(s) || /^Merge\b/.test(s)) {
    return { kind: 'none', why: 'release bookkeeping' };
  }
  if (conventional) {
    const type = conventional[1].toLowerCase();
    if (type === 'feat') return { kind: 'minor', why: 'a feature' };
    if (['fix', 'perf', 'revert'].includes(type)) return { kind: 'patch', why: 'a fix' };
    if (['docs', 'test', 'tests', 'ci', 'build', 'chore', 'style', 'refactor'].includes(type)) {
      return { kind: 'none', why: 'nothing people using Tricot see' };
    }
  }
  if (/\b(README|RELEASING|CONTRIBUTING|CHANGELOG)\b/.test(s) || /^(docs?|documentation|tests?|ci|typos?)\b/i.test(s)) {
    return { kind: 'none', why: 'docs, tests or CI' };
  }
  if (/\b(fix|fixes|fixed|bug|bugs|crash|crashes|crashed|regression|broken|again|no longer|doesn't|don't|didn't)\b/i.test(s)) {
    return { kind: 'patch', why: 'reads as a fix' };
  }
  return { kind: 'minor', why: 'reads as a new or changed feature' };
}

// The kind of release these commits call for, and why. Before 1.0.0 a
// breaking change bumps the minor version (0.1.x to 0.2.0), as npm's ^0.y
// ranges expect; going to 1.0.0 is a choice to make on purpose.
export function suggestBump(commits, current) {
  const classified = commits.map((commit) => ({ ...commit, ...classifyCommit(commit) }));
  const top = classified.reduce((best, c) => (RANK[c.kind] > RANK[best] ? c.kind : best), 'none');
  const v = parseVersion(current);
  let kind = top;
  let reason;
  if (top === 'none') {
    kind = 'patch';
    reason = 'nothing since the last release reads as user-facing, so a patch, if a release is wanted at all';
  } else if (top === 'major' && v && v.major === 0) {
    kind = 'minor';
    reason = 'a change says it breaks something; before 1.0.0 that is a minor bump (ask for major to go to 1.0.0)';
  } else {
    reason = { major: 'a change says it breaks something', minor: 'there are new or changed features', patch: 'there are only fixes' }[top];
  }
  return { kind, reason, commits: classified };
}

// The version to release: `wanted` is a version (with or without the "v"), a
// kind of bump, or empty for the suggested kind. { version } or { error }.
export function resolveTarget(current, wanted, suggested) {
  const ask = (wanted ?? '').trim();
  if (!parseVersion(current)) return { error: `package.json's version, ${current}, isn't a version.` };
  if (!ask || BUMPS.includes(ask.toLowerCase())) return { version: bumpVersion(current, ask ? ask.toLowerCase() : suggested) };
  const text = ask.replace(/^v/, '');
  const v = parseVersion(text);
  if (!v) return { error: `"${ask}" isn't a version (like 0.2.0) or a kind of bump (patch, minor or major).` };
  if (v.build) return { error: `Leave out the build metadata ("+${v.build}"): npm drops it, so the tag wouldn't match.` };
  if (compareVersions(text, current) <= 0) return { error: `${text} isn't after ${current}, package.json's version.` };
  return { version: text };
}

// Problems with release notes, for the update notice ("What's new in x.y.z",
// one plain paragraph of at most NOTES_MAX characters) and the top of the
// GitHub release. Errors stop it being written; warnings are for the person.
export function checkNotes(text) {
  const raw = typeof text === 'string' ? text : '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  const errors = [];
  const warnings = [];
  if (!flat) errors.push('The notes are empty: write a line or two on what changed for people who use Tricot.');
  if (flat.length > NOTES_MAX) {
    errors.push(`They are ${flat.length} characters, and the update notice shows ${NOTES_MAX} at most, cutting the rest: shorten them.`);
  }
  if (/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i.test(flat)) errors.push('Leave out commit hashes: people read these in the update notice.');
  if (/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/m.test(raw) || /`|\*\*|__|\[[^\]]+\]\([^)]+\)/.test(raw)) {
    warnings.push('The notice shows plain text in one paragraph, so Markdown (lists, headings, code, links) shows as typed.');
  }
  if (/\bT\d+\b|(^|[\s(])#\d+\b/.test(flat)) warnings.push("People who use Tricot don't see the board's task and decision numbers: say what changed instead.");
  if (/\n/.test(raw.trim())) warnings.push('Line breaks become spaces: the notes are kept as one paragraph.');
  return { flat, errors, warnings };
}

// package.json's text with releaseNotes set, kept where it is or put after
// "description", in the file's own indent and final newline.
export function withReleaseNotes(json, notes) {
  const pkg = JSON.parse(json);
  const indent = /^[{[]\r?\n([ \t]+)/.exec(json)?.[1] ?? '  ';
  let out;
  if (Object.hasOwn(pkg, 'releaseNotes') || !Object.hasOwn(pkg, 'description')) {
    out = { ...pkg, releaseNotes: notes };
  } else {
    out = {};
    for (const [key, value] of Object.entries(pkg)) {
      out[key] = value;
      if (key === 'description') out.releaseNotes = notes;
    }
  }
  return JSON.stringify(out, null, indent) + (/\n$/.test(json) ? '\n' : '');
}

// Lines of at most `width` characters, broken between words.
export function wrap(text, width = 72) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// The release commit's message: "Tricot x.y.z", the notes, and the trailer
// (Co-Authored-By) when an agent makes it.
export function releaseCommitMessage(version, notes, trailer) {
  const parts = [`Tricot ${version}`];
  const body = (notes ?? '').replace(/\s+/g, ' ').trim();
  if (body) parts.push(wrap(body));
  if (trailer?.trim()) parts.push(trailer.trim());
  return `${parts.join('\n\n')}\n`;
}

// What the person runs to send the release out; agents never push.
export const pushCommand = (version) => `git push origin main && git push origin v${version}`;

// "owner/repo" from package.json's repository, when it is on GitHub, read as
// githubRepo in src/server/updates.ts reads it.
export function githubRepo(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (typeof url !== 'string') return undefined;
  const match = /^(?:github:|(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}
