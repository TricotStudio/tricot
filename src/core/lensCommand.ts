// Typing ^ in the chat bar to ask for a lens on one message: "^Design what
// would make this clearer?". The ^Name is a command, not content: the bar marks
// it as a chip, and what is sent leaves it out and carries the lens beside the
// text (ThreadMessage.lens), so agents answer that message through it, in place
// of the thread's lens. The thread's own lens is not touched. A name is read as
// the hook in an agent's own terminal reads it (lensAsked, hooks/tricot-lenses.mjs):
// letters and digits, with - or _ inside, whatever the case. The bar takes one at
// the start of any word, as it sends the lens as data. These are the rules for
// reading it; the list itself is web/shared/mentions.tsx, beside the @, / and #
// ones. Nothing here draws.

import { nameFits } from './mentions';
import { lensAsked } from './threads';

// What is being typed just before the caret: a ^ that starts a word (so not
// x^2 or a regular expression), then as much of a name as there is.
export const LENS_TYPING = /(?:^|\s)\^([\p{L}\p{N}_-]{0,30})$/u;

export interface LensTyping {
  at: number; // where the ^ is
  query: string; // what follows it
}

export function readLensTyping(before: string): LensTyping | null {
  const match = before.match(LENS_TYPING);
  return match ? { at: before.length - match[1].length - 1, query: match[1] } : null;
}

// The name a ^ at the start of `text` gives, as lensAsked reads it: a
// preset's as LENSES spells it, any other as typed.
function nameAt(text: string): string | undefined {
  const asked = lensAsked(text);
  return asked && ('lens' in asked ? asked.lens.name : asked.unknown);
}

// Whether a lens can be asked for by its name: one of one's own whose name
// has a space in it can't, as ^ reads a name to the first space.
export const askable = (name: string): boolean => nameAt(`^${name}`)?.length === name.length;

// The lenses that fit what is typed after the ^, in the order given but for
// those that start with it, which come first. Case doesn't matter.
export function lensesFit<T extends { name: string }>(lenses: readonly T[], query: string): T[] {
  const typed = query.toLowerCase();
  const fits = lenses.filter((lens) => nameFits(lens.name, query));
  return [...fits.filter((l) => l.name.toLowerCase().startsWith(typed)), ...fits.filter((l) => !l.name.toLowerCase().startsWith(typed))];
}

export interface LensCommand {
  name: string; // as the list spells it
  start: number; // where the ^ is
  end: number; // just after the name
}

// The ^Names in a text that name one of `names`, in order, whatever the case.
// A ^ that doesn't start a word, or names no lens there, is text: ^Designer
// isn't ^Design.
export function findLensCommands(text: string, names: readonly string[]): LensCommand[] {
  const found: LensCommand[] = [];
  if (names.length === 0) return found;
  for (let at = text.indexOf('^'); at >= 0; at = text.indexOf('^', at + 1)) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    const typed = nameAt(text.slice(at));
    const name = typed && names.find((n) => n.toLowerCase() === typed.toLowerCase());
    if (!name) continue;
    found.push({ name, start: at, end: at + 1 + name.length });
    at += name.length;
  }
  return found;
}

// A text without its ^Names, and the spaces that followed each: "^Design is
// it clear?" reads "is it clear?", "a ^Design b" reads "a b". One that opens
// the text takes a colon or comma after it too ("^Design: is it clear?"). A
// space before one at the end stays: callers trim.
export function withoutLensCommands(text: string, names: readonly string[]): string {
  let out = '';
  let at = 0;
  for (const { start, end } of findLensCommands(text, names)) {
    out += text.slice(at, start);
    at = end;
    if (start === 0 && /[,:;]/.test(text[at] ?? '')) at++;
    // It started a word, so the spaces after it only separated it.
    while (/[ \t]/.test(text[at] ?? '')) at++;
  }
  return out + text.slice(at);
}

// What a message says, and the lens it asks for (the last ^Name, if the text
// has several): what is sent is the text without them.
export function splitLensCommand(text: string, names: readonly string[]): { body: string; lens?: string } {
  const lens = findLensCommands(text, names).at(-1)?.name;
  return { body: withoutLensCommands(text, names).trim(), ...(lens && { lens }) };
}

// `value` with the ^word being typed written as ^Name and a space after it,
// where the caret goes, and any other ^Name in the text gone: a message asks
// for one lens, so picking another changes it.
export function withLensCommand(value: string, typing: LensTyping, name: string, names: readonly string[]): { text: string; caret: number } {
  const before = withoutLensCommands(value.slice(0, typing.at), names);
  const after = withoutLensCommands(value.slice(typing.at + 1 + typing.query.length), names);
  const inserted = `^${name}${after.startsWith(' ') ? '' : ' '}`;
  return { text: before + inserted + after, caret: before.length + inserted.length + (after.startsWith(' ') ? 1 : 0) };
}
