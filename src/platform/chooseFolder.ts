import { currentOs, isWindows } from './os';
import { execProgram } from './run';
import { which } from './which';

// The system's own "choose a folder" dialog, opened on this computer for the
// board's project folder: a web page is never told a folder's full
// path, but the server runs here, so it can ask the system and hand the path
// back. macOS: a Finder dialog through osascript (`activate` first, so it
// comes in front rather than behind the browser). Windows: the folder
// browser of Windows Forms, through PowerShell in a single-threaded
// apartment, as that dialog needs. Linux and the rest: zenity, else kdialog;
// with neither, there is no dialog to open, and the person types the path.
//
// Nothing the person typed goes into these commands: the prompt is fixed, and
// the folder the dialog opens in is the home folder.

const PROMPT = 'Choose the project folder for this board';
const WAIT_MS = 10 * 60_000; // a dialog left open this long is given up on

export interface FolderChooser {
  command: string;
  args: string[];
}

// The dialog this system has, or undefined when it has none.
export function folderChooser(home: string, env: Record<string, string | undefined>, os: NodeJS.Platform = currentOs()): FolderChooser | undefined {
  if (os === 'darwin') {
    return { command: 'osascript', args: ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${PROMPT}" default location (path to home folder))`] };
  }
  if (isWindows(os)) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${PROMPT}'`,
      '$d.ShowNewFolderButton = $false',
      '$d.SelectedPath = [Environment]::GetFolderPath("UserProfile")',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', script] };
  }
  if (which('zenity', env, os)) return { command: 'zenity', args: ['--file-selection', '--directory', `--title=${PROMPT}`, `--filename=${home}/`] };
  if (which('kdialog', env, os)) return { command: 'kdialog', args: ['--getexistingdirectory', home, '--title', PROMPT] };
  return undefined;
}

// What the dialog said: the folder chosen, or none (the person cancelled).
// Each of them prints the path alone, on a line of its own (osascript with
// a / at the end), and prints nothing, or fails, when cancelled.
export function chosenFolder(stdout: string): string | undefined {
  const line = stdout.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > 1 && /[\\/]$/.test(line) ? line.slice(0, -1) : line;
}

// Opens the dialog and resolves with the folder chosen, or undefined when the
// person cancels. Rejects, saying why, when this system has no dialog.
export function chooseFolder(home: string, env: Record<string, string | undefined> = process.env, os: NodeJS.Platform = currentOs()): Promise<string | undefined> {
  const chooser = folderChooser(home, env, os);
  if (!chooser) return Promise.reject(new Error("This computer has no folder dialog Tricot can open (it looks for zenity or kdialog). Type the folder's path instead."));
  return new Promise((resolve, reject) => {
    execProgram(chooser.command, chooser.args, { env, timeout: WAIT_MS, windowsHide: false }, (error, stdout) => {
      // A program that couldn't start is said; any other failure is a cancel, as
      // each dialog exits non-zero when it is closed without a folder.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') reject(new Error(`Tricot couldn't open the folder dialog (${chooser.command} isn't there). Type the folder's path instead.`));
      else resolve(error ? undefined : chosenFolder(stdout));
    });
  });
}
