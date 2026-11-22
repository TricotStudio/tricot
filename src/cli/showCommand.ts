// `tricot show`: an agent in its own terminal puts what a
// person asked to see on the board, as a Sketchbook page, when its Tricot
// tools aren't there (Tricot wasn't running when it started, or it was never
// connected). Every agent can run a command.
//
//   tricot show [file ...] --title "<title>" --agent <name> --asked "<words>"
//   tricot show --page <id> [file ...] --agent <name>
//   tricot show --page <id> --reply "<words>" [file ...] --agent <name>
//   tricot show --listen --page <id> --agent <name>
//
// 1. Tricot: the board running on this data, or one started now in the
//    background as `tricot --background` starts it (boardCommands.ts), and
//    waited for until it answers. It keeps running after the command ends, so
//    the person can open the page; `tricot stop` stops it.
// 2. The board: --board, else the one used in this folder or the nearest
//    folder above it, short of the home folder, as `tricot claude` remembers
//    it (platform/folderBoards.ts). When neither says, or the one named isn't
//    there, it lists the boards and exits ASK_PERSON: the agent asks the
//    person, and runs it again with --board, or --new-board for a new one.
//    It never makes a board unasked. The board it used is remembered here.
// 3. The page, made as the agent (asAgent.ts: agents change boards through
//    their own tools, never as the person), keeping the agent and what the
//    person asked (add_page's `asked`), with a block for each file
//    (showBlocks.ts).
// 4. The page's link, as add_page gives it: the board's own address, then the
//    page's (core/pages.ts). Printed on its own line, for the agent to hand over.
// 5. --page adds the blocks to that page instead; --reply answers, as the
//    agent, what a person asked it there (waitingOn).
// 6. --listen waits until a person asks the agent something on the page, from
//    its chat bar or about blocks they selected, prints it and ends: an agent
//    running it in the background wakes as it ends (listenOnPage). The agent
//    shows on the board as asleep meanwhile, to be woken, as an agent
//    Tricot's terminal holds does.
//
// The guide tells agents to run it when their Tricot tools aren't there
// (server/mcp/tools/canvas.ts, add_page's part).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { agentKinds, findAgent } from '../core/agents/registry';
import { askedKind } from '../core/askedCards';
import { blockName } from '../core/canvas';
import { concernsAgent } from '../core/concerns';
import { meantFor } from '../core/delivery';
import { clip, listNames, samePerson } from '../core/format';
import { linkTo } from '../core/pages';
import { requestBlocks, requestFor } from '../core/requests';
import { routes, routeUrl } from '../core/routes';
import { hasSelection, selectionBlocks } from '../core/threadSelection';
import type { Board, BoardEvent, BoardSummary, ContextRequest, ScratchPage, Thread } from '../core/types';
import { boardUsedIn, rememberBoardIn } from '../platform/folderBoards';
import { findRunning } from '../platform/lock';
import { home } from '../platform/paths';
import { authHeaders } from '../platform/token';
import type { RunningLock } from './agentCommand';
import { asAgent, Refused, type AgentSession } from './asAgent';
import { useTerminalCards } from '../edition';
import { startDetached } from './boardCommands';
import { boardFits } from './boardVersion';
import { recentBoards } from './chooseBoard';
import { tokenFor, UNREAD_TOKEN, type Env } from './commandEnv';
import type { Words } from './commands';
import type { CliResult } from './main';
import { asThisTerminal } from './terminalKey';
import { blockOf, kindNamed, kindOfFile, STDIN_KINDS, type BlockFields } from './showBlocks';

// The exit code when the person has to choose the board: the agent asks them, then runs it again.
export const ASK_PERSON = 2;

const NOTHING_SHOWN = 'Nothing was shown.';

// A block to add, and where it came from, for saying which one was refused.
interface Shown {
  from: string;
  block: BlockFields;
}

// What the command acts with once Tricot runs.
interface Reach {
  env: Env;
  lock: RunningLock;
  headers: Record<string, string>;
  agent: string;
}

// The agent asking, as the board names it: an agent's id gives its name on
// the board (claude is Claude), and any other name is taken as it is.
export function agentNamed(given: string | undefined): string | undefined {
  const name = given?.trim();
  if (!name) return undefined;
  return findAgent(name.toLowerCase())?.boardName ?? name;
}

