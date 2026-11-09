// Approvals: an agent's permission prompt ("may I run this?"), brought to
// the board, where a person answers it, instead of the terminal. The agents
// that have it (approvals in the registry: Claude Code and Codex) run
// hooks/tricot-approve.mjs on their PermissionRequest event; it sends Tricot
// the request, waits for the person's answer, and gives it back to the agent
// as its own decision (server/approvals.ts keeps the requests,
// server/approvalsRoutes.ts serves them, web/access/approvals.tsx shows them).
//
// The hook never decides on its own: when Tricot can't be reached, the agent
// asks in the terminal as it always did. Only a person answers, from a
// browser or a Tricot tab (cli/switcher/tricotTab.ts) they let in as one of
// their seats (core/seats.ts): there is no MCP tool for it, and nothing an
// agent reads presents one.
//
// Types and words only: the browser imports this.

import { agentKinds } from './agents/registry';
import { clip, listNames } from './format';

// Which agent asks, by its id: one whose prompts come to the board
// (AgentKind.approvals; the registry's, agents/registry.ts). Read when asked,
// so this file can be imported before the agents have loaded.
export type ApprovalHarness = string;
export const approvalHarnesses = (): ApprovalHarness[] => agentKinds().filter((kind) => kind.approvals).map((kind) => kind.id);

// What the hook sends: the request as the agent made it.
export interface ApprovalRequest {
  harness: ApprovalHarness;
  tool: string; // "Bash", "Edit", "apply_patch", "mcp__github__create_issue"
  input: unknown; // the tool's input, exactly as the agent sent it
  description?: string; // why, in the agent's words (a command's description)
  session?: string; // the harness's session id
  worker?: string; // a subagent's id within it
  role?: string; // a subagent's type
  cwd?: string; // the folder the agent works in
  // What "Allow for this session" would also allow, in words (Claude Code's
  // suggestions, made to last the session only), one item for each rule,
  // mode or folder, every one shown in full; none: it isn't offered.
  forSession?: string[];
  at?: number; // ms since the epoch, when the agent asked
}

// What a card shows of "for this session": up to this many items, each in
// full up to this length. The hook offers it only when everything it would
// add fits (hooks/tricot-approve.mjs), and the server refuses a request with
// more (schemas/people.ts), so what is allowed is always what was shown.
export const APPROVAL_SESSION_ITEMS = 20;
export const APPROVAL_SESSION_ITEM = 500;

// One request waiting for a person, as pages see it. `id` is public (a page
// answers by it); the key that reads the answer is the hook's alone.
export interface Approval {
  id: string;
  agent: string; // its name on the board
  harness: ApprovalHarness;
  tool: string;
  input: unknown;
  description?: string;
  role?: string;
  cwd?: string;
  forSession?: string[];
  at: string;
  board?: string; // the board it is on (its key), where its agent's steps go
  card?: { kind: 'task' | 'decision'; id: string }; // the card its agent is working on
  on?: { board: string; title: string; card?: string; cardTitle?: string }; // as people name them: the board's id and title, "T183"
  // To a page or terminal that isn't one of the person's seats (core/seats.ts):
  // that an agent waits, and where, but not what it asks (tool and input
  // empty), which only a seat reads; it says to let that page or terminal in.
  sealed?: true;
}

// A request as a page or terminal that isn't a seat gets it.
export function sealedApproval(approval: Approval): Approval {
  const { id, agent, harness, role, at, board, card, on } = approval;
  return { id, agent, harness, tool: '', input: null, at, sealed: true, ...(role && { role }), ...(board && { board }), ...(card && { card }), ...(on && { on }) };
}

export type ApprovalBehavior = 'allow' | 'deny';

// Where a person answered: the board's page, or the Tricot tab of the
// terminal the agent runs in (`tricot claude codex`, T192).
export type AnsweredFrom = 'page' | 'terminal';

// A person's answer, as the hook that asked reads it.
export interface ApprovalAnswer {
  behavior: ApprovalBehavior;
  session?: boolean; // allow, and the same for the rest of the session (Claude Code)
  message?: string; // deny: what the agent reads
  by: string; // who answered
  from?: AnsweredFrom; // the page unless said
  where?: string; // the browser it was answered in, as its seat names it ("Chrome")
}

// What a person sends from the page.
export interface ApprovalReply {
  behavior: ApprovalBehavior;
  session?: boolean;
  reason?: string; // deny: why, for the agent to read
}

export const APPROVAL_REASON_LIMIT = 500;

// ---- words ---------------------------------------------------------------------

