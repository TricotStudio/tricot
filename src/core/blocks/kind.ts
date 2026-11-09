// What a kind of canvas block is, in one contract: everything the board knows
// how to do with a note, a table, a chart… is asked of its kind, and nothing
// else switches on a block's type. A kind lives in its own folder
// (core/blocks/<type>/), which is the whole of it on this side; the registry
// (registry.ts) lists them, one line each. Its web half (the drawing, the
// editor, its Add menu entry) is in web/canvas/blocks/<type>/.
//
// This is the core half: no React, no Express, no MCP server. It is internal:
// kinds are code in this repository, not something third parties load.

import type { z } from 'zod';

// The fields a kind reads, by name, each with its schema.
export type Shape = Record<string, z.ZodType>;
import type { Assets } from '../store/assets';
import type { BlockContent, Located, PinPart } from '../store/inputs';
import type { PinPlace } from '../pins';
import type { ConnectorPins } from '../connectors/connector';
import type { Block, BlockBase, Board, Canvas, Pin, PinAnchor } from '../types';

export interface Size {
  w: number;
  h: number;
}

// The types a kind is written in. `fields` is what a block of it has besides
// what every block has (and its type); `snapshot` what a version of it keeps;
// `input` what making one takes; `patch` the fields a change to one names.
// The board's Block, BlockSnapshot, BlockContent and BlockPatch types are made
// from these, so a kind adds its own to them by being registered. Its fields
// can't be named as a block's own are (id, rev, x, y, w, h, author…) or as a
// version's (rev, at, by), nor title or type.
export interface KindTypes {
  type: string;
  fields: object;
  snapshot: object;
  input: object;
  patch: object;
}

export type BlockOf<T extends KindTypes> = BlockBase & { type: T['type'] } & T['fields'];
export type SnapshotOf<T extends KindTypes> = { title?: string; type: T['type'] } & T['snapshot'];
export type InputOf<T extends KindTypes> = { type: T['type'] } & T['input'];

// The board's types, made from the kinds that are registered: a union of what
// every kind has, and for a change, every field any of them takes.
type KindTypesOf<K> = K extends { readonly types?: infer T } ? Extract<T, KindTypes> : never;
type EachKind<K, Make extends 'block' | 'snapshot' | 'input'> =
  KindTypesOf<K> extends infer T
    ? T extends KindTypes
      ? Make extends 'block'
        ? BlockOf<T>
        : Make extends 'snapshot'
          ? SnapshotOf<T>
          : InputOf<T>
      : never
    : never;
type Intersection<U> = (U extends unknown ? (member: U) => void : never) extends (member: infer I) => void ? I : never;

export type BlocksOf<K> = EachKind<K, 'block'>;
export type SnapshotsOf<K> = EachKind<K, 'snapshot'>;
export type InputsOf<K> = EachKind<K, 'input'>;
export type PatchesOf<K> = Intersection<KindTypesOf<K> extends infer T ? (T extends KindTypes ? T['patch'] : never) : never>;

// What a change to any block can name.
export interface CommonPatch {
  title?: string;
  optionId?: string | null;
  groupId?: string | null;
}

// ---- making and changing ------------------------------------------------------

export interface CreateContext {
  assets: Assets;
  located: Located;
  // Whether a block may name what is on this computer (a folder, a local dev
  // server): only while the server listens on this computer alone.
  localFiles: boolean;
}

export interface ChangeContext<T extends KindTypes> {
  block: BlockOf<T>; // as it is: nothing has changed yet
  patch: T['patch'] & CommonPatch;
  assets: Assets;
  canvas: Canvas;
  restoring?: SnapshotOf<T>; // the version being brought back, when the change is a restore
  localFiles: boolean; // as in CreateContext
}

// A change to a block's content, checked: `change` throws if it is refused,
// before anything has changed; `apply` then makes it.
export interface Change {
  // Returns true when it changed how the block looks and not what it says
  // (a link folding or opening), which is kept without a new version.
  apply(): boolean | void;
  // After the change, with the canvas's pins: pins on parts that moved follow them.
  settle?(pins: Pin[]): void;
}

// ---- pins ------------------------------------------------------------------------

export interface PinHooks<T extends KindTypes> {
  // The anchor and quote for a part of this kind of block, or undefined when
  // the part is not one it has (the caller then says which kinds have it).
  anchor?(block: BlockOf<T>, part: PinPart, pins: Pin[]): { anchor: PinAnchor; quote: string } | undefined;
  // Where a pin's part is now: null once it has changed past finding;
  // undefined when it is not a pin on a part this kind has.
  place?(block: BlockOf<T>, pin: Pin): PinPlace | null | undefined;
  // A card people pin whole, like a link, as against a block (the words they use).
  whole?: { word: 'card'; quote(block: BlockOf<T>): string };
  // How each kind of part it has reads and behaves, by its anchor's kind: a
  // scene's spots, a diagram's nodes and arrows. Shared code asks these
  // (core/parts.ts, partHooks) and switches on no part's kind.
  parts?: PartsHooks;
  // Its parts that people comment on and may ask agents to act on (a
  // website's elements, a code block's lines): what agents are told of them,
  // said as a connector says it of its parts (core/parts.ts). Server-only.
  part?: PartWords;
}

