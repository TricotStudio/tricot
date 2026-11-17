// `tricot connect` for an agent whose way in is an entry in its settings file
// (OMP, OpenCode, Goose, Hermes Agent: a connect of 'file' in the registry).
// Tricot adds its entry, named tricot, under the section that holds the
// agent's servers, and leaves every other line of the file as it was
// (core/settingsEntry.ts). Before it writes, it keeps a copy of the file as it
// was beside it (<file>.tricot-backup, the person's alone), and the file is
// written whole or not at all, keeping its mode.
//
// It changes nothing, and says why, for a file it can't edit safely: one it
// can't read as its format, or laid out in a way it doesn't edit; a link (a
// dotfiles folder's: Tricot doesn't write through links); one the agent
// writes itself the first time it runs that isn't there yet. The person then
// gets the entry to paste, as before. A file that isn't there yet, for an
// agent that reads one it didn't write, is made with the entry alone.
//
// The entry never holds the token: it names TRICOT_TOKEN, which the agent
// reads from its environment.

import { chmodSync, copyFileSync, constants, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentKind, ConnectView, FileConnect } from '../core/agents/agent';
import { SERVER_NAME } from '../core/agents/fileConnect';
import { setEnvironment, shellNoun, TOKEN_ENV } from '../core/connect';
import { EntryRefused, withEntry } from '../core/settingsEntry';
import { home } from '../platform/paths';
import { which } from '../platform/which';
import { displayPath, linkTarget, writeFileAtomic, type HookTarget } from '../server/hooks';
import { UNREAD_TOKEN } from './commandEnv';
import { addressIn, howToInstall, sameAddress } from './connectAgent';
import type { CliContext } from './main';
import { shellOf } from './shell';

export const BACKUP_SUFFIX = '.tricot-backup';

export type FileAgent = AgentKind & { connect: FileConnect };

export const isFileAgent = (agent: AgentKind): agent is FileAgent => agent.connect.how === 'file';

// Where the agents' folders are for this command: its home folder and environment.
export const targetOf = (ctx: CliContext): HookTarget => ({ home: home(ctx.env, ctx.platform), env: ctx.env });

// What adding the entry would do. `shown`: the file as a person reads it (~/…).
export type FilePlan =
  | { does: 'same'; file: string; shown: string }
  | { does: 'make' | 'add'; file: string; shown: string; next: string; before?: string }
  | { does: 'replace'; file: string; shown: string; next: string; before: string; was?: string }
  | { does: 'refuse'; file?: string; shown: string; why: string };

export const settingsPathOf = (agent: FileAgent, target: HookTarget): string | undefined => agent.settingsPath?.(target);

// Whether the agent is on this computer: its program on the PATH, or its settings file there.
export function fileAgentHere(agent: FileAgent, ctx: CliContext): boolean {
  const file = settingsPathOf(agent, targetOf(ctx));
  return Boolean(which(agent.command, ctx.env)) || (file !== undefined && existsSync(file)) || Boolean(agent.isInstalled?.(targetOf(ctx)));
}

