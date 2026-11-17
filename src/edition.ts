// The one place that chooses which Tricot starts, and the one place that knows a fuller edition may be there: the
// server's entries (cli/boardCommands.ts, server/runFromSource.ts) and the terminal's (cli/tricot.ts) take their edition
// from here and import none of that edition's files themselves; startServer, createApp and runSwitcher build what they are
// given and nothing else. `tricot canvas` and `npm run canvas` are Canvas, always. `tricot`, `tricot start` and
// `npm start` are the edition of that file where it is there, and Canvas where it is not.
import { boardCardKinds, useBoardCards } from './core/cards';
import { CANVAS_TITLE, canvasEdition } from './server/canvasEdition';
import type { SwitcherEdition } from './cli/switcher/run';
import type { Edition } from './server/start';

// What the edition file (src/editionFull.ts) gives: its server edition and its terminal.
interface FullEditionFile {
  fullEdition(): Edition;
  fullSwitcher: SwitcherEdition;
  fullTitle: string;
}

// The lookup, of one file of ours at one fixed path, made when that edition is first asked for: there, it is that
// edition; not there, there is none. It is a place for one file and nothing else: no search path, no setting, no name given
// from outside, so it is not a plugin API. An error from inside the file is never "not there": it is thrown, so that
// a broken edition says so instead of starting Canvas. Where the command is bundled (scripts/build-cli.mjs), the import
// is the bundler's own: the file is inside the bundle when it was there to bundle, and the import fails as a missing file
// when it was not.
let fullFile: Promise<FullEditionFile | undefined> | undefined;
const findFull = (): Promise<FullEditionFile | undefined> =>
  (fullFile ??= (
    // A tree without the file has nothing for the compiler to find there.
    // @ts-ignore TS2307
    import('./editionFull') as Promise<FullEditionFile>
  ).catch((error: unknown) => {
    if (isTheFileMissing(error)) return undefined;
    throw error;
  }));

// Whether an import failed because the edition file is not there, and not because a file it imports is.
const isTheFileMissing = (error: unknown): boolean => {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string' && /^Cannot find module '[^']*[\\/]editionFull(?:\.\w+)?'/.test(message);
};

// What startServer is given: Canvas's when `canvas` is asked for or the edition file is not there, else its edition.
export async function editionOf(canvas: boolean): Promise<Edition> {
  const full = canvas ? undefined : await findFull();
  return full ? full.fullEdition() : canvasEdition();
}

// What a person calls an edition, as its own file says it: Canvas's, the edition file's own, and plain "Tricot"
// where that file is not there.
export async function editionTitle(canvas: boolean): Promise<string> {
  return canvas ? CANVAS_TITLE : ((await findFull())?.fullTitle ?? 'Tricot');
}

// What the terminal that runs several agents is given, which is the edition file's whichever edition the board is, where it
// is there: the kinds of card its chat comments on and how its who-line reads them. Otherwise it has the core's cards and reading.
export async function terminalEdition(): Promise<SwitcherEdition> {
  return (await findFull())?.fullSwitcher ?? { cards: [] };
}

// The kinds of card the terminal's edition has, for a command that words what a request for one asks and has no switcher to
// register them (`tricot show`). A process that already has kinds registered keeps them.
export async function useTerminalCards(): Promise<void> {
  if (boardCardKinds().length) return;
  useBoardCards((await terminalEdition()).boardCards ?? []);
}
