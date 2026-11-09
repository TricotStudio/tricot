// Home's first run (#79, "Just ask"): until a person has a project, Home asks
// "What are you working on?" and one sentence starts everything. Sending it
// makes the project, titled with a few words drawn from the sentence and with
// the whole sentence as its goal, and starts a thread on its Decisions tab
// asking the agent what it needs decided, so its first question card lands
// beside the conversation (web/firstRun.tsx). Words and rules only: the
// browser imports this, and the tests read it.

import { LIMITS } from './schemas/limits';
import { defaultAgent, findAgent } from './agents/registry';
import type { ThreadDoor } from './types';

// ---- when it shows ------------------------------------------------------------------

// While no board is in use (none, or only archived ones), or while a send from
// it is under way: the board it has just made mustn't swap the page for the
// normal Home before the board opens.
export function firstRunShows(boards: { archived: boolean }[], sending: boolean): boolean {
  return sending || !boards.some((board) => !board.archived);
}

// ---- the project's title -----------------------------------------------------------

const TITLE_WORDS = 7;
const TITLE_CHARS = 50;
// Where the title's clause ends: a sentence's end, a colon or a semicolon
// before a space (not an address's), a dash or an opening bracket. Commas
// are lists ("a pricing page, retry logic"), so they only cut a clause that
// is still too long.
const CLAUSE_END = /(?<=[.?!])\s|[:;](?=\s|$)|[(—–]|\s-\s/;
// Words that say nothing of the work, in front of it.
const LEAD_IN = /^(?:(?:i[’']?m|i am|we[’']?re|we are)\s+)?(?:currently\s+)?working on\s+/i;
const ARTICLE = /^(?:a|an|the)\s+/i;
// Words a cut can leave hanging at the end: "Retry logic for the".
const DANGLING = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'so', 'for', 'with', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'into', 'about', 'that', 'which', 'our', 'my', 'your', 'its', 'is', 'are']);
const EDGE_PUNCTUATION = /^[\s"'“”‘’`*_]+|[\s"'“”‘’`*_,.;:!?…-]+$/g;

// A few words from the sentence, at a word boundary: its first clause, without
// "I'm working on" or a leading article, cut to seven words and fifty
// characters, and never ending on "for" or "the". "A pricing page for the Pro
// plan: which tiers we show…" is "Pricing page for the Pro plan".
export function shortTitle(sentence: string): string {
  const line = sentence.trim().split(/\r?\n/).find((l) => l.trim()) ?? '';
  const flat = line.replace(/\s+/g, ' ').trim();
  let clause = flat.split(CLAUSE_END)[0].replace(EDGE_PUNCTUATION, '');
  clause = clause.replace(LEAD_IN, '').replace(ARTICLE, '');
  let words = clause.split(' ').filter(Boolean);
  if (words.length > TITLE_WORDS) {
    const comma = words.findIndex((w) => w.endsWith(','));
    if (comma >= 1) words = words.slice(0, comma + 1);
  }
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length === TITLE_WORDS || [...kept, word].join(' ').length > TITLE_CHARS) break;
    kept.push(word);
  }
  while (kept.length > 1 && DANGLING.has(kept.at(-1)!.replace(/[,.;:!?]+$/, '').toLowerCase())) kept.pop();
  const title = kept.join(' ').replace(/["“”]/g, '').replace(EDGE_PUNCTUATION, '');
  // A first word longer than the title can be (an address), or nothing left
  // once trimmed ("???"): the start of the line as it was written.
  if (!title) return (flat.replace(EDGE_PUNCTUATION, '') || flat).slice(0, TITLE_CHARS).trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// ---- where Tricot was started ------------------------------------------------------

// The folder `tricot` was started in, as the server tells the page
// (/api/info, server/startFolder.ts): from ~, and what it is. Other: no git
// repository or package file there.
export interface StartFolder {
  shown: string; // "~/work/app"; "~" for the home folder itself
  kind: 'project' | 'home' | 'other';
}

// Near the welcome: where Tricot was started, or, when that isn't a project
// folder, gently so, rather than presenting ~ as the project.
export function folderLine(folder: StartFolder): { lead: string; path?: string; after?: string } {
  if (folder.kind === 'project') return { lead: 'Started in', path: folder.shown };
  if (folder.kind === 'home') return { lead: 'Started in your home folder: start Tricot inside a project folder to tie boards to it.' };
  return { lead: 'Started in', path: folder.shown, after: ", which isn't a project folder: start Tricot inside one to tie boards to it." };
}

// The line under the field, with the folder when it is a project's.
export function helperLine(folder: StartFolder | undefined): { lead: string; path?: string; after: string } {
  if (folder?.kind === 'project') return { lead: 'Tricot starts a project for it, here in', path: folder.shown, after: ', and asks your agent what it needs you to decide.' };
  return { lead: 'Tricot starts a project for it and asks your agent what it needs you to decide.', after: '' };
}

// On the new board's context, for agents (get_board points them to it before
// they plan): which folder the project is about. None outside a project folder.
export function folderNote(folder: StartFolder | undefined): { title: string; text: string } | undefined {
  if (folder?.kind !== 'project') return undefined;
  return { title: 'Project folder', text: `Tricot was started in \`${folder.shown}\`: the folder this project is about.` };
}

// ---- what is sent -------------------------------------------------------------------

export const FIRST_RUN_LIMIT = LIMITS.goal; // the sentence is the board's goal, so it holds as much as a goal does
export const FIRST_DOOR = 'decisions' satisfies ThreadDoor; // the tab it opens on, whose door the thread goes through
export const FIRST_QUESTION = 'What do you need me to decide first?';

// The thread's first message: the sentence as written, then the ask.
export function firstAsk(sentence: string): string {
  return `${sentence.trim()}\n\n${FIRST_QUESTION}`;
}

// What sending needs from the server: making the board, starting its thread.
// `noteFolder`, when Tricot was started in a project folder: the note that
// says which, on the new board's context (folderNote).
export interface FirstRunSteps<B extends { id: string }, T> {
  createBoard(title: string, goal: string): Promise<B>;
  startThread(boardId: string, body: string, door: ThreadDoor): Promise<T>;
  noteFolder?(boardId: string): Promise<unknown>;
}

// A send that failed. With `board`, the project was made and only the
// question didn't go: sending again asks on that project instead of making another.
export class FirstRunError<B> extends Error {
  constructor(
    message: string,
    readonly board?: B,
  ) {
    super(message);
    this.name = 'FirstRunError';
  }
}

// Sending, once at a time: a second press (a double click) while one is under
// way does nothing and resolves to undefined. A project made by an earlier
// try whose question didn't go is asked on again, not made twice.
export function firstRunSender<B extends { id: string }, T>(steps: FirstRunSteps<B, T>) {
  let sending = false;
  let made: B | undefined;
  return async (sentence: string): Promise<{ board: B; thread: T } | undefined> => {
    const text = sentence.trim();
    if (!text || sending) return undefined;
    sending = true;
    try {
      let board = made;
      if (!board) {
        try {
          board = made = await steps.createBoard(shortTitle(text), text);
        } catch (error) {
          throw new FirstRunError(`The project wasn't made. ${messageOf(error)}`);
        }
        // Context, not the question: a note that doesn't land leaves the
        // project and the question as they are.
        await steps.noteFolder?.(board.id).catch(() => {});
      }
      try {
        return { board, thread: await steps.startThread(board.id, firstAsk(text), FIRST_DOOR) };
      } catch (error) {
        throw new FirstRunError(`The project is made, but your question didn't send. ${messageOf(error)} Send it again to ask.`, board);
      }
    } finally {
      sending = false;
    }
  };
}

const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

// ---- connecting an agent -----------------------------------------------------------

// The agents the Connect panel has a command for: those in the registry
// (agents/registry.ts), in the order the hook installers list them.
export type FirstTool = string;

// The agent to show the command for: the first found on this computer (as
// live steps see them: its folder or its command), else the registry's
// default (Claude Code).
export function agentToConnect(agents: { id: string; name: string; found: boolean }[] | undefined): { tool: FirstTool; name: string; found: boolean } {
  const here = agents?.find((a) => a.found && findAgent(a.id));
  if (here) return { tool: here.id, name: here.name, found: true };
  const { id, name } = defaultAgent();
  return { tool: id, name, found: false };
}

// What to do with the command, in a sentence, before it. An agent with no
// command of its own has an entry for a file instead.
export function connectWords({ tool, name, found }: { tool: FirstTool; name: string; found: boolean }): string {
  if (!found) return `Tricot didn't find an agent on this computer. For ${name}, run this once in a terminal, then start a new session.`;
  const connect = findAgent(tool)?.connect;
  if (connect?.how === 'file') return `${name} is on this computer: add this to its settings (${connect.file}), then start a new ${name} session.`;
  return `${name} is on this computer: run this once in a terminal, then start a new ${name} session.`;
}

export const WAITS_LINE = 'Your question waits on the board until it connects.';

// Under that line, what to say to it so it listens (LISTEN_PHRASE,
// core/delivery.ts): until it listens, it won't see the new project unless
// it is told to look.
export function listenHintShows(agent: { state: 'listening' | 'working' | 'away' }): boolean {
  return agent.state !== 'listening';
}

// The one quiet line in its place once an agent has connected: what it
// does with the sentence, by how present it is. An agent listening gets it at
// once; one that only connected (its session started, or it made a call off
// any board) when it next checks; one gone quiet when it comes back.
export function agentLine(agent: { name: string; state: 'listening' | 'working' | 'away' }): string {
  if (agent.state === 'listening') return `${agent.name} is listening. It gets this the moment you send it.`;
  if (agent.state === 'working') return `${agent.name} is connected. It sees this the next time it checks the board.`;
  return `${agent.name} connected earlier but isn't checking now. Your question waits on the board until it does.`;
}
