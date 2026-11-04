// The strip: one line at the bottom of the terminal, under the agent that
// shows, listing the Tricot tab (T192) and every agent with what it is
// doing, and the keys.
//
//   ○ Tricot   ● 1 Claude · waiting for your OK   ○ 2 Codex · Running npm test · 1m 12s     Ctrl+\ 0 to answer
//
// What an agent is doing comes from Tricot's own live data where there is
// some (the board's stream, live.ts): a request for permission waiting on
// the board (T183) says "waiting for your OK"; its latest step says what it
// is doing ("Running npm test"); its MCP calls say it is listening. Without
// steps (an agent whose live steps are off), the terminal says what it can:
// a hidden agent that rang its bell or sent a notification "wants you", and
// one drawing is "working", else "idle". One that ended says so, with its
// exit code when it isn't 0.
import type { Approval } from '../../core/approvals';
import { stepText } from '../../core/delivery';
import { samePerson, shortDuration } from '../../core/format';
import type { AdmissionView } from '../../core/seats';
import { phaseOf } from '../../core/stepPhase';
import type { BoardEvent } from '../../core/types';
import type { AgentPresence } from '../../server/presence';
import type { AgentStep } from '../../server/steps';

// What the board's stream says now (live.ts).
export interface BoardLive {
  board: string; // the board's id
  steps: AgentStep[];
  approvals: Approval[];
  admissions?: AdmissionView[]; // browsers and terminals asking to act for the person, for this terminal to answer
  seated?: boolean; // this terminal reads as one of the person's seats
  presence: AgentPresence[];
  title?: string; // as the latest change named it
  activity?: BoardEvent[]; // its latest events, newest first (the Tricot tab's)
}

// An agent, as the host knows it.
export interface AgentNow {
  name: string; // its name on the board
  state: 'starting' | 'running' | 'ended';
  exitCode?: number;
  closing?: boolean; // quitting: it was asked to close
  wantsYou?: boolean; // it rang or sent a notification while hidden
  lastOutput?: number; // when it last drew anything, ms
}

export type Tone = 'normal' | 'alert' | 'quiet';

export interface AgentWords {
  words: string;
  tone: Tone;
}

// What it is doing, and for how long when it is a step that runs: the Tricot
// tab puts that at the right of its line, where the strip adds it to the words.
export interface AgentDoing extends AgentWords {
  lasted?: string;
}

export const ACTIVE_MS = 2_000; // drew this recently: working

// The agent's requests for permission waiting on this board, or on none yet.
export const waitingFor = (name: string, live: BoardLive | undefined): Approval[] =>
  live ? live.approvals.filter((a) => samePerson(a.agent, name) && (!a.on || a.on.board === live.board)) : [];

