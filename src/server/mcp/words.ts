import type { ZodType } from 'zod';
import { eventTold } from '../../core/eventsTold';
import { describedWords, type PartContext, type Told, type Words } from '../../core/words';
import type { Board, BoardEvent, EventType } from '../../core/types';

export { describedIn, plain } from '../../core/words';
export type { Piece, Words } from '../../core/words';

// What the board's own tools say, composed from named pieces, as the
// instructions are from named lines (instructions.ts): the core says what is
// true without a part, in pieces, and a tool group says the rest where it
// belongs, so a server with no group tells an agent nothing of decisions,
// tasks or the status, and one with a part registered tells it exactly what it
// was told before (the tools' golden records it).
//
// A text is a list of pieces, each `[name, text]`, joined as written: a piece
// carries its own spaces, so a group can put a sentence between two sentences,
// or a clause inside one. A piece may be empty, to name a place. The texts a
// group can edit are named by an id: a tool's `<tool>.description`,
// `<tool>.guide` and `<tool>.<argument>` (the words an argument is described
// with, `describedIn`), a guide topic's `topic.<name>`, a sentence a tool says
// when it refuses (`Phrases.say`), and so on. A group's edit (`Edit`) is a piece that
// goes `before` or `after` a piece of the core's, or `replaces` it, and never
// changes the text of one. A group can also add an argument to a tool (`Param`)
// at a position among the core's, or replace one, and give a sentence that
// depends on what a call is about (`lines`). It can also say a part of a digest
// the core leaves out (`parts`), what it offers agents that the core does not
// (`offers`), and the kinds of event it tells (`events`, core/eventsTold.ts).
//
// A mistake in a group (a piece named as another is, a position that is none or
// more than one, a piece of the core's that is none, two groups replacing one
// piece) is a mistake in Tricot, and is refused with the group's name where
// the text is made.

export interface Edit {
  name: string;
  text: string;
  before?: string;
  after?: string;
  replaces?: string;
}

// An argument a group adds to a board tool, at a position among the core's: `before` or `after` one of them, or in
// place of it (`replaces`).
export interface Param {
  name: string;
  schema: ZodType;
  before?: string;
  after?: string;
  replaces?: string;
}

// A tool's arguments, by name.
export type Shape = Record<string, ZodType>;

export type Line = (vars: Record<string, string>) => string | undefined;

// A part of a digest made from the board and the agent reading it: none when it has nothing to say there.
export type Part = (board: Board, viewer?: string, context?: PartContext) => string | undefined;

// What a tool group says of the board's own texts.
export interface Phrasing {
  edits?: Record<string, Edit[]>; // by the id of the text
  params?: Record<string, Param[]>; // by the board tool's name
  lines?: Record<string, Line>; // by id: a sentence made for the call at hand
  parts?: Record<string, Part>; // by id: a part of a digest the core leaves out
  offers?: string[]; // what it offers agents beyond the core's (core/words.ts Told)
  events?: EventType[]; // the kinds of event it tells, which the core leaves out
}

interface Contributed<T> {
  group: string;
  of: T;
}

const POSITIONS = ['before', 'after', 'replaces'] as const;

// The position an item says it is at: exactly one of before, after or replaces, and the item it names.
function positionOf(item: Edit | Param, group: string): { kind: (typeof POSITIONS)[number]; where: string } {
  const given = POSITIONS.filter((position) => item[position] !== undefined);
  if (given.length !== 1) {
    throw new Error(`The tool group ${group} gives its entry ${item.name} ${given.length === 0 ? 'no position' : `${given.length} positions (${given.join(', ')})`}: say one of ${POSITIONS.join(', ')}.`);
  }
  return { kind: given[0], where: item[given[0]]! };
}

// What a place of the core's comes to: what goes before it, what says it instead (when something does), and what goes after.
interface Place<T> {
  before: T[];
  instead: T[] | undefined;
  after: T[];
  by: string | undefined; // the group that replaced it
}

// Items placed among the core's, each by its position: the lists the layout is read from.
function place<T extends Edit | Param>(scope: string, core: Map<string, string>, items: Contributed<T>[]): Map<string, Place<T>> {
  const places = new Map([...core.keys()].map((name) => [name, { before: [], instead: undefined, after: [], by: undefined } as Place<T>]));
  const owner = new Map(core);
  for (const { group, of: item } of items) {
    const { kind, where } = positionOf(item, group);
    // An argument may stand in for the one of its own name.
    if (owner.has(item.name) && !(kind === 'replaces' && where === item.name)) {
      throw new Error(`Two entries of ${scope} are named ${item.name}: ${owner.get(item.name)} and the tool group ${group}.`);
    }
    owner.set(item.name, `the tool group ${group}`);
    const at = places.get(where);
    if (!at) throw new Error(`The tool group ${group} puts its entry ${item.name} of ${scope} ${kind === 'replaces' ? 'in place of' : kind} ${where}, which is none of the core's.`);
    if (kind !== 'replaces') {
      at[kind].push(item);
      continue;
    }
    if (at.by !== undefined && at.by !== group) throw new Error(`The tool groups ${at.by} and ${group} both replace ${where} of ${scope}.`);
    at.by = group;
    (at.instead ??= []).push(item);
  }
  return places;
}

