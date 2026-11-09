// The Tricot tab, drawn (T192): the board and where it runs, each agent and
// what it is doing, the requests for permission waiting with their keys,
// and the board's latest activity, in the rows above the strip.
//
//    ▀█▀ █▀▄ █ █▀▀ █▀█ ▀█▀   Tricot roadmap
//     █  █▀▄ █ █▄▄ █▄█  █    http://127.0.0.1:4545
//
//    Your agents
//      1 Claude   Running npm test                          1 min 12 s
//      2 Codex    Listening on the board
//
//    Waiting for your OK
//      Claude wants to run a command in tricot:
//        rm -rf dist && npm run build
//        "Rebuild the web bundle after the CSS change"
//      Allow    Allow for this session  ❯ Deny  (←→ Enter, or y/s/n)
//
//    Lately on the board
//      Wassim approved T183 and asked for a commit           2 min ago
//
//    o open the board · t threads · a add an agent · x stop one · q quit
//
// (In a window under 68 columns the keys are fewer words: o open · t threads · a add · x stop · q quit.)
//
// A request's answers are a row of choices, one highlighted (❯ and bold):
// the arrows move it, Enter answers with it, and the letters y, s and n
// answer at once. It starts on Deny, so a stray Enter never allows a command.
// Each choice has a slot of two columns before its words for the ❯, so the
// words stay where they are as the highlight moves. "Allow for this session"
// is there only where the request offers it. Where the row doesn't fit, it
// drops its hint, then the arrows for another request, and then says
// "Session" in place of "Allow for this session", before it cuts a choice. A request this terminal can't
// read yet has no choices, only the one key that asks to be let in.
//
// The first two rows are the TRICOT wordmark (wordmark.ts draws it, knitted
// up a stitch at a time as the switcher opens; tricotTab.ts says when), the
// board's title bold beside its top row and Tricot's address dim beside its
// bottom row, each cut to fit. The rest is drawn below them as usual, losing
// its least important rows first. A window too narrow or short for it, or
// with no room for both its rows, has the one-line header in its place:
//
//    Tricot · Tricot roadmap                         http://127.0.0.1:4545
//
// "t" swaps all of this for the chat with the board's threads in a panel
// beside it, which chatView.ts and threadsView.ts draw (tricotTab.ts picks
// which of the two to draw).
//
// "x" asks before it hangs one up, with the same pair every yes-or-no question
// of the tab is (the highlighted one has ❯ before it and is bold):
//
//    Stop Codex?    Yes  ❯ No  (←→ Enter, or y/n)
//
// A browser or terminal asking to act for the person comes before all else,
// its question whole (it carries the code the person checks against the
// browser's, so it is wrapped, never cut), the pair on a row of its own below:
//
//    A browser wants to act for you (Chrome on macOS, code 4271). Allow?
//    Allow it only if the browser you're using shows 4271: it can then do all you do in Tricot.
//      Yes  ❯ No  (←→ Enter, or y/n · Esc later)
//
// "a" lists every agent Tricot knows that isn't running, one to a row, with
// a few words after one that can't be started now. One row is highlighted
// (❯ and bold): the arrows move it, Enter picks it, and the numbers 1 to 9
// pick a row at once (a row past the ninth has no number). "x" lists the
// agents that are running the same way, each with its number from "Your
// agents":
//
//    Add which agent?   ↑↓ move · Enter pick · Esc cancel
//      1  Claude Code
//     ❯ 2  Codex
//      3  OpenCode    not installed
//      4  Gemini CLI  connect it first
//
//    Stop which agent?  ↑↓ move · Enter pick · Esc cancel
//     ❯ 1  Claude
//      2  Codex
//
// /add and /stop typed in the chat draw these same lists, and the question
// after them, at the chat's foot in place of its keys (tricotTab.ts).
//
// Every size gets what fits: each row has a priority, and the rows kept are
// the most important ones, in their order (a short window loses the blank
// rows, then the activity, then all but the first lines of a long
// command, which says how many more it has). The keys stay on the last row.
// A list taller than the window keeps its question on top and scrolls, so
// the highlighted row is always in view.
//
// What agents sent is shown as plain text, exactly: a control character is
// shown as its picture (␛), never sent to the terminal.
import { approvalAction, approvalText, type Approval } from '../../core/approvals';
import { admissionWords, type AdmissionView } from '../../core/seats';
import type { BoardEvent } from '../../core/types';
import { columns, fit, type AgentDoing, type Tone } from './strip';

