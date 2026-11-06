import { currentOs, isWindows } from './os';
import { runProgram } from './run';

// What opens an address in this machine's browser: $BROWSER when it is set, else the system's opener.
//
// On Windows that is rundll32's FileProtocolHandler, which takes the address
// as an argument of its own and starts the default browser. `cmd /c start`
// would put the address through cmd.exe, which reads & | ^ % in it, and
// Node's quoting of the empty title it asks for ("") is not one cmd.exe
// understands. Only a web address is opened that way: the same call
// would run a file, and the address of a file is not Tricot's to open. It is
// handed over as the URL parser writes it, which has no space or quote in it.
export function openCommand(url: string, env: { BROWSER?: string }, os: NodeJS.Platform = currentOs()): { command: string; args: string[] } | undefined {
  if (env.BROWSER) return { command: env.BROWSER, args: [url] };
  if (os === 'darwin') return { command: 'open', args: [url] };
  if (!isWindows(os)) return { command: 'xdg-open', args: [url] };
  try {
    const address = new URL(url);
    if (address.protocol !== 'http:' && address.protocol !== 'https:') return undefined;
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', address.href] };
  } catch {
    return undefined;
  }
}

// Opens an address in this machine's browser: $BROWSER when it is set ('none'
// opens nothing), else the system's opener. `unopened` is told when it can't.
export function openUrl(url: string, env: { BROWSER?: string }, unopened: (url: string) => void, os: NodeJS.Platform = currentOs()): void {
  if (env.BROWSER === 'none') return;
  const opener = openCommand(url, env, os);
  if (!opener) {
    unopened(url);
    return;
  }
  // The browser is a window of its own: on Windows it is not started hidden.
  const child = runProgram(opener.command, opener.args, { stdio: 'ignore', detached: true, windowsHide: false });
  child.on('error', () => unopened(url));
  child.unref();
}