// A page's link, as add_page gives it: the board's own address, then the page's.
export const pageLink = (url: string, boardId: string, pageId: string): string => `${url}/${linkTo.page(boardId, pageId)}`;

export async function show(env: Env, { positionals }: Words): Promise<CliResult> {
  const { ctx, values } = env;
  await useTerminalCards();
  const fail = (line: string): CliResult => {
    ctx.err(line);
    return { exitCode: 1 };
  };
  const agent = agentNamed(values.agent);
  if (!agent) return fail(`Say which agent is asking: --agent <name>, as the board knows it, or its id (${agentKinds().map((kind) => kind.id).join(', ')}). The page is made as that agent, never as the person. ${NOTHING_SHOWN}`);
  const pageId = values.page?.trim();
  const files = positionals.slice(1);
  if (values.listen) {
    if (!pageId) return fail('--listen waits on a page: add --page <id>, as tricot show printed it.');
    if (files.length || values.text !== undefined || values.reply !== undefined) return fail('--listen only waits: show or reply in a call of its own.');
  }
  const reply = values.reply?.trim();
  if (values.reply !== undefined && !pageId) return fail(`--reply answers on a page: add --page <id>, as tricot show printed it. ${NOTHING_SHOWN}`);
  if (values.reply !== undefined && !reply) return fail(`--reply needs the words to post. ${NOTHING_SHOWN}`);
  if (values.to !== undefined && values.reply === undefined) return fail(`--to says what --reply answers: add --reply "<words>". ${NOTHING_SHOWN}`);
  const title = values.title?.trim();
  if (!pageId && !title) return fail(`Name the new page: --title "<what it shows>". ${NOTHING_SHOWN}`);

  const folder = path.resolve(ctx.cwd ?? process.cwd());
  const read = values.listen ? { blocks: [] } : await readBlocks(env, files, folder);
  if ('problem' in read) return fail(`${read.problem} ${NOTHING_SHOWN}`);
  const { blocks } = read;
  if (!values.listen && !reply && !blocks.length) return fail(`Nothing to show: name the files to put on the page, pipe one in with -, or give --text "<words>". ${NOTHING_SHOWN}`);

  const running = await ensureRunning(env);
  if (!running) return { exitCode: 1 };
  const { lock, started } = running;
  if (started) ctx.out("Tricot wasn't running, so it started in the background; tricot stop stops it.");
  if (tokenFor(env, lock.host ?? env.host) === UNREAD_TOKEN) return fail(`This board listens beyond this machine and needs its token, which isn't in ${env.dataDir} yet. ${NOTHING_SHOWN}`);
  const reach: Reach = { env, lock, headers: authHeaders(env.dataDir), agent };
  // A board found running may be too old for it, or it too old for the board (boardVersion.ts).
  if (!started) {
    const fit = await boardFits(env, lock.url, reach.headers);
    if (fit.problem) return fail(`${fit.problem} ${NOTHING_SHOWN}`);
    if (fit.note) ctx.err(fit.note);
  }

  try {
    if (values.listen) return await listenOnPage(reach, pageId!);
    if (pageId) return await onPage(reach, pageId, blocks, reply);
    const where = await boardForPage(reach, folder);
    if ('ask' in where) {
      ctx.err(where.ask);
      return { exitCode: ASK_PERSON };
    }
    if ('problem' in where) return fail(where.problem);
    return await asAgent(lock.mcpUrl, agent, reach.headers, async (session) => {
      const board = 'board' in where ? where.board : await newBoard(session, where.newBoard);
      const asked = values.asked?.trim();
      const made = idIn(await session.call('add_page', { board_id: board.id, title, ...(asked && { asked }) }), 'page id');
      rememberBoardIn(env.dataDir, folder, board.id);
      const added = await addBlocks(session, blocks, { page_id: made });
      const page = `the Sketchbook page "${title}" on the board "${board.title}"`;
      if (added.refused) return partly(env, `Added ${page} as ${agent}, but Tricot refused ${added.refused.from}: ${added.refused.why}`, pageLink(lock.url, board.id, made));
      ctx.out(`Added ${page} as ${agent}, with ${count(added.count)}:`);
      ctx.out(pageLink(lock.url, board.id, made));
      ctx.out(`To add to it: tricot show --page ${made} --agent ${shellWord(agent)} <files>`);
      ctx.out(listenLine(made, agent));
      return { exitCode: 0 };
    });
  } catch (error) {
    return fail(error instanceof Refused ? `Tricot refused it: ${error.message}` : `Tricot didn't take it: ${error instanceof Error ? error.message : error}`);
  }
}

