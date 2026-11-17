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
import type { CardKindName } from './pins';

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
  // That the hook can give a person's answers to an agent's question back to it (hooks/tricot-approve.mjs, from
  // Claude Code's AskUserQuestion on): a hook copy from before this says nothing, and the card then keeps the
  // plain Allow and Deny, as the hook would print nothing for answers.
  canAnswer?: true;
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
  canAnswer?: true;
  at: string;
  board?: string; // the board it is on (its key), where its agent's steps go
  card?: { kind: CardKindName; id: string }; // the card its agent is working on
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

// What a person's reply says, which is an ApprovalBehavior or that they leave
// the agent's prompt to the terminal (`terminal`: the hook prints nothing, and
// the agent asks there as it always did).
export type ApprovalReplyBehavior = ApprovalBehavior | 'terminal';

// Where a person answered: the board's page, or the Tricot tab of the
// terminal the agent runs in (`tricot claude codex`).
export type AnsweredFrom = 'page' | 'terminal';

// A person's answer, as the hook that asked reads it.
export interface ApprovalAnswer {
  behavior: ApprovalReplyBehavior;
  session?: boolean; // allow, and the same for the rest of the session (Claude Code)
  message?: string; // deny: what the agent reads
  answers?: QuestionAnswers; // allow, for an agent's question: the pick for each
  by: string; // who answered
  from?: AnsweredFrom; // the page unless said
  where?: string; // the browser it was answered in, as its seat names it ("Chrome")
}

// What a person sends from the page.
export interface ApprovalReply {
  behavior: ApprovalReplyBehavior;
  session?: boolean;
  reason?: string; // deny: why, for the agent to read
  answers?: QuestionAnswers; // allow, for an agent's question: the pick for each
}

export const APPROVAL_REASON_LIMIT = 500;

// ---- an agent's question ---------------------------------------------------------
// Claude Code asks a person a question with its AskUserQuestion tool: one to
// four of them, each with options to pick from (a few, one or several). The
// hook brings it as any request, its input as the agent sent it; a card that
// finds the input well-formed draws it as questions, and the person's picks go
// back as `answers`, which the hook puts in the tool's input as Claude Code
// reads them: for each question's exact text, the label of the option picked,
// or the person's own words; several labels of a multi-select joined by ", ".

export interface AskedOption {
  label: string;
  description?: string;
}

export interface AskedQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskedOption[];
}

// Each question's exact text, and the answer to it.
export type QuestionAnswers = Record<string, string>;

export const QUESTION_TOOL = 'AskUserQuestion';
export const QUESTION_JOIN = ', ';
export const MAX_QUESTIONS = 4;
export const MAX_QUESTION_OPTIONS = 8;
export const MAX_QUESTION_TEXT = 1_000;
export const MAX_QUESTION_LABEL = 120;
export const MAX_QUESTION_DESCRIPTION = 1_000;
export const MAX_QUESTION_HEADER = 60;
// What a person's own words may be, and all an answer may be (several labels and their own words).
export const MAX_OTHER_ANSWER = 1_000;
export const MAX_QUESTION_ANSWER = MAX_QUESTION_OPTIONS * (MAX_QUESTION_LABEL + QUESTION_JOIN.length) + MAX_OTHER_ANSWER;

const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max;
// Optional words: none given, or some within `max`; anything else is not well-formed (undefined).
const optionalWords = (value: unknown, max: number): { words?: string } | undefined => {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value.trim() ? { words: value.trim() } : {};
};

function askedOption(value: unknown): AskedOption | undefined {
  const option = asRecord(value);
  const description = optionalWords(option.description, MAX_QUESTION_DESCRIPTION);
  if (!plain(option.label, MAX_QUESTION_LABEL) || !description) return undefined;
  return { label: option.label, ...(description.words && { description: description.words }) };
}

function askedQuestion(value: unknown): AskedQuestion | undefined {
  const asked = asRecord(value);
  const header = optionalWords(asked.header, MAX_QUESTION_HEADER);
  if (!plain(asked.question, MAX_QUESTION_TEXT) || !header || !Array.isArray(asked.options)) return undefined;
  if (asked.options.length === 0 || asked.options.length > MAX_QUESTION_OPTIONS) return undefined;
  if (asked.multiSelect !== undefined && typeof asked.multiSelect !== 'boolean') return undefined;
  const options = asked.options.map(askedOption);
  if (options.some((option) => !option) || new Set(options.map((option) => option!.label)).size !== options.length) return undefined;
  return { question: asked.question, ...(header.words && { header: header.words }), multiSelect: asked.multiSelect === true, options: options as AskedOption[] };
}