export function planFile(agent: FileAgent, ctx: CliContext, url: string, token?: string): FilePlan {
  const target = targetOf(ctx);
  const file = settingsPathOf(agent, target);
  if (!file) return { does: 'refuse', shown: agent.connect.file, why: `is where ${agent.name} keeps its settings, which Tricot can't find on this computer` };
  const shown = displayPath(file, target, 'user');
  const refuse = (why: string): FilePlan => ({ does: 'refuse', file, shown, why });
  const value = agent.connect.value(url, token);
  // The entry names the variable that holds the token, never the token itself.
  if (token && token !== UNREAD_TOKEN && JSON.stringify(value).includes(token)) throw new Error(`${agent.name}'s entry would hold the board's token; it must name ${TOKEN_ENV} instead.`);
  const link = linkTarget(file);
  if (link !== undefined) return refuse(`is a link (to ${link}), and Tricot doesn't write through links or replace them`);
  let before: string | undefined;
  if (existsSync(file)) {
    if (!statSync(file).isFile()) return refuse("isn't a file");
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      return refuse(`can't be read (${(error as NodeJS.ErrnoException).code ?? error})`);
    }
    before = bytes.toString('utf8');
    // Written back as text, every byte must come out as it was.
    if (!Buffer.from(before, 'utf8').equals(bytes)) return refuse("isn't UTF-8 text");
  } else if (agent.connect.agentWrites) {
    return refuse(`isn't there yet: ${agent.name} writes it the first time it runs, with its own settings in it. Run ${agent.name} once, then connect again`);
  }
  try {
    const edit = withEntry(before, { format: agent.connect.format, section: agent.connect.section, name: SERVER_NAME }, value);
    if (edit.existing === undefined) return before === undefined ? { does: 'make', file, shown, next: edit.next } : { does: 'add', file, shown, next: edit.next, before };
    const was = addressIn(edit.existing);
    if (was !== undefined && sameAddress(was, url)) return { does: 'same', file, shown };
    return { does: 'replace', file, shown, next: edit.next, before: before!, ...(was && { was }) };
  } catch (error) {
    if (error instanceof EntryRefused) return refuse(error.why);
    throw error;
  }
}

// Writes what planFile planned: the copy of the file first, then the file.
// It writes nothing when the file changed since it was read (the agent, or
// the person, wrote to it meanwhile). Gives the copy's path, when it kept one.
export function applyFile(plan: Extract<FilePlan, { next: string }>): { backup?: string } {
  const now = existsSync(plan.file) ? readFileSync(plan.file, 'utf8') : undefined;
  if (now !== plan.before) throw new FileChanged(plan.shown);
  if (plan.before === undefined) {
    writeFileAtomic(plan.file, plan.next);
    return {};
  }
  const backup = `${plan.file}${BACKUP_SUFFIX}`;
  keepCopy(plan.file, backup, plan.shown);
  writeFileAtomic(plan.file, plan.next);
  return { backup };
}

export class FileChanged extends Error {
  constructor(shown: string) {
    super(`${shown} changed while Tricot was asking, so Tricot wrote nothing to it. Run tricot connect again.`);
    this.name = 'FileChanged';
  }
}

