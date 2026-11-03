// Pure formatting helpers shared by the server and the web UI.

import type { Actor, Board, Decision, Option } from './types';

export function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function describeChoice(decision: Decision): string {
  const resolution = decision.resolution;
  if (!resolution) return '';
  const option = decision.options.find((o) => o.id === resolution.optionId);
  return option ? `${option.id}) ${option.label}` : `"${clip(resolution.answer ?? '', 120)}"`;
}

// Whose an option is: the last person to propose or reword it. Agents leave a
// person's option as it is, as they do a person's canvas block.
export function optionPerson(option: Option): Actor | undefined {
  return option.person ?? (option.proposedBy.kind === 'human' ? option.proposedBy : undefined);
}

export function samePerson(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// People who have acted on a board, most recently active first.
export function peopleOn(board: Pick<Board, 'activity'>): { name: string; lastActive: string }[] {
  return board.activity.actors.filter((seen) => seen.actor.kind === 'human').map((seen) => ({ name: seen.actor.name, lastActive: seen.at }));
}

export function pendingAsks(decision: Decision) {
  return decision.asks.filter((ask) => !ask.answeredAt);
}

export function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// A length of time as a quiet line says it: "42 s", "1 min 30 s", "14 min", "1 h 5 min".
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

// A line split around its first file path, so a narrow line can give way in
// the path's middle (web/steps.tsx StepText): "Reading src/web/ReceiptPanel.tsx
// on T1" is "Reading ", the folders "src/web/", the file's name in two,
// "Receipt" and "Panel.tsx" (the end of a long one: up to five characters
// and its extension), and what follows, " on T1". A line with no path has none.
const PATH = /(?:[\w.@~+-]+\/)+[\w.@~+-]+/;

export interface PathParts {
  lead: string;
  dirs: string;
  head: string; // the file's name but its end ('' for a short name)
  tail: string; // its end, which stays in view
  after: string;
}

export function pathParts(text: string): PathParts | undefined {
  const found = PATH.exec(text);
  if (!found) return undefined;
  const end = found.index + found[0].length;
  const cut = found.index + found[0].lastIndexOf('/') + 1;
  const name = text.slice(cut, end);
  const tail = /.{1,5}(?:\.[\w-]{1,8})?$/.exec(name)![0];
  return { lead: text.slice(0, found.index), dirs: text.slice(found.index, cut), head: name.slice(0, name.length - tail.length), tail, after: text.slice(end) };
}

// Whether what a person typed names a board: its title, as it is (a stray
// space at either end doesn't matter). Deleting a board for good asks for it.
export function namesBoard(typed: string, title: string): boolean {
  return typed.trim() === title;
}
