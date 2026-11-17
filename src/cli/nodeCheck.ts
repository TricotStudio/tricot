// The Node.js the command needs: 22.13, the first with node:sqlite built in
// and on by default (package.json's engines says the same, and a test keeps
// the two together). An older Node would stop at that import with a stack
// trace, so bin.ts asks this first and says what to do instead.
export const NODE_MIN = '22.13.0';

const parts = (version: string) => version.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

// What to tell the person when `version` is too old to run Tricot; none when it will do.
export function nodeTooOld(version: string): string | undefined {
  const [major, minor, patch] = parts(version);
  const [needMajor, needMinor, needPatch] = parts(NODE_MIN);
  const enough = major !== needMajor ? major > needMajor : minor !== needMinor ? minor > needMinor : patch >= needPatch;
  if (enough) return undefined;
  return `Tricot needs Node.js ${NODE_MIN.replace(/\.0$/, '')} or newer, and this is Node.js ${version.replace(/^v/, '')}. Install a newer Node.js (https://nodejs.org, or your version manager), then run tricot again.`;
}
