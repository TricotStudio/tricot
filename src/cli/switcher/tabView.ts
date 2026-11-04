// The Tricot tab, drawn (T192): the board and where it runs, each agent and
// what it is doing, the requests for permission waiting with their keys,
// and the board's latest activity, in the rows above the strip.
//
//    Tricot · Tricot roadmap                         http://127.0.0.1:4545
//
//    Your agents
//      1 Claude   Running npm test                          1 min 12 s
//      2 Codex    Listening on the board
//
//    Waiting for your OK
//      Claude wants to run a command in tricot:
//        rm -rf dist && npm run build
//        "Rebuild the web bundle after the CSS change"
//      [y] allow   [s] allow for this session   [n] deny
//
//    Lately on the board
//      Wassim approved T183 and asked for a commit           2 min ago
//
//    o open the board · a add an agent · x stop one · q quit
//
// Every size gets what fits: each row has a priority, and the rows kept are
// the most important ones, in their order (a short window loses the blank
// rows, then the activity, then all but the first lines of a long
// command, which says how many more it has). The keys stay on the last row.
//
// What agents sent is shown as plain text, exactly: a control character is
// shown as its picture (␛), never sent to the terminal.
import { approvalAction, approvalText, type Approval } from '../../core/approvals';
import { admissionWords, type AdmissionView } from '../../core/seats';
import type { BoardEvent } from '../../core/types';
import { columns, fit, type AgentDoing, type Tone } from './strip';

export type TabPrompt =
  | { kind: 'keys' } // the tab's own keys
  | { kind: 'add'; choices: { name: string; note?: string }[] }
  | { kind: 'stop'; choices: { number: number; name: string }[] }
  | { kind: 'confirm-stop'; name: string };

export interface TabView {
  title?: string; // the board's
  url: string; // Tricot's address
  connected: boolean; // to the board's stream
  agents: { number: number; name: string; doing: AgentDoing }[];
  approvals: Approval[]; // waiting, oldest first
  selected: number; // the one the keys answer
  sending?: 'allow' | 'deny'; // its answer is on its way
  reason?: string; // denying it: the reason typed so far
  activity: BoardEvent[]; // newest first
  // A browser or terminal asking to act for the person, for this terminal to answer (T187).
  admission?: AdmissionView & { sending?: boolean };
  // This terminal as one of the person's seats: let in, or the code it asks with.
  seat?: { seated: boolean; code?: string; asking?: boolean };
  prompt: TabPrompt;
  note?: { text: string; tone: Tone }; // what the last key did
  quitting?: boolean;
  now: number;
}

export interface TabFrame {
  rows: string[]; // each as written from the row's first column, colours and all
  plain: string[]; // the same as text
  cursor?: { x: number; y: number }; // from 0; shown only while a reason is typed
}

// Looks, as SGR parameters: the terminal's own colours, bold and dim, and
// the strip's alert colour, light or dark.
const BOLD = '1';
const DIM = '2';
const alertOf = (light: boolean) => (light ? '38;5;130' : '38;5;214');

type Part = [text: string, sgr?: string];

// One row: the parts, cut to the width, the rest erased.
function paint(parts: Part[], width: number): { line: string; plain: string } {
  let line = '';
  let plain = '';
  for (const [text, sgr] of parts) {
    const room = width - columns(plain);
    if (room <= 0) break;
    const shown = fit(text, room);
    line += `\x1b[0${sgr ? `;${sgr}` : ''}m${shown}`;
    plain += shown;
  }
  return { line: columns(plain) < width ? `${line}\x1b[0m\x1b[K` : `${line}\x1b[0m`, plain };
}

// Parts at the left and at the right of one row; the right ones go first
// when there isn't room for both with a gap.
function spread(left: Part[], right: Part[], width: number, gap = 3): Part[] {
  const used = (parts: Part[]) => parts.reduce((sum, [text]) => sum + columns(text), 0);
  const rightWidth = used(right);
  if (!right.length || used(left) + gap + rightWidth > width) {
    // The left alone, unless it can be cut to leave the right some room.
    const room = width - rightWidth - gap;
    if (!right.length || room < Math.min(24, used(left))) return left;
    return [...cutParts(left, room), [' '.repeat(gap)], ...right];
  }
  return [...left, [' '.repeat(width - used(left) - rightWidth)], ...right];
}

