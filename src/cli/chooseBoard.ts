// Which board `tricot claude` starts the agent on: the one --board names, or
// one picked in the terminal (boardPicker.ts) from the running board's list,
// or a new one made there. It asks the running board over its REST API, as
// the browser does, since that server holds the boards.
//
// The board used in each folder is remembered in the data folder
// (folder-boards.json, by the folder's absolute path), never in the project,
// and starts highlighted the next time the picker opens there.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routes, routeUrl } from '../core/routes';
import { LIMITS } from '../core/schemas/limits';
import type { BoardSummary } from '../core/types';
import { authHeaders } from '../platform/token';
import { pickBoard, type PickerBoard, type TerminalKeys } from './boardPicker';
import { asThisTerminal } from './terminalKey';

export interface ChosenBoard {
  id: string;
  title: string;
}

export type Choice = { board: ChosenBoard } | { problem: string } | { cancelled: true };

export interface ChooseOptions {
  url: string; // the running board's address
  dataDir: string;
  folder: string; // where the command runs
  board?: string; // --board
  keys?: TerminalKeys; // none without a terminal
  question: string; // "Which board should Claude work on?"
  now?: number;
}

// The most boards the picker lists; the one used here last is always among them.
export const PICKER_BOARDS = 8;

export async function chooseBoard(options: ChooseOptions): Promise<Choice> {
  const { url, dataDir, folder } = options;
  const choice = options.board ? await namedBoard(url, dataDir, options.board) : await picked(options);
  if ('board' in choice) rememberBoardIn(dataDir, folder, choice.board.id);
  return choice;
}

async function namedBoard(url: string, dataDir: string, board: string): Promise<Choice> {
  const res = await call(url, dataDir, routeUrl(routes.board, { boardId: board }));
  if (res.status === 404) return { problem: `There's no board "${board}" on this Tricot. Leave out --board to pick one in the terminal.` };
  if (!res.ok) return { problem: `Tricot didn't give the board "${board}": ${res.error}` };
  const found = res.body as { id: string; title: string };
  return { board: { id: found.id, title: found.title } };
}

async function picked(options: ChooseOptions): Promise<Choice> {
  const { url, dataDir, folder, keys } = options;
  if (!keys) return { problem: 'Name the board to work on: add --board <id>. Without it, Tricot asks in a terminal.' };
  const list = await call(url, dataDir, routeUrl(routes.boards));
  if (!list.ok) return { problem: `Tricot didn't list its boards: ${list.error}` };
  const lastHere = boardUsedIn(dataDir, folder);
  const boards = recentBoards(list.body as BoardSummary[], lastHere);
  const pick = await pickBoard(keys, {
    question: options.question,
    boards,
    lastHere,
    newName: path.basename(folder) || 'My board',
    maxName: LIMITS.boardTitle,
    now: options.now,
  });
  if (!pick) return { cancelled: true };
  if ('board' in pick) return { board: { id: pick.board.id, title: pick.board.title } };
  // Making a board is a person's, so it goes as this terminal's (terminalKey.ts).
  const actor = await personName(url, dataDir, boards);
  const made = await asThisTerminal(url, authHeaders(dataDir), (headers) => call(url, dataDir, routeUrl(routes.createBoard), { title: pick.title, actor }, headers));
  if (!made.ok) return { problem: `Tricot didn't make the board "${pick.title}": ${made.error}` };
  const board = made.body as { id: string; title: string };
  return { board: { id: board.id, title: board.title } };
}

// The boards updated most recently, newest first, but never archived ones,
// and with the one used here last among them.
export function recentBoards(all: BoardSummary[], lastHere?: string): PickerBoard[] {
  const open = all.filter((board) => !board.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = open.slice(0, PICKER_BOARDS);
  const here = open.find((board) => board.id === lastHere);
  if (here && !shown.includes(here)) shown.splice(PICKER_BOARDS - 1, 1, here);
  return shown.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
}

// Who makes a new board: the person who last did something on the board
// updated most recently, as the browser named them, else this computer's account.
async function personName(url: string, dataDir: string, boards: PickerBoard[]): Promise<string> {
  return personOn(url, dataDir, boards[0]?.id);
}

// The person at this terminal, as a board knows them: the one who last did
// something on it, as the browser named them, else this computer's account.
// It names who answers from the Tricot tab (switcher/tricotTab.ts) too.
export async function personOn(url: string, dataDir: string, board: string | undefined): Promise<string> {
  if (board) {
    const res = await call(url, dataDir, routeUrl(routes.board, { boardId: board }));
    const actors = res.ok ? ((res.body as { activity?: { actors?: { actor: { kind: string; name: string } }[] } }).activity?.actors ?? []) : [];
    const person = actors.find((seen) => seen.actor.kind === 'human');
    if (person) return person.actor.name;
  }
  try {
    return os.userInfo().username || 'You';
  } catch {
    return 'You';
  }
}

type Called = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: string };

async function call(url: string, dataDir: string, route: string, post?: unknown, headers: Record<string, string> = authHeaders(dataDir)): Promise<Called> {
  try {
    const res = await fetch(`${url}${route}`, {
      method: post ? 'POST' : 'GET',
      headers: { ...headers, ...(post ? { 'Content-Type': 'application/json' } : {}) },
      ...(post ? { body: JSON.stringify(post) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true, status: res.status, body } : { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---- the board used in each folder ------------------------------------------------

export const FOLDER_BOARDS_FILE = 'folder-boards.json';
const FOLDERS_KEPT = 200;

type FolderBoards = Record<string, { board: string; at: string }>;

function readFolderBoards(dataDir: string): FolderBoards {
  try {
    const kept = JSON.parse(readFileSync(path.join(dataDir, FOLDER_BOARDS_FILE), 'utf8')) as unknown;
    return kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as FolderBoards) : {};
  } catch {
    return {};
  }
}

export function boardUsedIn(dataDir: string, folder: string): string | undefined {
  const kept = readFolderBoards(dataDir)[path.resolve(folder)];
  return typeof kept?.board === 'string' ? kept.board : undefined;
}

// Kept for the folders used most recently; one that can't be written is
// forgotten, which costs a keypress next time.
export function rememberBoardIn(dataDir: string, folder: string, board: string): void {
  const all = { ...readFolderBoards(dataDir), [path.resolve(folder)]: { board, at: new Date().toISOString() } };
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))
    .slice(0, FOLDERS_KEPT);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, FOLDER_BOARDS_FILE), `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Not remembered.
  }
}