// A pinned part, or a part about to be pinned (a person's prompt names it
// before it is checked, with the fields it has so far), and its quote.
export type PartLike<A extends { kind: string } = PinAnchor> = {
  anchor: A extends unknown ? Partial<A> & Pick<A, 'kind'> : never;
  quote: string;
};

// How one kind of pinned part reads and behaves, wherever the board names it:
// in digests, pin prompts, chips and threads, and agents' tool text. A
// kind's pins say it for each kind of part it has (pins.parts), and a
// connector's pins for its own (a Google Doc's paragraph). Each is said once
// here, and nothing else switches on the part's kind. What isn't said is the
// default given beside it.
export interface PartHooks<A extends PinAnchor = PinAnchor> {
  // The part in a phrase: node "Retry", box 1, line 12 of a.ts. The quote if not said.
  name?(pin: PartLike<A>): string;
  // The part as a prompt or a comment quotes it: the words in quotes,
  // a.ts:12 · “code”. If not said, its block's name · its phrase.
  quote?(pin: PartLike<A>): string;
  // What a task's detail or a question's context quotes of it, after
  // "Pinned from …:". The pin's quote if not said.
  detail?(pin: PartLike<A>): string;
  // What its pin no longer finding it means: "object removed". "text changed" if not said.
  lost?: string;
  // Whether two of its anchors are the same part: a box is, whatever number
  // it was given. Anchors that are equal if not said.
  same?(a: A, b: A): boolean;
  // Drawn on its block (tinted cells, a box, a spot): its pins' chips go in
  // the strip under the block, naming it.
  drawn?: true;
  // Words people selected, which work pinned from them quotes whole.
  words?: true;
  // What agents do with a request on it, as its thread tells the person who
  // asked: "change the scene". "act on it" if not said.
  askedTo?: string;
  // A part agents answer on, by its pin (a diff's or code block's line), as
  // they are told to: "the line". Where they read the canvas, it reads with
  // what people said about it, wherever it was said.
  answeredOn?: string;
  // What agents read after it to find it: " (id Retry)". Nothing if not said.
  where?(pin: Omit<Pin, 'anchor'> & { anchor: A }): string;
  // Said when a block isn't one that has it: "Spots are pinned on 3D scenes; …".
  missing?(block: Block): string;
}

// A kind's parts' hooks, by their anchor's kind.
export type PartsHooks = { readonly [K in Exclude<PinAnchor['kind'], 'block'>]?: PartHooks<Extract<PinAnchor, { kind: K }>> };

// What a kind of part says of itself, as a connector's pins do. `kind` names
// the part where a request or a pairing session says which (a comment's
// askPart, a session's part). Its pins are anchored by that name ('site'),
// or, for parts pinned with anchors other kinds share (a code block's lines
// are 'line' anchors, as a diff's are), by `anchors`. Where agents find one
// and what a block without it says are its part's hooks (pins.parts).
export type PartWords = Pick<ConnectorPins, 'kind' | 'label' | 'seen' | 'ask'> & { anchors?: readonly PinAnchor['kind'][] };

// ---- what agents send ------------------------------------------------------------

// What the MCP shell gives a kind to read what an agent sent: the file reading
// and asset saving that only it can do.
export interface AgentIo {
  readImage(path?: string, base64?: string): Buffer;
  saveAsset(data: Uint8Array): string;
  // Whether what an agent names on this computer (a file, a repository) may
  // be read: only while the server listens on this computer alone.
  localFiles: boolean;
}

// The sentences about a kind: its brief entry in add_block's description, and
// in the guide's blocks topic (read_guide), its full entry and advice.
export interface AgentDocs {
  brief: string; // its entry in add_block's "Fields by type", a few words, without the ; or . that ends it
  add: string; // its full entry in the guide's "Fields by type", without the ; or . that ends it
  guide?: string; // advice after those entries
  more?: string; // advice after that
  update?: string; // its fields as update_block lists them, in a row
  updateSpecial?: string; // a clause of their own after that row
}

