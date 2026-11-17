// What a `tricot` command and the board it reaches know of each other's
// version. The board says its version and protocol at GET
// /api/info (core/protocol.ts). A command that reaches a board reads them
// before it asks the board anything (boardFits), and refuses plainly, naming
// the update, when the board is older than it needs (its entry's needsBoard,
// commands.ts) or when it is older than the board still serves (the board's
// oldestCommand). A board older than this command that it doesn't need newer
// is only said, in a line: it may lack something new, and nothing more.
//
// An older `tricot` can't be changed after the fact: the board hands agents
// commands that run as its own version (server/mcp/session.ts
// listenCommand), and from this one on, a line `tricot` can't read (an
// unknown command or option) names the update when the board it was meant
// for is newer than it (newerBoardNote), as a newer board may hand out a
// command or an option this one lacks.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { oldestCommandOf, PROTOCOL, protocolOf, type BoardInfo } from '../core/protocol';
import { routes, routeUrl } from '../core/routes';
import { findRunning } from '../platform/lock';
import { defaultDataPath } from '../platform/paths';
import { authHeaders } from '../platform/token';
import type { Env } from './commandEnv';
import { LOOPBACK } from './listenCommand';
import type { CliContext } from './main';

const INFO_TIMEOUT_MS = 3000;

// The command that brings a `tricot` and the board it runs up to date
// (updateCommand.ts): Homebrew's or npm's, as it was installed, and it says
// when another `tricot` on the PATH is older than the board.
export const UPDATE = 'tricot update';

// What the board at `url` says of itself; nothing when it doesn't answer, or not as Tricot.
export async function boardInfo(url: string, headers: Record<string, string> = {}, doFetch: typeof fetch = fetch): Promise<BoardInfo | undefined> {
  try {
    const res = await doFetch(`${url}${routeUrl(routes.info)}`, { headers, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const info = (await res.json()) as BoardInfo | null;
    return info?.app === 'tricot' ? info : undefined;
  } catch {
    return undefined;
  }
}

// How a board and this command fit: nothing to say, a problem (the command
// goes no further), or a note.
export interface Fit {
  problem?: string;
  note?: string;
}

// What this command is: its version and protocol (tests stand in for a
// newer or older one), its name and the protocol it needs of the board.
export interface Asking {
  version: string;
  name?: string; // `tricot <name>`
  needsBoard: number;
  protocol?: number; // PROTOCOL unless said
}

// The board's Tricot, said beside this one's: a checkout says the last
// release's version while its code is newer, so the same version is
// another build of it.
function boardTricot(info: BoardInfo, version: string, newer: boolean): string {
  const which = newer ? 'a newer' : 'an older';
  if (!info.version) return `${which} Tricot`;
  return info.version === version ? `${which} build of Tricot ${info.version}` : `Tricot ${info.version}`;
}

// The same, and how it compares with this one.
function compared(info: BoardInfo, version: string, newer: boolean): string {
  const tricot = boardTricot(info, version, newer);
  return info.version && info.version !== version ? `${tricot}, ${newer ? 'newer' : 'older'} than this tricot (${version})` : `${tricot} than this tricot`;
}

export function fitOf(info: BoardInfo, url: string, asking: Asking): Fit {
  const mine = asking.protocol ?? PROTOCOL;
  const theirs = protocolOf(info);
  if (oldestCommandOf(info) > mine) {
    return { problem: `This tricot (${asking.version}) is too old for the board at ${url}, which runs ${boardTricot(info, asking.version, true)}. Update this tricot with: ${UPDATE}` };
  }
  if (theirs < asking.needsBoard) {
    return {
      problem: `${asking.name ? `tricot ${asking.name}` : 'This command'} needs a newer board than the one at ${url}, which runs ${boardTricot(info, asking.version, false)} (this tricot is ${asking.version}). Update the board with ${UPDATE}, or stop it with tricot stop and start it again with this tricot.`,
    };
  }
  if (theirs < mine) {
    return {
      note: `The board at ${url} runs ${compared(info, asking.version, false)}, so some of what this command does may not work there. Update it with ${UPDATE}, or stop it with tricot stop and run this again to start it on this version.`,
    };
  }
  return {};
}

// How the board at `url` fits the command `env` runs: nothing to say when it
// doesn't answer (the command finds that out its own way) or says nothing of
// its version that matters here.
export async function boardFits(env: Pick<Env, 'version' | 'command'>, url: string, headers: Record<string, string> = {}, doFetch?: typeof fetch): Promise<Fit> {
  const info = await boardInfo(url, headers, doFetch);
  return info ? fitOf(info, url, { version: env.version, ...(env.command && { name: env.command.name }), needsBoard: env.command?.needsBoard ?? 1 }) : {};
}

// Said after a line this `tricot` can't read (an unknown command or option),
// when the board it was meant for is newer than it: the board at the line's
// --url (as `tricot listen` takes it), else the one running on its data
// folder. Nothing otherwise: the line is a typo, said as one.
export async function newerBoardNote(ctx: Pick<CliContext, 'env'>, args: string[], version: string, protocol = PROTOCOL): Promise<string | undefined> {
  let values: { url?: unknown; data?: unknown };
  try {
    values = parseArgs({ args, strict: false, allowPositionals: true, options: { url: { type: 'string' }, data: { type: 'string' } } }).values;
  } catch {
    return undefined;
  }
  const dataDir = path.resolve(typeof values.data === 'string' ? values.data : (ctx.env.TRICOT_DATA_DIR ?? defaultDataPath()));
  const given = typeof values.url === 'string' && LOOPBACK.test(values.url) ? values.url : undefined;
  const url = given ?? (await findRunning(dataDir))?.url;
  if (!url) return undefined;
  const info = await boardInfo(url, authHeaders(dataDir));
  if (!info || protocolOf(info) <= protocol) return undefined;
  return `The board at ${url} runs ${compared(info, version, true)}, and may have given you this line: update this tricot with: ${UPDATE}`;
}
