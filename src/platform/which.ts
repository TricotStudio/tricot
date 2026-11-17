import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { isWindows } from './os';

// The PATH of an environment. Windows names it Path, and a copy of its
// environment ({ ...process.env }) keeps that spelling: only process.env
// itself matches names without regard to case.
function pathOf(env: Record<string, string | undefined> | undefined, windows: boolean): string {
  if (!env) return '';
  if (!windows) return env.PATH ?? '';
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return (key && env[key]) || '';
}

// What a program's file may be called on Windows: Node starts an .exe itself,
// and a .cmd or .bat through cmd.exe (run.ts). Tried in this order.
export const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const;

// Each file a program has on the PATH in `env`, in the order the PATH has
// them, one for each folder, found without running it. On Windows a program
// carries an extension (.exe, .cmd, .bat), so each is tried.
function* filesOf(command: string, env: Record<string, string | undefined> | undefined, os?: NodeJS.Platform): Generator<string> {
  const windows = isWindows(os);
  const dirs = pathOf(env, windows).split(path.delimiter).filter(Boolean);
  const names = windows ? [...WINDOWS_EXTENSIONS.map((extension) => `${command}${extension}`), command] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        yield file;
        break;
      } catch {
        // not here
      }
    }
  }
}

// A program's file on the PATH in `env`, the first one: the one that runs.
export const which = (command: string, env: Record<string, string | undefined> | undefined, os?: NodeJS.Platform): string | undefined => filesOf(command, env, os).next().value;

// Every file the PATH has for it, the one that runs first; a folder listed twice counts once.
export const whichAll = (command: string, env: Record<string, string | undefined> | undefined, os?: NodeJS.Platform): string[] => [...new Set(filesOf(command, env, os))];