export type TabPrompt =
  | { kind: 'keys' } // the tab's own keys
  | { kind: 'add'; choices: { name: string; note?: string }[]; at: number } // `at`: the row highlighted, from 0
  | { kind: 'stop'; choices: { number: number; name: string }[]; at: number }
  | { kind: 'confirm-stop'; name: string; yes: boolean }; // `yes`: Yes is the one highlighted

// The answers to a request: allow it once, for the session, or deny it.
export type ApprovalChoice = 'allow' | 'session' | 'deny';

export interface TabView {
  title?: string; // the board's
  url: string; // Tricot's address
  connected: boolean; // to the board's stream
  agents: { number: number; name: string; doing: AgentDoing }[];
  approvals: Approval[]; // waiting, oldest first
  selected: number; // the one the keys answer
  choice?: ApprovalChoice; // the one highlighted in its row of answers (deny: none)
  sending?: 'allow' | 'deny'; // its answer is on its way
  reason?: string; // denying it: the reason typed so far
  activity: BoardEvent[]; // newest first
  // A browser or terminal asking to act for the person, for this terminal to answer (T187).
  admission?: AdmissionView & { sending?: boolean; allow?: boolean }; // `allow`: Yes is the one highlighted
  // This terminal as one of the person's seats: let in, or the code it asks with.
  seat?: { seated: boolean; code?: string; asking?: boolean };
  prompt: TabPrompt;
  note?: { text: string; tone: Tone }; // what the last key did
  quitting?: boolean;
  wordmark?: Part[][]; // its two rows, the title and address beside them, in place of the one-line header (wordmark.ts)
  now: number;
}

export interface TabFrame {
  rows: string[]; // each as written from the row's first column, colours and all
  plain: string[]; // the same as text
  cursor?: { x: number; y: number }; // from 0; shown only while a reason is typed
  links?: FrameLink[][]; // each row's links, where a click opens one (T36)
}

// A link on a row: its columns, from 0, `to` not included, and where it goes.
export interface FrameLink {
  from: number;
  to: number;
  url: string;
}

// The link at a cell of a frame, from 0, if one is drawn there.
export const linkAt = (frame: TabFrame, x: number, y: number): string | undefined => frame.links?.[y]?.find((l) => x >= l.from && x < l.to)?.url;

// Looks, as SGR parameters: the terminal's own colours, bold and dim, and
// the strip's alert colour, light or dark.
export const BOLD = '1';
export const DIM = '2';
export const alertOf = (light: boolean) => (light ? '38;5;130' : '38;5;214');

// `link`: where a click on it goes (FrameLink); it is drawn underlined.
export type Part = [text: string, sgr?: string, link?: string];

// One row: the parts, cut to the width, the rest erased, and where its links are.
export function paint(parts: Part[], width: number): { line: string; plain: string; links: FrameLink[] } {
  let line = '';
  let plain = '';
  let used = 0;
  const links: FrameLink[] = [];
  for (const [text, sgr, link] of parts) {
    const room = width - used;
    if (room <= 0) break;
    const shown = fit(text, room);
    const looks = link ? (sgr ? `${sgr};4` : '4') : sgr;
    line += `\x1b[0${looks ? `;${looks}` : ''}m${shown}`;
    plain += shown;
    const wide = columns(shown);
    if (link && wide) links.push({ from: used, to: used + wide, url: link });
    used += wide;
  }
  return { line: used < width ? `${line}\x1b[0m\x1b[K` : `${line}\x1b[0m`, plain, links };
}

// Where the web addresses in a text are, by character, and each whole.
export function webAddresses(text: string): FrameLink[] {
  const found: FrameLink[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    let url = match[0];
    // A sentence's end, or a bracket that closes around it, isn't the address's.
    for (;;) {
      const trimmed = url.replace(/[.,;:!?*_]+$/, '');
      const closing = /[)\]]$/.exec(trimmed)?.[0];
      const open = closing === ')' ? '(' : '[';
      const unbalanced = closing && trimmed.split(open).length <= trimmed.split(closing).length - 1;
      const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
      if (next === url) break;
      url = next;
    }
    if (/^https?:\/\/[^/?#\s]/i.test(url)) found.push({ from: match.index!, to: match.index! + url.length, url });
  }
  return found;
}

