// What the commands share (boardCommands.ts, connectCommand.ts, agentCommands.ts,
// updateCommand.ts): the context and the options one `tricot` call was run with, and the
// board's address and token as they come from them.
import { linkTo } from '../core/pages';
import { isLoopbackHost, readToken } from '../server/access';
import type { ServerLock } from '../platform/lock';
import type { CliContext } from './main';
import type { HooksEnv } from './hooks';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Env = {
  values: HooksEnv['values'] & {
    board?: string;
    name?: string;
    print?: boolean;
    'no-open'?: boolean;
    background?: boolean;
    'stop-with-agents'?: boolean;
    'no-update-check'?: boolean;
  };
  ctx: CliContext;
  version: string;
  source?: string; // the repository's page, for the Source link on Home
  repo?: string; // "owner/repo" on GitHub, whose releases the update check asks for
  port: number;
  host: string;
  dataDir: string;
  // Set when the board listens beyond this machine: what agents and the browser must send.
  token?: string;
};

// Every option a `tricot` call can carry, as the parser gives them: the table of commands says which
// there are (commands.ts, options.ts).
export type Values = Env['values'] & { port?: string; host?: string; data?: string; version?: boolean; help?: boolean };

// What stands for a token this command can't read yet (the server makes it when it first starts).
export const UNREAD_TOKEN = '<token>';

// The token for a board listening on `host`: none on this machine alone. The
// server keeps it in the data folder, which this command reads as the same user.
export function tokenFor(env: Env, host: string): string | undefined {
  return isLoopbackHost(host) ? undefined : (readToken(env.dataDir) ?? UNREAD_TOKEN);
}

export const publicHost = (host: string) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);

// The board's address. With a token it opens `/?token=…` first, which gives the
// browser its cookie and comes back to the board without the token showing.
export function boardUrl(env: Env, url: string): string {
  const entry = env.token ? `/?token=${encodeURIComponent(env.token)}` : '';
  return env.values.board ? `${url}${entry || '/'}${linkTo.board(env.values.board)}` : `${url}${entry}`;
}

export function openBoard(env: Env, url: string): void {
  if (!env.values['no-open']) env.ctx.open(boardUrl(env, url));
}

// Where the steps go: the board running on this data, else where this one would listen.
export function hooksEnv(env: Env, running: ServerLock | undefined): HooksEnv {
  return { ctx: env.ctx, dataDir: env.dataDir, url: running?.url ?? `http://${publicHost(env.host)}:${env.port}`, values: env.values };
}
