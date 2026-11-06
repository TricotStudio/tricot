// Where things are on this computer: the home folder, the temp folder and the
// data folder Tricot keeps its boards in by default.
//
// hooks/tricot-approve.mjs decides the same default folder for itself (it runs
// by itself from an agent's settings and can't import from src/);
// test/platformPaths.test.ts holds the two to the same answer.
import os from 'node:os';
import path from 'node:path';
import { currentOs, isWindows } from './os';

export const DATA_DIR_NAME = '.tricot';

// The home folder as the operating system names it.
export const osHome = (): string => os.homedir();

// The home folder for a process whose environment is given, which the
// command line uses for the agents' settings; the server asks osHome(), and
// the two must name the same folder.
// - Elsewhere: its HOME when set, else the operating system's.
// - On Windows: its USERPROFILE when set, else the operating system's. HOME
//   is not looked at there: Git Bash and other Unix-like tools set it to a
//   folder of their own, or to a /c/Users/... path Node can't use, while
//   the agents keep their settings under %USERPROFILE%, which is also what
//   os.homedir() answers. USERPROFILE stands where HOME does for a test or
//   a caller that gives an environment of its own.
export const home = (env: { HOME?: string; USERPROFILE?: string }, platform: NodeJS.Platform = currentOs()): string =>
  isWindows(platform) ? env.USERPROFILE || osHome() : (env.HOME ?? osHome());

export const tmpDir = (): string => os.tmpdir();

// Tricot's data folder under a home folder.
export const dataDirIn = (homeFolder: string): string => path.join(homeFolder, DATA_DIR_NAME);

// Where boards are kept when nothing says otherwise: ~/.tricot.
export const defaultDataPath = (): string => dataDirIn(osHome());