const count = (n: number) => `${n} block${n === 1 ? '' : 's'}`;

const listenLine = (page: string, agent: string) => `To hear what the person asks on it, run in the background: tricot show --listen --page ${page} --agent ${shellWord(agent)}`;

// What was made before a block was refused: said, with the page's link, as a failure.
function partly(env: Env, said: string, link: string): CliResult {
  env.ctx.err(said);
  env.ctx.out(link);
  return { exitCode: 1 };
}

// A word as a shell takes it back: quoted when it holds anything but letters, digits and a few marks.
const shellWord = (word: string) => (/^[\w.@:+-]+$/.test(word) ? word : `"${word.replace(/(["\\$`])/g, '\\$1')}"`);

// ---- what goes on the page ---------------------------------------------------------

async function readBlocks(env: Env, names: string[], folder: string): Promise<{ blocks: Shown[] } | { problem: string }> {
  const { ctx, values } = env;
  const blocks: Shown[] = [];
  if (values.text?.trim()) blocks.push({ from: '--text', block: { type: 'note', text: values.text } });
  if (values.as !== undefined && !names.includes('-')) return { problem: '--as says what stdin holds: add - where it goes among the files.' };
  if (names.filter((name) => name === '-').length > 1) return { problem: '- reads stdin once: name it once.' };
  for (const name of names) {
    let made: ReturnType<typeof blockOf>;
    if (name === '-') {
      const kind = values.as === undefined ? 'note' : kindNamed(values.as);
      if (!kind) return { problem: `--as takes ${STDIN_KINDS.join(', ')}, not "${values.as}".` };
      if (!ctx.stdin) return { problem: 'Nothing was piped in for -.' };
      made = blockOf(kind, { bytes: Buffer.from(await ctx.stdin(), 'utf8') });
    } else {
      const file = path.resolve(folder, name);
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { problem: code === 'ENOENT' ? `There's no file ${name}.` : code === 'EISDIR' ? `${name} is a folder: name the files in it.` : `Can't read ${name}: ${(error as Error).message}` };
      }
      // A file in this folder is named from it, as a project's files are; any other by its full path.
      const relative = path.relative(folder, file);
      const shown = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file;
      made = blockOf(kindOfFile(name), { name: shown, bytes });
    }
    if ('problem' in made) return made;
    blocks.push({ from: name === '-' ? 'stdin' : name, block: made.block });
  }
  return { blocks };
}

// Adds the blocks in order, where `on` says (page_id, and a thread or a group
// there), and stops at the first the board refuses.
async function addBlocks(session: AgentSession, blocks: Shown[], on: Record<string, string>): Promise<{ count: number; refused?: { from: string; why: string } }> {
  let added = 0;
  for (const { from, block } of blocks) {
    try {
      await session.call('add_block', { ...on, ...block });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return { count: added, refused: { from, why: error.message } };
    }
    added++;
  }
  return { count: added };
}

// The id the board's answer names after `label`: "[page id: …]", "[id: …]",
// "[page id: …; board id: …]".
export function idIn(answer: string, label: string): string {
  const found = new RegExp(`(?:\\[|; )${label}: ([^\\];]+)[\\];]`).exec(answer);
  if (!found) throw new Error(`its answer named no ${label}: ${answer.split('\n')[0]}`);
  return found[1].trim();
}

// ---- Tricot, and the board --------------------------------------------------------

async function ensureRunning(env: Env): Promise<{ lock: RunningLock; started: boolean } | undefined> {
  const running = await findRunning(env.dataDir);
  if (running?.url && running.mcpUrl) return { lock: running as RunningLock, started: false };
  const lock = await startDetached(env);
  if (lock) return { lock, started: true };
  env.ctx.err(`Tricot wasn't running, and didn't start: see ${path.join(env.dataDir, 'server.log')}. ${NOTHING_SHOWN}`);
  return undefined;
}

type Got<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

