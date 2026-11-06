// Running git in a repository on this computer, for the kinds that read one
// (a diff from its changes, a code block from its file). Server only: the
// kinds' server.ts import it, and the web build leaves those out.
//
// git is started as a program, never through a shell, so nothing an agent
// sends is read as a command; revisions are checked before they get here,
// and paths come after `--`. What git does as it reads is held to reading:
// no pager, no colours, no external diff or text conversion programs, no
// file-system monitor, and none of the optional locks that would let it
// write the person's index (GIT_OPTIONAL_LOCKS=0).

import { runProgram } from '../../platform/run';

const TIMEOUT_MS = 30_000;
const STDERR_MAX = 8 * 1024;

// The variables that point git at another repository than the folder it runs
// in (`git rev-parse --local-env-vars`): set when Tricot itself runs inside a
// git hook, say, and never meant for the person's repository.
const REPO_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
];

// Why git gave nothing: it isn't installed, it said no (with what it said),
// it printed more than was asked for, or it took too long.
export type GitFailure = 'missing' | 'failed' | 'too-big' | 'timeout';

export class GitError extends Error {
  constructor(
    readonly failure: GitFailure,
    readonly said = '',
  ) {
    super(said || failure);
  }
}

export interface GitOptions {
  cwd: string;
  maxBytes: number; // past this much output, git is stopped
  index?: string; // an index file of its own, in place of the repository's
}

// What git prints for these arguments in `cwd`, as text.
export function git(args: readonly string[], { cwd, maxBytes, index }: GitOptions): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const name of REPO_VARIABLES) delete env[name];
  if (index) env.GIT_INDEX_FILE = index;
  const words = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'color.ui=never', ...args];
  return new Promise((resolve, reject) => {
    const child = runProgram('git', words, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let errors = '';
    let failure: GitError | undefined;
    const stop = (error: GitError) => {
      failure ??= error;
      child.kill();
    };
    const timer = setTimeout(() => stop(new GitError('timeout')), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop(new GitError('too-big'));
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.length < STDERR_MAX) errors += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(failure ?? new GitError(error.code === 'ENOENT' ? 'missing' : 'failed', error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new GitError('failed', errors.trim()));
    });
  });
}

// git's message, as an agent reads it: the line saying why it stopped (past
// any warnings and hints), without "fatal: ".
export function gitSaid(error: GitError): string {
  const lines = error.said.split('\n').filter((l) => l.trim());
  const line = lines.find((l) => /^(fatal|error): /.test(l)) ?? lines[0] ?? '';
  return line.replace(/^(fatal|error): /, '').slice(0, 200);
}

// The top folder of the repository a folder is in, or undefined when it is in none.
export async function repoTop(folder: string): Promise<string | undefined> {
  try {
    const top = (await git(['rev-parse', '--show-toplevel'], { cwd: folder, maxBytes: 64 * 1024 })).trim();
    return top || undefined;
  } catch (error) {
    if (error instanceof GitError && error.failure === 'failed') return undefined;
    throw error;
  }
}

export const NO_GIT = "git isn't installed on this computer (or isn't on the PATH), so Tricot can't read the repository.";