// The last part of a path, on any system: the folder the agent works in, by name.
function lastPart(file: string): string {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? file;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const stringOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// A file the tool names, as the person knows it: from the folder the agent works in.
function fileOf(input: Record<string, unknown>, cwd?: string): string | undefined {
  const file = stringOf(input.file_path) ?? stringOf(input.notebook_path) ?? stringOf(input.path);
  if (!file) return undefined;
  const base = cwd?.replace(/[\\/]+$/, '');
  return base && file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
}

const COMMAND_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell', 'unified_exec']);

// A command the tool runs, as the agent sent it; undefined for other tools.
function commandOf(tool: string, input: Record<string, unknown>): string | undefined {
  if (!COMMAND_TOOLS.has(tool)) return undefined;
  const command = input.command ?? input.cmd;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return stringOf(command);
}

// What the agent asks to do, in a few words: "Run a command in tricot",
// "Edit src/web/App.tsx", "Use github: create issue".
export function approvalAction(approval: Pick<Approval, 'tool' | 'input' | 'cwd' | 'sealed'>): string {
  if (approval.sealed) return 'Let this browser act for you to see what it asks'; // a page or terminal that isn't a seat
  const input = asRecord(approval.input);
  const file = fileOf(input, approval.cwd);
  const where = approval.cwd ? ` in ${lastPart(approval.cwd)}` : '';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(approval.tool);
  if (mcp) return `Use ${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}`;
  if (commandOf(approval.tool, input) !== undefined || COMMAND_TOOLS.has(approval.tool)) return `Run a command${where}`;
  switch (approval.tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `Edit ${file}` : `Edit a file${where}`;
    case 'Write':
      return file ? `Write ${file}` : `Write a file${where}`;
    case 'apply_patch':
      return `Change files${where}`;
    case 'Read':
      return file ? `Read ${file}` : `Read a file${where}`;
    case 'WebFetch':
      return 'Fetch a web page';
    case 'WebSearch':
      return 'Search the web';
    default:
      return `Use ${approval.tool.replace(/_/g, ' ')}`;
  }
}

// What the agent sent, exactly, as plain text to show: a command as it would
// run, a patch as it is, anything else as its input's JSON. `more` are the
// other things a command was sent with ("run_in_background: true"), which
// change what allowing it does.
export function approvalText(approval: Pick<Approval, 'tool' | 'input' | 'sealed'>): { text: string; more: string[] } {
  if (approval.sealed) return { text: '', more: [] };
  const input = asRecord(approval.input);
  const command = commandOf(approval.tool, input);
  if (command !== undefined) {
    const more = Object.entries(input)
      .filter(([key]) => key !== 'command' && key !== 'cmd' && key !== 'description')
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    return { text: command, more };
  }
  if (approval.tool === 'apply_patch') {
    const patch = stringOf(input.command) ?? stringOf(input.patch) ?? stringOf(input.input);
    if (patch !== undefined) return { text: patch, more: [] };
  }
  let text: string;
  try {
    text = JSON.stringify(approval.input, null, 2) ?? String(approval.input);
  } catch {
    text = String(approval.input);
  }
  return { text, more: [] };
}

// The line a card or a toast leads with: "Claude is waiting for your OK".
export const waitingWords = (approval: Pick<Approval, 'agent' | 'role'>): string =>
  `${approval.agent}${approval.role ? ` (${approval.role} subagent)` : ''} is waiting for your OK`;

// What leads the tab's title while it is in the background: "⏸ Claude needs
// you", before the page's name (web/shared/tabTitle.ts).
export function needsYouTitle(agents: string[]): string {
  const names = [...new Set(agents)];
  if (names.length === 0) return '';
  if (names.length > 2) return `⏸ ${names.length} agents need you`;
  return `⏸ ${listNames(names)} need${names.length === 1 ? 's' : ''} you`;
}

// The requests a board's own "Needs you" counts: those on it (on one of its
// cards, or on the board with no card), and those on no board yet, which
// wait wherever the person is. Home counts them all.
export const approvalsOn = <T extends Pick<Approval, 'board'>>(approvals: T[], boardKey: string): T[] =>
  approvals.filter((approval) => approval.board === undefined || approval.board === boardKey);

// Home's headline counts each request with what else needs the person, and
// says who waits: "Claude is waiting for your OK."
export function waitingSentence(approvals: Pick<Approval, 'agent'>[]): string | undefined {
  const names = [...new Set(approvals.map((a) => a.agent))];
  if (names.length === 0) return undefined;
  if (names.length > 2) return `${names.length} agents are waiting for your OK.`;
  return `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} waiting for your OK.`;
}

// "in Tricot's terminal", "in Chrome", or "on the Tricot board".
export const whereAnswered = (from?: AnsweredFrom, where?: string) => (from === 'terminal' ? "in Tricot's terminal" : where ? `in ${where}` : 'on the Tricot board');

// What the agent reads when a person says no: who, where, and why if they said.
export function denyMessage(by: string, reason?: string, from?: AnsweredFrom, where?: string): string {
  const why = reason?.trim();
  return `${by} denied this ${whereAnswered(from, where)}${why ? `: ${why}` : '.'}`;
}

// What a second answer is told, from the board or the terminal, when the
// first one won: "Already answered: Sam allowed it in Chrome."
export function alreadyAnswered(answer: Pick<ApprovalAnswer, 'behavior' | 'session' | 'by' | 'from' | 'where'>): string {
  const what = answer.behavior === 'deny' ? 'denied it' : answer.session ? 'allowed it for the session' : 'allowed it';
  return `Already answered: ${answer.by} ${what} ${whereAnswered(answer.from, answer.where)}.`;
}

// A system notification's words: who needs you, and for what.
export function notificationText(approval: Approval): { title: string; body: string } {
  if (approval.sealed) return { title: `${approval.agent} needs your OK`, body: 'Let this browser act for you to see what it asks, and answer.' };
  return { title: `${approval.agent} needs your OK`, body: clip(`${approvalAction(approval)}: ${approvalText(approval).text}`, 180) };
}