// The file's bytes, as they are, in `backup`: made whole beside it, then put in
// place of any copy an earlier connect kept, readable by the person alone. A
// link there is never written through or replaced.
export function keepCopy(file: string, backup: string, shown: string): void {
  const link = linkTarget(backup);
  if (link !== undefined) throw new Error(`${shown}${BACKUP_SUFFIX} is a link (to ${link}), so Tricot kept no copy there and wrote nothing.`);
  const temporary = `${backup}.tricot-${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  try {
    copyFileSync(file, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    renameSync(temporary, backup);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// The copy, as a person reads it: its name, beside the file.
export const backupName = (plan: { file?: string; shown: string }) => `${path.basename(plan.file ?? plan.shown)}${BACKUP_SUFFIX}`;

// The line that tells the person where the agent reads the board's token from.
export function tokenLine(name: string, ctx: CliContext, dataDir: string): string {
  const shell = shellOf(ctx.platform);
  const set = shell === 'powershell' ? setEnvironment(TOKEN_ENV, '<token>', shell) : `export ${TOKEN_ENV}=<token>`;
  return `${name} reads the token from ${TOKEN_ENV}: set it in the ${shellNoun(shell)} ${name} runs from, with ${set} (the token is in ${path.join(dataDir, 'token')}).`;
}

export interface FileConnectRun {
  ctx: CliContext;
  agent: FileAgent;
  view: ConnectView; // the address as the agent names itself on the board, and the token
  dataDir: string;
  yes?: boolean;
  // The instructions as --print shows them, for where this changes nothing.
  show(): void;
}

// `tricot connect <agent>` for an agent that joins through its file: says what
// it would add, and where, asks (--yes skips the question), and adds it. As
// with an agent's own command, an entry already there for this board means
// nothing to do, and one for another address is replaced only on a yes to the
// question that says so: never with --yes, never without a terminal.
export async function connectFileAgent(c: FileConnectRun): Promise<{ exitCode: number; ran: boolean }> {
  const { ctx, agent, view } = c;
  const { out } = ctx;
  const declined = (why: string) => {
    c.show();
    ctx.err(why);
    return { exitCode: 1, ran: false };
  };
  const target = targetOf(ctx);
  const where = settingsPathOf(agent, target);
  if (!fileAgentHere(agent, ctx)) {
    c.show();
    ctx.err(
      `${agent.name} isn't installed here: Tricot looked for \`${agent.command}\` on your PATH${where ? ` and for ${displayPath(where, target, 'user')}` : ''}, so it changed nothing. Add the entry above where ${agent.name} is installed.`,
    );
    howToInstall(ctx, agent);
    return { exitCode: 1, ran: false };
  }
  const plan = planFile(agent, ctx, view.url, view.token);
  if (plan.does === 'same') {
    out(`${agent.name} is already connected to this board (${plan.shown}). Nothing to do.`);
    return { exitCode: 0, ran: false };
  }
  if (plan.does === 'refuse') return declined(`${plan.shown} ${plan.why}, so Tricot left it as it is. Add the entry above to it yourself.`);
  const found = `${plan.shown} already has a server named tricot${plan.does === 'replace' && plan.was ? `, at ${plan.was},` : ''} which is not this board's`;
  if (plan.does === 'replace' && (c.yes || !ctx.ask)) {
    return declined(
      `${found}. ${c.yes ? '--yes never replaces one' : "Without a terminal to ask in, Tricot didn't replace it"}: Tricot replaces it only when you answer y to its question. To replace it yourself, put the entry above in its place; nothing was changed.`,
    );
  }
  if (!c.yes && !ctx.ask) return declined("Without a terminal to ask in, Tricot didn't change the file. Add the entry above yourself, or add --yes to have Tricot add it; nothing was changed.");

  const { section } = agent.connect;
  if (plan.does === 'make') out(`${agent.name} has no command for joining a board, so Tricot would make ${plan.shown} with its entry:`);
  else if (plan.does === 'add') out(`${agent.name} has no command for joining a board, so Tricot would add its entry to ${plan.shown}, under "${section}", and change nothing else in the file:`);
  else out(`${found}. Tricot would put the board's entry in its place, and change nothing else in the file:`);
  out(agent.connect.entry(view.url, view.token));
  if (plan.does !== 'make') out(`It keeps a copy of the file as it is now beside it, as ${backupName(plan)}.`);
  if (view.token) out(`The entry names ${TOKEN_ENV}, which ${agent.name} reads the token from: the token itself never goes in the file.`);
  const question = plan.does === 'replace' ? `Replace it: put the board's entry in that one's place in ${agent.name}'s settings?` : `Add it to ${agent.name}'s settings?`;
  if (!c.yes && !(await ctx.ask!(question, false))) {
    out('Nothing was changed.');
    return { exitCode: 0, ran: false };
  }
  let backup: string | undefined;
  try {
    ({ backup } = applyFile(plan));
  } catch (error) {
    ctx.err(error instanceof Error ? error.message : String(error));
    return { exitCode: 1, ran: true };
  }
  out(`Connected: ${agent.name} now has the board, in every session. Start a new session for it to show up.`);
  if (backup) out(`The file as it was is kept beside it, as ${backupName(plan)}.`);
  if (view.token) out(tokenLine(agent.name, ctx, c.dataDir));
  for (const line of agent.afterwards ?? []) out(line);
  agent.afterConnected?.(view);
  return { exitCode: 0, ran: true };
}
