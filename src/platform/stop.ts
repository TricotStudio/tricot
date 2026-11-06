import { currentOs, isWindows } from './os';

// Asks a process to stop. `group`: its whole process group, on systems that
// have them (a server started detached takes what it started with it);
// Windows has none, so it is the process alone there. Throws when there is no
// such process, as process.kill does.
//
// On Windows there is no asking: any signal ends the process at once, with
// no chance to save or to let go of its lock. A Tricot board is asked over
// HTTP first (server/stopRoutes.ts), and this is what is left when that can't be.
export function stopProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM', options: { group?: boolean } = {}): void {
  process.kill(options.group && !isWindows() ? -pid : pid, signal);
}

// The signals that end a server running in the foreground gently (it saves
// and lets go of its lock): Ctrl+C and a request to terminate. On Windows
// also Ctrl+Break, and the console window being closed, which Node reports as
// SIGBREAK and SIGHUP.
export const stopSignals = (os: NodeJS.Platform = currentOs()): NodeJS.Signals[] => (isWindows(os) ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM']);

// Ctrl+C as this process reads it from a key, while the terminal is in raw
// mode: what the signal would have done, for the handlers that stop Tricot
// (a process with none ends, as for the signal). On Windows a signal sent to
// oneself is no signal but the same abrupt end, so the handlers are called.
export function interruptSelf(os: NodeJS.Platform = currentOs()): void {
  if (!isWindows(os)) {
    process.kill(process.pid, 'SIGINT');
    return;
  }
  if (!process.emit('SIGINT', 'SIGINT')) process.exit(130);
}