function cutParts(parts: Part[], room: number): Part[] {
  const out: Part[] = [];
  let left = room;
  for (const [text, sgr] of parts) {
    if (left <= 0) break;
    const shown = fit(text, left);
    out.push([shown, sgr]);
    left -= columns(shown);
  }
  return out;
}

// Words from the board on one line: control characters out.
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

// What an agent sent, shown as itself: tabs as spaces, and each control
// character (and a direction override, which could hide what follows) as a
// picture of it, so nothing it sent reaches the terminal as a command.
export function asSent(line: string): string {
  return line
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u001f]/g, (c) => String.fromCharCode(0x2400 + c.charCodeAt(0)))
    .replace(/\u007f/g, '␡')
    .replace(/[\u0080-\u009f‎‏‪-‮⁦-⁩]/g, '�');
}

const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);
const upperFirst = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

// "just now", "2 min ago", "3 h ago", "2 d ago".
export function ago(at: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(at)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// "Claude wants to run a command in tricot"
export function wantsTo(approval: Approval): string {
  if (approval.sealed) return waitingFor(approval);
  return `${who(approval)} wants to ${lowerFirst(oneLine(approvalAction(approval)))}`;
}

// "Claude is waiting for your OK": all a terminal that isn't a seat reads of it.
const waitingFor = (approval: Approval) => `${who(approval)} is waiting for your OK`;
const who = (approval: Approval) => `${oneLine(approval.agent)}${approval.role ? ` (${oneLine(approval.role)} subagent)` : ''}`;

interface Row {
  parts: Part[];
  priority: number;
  command?: number; // the command's line, from 0
}

export function renderTab(view: TabView, cols: number, rows: number, light = false): TabFrame {
  const alert = alertOf(light);
  const body: Row[] = [];
  const add = (priority: number, parts: Part[], more: Partial<Row> = {}) => body.push({ parts, priority, ...more });
  const blank = (priority: number) => add(priority, []);
  const toneSgr = (tone: Tone) => (tone === 'alert' ? alert : tone === 'quiet' ? DIM : undefined);
  let cursorRow: { index: number; x: number } | undefined;

  // ---- the board and where it runs
  const title = view.title ? oneLine(view.title) : undefined;
  add(100, spread([[' Tricot', BOLD], ...(title ? ([[' · '], [title, BOLD]] as Part[]) : [])], [[view.connected ? view.url : `${view.url} · connecting…`, DIM], [' ']], cols, 2));
  blank(70);

  // ---- a browser or terminal asking to act for the person: first, as it waits on a keypress
  const asking = view.admission;
  if (asking) {
    // "… Allow? [y/N]" on one line where it fits; else the question goes with the keys.
    const words = ` ${oneLine(admissionWords(asking))}.`;
    const whole = columns(`${words} Allow? [y/N]`) <= cols;
    add(99, [[whole ? `${words} Allow? [y/N]` : words, `${BOLD};${alert}`]]);
    add(98, [[`   Allow it only if the ${asking.kind === 'terminal' ? 'terminal' : 'browser'} you're using shows ${asking.code}: it can then do all you do in Tricot.`, DIM]]);
    if (asking.first) add(97, [["   It would be the first: from then on, only what you've let in can let others in.", DIM]]);
    const keys: Part[] = [['   '], ...(whole ? [] : ([['Allow? [y/N]', BOLD], ['   ']] as Part[])), ['[y]', BOLD], [' allow   '], ['[n]', BOLD], [' deny   '], ['Esc', BOLD], [' later']];
    add(99, asking.sending ? [['   Answering…', DIM]] : keys);
    blank(46);
  }

  // ---- the agents (a heading goes before the rows under it, never without them)
  add(89.9, [[' Your agents', BOLD]]);
  const nameWidth = Math.max(0, ...view.agents.map((a) => columns(oneLine(a.name))));
  for (const [i, agent] of view.agents.entries()) {
    const name = oneLine(agent.name);
    const left: Part[] = [[`   ${agent.number} `], [name + ' '.repeat(nameWidth - columns(name) + 3), agent.doing.tone === 'quiet' ? DIM : undefined], [upperFirst(agent.doing.words), toneSgr(agent.doing.tone)]];
    add(90 - i * 0.01, spread(left, agent.doing.lasted ? [[agent.doing.lasted, DIM], [' ']] : [], cols));
  }
  if (!view.agents.length) add(89, [['   None yet: a adds one.', DIM]]);
  blank(45);

  // ---- the requests waiting
  const waiting = view.approvals;
  if (!waiting.length) {
    add(81, [[' Waiting for your OK', BOLD]]);
    add(80, [['   Nothing is waiting for you.', DIM]]);
  } else {
    add(95, [[' Waiting for your OK', `${BOLD};${alert}`], ...(waiting.length > 1 ? ([[` · ${waiting.length}`, alert]] as Part[]) : [])]);
    const selected = Math.min(Math.max(0, view.selected), waiting.length - 1);
    for (const [i, approval] of waiting.entries()) {
      const several = waiting.length > 1;
      if (i !== selected) {
        add(58 - i * 0.01, [[`   ${wantsTo(approval)}`, DIM]]);
        continue;
      }
      if (approval.sealed) {
        add(95, [[several ? ' › ' : '   ', alert], [`${waitingFor(approval)}.`, BOLD]]);
        if (view.seat?.code) {
          add(94, [[`     Allow this terminal in Tricot's page, in a browser you've let in: it shows code ${view.seat.code}.`]]);
          add(93, [['     Waiting for you there…', DIM]]);
        } else {
          add(94, [["     This terminal can't see what it asks until you let it answer for you.", DIM]]);
          add(95, view.seat?.asking ? [['   Asking…', DIM]] : [['   '], ['[y]', BOLD], [' let this terminal answer for you'], ...(several ? ([['   '], ['↑↓', BOLD], [' another']] as Part[]) : [])]);
        }
        continue;
      }
      add(95, [[several ? ' › ' : '   ', alert], [`${wantsTo(approval)}:`, BOLD]]);
      const { text, more } = approvalText(approval);
      const lines = text.split(/\r\n|\r|\n/);
      // Its keys never show without the start of what they answer.
      for (const [n, line] of lines.entries()) add(n === 0 ? 95 : n < 6 ? 60 - n * 0.01 : 30 - n * 0.0001, [[`     ${asSent(line)}`]], { command: n });
      for (const line of more) add(55, [[`     ${asSent(line)}`, DIM]]);
      if (approval.description?.trim()) add(55, [[`     “${oneLine(approval.description)}”`, DIM]]);
      if (view.reason !== undefined) {
        add(96, [[`   Tell ${oneLine(approval.agent)} why (optional; it reads this). `], ['Enter', BOLD], [' deny · '], ['Esc', BOLD], [' back']]);
        const room = Math.max(1, cols - 6);
        const typed = view.reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
        const shown = columns(typed) < room ? typed : `…${tail(typed, room - 2)}`;
        cursorRow = { index: body.length, x: 5 + columns(shown) };
        add(96, [['   › ', alert], [shown]]);
      } else if (view.sending) {
        add(95, [[`   ${view.sending === 'allow' ? 'Allowing' : 'Denying'}…`, DIM]]);
      } else {
        const keys: Part[] = [['   '], ['[y]', BOLD], [' allow   ']];
        if (approval.forSession?.length) keys.push(['[s]', BOLD], [' allow for this session   ']);
        keys.push(['[n]', BOLD], [' deny']);
        if (several) keys.push(['   '], ['↑↓', BOLD], [' another']);
        add(95, keys);
      }
    }
  }
  blank(45);

  // ---- the board's latest activity
  if (view.activity.length) {
    add(39.9, [[' Lately on the board', BOLD]]);
    for (const [i, event] of view.activity.entries()) {
      const words = `${oneLine(event.actor.name)} ${oneLine(event.summary)}`;
      add(i < 3 ? 40 - i * 0.01 : 20 - i * 0.01, spread([[`   ${words}`]], [[ago(event.at, view.now), DIM], [' ']], cols));
    }
    blank(44);
  }

  // ---- the keys, and what the last one did: the last rows, always
  const footer: Part[][] = [];
  if (view.note) footer.push([[` ${oneLine(view.note.text)}`, toneSgr(view.note.tone)]]);
  footer.push(promptParts(view));

  // Keep the rows that matter most, in their order.
  const room = Math.max(0, rows - footer.length);
  const order = body.map((row, index) => ({ row, index })).sort((a, b) => b.row.priority - a.row.priority || a.index - b.index);
  const kept = new Set(order.slice(0, room).map((o) => o.index));
  // Trailing blank rows are no use: the footer is apart from the rest anyway.
  let shown = body.filter((_, index) => kept.has(index));
  const commandRows = body.filter((row) => row.command !== undefined).length;
  const commandShown = shown.filter((row) => row.command !== undefined);
  if (commandShown.length === 1 && commandRows > 1) {
    // Only its first line has room: it says how many more there are after it.
    const hidden = commandRows - 1;
    commandShown[0].parts = [...commandShown[0].parts, [`  … ${hidden} more line${hidden === 1 ? '' : 's'}`, DIM]];
  } else if (commandShown.length && commandShown.length < commandRows) {
    const last = commandShown[commandShown.length - 1];
    const hidden = commandRows - commandShown.length + 1;
    last.parts = [[`     … ${hidden} more line${hidden === 1 ? '' : 's'}`, DIM]];
  }
  const cursorAt = cursorRow && kept.has(cursorRow.index) ? shown.indexOf(body[cursorRow.index]) : -1;
  while (shown.length && !shown[shown.length - 1].parts.length) shown = shown.slice(0, -1);

  const out: TabFrame = { rows: [], plain: [] };
  const push = (parts: Part[]) => {
    const { line, plain } = paint(parts, cols);
    out.rows.push(line);
    out.plain.push(plain);
  };
  for (const row of shown) push(row.parts);
  while (out.rows.length < room) push([]);
  for (const parts of footer.slice(-rows)) push(parts);
  out.rows = out.rows.slice(0, rows);
  out.plain = out.plain.slice(0, rows);
  if (cursorAt >= 0 && cursorRow) out.cursor = { x: Math.min(cols - 1, cursorRow.x), y: cursorAt };
  return out;
}

// The last `room` columns of a string.
function tail(text: string, room: number): string {
  const chars = [...text];
  let out = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    if (columns(chars[i] + out) > room) break;
    out = chars[i] + out;
  }
  return out;
}

