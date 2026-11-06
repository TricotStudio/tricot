// Tricot's version numbers, as npm writes them (semver: 0.2.0, 1.0.0-beta.2),
// and which of two is newer. The update check (install/updates.ts), the
// `tricot update` command and the page's notice all compare them here.

// major.minor.patch, an optional pre-release after "-", and optional build
// metadata after "+", which says nothing about order. Nothing else: this is
// also what makes a version safe to put in `tricot@<version>`.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  // The pre-release's dot-separated parts, numbers as numbers: [] for a release.
  pre: (string | number)[];
}

export function parseVersion(text: unknown): Version | undefined {
  if (typeof text !== 'string' || text.length > 256) return undefined;
  const match = SEMVER.exec(text);
  if (!match) return undefined;
  const [, major, minor, patch, pre] = match;
  const numbers = [major, minor, patch].map(Number);
  if (!numbers.every(Number.isSafeInteger)) return undefined;
  return {
    major: numbers[0],
    minor: numbers[1],
    patch: numbers[2],
    pre: pre ? pre.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  };
}

export const isVersion = (text: unknown): text is string => parseVersion(text) !== undefined;

export const isPrerelease = (text: string): boolean => (parseVersion(text)?.pre.length ?? 0) > 0;

// Semver precedence: below 0, a is older; above 0, newer. A pre-release comes
// before its release (1.0.0-beta < 1.0.0); its parts compare one by one,
// numbers below words. Throws on a version it can't read.
export function compareVersions(a: string, b: string): number {
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

// Is `latest` an update for someone running `current`? A pre-release is
// offered only to someone already on one; anything unreadable is not.
export function isNewer(latest: string, current: string): boolean {
  if (!isVersion(latest) || !isVersion(current)) return false;
  if (isPrerelease(latest) && !isPrerelease(current)) return false;
  return compareVersions(latest, current) > 0;
}