// The questions in a question tool's input, when it is well-formed: one to
// four questions, each with its own text (the answers are keyed by it) and one
// to eight options, each with a label of its own.
function parseQuestions(input: unknown): AskedQuestion[] | undefined {
  const { questions } = asRecord(input);
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) return undefined;
  const asked = questions.map(askedQuestion);
  if (asked.some((question) => !question) || new Set(asked.map((question) => question!.question)).size !== asked.length) return undefined;
  return asked as AskedQuestion[];
}

// The questions a request asks, when it is Claude Code's AskUserQuestion, its
// hook says it can give answers back (`canAnswer`) and the input is well-formed.
// Anything else is no question here, and keeps the card it always had.
export function questionsOf(approval: Partial<Pick<Approval, 'harness' | 'tool' | 'input' | 'canAnswer' | 'sealed'>>): AskedQuestion[] | undefined {
  if (approval.sealed || !approval.canAnswer || approval.harness !== 'claude' || approval.tool !== QUESTION_TOOL) return undefined;
  return parseQuestions(approval.input);
}

// Whether `answers` answer exactly the questions of a request: only a question
// has any, one for each of its questions' texts and no other, each in words.
// The sentence that says what is wrong, or undefined when all is right.
export function questionAnswersProblem(approval: Pick<Approval, 'harness' | 'tool' | 'input' | 'canAnswer' | 'sealed'>, answers: QuestionAnswers): string | undefined {
  const asked = questionsOf(approval);
  if (!asked) return "This request asks no question that can be answered here, so there is nothing to answer: allow it, or deny it.";
  const given = Object.keys(answers);
  if (given.length !== asked.length || asked.some(({ question }) => !Object.hasOwn(answers, question))) return 'Answer each question, and only the questions asked.';
  if (given.some((key) => !plain(answers[key], MAX_QUESTION_ANSWER))) return `Each answer is some words, up to ${MAX_QUESTION_ANSWER} characters.`;
  return undefined;
}

// What a person's picks say, as Claude Code reads one: the labels picked and
// the person's own words, joined by ", ".
export const joinAnswer = (parts: string[]): string => parts.join(QUESTION_JOIN);

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
  if (approval.tool === QUESTION_TOOL) {
    const count = parseQuestions(approval.input)?.length ?? 1;
    return count === 1 ? 'Ask you a question' : `Ask you ${count} questions`;
  }
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

// The line a card or a toast leads with: "Claude is waiting for your OK", or "Claude asks you" for a question.
export const waitingWords = (approval: Pick<Approval, 'agent' | 'role'> & Parameters<typeof questionsOf>[0]): string =>
  `${approval.agent}${approval.role ? ` (${approval.role} subagent)` : ''} ${questionsOf(approval) ? 'asks you' : 'is waiting for your OK'}`;

// What leads the tab's title while it is in the background: "⏸ Claude needs
// you", before the page's name (web/shared/tabTitle.ts).
export function needsYouTitle(agents: string[]): string {
  const names = [...new Set(agents)];
  if (names.length === 0) return '';
  if (names.length > 2) return `⏸ ${names.length} agents need you`;
  return `⏸ ${listNames(names)} need${names.length === 1 ? 's' : ''} you`;
}

// The requests a board's own "what needs you" counts: those on it (on one of its
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
export function alreadyAnswered(answer: Pick<ApprovalAnswer, 'behavior' | 'session' | 'answers' | 'by' | 'from' | 'where'>): string {
  const what =
    answer.behavior === 'deny' ? 'denied it' : answer.behavior === 'terminal' ? 'left it to the terminal' : answer.answers ? 'answered it' : answer.session ? 'allowed it for the session' : 'allowed it';
  return `Already answered: ${answer.by} ${what} ${whereAnswered(answer.from, answer.where)}.`;
}

// A system notification's words: who needs you, and for what.
export function notificationText(approval: Approval): { title: string; body: string } {
  if (approval.sealed) return { title: `${approval.agent} needs your OK`, body: 'Let this browser act for you to see what it asks, and answer.' };
  const asked = questionsOf(approval);
  return { title: `${approval.agent} needs your OK`, body: clip(`${approvalAction(approval)}: ${asked ? asked.map((q) => q.question).join(' ') : approvalText(approval).text}`, 180) };
}