// A text with the groups' edits in place: the core's pieces in order, each with what goes before it, what stands in
// for it, and what goes after.
export function compose(id: string, words: Words, edits: Contributed<Edit>[]): string {
  if (typeof words === 'string') {
    if (edits.length > 0) throw new Error(`The tool group ${edits[0].group} edits ${id}, which the core says in one piece, with none to place it by.`);
    return words;
  }
  const core = new Map<string, string>();
  for (const [name] of words) {
    if (core.has(name)) throw new Error(`Two pieces of ${id} are named ${name}.`);
    core.set(name, 'the core');
  }
  const places = place(id, core, edits);
  return words
    .map(([name, text]) => {
      const at = places.get(name)!;
      return [...at.before.map((edit) => edit.text), ...(at.instead?.map((edit) => edit.text) ?? [text]), ...at.after.map((edit) => edit.text)].join('');
    })
    .join('');
}

// The same for an argument list: the core's arguments in order, with the groups' placed among them.
function composeShape(tool: string, shape: Shape, params: Contributed<Param>[]): Shape {
  const core = new Map(Object.keys(shape).map((name) => [name, 'the core']));
  const places = place(`the arguments of ${tool}`, core, params);
  const made: Shape = {};
  for (const [name, schema] of Object.entries(shape)) {
    const at = places.get(name)!;
    for (const param of at.before) made[param.name] = param.schema;
    if (at.instead) for (const param of at.instead) made[param.name] = param.schema;
    else made[name] = schema;
    for (const param of at.after) made[param.name] = param.schema;
  }
  return made;
}

// What the groups registered with a server say of the board's own texts, built for a session (ToolGroups.phrases). With
// no group, every text is the core's.
export class Phrases implements Told {
  constructor(private readonly contributions: { group: string; phrasing: Phrasing }[] = []) {
    const owners = new Map<string, string>();
    for (const { group, phrasing } of contributions) {
      for (const id of Object.keys(phrasing.lines ?? {})) {
        if (owners.has(id)) throw new Error(`The tool groups ${owners.get(id)} and ${group} both give the sentence ${id}.`);
        owners.set(id, group);
      }
    }
    const parts = new Map<string, string>();
    for (const { group, phrasing } of contributions) {
      for (const id of Object.keys(phrasing.parts ?? {})) {
        if (parts.has(id)) throw new Error(`The tool groups ${parts.get(id)} and ${group} both give the part ${id}.`);
        parts.set(id, group);
      }
    }
    this.eventKinds = new Set(contributions.flatMap(({ phrasing }) => phrasing.events ?? []));
  }

  // The kinds of event the groups tell.
  private readonly eventKinds: ReadonlySet<EventType>;

  private edits(id: string): Contributed<Edit>[] {
    return this.contributions.flatMap(({ group, phrasing }) => (phrasing.edits?.[id] ?? []).map((of) => ({ group, of })));
  }

  // The tools the groups add arguments to.
  toolsWithParams(): string[] {
    return [...new Set(this.contributions.flatMap(({ phrasing }) => Object.keys(phrasing.params ?? {})))];
  }

  // A text as this server says it: the core's pieces with the edits registered for `id`.
  say(id: string, words: Words): string {
    return compose(id, words, this.edits(id));
  }

  // A sentence a group makes for the call at hand, or none when no group gives one (the core then says its own).
  line(id: string, vars: Record<string, string>): string | undefined {
    for (const { phrasing } of this.contributions) if (phrasing.lines?.[id]) return phrasing.lines[id](vars);
    return undefined;
  }

  // A part of a digest a group says, or none when no group does (the core then leaves it out).
  part(id: string, board: Board, viewer?: string, context?: PartContext): string | undefined {
    for (const { phrasing } of this.contributions) if (phrasing.parts?.[id]) return phrasing.parts[id](board, viewer, context);
    return undefined;
  }

  // Whether an event is told: the core's own, and the kinds a group tells (core/eventsTold.ts).
  tells(event: BoardEvent, board: Board): boolean {
    return eventTold(event, board, (what) => this.offers(what), this.eventKinds);
  }

  // Whether a group offers agents what the core leaves out.
  offers(what: string): boolean {
    return this.contributions.some(({ phrasing }) => phrasing.offers?.includes(what));
  }

  // A tool's arguments as this server lists them: the groups' added, and the ones the groups edit described anew.
  shape(tool: string, shape: Shape): Shape {
    const edited = Object.fromEntries(
      Object.entries(shape).map(([name, schema]) => {
        const id = `${tool}.${name}`;
        const edits = this.edits(id);
        if (edits.length === 0) return [name, schema];
        const pieces = describedWords(schema);
        if (!pieces) throw new Error(`The tool group ${edits[0].group} edits ${id}, which the core describes in one piece, with none to place it by.`);
        return [name, schema.describe(compose(id, pieces, edits))];
      }),
    );
    const params = this.contributions.flatMap(({ group, phrasing }) => (phrasing.params?.[tool] ?? []).map((of) => ({ group, of })));
    return params.length > 0 ? composeShape(tool, edited, params) : edited;
  }
}
