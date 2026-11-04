// This terminal, for `tricot claude`: its keys, one at a time, for the board
// picker (boardPicker.ts), and the agent run in it. tricot.ts hands both to
// the command; tests stand in for them.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { emitKeypressEvents } from 'node:readline';
import type { Key, TerminalKeys } from './boardPicker';

// Raw mode while the picker listens, and back as it was when it stops, or
// when the process exits first.
export function terminalKeys(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): TerminalKeys {
  return {
    write: (text) => void output.write(text),
    get columns() {
      return output.columns;
    },
    color: output.hasColors?.() ?? false,
    listen(onKey) {
      emitKeypressEvents(input);
      const wasRaw = input.isRaw;
      input.setRawMode(true);
      const onKeypress = (sequence: string | undefined, key?: Key) => onKey({ ...key, sequence: key?.sequence ?? sequence });
      input.on('keypress', onKeypress);
      input.resume();
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        input.off('keypress', onKeypress);
        input.setRawMode(wasRaw);
        input.pause(); // the agent reads the terminal next, not this process
        process.off('exit', stop);
      };
      process.once('exit', stop);
      return stop;
    },
  };
}

// An agent to run in this terminal: the command found on PATH, its
// arguments, and its whole environment.
export interface AgentLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

// Runs the agent with this terminal as its own, and resolves with its exit
// code (128 + the signal's number when a signal ended it). Ctrl+C and Ctrl+\
// reach the agent and this process alike: the agent decides what they mean,
// and this process waits for it rather than leaving it behind. A hangup or
// a request to terminate is passed on to it.
export function runInTerminal({ command, args, env, cwd }: AgentLaunch): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, cwd });
    const ignore = () => {};
    const passOn = (signal: NodeJS.Signals) => () => void child.kill(signal);
    const handlers: [NodeJS.Signals, () => void][] = [
      ['SIGINT', ignore],
      ...(process.platform === 'win32' ? [] : ([['SIGQUIT', ignore]] as [NodeJS.Signals, () => void][])),
      ['SIGHUP', passOn('SIGHUP')],
      ['SIGTERM', passOn('SIGTERM')],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      done();
      resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
    });
  });
}