export interface AgentHalf<T extends KindTypes> {
  addShape: Shape; // the add_block fields it reads
  updateShape: Shape; // the update_block fields it reads
  // Types agents may still name that make a block of this kind: a kind that
  // became part of this one (a checklist is a note with a task list).
  aliases?: readonly string[];
  docs: AgentDocs;
  // Reads what an agent named on this computer instead of sending it (a
  // repository's diff, a file's lines) into the fields it would have sent,
  // before read or patch: the args with those fields filled in, or undefined
  // when none of its fields are in `args`. Given the block for update_block,
  // which asks every kind: one that isn't its kind is refused, saying so.
  fill?(args: Record<string, unknown>, io: AgentIo, block?: Block): Promise<Record<string, unknown> | undefined>;
  // Reads what an agent sent as a block of this kind, refusing what is wrong
  // with it now. It returns what saves anything pending (an image's file) and
  // gives its content, so a call with a bad block saves nothing.
  read(args: Record<string, unknown>, io: AgentIo): () => InputOf<T>;
  // What an update_block call changes in a block of this kind.
  patch?(args: Record<string, unknown>, io: AgentIo): T['patch'];
  // Advice after adding one, or after updating one with these fields.
  adviceAdded?(block: BlockOf<T>, args: Record<string, unknown>): string[];
  adviceUpdated?(block: BlockOf<T>, args: Record<string, unknown>): string[];
  // Something worth telling an agent about what an update did (to the pins, say).
  noticeUpdated?(before: BlockOf<T>, block: BlockOf<T>, pins: Pin[]): string;
  // The picture a block is, to attach when an agent reads the canvas.
  picture?(block: BlockOf<T>): string | undefined;
  // The pin tool's fields it reads, and what part of it they name, given its
  // block: undefined when none of its fields are in `args`.
  pinShape?: Shape;
  // It reads them whatever the block (and refuses, saying so, a block that isn't its kind).
  pinPart?(block: Block, args: Record<string, unknown>): PinPart | undefined;
  // People's requests on its parts that wait on an agent (a website's
  // elements), for get_board and the agent's updates.
  asks?(board: Board, viewer?: string): string | undefined;
}

// What a person can make from a block with a button ("Make a chart" on a
// table): another block, put beside it.
export interface Derive<T extends KindTypes> {
  readonly from: string; // what the block has to be, for the refusal: "is not a table"
  // The new block's content, and which of the block's parts it left out (said in words).
  // Throws a BoardError when there is nothing to make of it.
  make(block: BlockOf<T>): { content: BlockContent; left: string[] };
}

// What people send: how the browser makes one (a zod object with the type
// literal, as the REST body has it), what a change to one may name, and the
// parts of it they pin, by their anchor's kind (a zod object each with the
// kind literal, as a pin's part is in the REST body).
export interface PeopleHalf {
  create?: z.ZodObject;
  patch?: Shape;
  parts?: { readonly [K in Exclude<PinPart['kind'], 'block'>]?: z.ZodObject };
}

// ---- the kind --------------------------------------------------------------------

export interface BlockKind<T extends KindTypes = any> {
  readonly types?: T; // type-level only: what the board's types are made from
  readonly type: T['type'];
  readonly label: string; // "Note": what people and search call it
  readonly defaultSize: Size;
  readonly titled?: false; // a code block is named by its path: it has no title

  // How it is called when it has no title ("code block" aside, the title comes first).
  named?(block: BlockOf<T>): string | undefined; // before the title
  untitled?(block: BlockOf<T>): string | undefined; // when there is none; else "untitled <type>"
  // The size of a new one: from its content, and the width and height asked for.
  sizeFor?(fields: T['fields'], asked: { w?: number; h?: number }): Size;

  create(input: T['input'], context: CreateContext): T['fields'];
  // The names of the patch fields it takes; a change naming one a block's kind
  // doesn't take is refused, in those words.
  readonly patchFields: readonly string[];
  change?(context: ChangeContext<T>): Change | undefined;
  // What changed from one version of a block to the next, in the words agents read.
  describe(before: BlockOf<T>, after: BlockOf<T>): string[];
  snapshot(block: BlockOf<T>): T['snapshot'];
  // A block's fields as a version had them.
  fromSnapshot(version: SnapshotOf<T>, block: BlockBase & { type: string }): T['fields'];
  restorePatch(version: SnapshotOf<T>): T['patch'];
  // What a copy of a block (pasted on another canvas) keeps besides what a
  // version of it holds: its fields that aren't content, such as how a link
  // shows. What it leaves out stays behind: a connector's draft, pins, versions.
  copy?(block: BlockOf<T>): Partial<T['fields']>;

  digest(block: BlockOf<T>, full: boolean): string; // what agents read of its content
  readonly inline?: true; // a digest short enough to sit on the block's own line
  searchText(block: BlockOf<T>): (string | undefined)[];
  readonly briefInFull?: true; // a task's brief carries its content whole
  // The files of pictures it holds, whether in a block or in a version of one.
  assets?(shown: BlockOf<T> | SnapshotOf<T>): string[];
  // What people are sent of it, when that is less than what agents get.
  forPeople?(block: BlockOf<T>): object;

  readonly pins?: PinHooks<T>;
  readonly agent: AgentHalf<T>;
  readonly people?: PeopleHalf;
  readonly derive?: Derive<T>;
}

// What of a kind only the server uses (REST, MCP, the store): making and
// changing blocks, what agents read of them, what people send. It lives in the
// kind's server.ts, which the web build leaves out; the rest of the kind
// (what the browser needs to name, place and show a block) is in its index.ts.
export type ServerHalf<T extends KindTypes = any> = Pick<
  BlockKind<T>,
  'create' | 'patchFields' | 'change' | 'describe' | 'snapshot' | 'restorePatch' | 'copy' | 'digest' | 'inline' | 'searchText' | 'briefInFull' | 'assets' | 'forPeople' | 'agent' | 'people' | 'derive'
> & { anchor?: PinHooks<T>['anchor']; part?: PinHooks<T>['part'] };

export type AnyKind = BlockKind<any>;