// Its latest step still showing, newest first.
function latestStep(name: string, live: BoardLive | undefined, now: number): AgentStep | undefined {
  return live?.steps.filter((s) => samePerson(s.agent, name) && phaseOf(s, now)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

// One line's words: control characters out, so a step can't move the cursor.
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

export function agentWords(agent: AgentNow, live: BoardLive | undefined, now: number): AgentWords {
  const { words, tone, lasted } = agentDoing(agent, live, now);
  return { words: lasted ? `${words} · ${lasted}` : words, tone };
}

export function agentDoing(agent: AgentNow, live: BoardLive | undefined, now: number): AgentDoing {
  if (agent.state === 'ended' && agent.closing) return { words: 'stopped', tone: 'quiet' }; // asked to close, from the Tricot tab
  if (agent.state === 'ended') return { words: agent.exitCode ? `ended (${agent.exitCode})` : 'ended', tone: 'quiet' };
  if (agent.closing) return { words: 'closing', tone: 'quiet' };
  if (waitingFor(agent.name, live).length) return { words: 'waiting for your OK', tone: 'alert' };
  if (agent.wantsYou) return { words: 'wants you', tone: 'alert' };
  const step = latestStep(agent.name, live, now);
  if (step && phaseOf(step, now) === 'live') {
    const lasted = step.running && !step.ended ? now - Date.parse(step.at) : 0;
    return { words: clean(stepText(step)), tone: 'normal', ...(lasted >= 1000 && { lasted: shortDuration(lasted) }) };
  }
  const presence = live?.presence.find((p) => samePerson(p.name, agent.name));
  if (presence?.state === 'listening') return { words: 'listening on the board', tone: 'normal' };
  if (step) return { words: clean(stepText(step)), tone: 'quiet' };
  if (agent.state === 'starting') return { words: 'starting', tone: 'quiet' };
  return agent.lastOutput !== undefined && now - agent.lastOutput < ACTIVE_MS ? { words: 'working', tone: 'normal' } : { words: 'idle', tone: 'quiet' };
}

// ---- drawing ------------------------------------------------------------------------

export interface StripEntry extends AgentWords {
  name: string;
  ended: boolean;
  number?: string; // what picks it after the switch key: its place from 1 unless given; '' for none (the Tricot tab)
}

// Where each agent's label is, for a click: columns from 1, `to` not included.
export interface StripLayout {
  line: string; // exactly `width` columns, with its colours
  plain: string; // the same without them
  ranges: { from: number; to: number; index: number }[];
}

// Colours from the 256 the terminal's palette has: a bar a shade off its
// background, light or dark.
interface Palette {
  bar: string;
  text: string;
  shown: string;
  alert: string;
  quiet: string;
  hint: string;
}
const DARK: Palette = { bar: '48;5;236', text: '38;5;252', shown: '1;38;5;231;48;5;24', alert: '38;5;214', quiet: '38;5;244', hint: '38;5;245' };
const LIGHT: Palette = { bar: '48;5;254', text: '38;5;236', shown: '1;38;5;231;48;5;25', alert: '38;5;130', quiet: '38;5;245', hint: '38;5;243' };

// Columns a string takes: wide characters (CJK, most emoji) two.
export function columns(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || (code >= 0x300 && code < 0x370) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
  }
  return width;
}

// The first `room` columns of a string, with … when cut.
export function fit(text: string, room: number): string {
  if (columns(text) <= room) return text;
  if (room <= 0) return '';
  let out = '';
  for (const ch of text) {
    if (columns(out + ch) > room - 1) break;
    out += ch;
  }
  return `${out}…`;
}

export function renderStrip(entries: StripEntry[], visible: number, width: number, hint: string, light = false): StripLayout {
  const look = light ? LIGHT : DARK;
  const mark = (entry: StripEntry, at: number) => (entry.ended ? '✕' : at === visible ? '●' : '○');
  // As much as fits: every agent's words, then those of the agent showing and
  // any wanting you, then names alone; each label cut to share what is left.
  const label = (entry: StripEntry, at: number, detail: 'all' | 'some' | 'none') => {
    const say = detail === 'all' || (detail === 'some' && (at === visible || entry.tone === 'alert'));
    const number = entry.number ?? String(at + 1);
    return ` ${mark(entry, at)} ${number ? `${number} ` : ''}${entry.name}${say && entry.words ? ` · ${entry.words}` : ''} `;
  };
  const total = (labels: string[]) => labels.reduce((sum, l) => sum + columns(l), 0) + labels.length - 1;
  let labels = entries.map((e, at) => label(e, at, 'all'));
  for (const detail of ['some', 'none'] as const) if (total(labels) > width) labels = entries.map((e, at) => label(e, at, detail));
  if (total(labels) > width) {
    const share = Math.max(4, Math.floor((width - entries.length + 1) / entries.length));
    labels = labels.map((l) => fit(l, share));
  }
  let line = `\x1b[0;${look.bar}m`;
  let plain = '';
  const ranges: StripLayout['ranges'] = [];
  for (const [at, text] of labels.entries()) {
    const room = width - columns(plain);
    if (room <= 0) break;
    const shown = fit(text, room);
    const entry = entries[at];
    const style = at === visible ? look.shown : entry.tone === 'alert' ? look.alert : entry.tone === 'quiet' || entry.ended ? look.quiet : look.text;
    ranges.push({ from: columns(plain) + 1, to: columns(plain) + 1 + columns(shown), index: at });
    line += `\x1b[0;${look.bar};${style}m${shown}\x1b[0;${look.bar}m`;
    plain += shown;
    if (columns(plain) < width && at < labels.length - 1) {
      line += ' ';
      plain += ' ';
    }
  }
  // The keys at the right, with a space either side, when they fit.
  const left = width - columns(plain);
  const fits = left >= columns(hint) + 2;
  const pad = ' '.repeat(fits ? left - columns(hint) - 1 : Math.max(0, left));
  line += fits ? `${pad}\x1b[0;${look.bar};${look.hint}m${hint} ` : pad;
  plain += fits ? `${pad}${hint} ` : pad;
  return { line: `${line}\x1b[0m`, plain, ranges };
}

// Whether the terminal's background, as it answered OSC 11 ("rgb:ffff/ffff/ffff",
// "#fdf6e3"), is light.
export function isLight(background: string | undefined): boolean {
  if (!background) return false;
  const rgb = /^rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(background);
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(background);
  const parts = rgb ? rgb.slice(1, 4).map((p) => parseInt(p, 16) / (16 ** p.length - 1)) : hex ? hex.slice(1, 4).map((p) => parseInt(p, 16) / 255) : undefined;
  if (!parts) return false;
  const [r, g, b] = parts;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}