// A row on a background (an SGR one, "48;5;235"), across `width` columns:
// each part keeps its own looks on it, and spaces on it fill the rest, as
// paint erases the rest of a row with the terminal's own background.
export function onBand(parts: Part[], background: string, width: number): Part[] {
  const cut = cutParts(parts, width);
  const used = cut.reduce((sum, [text]) => sum + columns(text), 0);
  const fill: Part[] = used < width ? [[' '.repeat(width - used), background]] : [];
  return [...cut.map(([text, sgr, link]): Part => (link ? [text, sgr ? `${sgr};${background}` : background, link] : [text, sgr ? `${sgr};${background}` : background])), ...fill];
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

export function cutParts(parts: Part[], room: number): Part[] {
  const out: Part[] = [];
  let left = room;
  for (const [text, sgr, link] of parts) {
    if (left <= 0) break;
    const shown = fit(text, left);
    out.push(link ? [shown, sgr, link] : [shown, sgr]);
    left -= columns(shown);
  }
  return out;
}

// Words from the board on one line: control characters out.
export const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

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

// The columns between the wordmark and the title and address beside it.
const BESIDE_GAP = 3;

// The same board header above the status view and conversations.
export function tabHeader(view: Pick<TabView, 'title' | 'url' | 'connected' | 'wordmark'>, cols: number, room: number): Part[][] {
  const title = view.title ? oneLine(view.title) : undefined;
  // The address opens the board when clicked (tricotTab.ts).
  const address: Part[] = [[view.url, DIM, view.url], ...(view.connected ? [] : ([[' · connecting…', DIM]] as Part[]))];
  if (view.wordmark && room >= view.wordmark.length) {
    const width = Math.max(...view.wordmark.map(partsWidth));
    const words: Part[][] = [title ? [[title, BOLD]] : [], address];
    return view.wordmark.map((mark, i) => {
      const beside = words[i] ?? [];
      return beside.length ? [...mark, [' '.repeat(width - partsWidth(mark) + BESIDE_GAP)] as Part, ...cutParts(beside, cols - width - BESIDE_GAP - 1)] : mark;
    });
  }
  return [spread([[' Tricot', BOLD], ...(title ? ([[' · '], [title, BOLD]] as Part[]) : [])], [...address, [' ']], cols, 2)];
}

interface Row {
  parts: Part[];
  priority: number;
  command?: number; // the command's line, from 0
}

// A tone's look: the alert colour, dim, or the terminal's own.
const toneOf = (tone: Tone, light: boolean) => (tone === 'alert' ? alertOf(light) : tone === 'quiet' ? DIM : undefined);

// What the last key did, on as many rows as it takes, to a few: above the keys
// here, and at the chat's foot for what a command typed there did (tricotTab.ts).
export function noteRows(note: { text: string; tone: Tone }, cols: number, light = false): Part[][] {
  return wrap(oneLine(note.text), Math.max(10, cols - 2), NOTE_ROWS).map((line) => [[` ${line}`, toneOf(note.tone, light)]]);
}

export function renderTab(view: TabView, cols: number, rows: number, light = false): TabFrame {
  const alert = alertOf(light);
  const body: Row[] = [];
  const add = (priority: number, parts: Part[], more: Partial<Row> = {}) => body.push({ parts, priority, ...more });
  const blank = (priority: number) => add(priority, []);
  const toneSgr = (tone: Tone) => toneOf(tone, light);
  let cursorRow: { index: number; x: number } | undefined;

  // ---- the keys, and what the last one did: the last rows, always (the rest has the rows above them)
  const footer: Part[][] = view.note ? noteRows(view.note, cols, light) : [];
  footer.push(...promptRows(view, rows, cols));
  const room = Math.max(0, rows - footer.length);

  // ---- the board and where it runs: beside the wordmark, one to a row, where both its rows fit; else on one row
  for (const [i, row] of tabHeader(view, cols, room).entries()) add(100 - i * 0.01, row);
  blank(70);

  // ---- a browser or terminal asking to act for the person: first, as it waits on a keypress
  const asking = view.admission;
  if (asking) {
    // The question whole, on as many rows as it takes: the code in it is what the person checks.
    const question = `${oneLine(admissionWords(asking))}. Allow?`;
    for (const line of wrap(question, Math.max(10, cols - 2), 20)) add(99, [[` ${line}`, `${BOLD};${alert}`]]);
    add(98, [[`   Allow it only if the ${asking.kind === 'terminal' ? 'terminal' : 'browser'} you're using shows ${asking.code}: it can then do all you do in Tricot.`, DIM]]);
    if (asking.first) add(97, [["   It would be the first: from then on, only what you've let in can let others in.", DIM]]);
    const pair: Part[] = [[' '], ...yesNo(asking.allow === true)];
    add(99, asking.sending ? [['   Answering…', DIM]] : fitOne(pair, [[['  '], ['(←→ Enter, or y/n · Esc later)', DIM]], [['  '], ['(Esc later)', DIM]]], cols));
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
        add(95, answerRow(approval, view.choice ?? 'deny', several, cols));
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

  // Keep the rows that matter most, in their order.
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

  const out: TabFrame = { rows: [], plain: [], links: [] };
  const push = (parts: Part[]) => {
    const { line, plain, links } = paint(parts, cols);
    out.rows.push(line);
    out.plain.push(plain);
    out.links!.push(links);
  };
  for (const row of shown) push(row.parts);
  while (out.rows.length < room) push([]);
  for (const parts of footer.slice(-rows)) push(parts);
  out.rows = out.rows.slice(0, rows);
  out.plain = out.plain.slice(0, rows);
  out.links = out.links!.slice(0, rows);
  if (cursorAt >= 0 && cursorRow) out.cursor = { x: Math.min(cols - 1, cursorRow.x), y: cursorAt };
  return out;
}

// The last `room` columns of a string.
export function tail(text: string, room: number): string {
  const chars = [...text];
  let out = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    if (columns(chars[i] + out) > room) break;
    out = chars[i] + out;
  }
  return out;
}

// The last rows: the keys, or the question one of them asks (the add and stop
// lists are one row to an agent, the rest are one row), in `room` rows at most.
// The chat draws the lists and the question at its foot too, for /add and
// /stop typed there (tricotTab.ts).
export function promptRows(view: Pick<TabView, 'prompt' | 'quitting'>, room: number, cols: number): Part[][] {
  const key = (k: string, words: string): Part[] => [[k, BOLD], [` ${words}`]];
  const sep: Part = [' · '];
  if (view.quitting) return [[[' Closing the agents…', DIM]]];
  switch (view.prompt.kind) {
    case 'add': {
      const { choices, at } = view.prompt;
      if (!choices.length) return [[[' Every agent is running. '], ['Esc', BOLD], [' back']]];
      const width = Math.max(...choices.map((choice) => columns(oneLine(choice.name))));
      const rows = choices.map((choice, i) => {
        const name = oneLine(choice.name);
        // Only the numbers 1 to 9 pick a row: a row past the ninth has none.
        return listRow(i === at, i < 9 ? `${i + 1}` : ' ', `${name}${' '.repeat(width - columns(name))}`, choice.note ? ([['  '], [oneLine(choice.note), DIM]] as Part[]) : []);
      });
      return listRows(' Add which agent?   ', rows, at, room, cols);
    }
    case 'stop': {
      const { choices, at } = view.prompt;
      if (!choices.length) return [[[' No agent is running. '], ['Esc', BOLD], [' back']]];
      const width = Math.max(...choices.map((choice) => `${choice.number}`.length));
      const rows = choices.map((choice, i) => listRow(i === at, `${choice.number}`.padStart(width), oneLine(choice.name), []));
      return listRows(' Stop which agent?  ', rows, at, room, cols);
    }
    case 'confirm-stop': {
      const question: Part = [` Stop ${oneLine(view.prompt.name)}?`];
      const pair = yesNo(view.prompt.yes);
      const hint: Part[][] = [[['  '], ['(←→ Enter, or y/n)', DIM]]];
      const one: Part[] = [question, ['  '], ...pair];
      if (partsWidth(one) <= cols) return [fitOne(one, hint, cols)];
      return [[question], fitOne([[' '], ...pair], hint, cols)];
    }
    default: {
      // In words where they fit, and in fewer where they don't, so "q quit" stays in a narrow window.
      const keys = (words: [string, string][]): Part[] => [[' '], ...words.flatMap(([k, what], i) => (i ? [sep, ...key(k, what)] : key(k, what)))];
      const full = keys([['o', 'open the board'], ['t', 'threads'], ['a', 'add an agent'], ['x', 'stop one'], ['q', 'quit']]);
      return [columns(full.map(([text]) => text).join('')) <= cols ? full : keys([['o', 'open'], ['t', 'threads'], ['a', 'add'], ['x', 'stop'], ['q', 'quit']])];
    }
  }
}

const partsWidth = (parts: Part[]) => parts.reduce((sum, [text]) => sum + columns(text), 0);

// The row with the first of these endings that fits the width, or as it is.
function fitOne(row: Part[], endings: Part[][], cols: number): Part[] {
  const ending = endings.find((e) => partsWidth([...row, ...e]) <= cols);
  return ending ? [...row, ...ending] : row;
}

// One choice of a row, the highlighted one with ❯ before it and bold.
const choicePart = (label: string, on: boolean): Part => [`${on ? '❯' : ' '} ${label}`, on ? BOLD : undefined];

// "  Yes  ❯ No": the pair every yes-or-no question has.
export const yesNo = (yes: boolean): Part[] => [choicePart('Yes', yes), ['  '], choicePart('No', !yes)];

// The choices of a request the person can answer: their words, and the words
// where the row is too narrow for them.
const CHOICES: Record<ApprovalChoice, [string, string]> = { allow: ['Allow', 'Allow'], session: ['Allow for this session', 'Session'], deny: ['Deny', 'Deny'] };

// What a request can be answered with, in the order they are drawn.
export const choicesOf = (approval: Approval): ApprovalChoice[] => (approval.forSession?.length ? ['allow', 'session', 'deny'] : ['allow', 'deny']);

// "Allow    Allow for this session  ❯ Deny  (←→ Enter, or y/s/n)   ↑↓ another".
function answerRow(approval: Approval, choice: ApprovalChoice, several: boolean, cols: number): Part[] {
  const offered = choicesOf(approval);
  const on = offered.includes(choice) ? choice : 'deny';
  const row = (short: 0 | 1): Part[] => [[' '], ...offered.flatMap((c, i): Part[] => [...(i ? ([['  ']] as Part[]) : []), choicePart(CHOICES[c][short], c === on)])];
  const choices = partsWidth(row(0)) <= cols ? row(0) : row(1);
  const another: Part[] = several ? [['   '], ['↑↓', BOLD], [' another']] : [];
  const hint: Part[] = [['  '], [`(←→ Enter, or ${offered.includes('session') ? 'y/s/n' : 'y/n'})`, DIM]];
  // Another request's arrows matter more than the hint: the hint goes where it leaves them room.
  const withHint = partsWidth([...choices, ...hint, ...another]) <= cols ? [...choices, ...hint] : choices;
  return partsWidth([...withHint, ...another]) <= cols ? [...withHint, ...another] : withHint;
}

// One row of a list: the highlighted one has ❯ before it and a bold name.
const listRow = (on: boolean, number: string, name: string, after: Part[]): Part[] => [[` ${on ? '❯' : ' '} `, BOLD], [number, BOLD], [`  ${name}`, on ? BOLD : undefined], ...after];

// A list's question with its keys (just Esc where the rest doesn't fit the
// width), then its rows: all of them, or as many as `room` leaves after the
// question, scrolled so the highlighted row is among them.
function listRows(question: string, rows: Part[][], at: number, room: number, cols: number): Part[][] {
  const words = columns(`${question}↑↓ move · Enter pick · Esc cancel`) <= cols;
  const keys: Part[] = words ? [['↑↓', BOLD], [' move · '], ['Enter', BOLD], [' pick · '], ['Esc', BOLD], [' cancel']] : [['Esc', BOLD], [' cancel']];
  const shown = Math.max(0, room - 1);
  const first = rows.length <= shown ? 0 : Math.min(Math.max(0, at - Math.floor(shown / 2)), rows.length - shown);
  return [[[question], ...keys], ...rows.slice(first, first + shown)];
}

// The note's rows: as many as it needs, to this many; what doesn't fit ends
// the last row with an ellipsis, so a note never looks whole when it isn't.
const NOTE_ROWS = 4;
function wrap(text: string, width: number, rows: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    // A word longer than a row is broken at the row's end.
    while (columns(rest) > width) {
      let head = '';
      for (const ch of rest) {
        if (columns(head + ch) > width) break;
        head += ch;
      }
      if (!head) break;
      if (line) lines.push(line);
      lines.push(head);
      line = '';
      rest = rest.slice(head.length);
    }
    if (!rest) continue;
    if (line && columns(`${line} ${rest}`) > width) {
      lines.push(line);
      line = rest;
    } else line = line ? `${line} ${rest}` : rest;
  }
  if (line) lines.push(line);
  if (lines.length <= rows) return lines;
  const shown = lines.slice(0, rows);
  let last = shown[rows - 1];
  while (last && columns(`${last}…`) > width) last = [...last].slice(0, -1).join('').trimEnd();
  shown[rows - 1] = `${last}…`;
  return shown;
}