function promptParts(view: TabView): Part[] {
  const key = (k: string, words: string): Part[] => [[k, BOLD], [` ${words}`]];
  const sep: Part = [' · '];
  if (view.quitting) return [[' Closing the agents…', DIM]];
  switch (view.prompt.kind) {
    case 'add': {
      if (!view.prompt.choices.length) return [[' Every agent Tricot can start is running. '], ['Esc', BOLD], [' back']];
      const parts: Part[] = [[' Add which agent?  ']];
      for (const [i, choice] of view.prompt.choices.entries()) parts.push([`${i + 1}`, BOLD], [` ${choice.name}${choice.note ? ` (${choice.note})` : ''}   `]);
      parts.push(['Esc', BOLD], [' cancel']);
      return parts;
    }
    case 'stop': {
      if (!view.prompt.choices.length) return [[' No agent is running. '], ['Esc', BOLD], [' back']];
      const parts: Part[] = [[' Stop which agent?  ']];
      for (const choice of view.prompt.choices) parts.push([`${choice.number}`, BOLD], [` ${oneLine(choice.name)}   `]);
      parts.push(['Esc', BOLD], [' cancel']);
      return parts;
    }
    case 'confirm-stop':
      return [[` Stop ${oneLine(view.prompt.name)}?  `], ['y', BOLD], [' stop · any other key keeps it']];
    default:
      return [[' '], ...key('o', 'open the board'), sep, ...key('a', 'add an agent'), sep, ...key('x', 'stop one'), sep, ...key('q', 'quit')];
  }
}