async function read<T>({ lock, headers }: Reach, route: string): Promise<Got<T>> {
  try {
    const res = await fetch(`${lock.url}${route}`, { headers, signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, body } : { ok: false, status: res.status, error: body.error ?? `it answered ${res.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

type ChosenBoard = { id: string; title: string };
type Where = { board: ChosenBoard } | { newBoard: string } | { ask: string } | { problem: string };

// The board a new page goes on (2 above).
async function boardForPage(reach: Reach, folder: string): Promise<Where> {
  const { values } = reach.env;
  if (values['new-board'] !== undefined) {
    const title = values['new-board'].trim();
    return title ? { newBoard: title } : { problem: `--new-board needs the new board's title, as the person gave it. ${NOTHING_SHOWN}` };
  }
  const open = async (id: string): Promise<{ board?: ChosenBoard; why?: string; error?: string }> => {
    const got = await read<Board>(reach, routeUrl(routes.board, { boardId: id }));
    if (got.ok) return got.body.archived ? { why: `The board "${got.body.title}" is archived, so nothing can be added to it.` } : { board: { id: got.body.id, title: got.body.title } };
    return got.status === 404 ? { why: `There's no board "${id}" on this Tricot.` } : { error: got.error };
  };
  let why: string;
  let here: string | undefined;
  if (values.board) {
    const named = await open(values.board);
    if (named.board) return { board: named.board };
    if (named.error) return { problem: `Tricot didn't give the board "${values.board}": ${named.error}` };
    why = named.why!;
  } else {
    const used = boardAround(reach.env, folder);
    if (used) {
      const found = await open(used.board);
      if (found.board) return { board: found.board };
      if (found.error) return { problem: `Tricot didn't give the board "${used.board}": ${found.error}` };
      here = used.board;
      why = `${found.why} It's the board used in ${used.folder}.`;
    } else why = `No board was used in this folder (${folder}) yet, so Tricot can't tell which board the page goes on.`;
  }
  const list = await read<BoardSummary[]>(reach, routeUrl(routes.boards));
  if (!list.ok) return { problem: `Tricot didn't list its boards: ${list.error}` };
  return { ask: boardChoices(why, list.body, here) };
}

// The board used in this folder, or in the nearest folder above it, short of
// the home folder (unless it is the home folder): a project's subfolders and
// worktrees are the project's, but every folder under home isn't home's.
function boardAround(env: Env, folder: string): { board: string; folder: string } | undefined {
  const homeFolder = path.resolve(home(env.ctx.env, env.ctx.platform));
  for (let at = folder; ; at = path.dirname(at)) {
    if (at === homeFolder && at !== folder) return undefined;
    const board = boardUsedIn(env.dataDir, at);
    if (board) return { board, folder: at };
    if (path.dirname(at) === at) return undefined; // the top of the disk
  }
}

// What the agent is told when the person has to choose: why, the boards it
// could be, latest first, and the two ways to run it again.
export function boardChoices(why: string, boards: BoardSummary[], lastHere?: string): string {
  const open = boards.filter((board) => !board.archived);
  if (!open.length) return [why, `There's no board on this Tricot yet. Ask the person what to call one, then run the same command again with --new-board "<title>". Nothing was added.`].join('\n');
  const shown = recentBoards(open, lastHere);
  const width = Math.max(...shown.map((board) => board.id.length));
  const rest = open.length - shown.length;
  return [
    why,
    'Ask the person which board it goes on, then run the same command again with --board <id>, or with --new-board "<title>" for a new board. Nothing was added.',
    'The boards, latest first:',
    ...shown.map((board) => `  ${board.id.padEnd(width)}  ${board.title}`),
    ...(rest > 0 ? [`  and ${rest} more, on Tricot's Projects page.`] : []),
  ].join('\n');
}

async function newBoard(session: AgentSession, title: string): Promise<ChosenBoard> {
  const made = await session.call('create_board', { title });
  return { id: idIn(made, 'id'), title };
}

// ---- a page there already ---------------------------------------------------------

// The page, and its board, as the board has them now.
async function pageOn(reach: Reach, session: AgentSession, pageId: string): Promise<{ board: Board; page: ScratchPage } | { problem: string }> {
  let canvas: string;
  try {
    canvas = await session.call('get_canvas', { page_id: pageId, include_images: false });
  } catch (error) {
    if (error instanceof Refused) return { problem: `${error.message} ${NOTHING_SHOWN}` };
    throw error;
  }
  const got = await read<Board>(reach, routeUrl(routes.board, { boardId: idIn(canvas, 'board id') }));
  const page = got.ok ? got.body.pages?.find((p) => p.id === pageId) : undefined;
  if (!got.ok || !page) return { problem: `Tricot didn't give the page "${pageId}"${got.ok ? '' : `: ${got.error}`}. ${NOTHING_SHOWN}` };
  return { board: got.body, page };
}

// Adds to a page (5 above), or answers on it.
async function onPage(reach: Reach, pageId: string, blocks: Shown[], reply: string | undefined): Promise<CliResult> {
  const { env, lock, agent } = reach;
  const { ctx, values } = env;
  const fail = (line: string): CliResult => {
    ctx.err(line);
    return { exitCode: 1 };
  };
  return asAgent(lock.mcpUrl, agent, reach.headers, async (session) => {
    const found = await pageOn(reach, session, pageId);
    if ('problem' in found) return fail(found.problem);
    const { board, page } = found;
    const link = pageLink(lock.url, board.id, page.id);
    if (!reply) {
      const added = await addBlocks(session, blocks, { page_id: page.id });
      if (added.refused) return partly(env, `Added ${count(added.count)} to the page "${page.title}" as ${agent}, but Tricot refused ${added.refused.from}: ${added.refused.why}`, link);
      ctx.out(`Added ${count(added.count)} to the page "${page.title}" on the board "${board.title}" as ${agent}:`);
      ctx.out(link);
      return { exitCode: 0 };
    }
    const waiting = waitingOn(board, page.id, agent);
    const to = values.to?.trim();
    const item = to ? waiting.find((w) => w.id === to) : waiting.at(-1);
    if (!item) {
      const what = to ? `Nothing on the page "${page.title}" waits for ${agent}'s answer as "${to}"` : `Nothing on the page "${page.title}" waits for ${agent}'s answer`;
      return fail(`${what}: a reply answers what a person asked ${agent} there, in the page's chat or about blocks they selected. To add to the page, name files without --reply. Nothing was posted.`);
    }
    if (item.kind === 'thread') {
      const added = await addBlocks(session, blocks, { page_id: page.id, thread_id: item.id });
      if (added.refused) return partly(env, `Tricot refused ${added.refused.from}: ${added.refused.why} Nothing was posted in the thread.`, link);
      await session.call('reply_in_thread', { thread_id: item.id, body: reply });
      ctx.out(`Answered ${item.by} as ${agent} in the page's thread "${clip(item.title, 60)}"${blocks.length ? `, with ${count(blocks.length)} on the page` : ''}:`);
      ctx.out(link);
      ctx.out(listenLine(page.id, agent));
      return { exitCode: 0 };
    }
    // A selection's ask: its answer is blocks in its group, the words first, then finishing it.
    if (item.ask) {
      const asked = askedKind(item.ask)?.asked;
      return fail(`${item.by} asked for ${asked?.noun ?? 'cards'} about those blocks, which only your Tricot tools make${asked ? ` (${asked.tool} with request_id: ${item.id})` : ''}; tricot show can't. Nothing was posted.`);
    }
    const group = idIn(await session.call('take_request', { request_id: item.id }), 'group id');
    const added = await addBlocks(session, [{ from: '--reply', block: { type: 'note', text: reply } }, ...blocks], { page_id: page.id, group_id: group });
    if (added.refused) return partly(env, `Tricot refused ${added.refused.from}: ${added.refused.why} The ask stays open.`, link);
    await session.call('finish_request', { request_id: item.id, note: clip(reply.split('\n')[0], 200) });
    ctx.out(`Answered ${item.by}'s ask as ${agent}, with ${count(added.count)} in its group on the page "${page.title}":`);
    ctx.out(link);
    ctx.out(listenLine(page.id, agent));
    return { exitCode: 0 };
  });
}

// What a person asked an agent on a page that is still waiting for it, the
// oldest first: a thread from the page's chat bar whose last message is a
// person's, for this agent (or any agent); and an ask about blocks selected
// there, open or taken by this agent, for it (an ask that
// mentions nobody to the page's agent). Read as the board reads them for the
// agent (core/delivery.ts meantFor, core/requests.ts requestFor).
export interface Waiting {
  kind: 'thread' | 'request';
  id: string;
  by: string;
  at: string;
  title: string; // the thread's, or the blocks the ask is about
  ask?: 'decision' | 'tasks'; // an ask for a card, not for blocks
}

export function waitingOn(board: Board, pageId: string, agent: string): Waiting[] {
  const waiting: Waiting[] = [];
  for (const thread of board.threads ?? []) {
    const last = thread.messages.at(-1);
    if (thread.pageId !== pageId || !last || last.author.kind !== 'human') continue;
    const meant = meantFor(board, { thread }, last);
    if (meant && (meant.length === 0 || meant.some((name) => samePerson(name, agent)))) waiting.push({ kind: 'thread', id: thread.id, by: last.author.name, at: last.at, title: thread.title });
  }
  for (const request of board.requests ?? []) {
    if (request.pageId !== pageId || !requestFor(request, agent)) continue;
    if (request.status !== 'open' && !(request.status === 'working' && request.takenBy && samePerson(request.takenBy.name, agent))) continue;
    waiting.push({ kind: 'request', id: request.id, by: request.by.name, at: request.at, title: blocksOf(board, request), ...(request.kind ? { ask: request.kind } : {}) });
  }
  return waiting.sort((a, b) => a.at.localeCompare(b.at));
}

const blocksOf = (board: Board, request: ContextRequest): string => listNames(requestBlocks(board, request).map((block) => blockName(block, 40)));

// ---- listening on a page ----------------------------------------------------------

// Waits until a person asks the agent something on the page (6 above): from
// the agent's last doing on the board, so what came while it was between
// commands isn't missed, and never its own messages (core/concerns.ts
// concernsAgent, on that page alone). It reads the board's news as a person's
// page does, so nothing counts as read by the agent until it prints it. And
// it holds the agent asleep on the board as Tricot's terminal holds the
// agents it wakes (server/sleepers.ts, cli/switcher/wake.ts), registered as
// one on this computer for as long as it runs (terminalKey.ts): the board
// shows the agent listening, and what a person asks it on the page waits for
// it. Another terminal holding it there keeps it; this one listens all the same.
async function listenOnPage(reach: Reach, pageId: string, options: ListenOptions = {}): Promise<CliResult> {
  const { env, lock, agent } = reach;
  const { ctx } = env;
  const found = await asAgent(lock.mcpUrl, agent, reach.headers, (session) => pageOn(reach, session, pageId));
  if ('problem' in found) {
    ctx.err(found.problem.replace(` ${NOTHING_SHOWN}`, ''));
    return { exitCode: 1 };
  }
  const boardId = found.board.id;
  const own = await read<{ events: BoardEvent[] }>(reach, routeUrl(routes.boardEvents, { boardId }, { actor: agent, limit: '1' }));
  let cursor = own.ok && own.body.events[0] ? own.body.events[0].seq : found.board.seq;
  const holder = `tricot-show-${randomBytes(12).toString('base64url')}`;
  const asleep = { name: agent, asleep: true, since: cursor, at: Date.now() };
  const everyMs = options.everyMs ?? LISTEN_EVERY_MS;
  return asThisTerminal(
    lock.url,
    reach.headers,
    async (headers) => {
      const post = (route: string, body: unknown) =>
        fetch(`${lock.url}${route}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
          .then((res) => res.arrayBuffer())
          .catch(() => undefined);
      const hold = (gone = false) => post(routeUrl(routes.wakes, { boardId }), { holder, agents: gone ? [] : [asleep], ...(gone && { gone: [agent] }) });
      let lostAt: number | undefined; // since when Tricot hasn't answered
      for (;;) {
        await post(routeUrl(routes.hostHeartbeat), {});
        await hold();
        try {
          const heard = await heardOnPage(reach, boardId, pageId, cursor);
          lostAt = undefined;
          if ('said' in heard) {
            await hold(true);
            ctx.out(heard.said);
            return { exitCode: 0 };
          }
          cursor = heard.cursor;
        } catch (error) {
          if (!(error instanceof Unanswered)) {
            await hold(true);
            throw error;
          }
          lostAt ??= Date.now();
          if (Date.now() - lostAt >= (options.lostMs ?? LISTEN_LOST_MS)) {
            ctx.err(`Tricot stopped answering while ${agent} listened on the page: run this again once it's back.`);
            return { exitCode: 1 };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
    },
    fetch,
    'tricot show --listen',
  );
}

// How often --listen reads the board's news, and how long it waits for a
// Tricot that stopped answering (it restarted, the computer slept).
export const LISTEN_EVERY_MS = 1_000;
export const LISTEN_LOST_MS = 60_000;

export interface ListenOptions {
  everyMs?: number;
  lostMs?: number;
}

// The board didn't answer a read: tried again, for a while.
class Unanswered extends Error {}

// What came after the cursor for the agent on the page, said as it prints;
// else how far it read.
async function heardOnPage(reach: Reach, boardId: string, pageId: string, since: number): Promise<{ said: string } | { cursor: number }> {
  const events: BoardEvent[] = [];
  let cursor = since;
  for (;;) {
    const got = await read<{ events: BoardEvent[]; more: boolean; seq: number }>(reach, routeUrl(routes.boardEvents, { boardId }, { since: String(cursor), limit: '500' }));
    if (!got.ok) throw got.status === 0 ? new Unanswered(got.error) : new Error(`Tricot didn't give the board's news: ${got.error}`);
    events.push(...got.body.events);
    cursor = got.body.events.at(-1)?.seq ?? Math.max(cursor, got.body.seq);
    if (!got.body.more) break;
  }
  if (!events.length) return { cursor };
  const got = await read<Board>(reach, routeUrl(routes.board, { boardId }));
  if (!got.ok) throw got.status === 0 ? new Unanswered(got.error) : new Error(`Tricot didn't give the board: ${got.error}`);
  const board = got.body;
  const page = board.pages?.find((p) => p.id === pageId);
  if (!page) throw new Error(`The page "${pageId}" was deleted.`);
  for (const event of events) {
    if (!concernsAgent(event, board, reach.agent)) continue;
    const said = saidOnPage(board, page, event, reach.agent);
    if (said) return { said };
  }
  return { cursor };
}

// What a person said to the agent on the page in this event, as --listen
// prints it: who, where, their words, and how to answer. None for an event
// elsewhere.
export function saidOnPage(board: Board, page: ScratchPage, event: BoardEvent, agent: string): string | undefined {
  const answer = (id: string) => `Answer with: tricot show --page ${page.id} --agent ${shellWord(agent)} --to ${id} --reply "<words>" [file ...]`;
  const quoted = (text: string) => text.split('\n').map((line) => `  > ${line}`);
  if (event.type === 'thread_started' || event.type === 'thread_replied') {
    const thread: Thread | undefined = board.threads?.find((t) => t.id === event.itemId);
    if (thread?.pageId !== page.id) return undefined;
    const message = thread.messages.find((m) => m.id === event.commentId) ?? thread.messages.findLast((m) => m.author.name === event.actor.name);
    if (!message) return undefined;
    // A thread over blocks a person selected is for talking them through first.
    const picked = selectionBlocks(board, thread).map((block) => blockName(block, 40));
    const about = hasSelection(thread) ? ` about ${picked.length ? listNames(picked) : 'blocks since removed'}` : '';
    const talk = hasSelection(thread) ? [`It is a conversation about those blocks: answer in words, and add files to the page only once they ask for something made.`] : [];
    return [`${message.author.name} wrote to ${agent} on the page "${page.title}"${about}, in its thread "${clip(thread.title, 60)}":`, ...quoted(message.body), ...talk, answer(thread.id)].join('\n');
  }
  if (event.type === 'request_asked') {
    const request = board.requests?.find((r) => r.id === event.itemId);
    if (request?.pageId !== page.id) return undefined;
    const about = blocksOf(board, request);
    const asked = askedKind(request.kind)?.asked;
    const lead = `${request.by.name} asked ${agent} about ${about || 'blocks'} on the page "${page.title}"${request.kind ? `, for ${asked?.noun ?? 'cards'}` : ''}:`;
    const how = request.kind
      ? `Only your Tricot tools answer this one${asked ? `: ${asked.tool} with request_id: ${request.id}` : ''}.`
      : `${answer(request.id)} (the words and files go in its group beside those blocks)`;
    return [lead, ...quoted(request.text), how].join('\n');
  }
  return undefined;
}
