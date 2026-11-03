// What only REST and MCP need of note blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { NoteTypes } from './index';
import type { AgentHalf, PeopleHalf, ServerHalf } from '../kind';
import { plainText } from '../schema';
import { blockIs, missing, more, wordsPin } from '../shared';
import { noteAdvice } from '../../advice';
import { blockLabel } from '../../canvas';
import { clip } from '../../format';
import { plainMarkdown } from '../../markdown';
import { findWords, noteText, quoteAt } from '../../pins';
import { BoardError } from '../../store/errors';
import type { PinPart } from '../../store/inputs';
import { LIMITS, limited, required } from '../../store/validate';
import { proseOf, taskLines, taskProgress, taskWords, withTasks, type TaskInput, type TaskLine } from '../../taskList';

// Tasks as an agent sends a checklist's items, checked: words on each, and no more than a list holds.
function checkedTasks(items: TaskInput[]): TaskInput[] {
  if (items.length > LIMITS.items) throw new BoardError(`A task list can have at most ${LIMITS.items} tasks.`);
  return items.map((item) => ({ text: limited(required(item.text, 'A task'), LIMITS.itemText, 'A task'), done: item.done }));
}

const itemsShape = z
  .array(z.union([z.string(), z.object({ text: z.string(), done: z.boolean().optional() })]))
  .describe("A note's task list, as a checklist's items: strings, or {text, done}");

const toItems = (items: unknown): TaskInput[] => (items as (string | TaskInput)[]).map((item) => (typeof item === 'string' ? { text: item } : item));

// What an agent that asked for a checklist is told it got.
const CHECKLIST_NOW = 'Checklists are notes now: its items are the note\'s task list, "- [ ]" lines people tick. update_block with items, or text, changes them.';

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A task in a note, by its words as written or as they read.
function findTask(block: { text: string }, wanted: string): TaskLine | undefined {
  const tasks = taskLines(block.text);
  return (
    tasks.find((t) => t.text === wanted.trim()) ?? tasks.find((t) => sameText(t.text, wanted)) ?? tasks.find((t) => sameText(noteText(t.text), wanted))
  );
}

export const agent: AgentHalf<NoteTypes> = {
  addShape: { text: z.string().optional(), items: itemsShape.optional() },
  updateShape: { text: z.string().optional(), items: itemsShape.optional() },
  // An agent that still asks for a checklist gets a note with its task list.
  aliases: ['checklist'],
  docs: {
    add: 'note → text (Markdown; task lists live in notes, as "- [ ] step" lines people tick and "- [x] step" once done); checklist → items, accepted for compatibility: it makes a note with that task list',
    update: 'text, items (a note\'s task list)',
  },
  read(args) {
    const items = args.items === undefined ? undefined : checkedTasks(toItems(args.items));
    if (args.type === 'checklist' && !items) throw missing('checklist', 'items');
    if (args.text === undefined && !items) throw missing('note', 'text');
    const text = items ? withTasks((args.text as string | undefined) ?? '', items) : (args.text as string);
    return () => ({ type: 'note', text });
  },
  patch: (args) => ({ text: args.text as string | undefined, items: args.items === undefined ? undefined : toItems(args.items) }),
  // A list of steps is no wall of prose: the advice reads what is around it.
  adviceAdded: (block, args) => [...(args.type === 'checklist' ? [CHECKLIST_NOW] : []), ...noteAdvice(proseOf(block.text))],
  adviceUpdated: (block, args) => (args.text !== undefined || args.items !== undefined ? noteAdvice(proseOf(block.text)) : []),
  pinShape: { item: z.string().optional().describe("A task in a note's task list (a checklist's item), by its words") },
  pinPart(block, args) {
    if (args.item === undefined) return undefined;
    if (block.type !== 'note') throw new BoardError(`Only notes have task lists; ${blockIs(block)}.`);
    const wanted = args.item as string;
    const task = findTask(block, wanted);
    if (!task) throw new BoardError(`${blockLabel(block)} has no task "${clip(wanted, 60)}".`);
    return taskPart(block.text, task, args.text as string | undefined, args.occurrence as number | undefined);
  },
};

// Words in a task, or the whole of it, as the note's words: told apart from
// the same words elsewhere in the note by the text around them.
function taskPart(markdown: string, task: TaskLine, words: string | undefined, occurrence: number | undefined): PinPart {
  const reads = noteText(markdown);
  const line = taskWords(markdown, task.line);
  if (!line) return { kind: 'text', quote: words ?? task.text, occurrence };
  const own = reads.slice(line.start, line.end);
  const at = words === undefined ? { start: 0, end: own.length } : findWords(own, words, { occurrence });
  if (!at) throw new BoardError(`"${clip(words ?? '', 60)}" isn't in task "${clip(own, 60)}". Quote the words exactly as they read.`);
  const quoted = quoteAt(reads, line.start + at.start, line.start + at.end);
  if (!quoted) return { kind: 'text', quote: words ?? task.text, occurrence };
  return { kind: 'text', ...quoted };
}

export const people: PeopleHalf = {
  create: z.object({ type: z.literal('note'), text: z.string() }),
  patch: { text: plainText },
};

// What changed in a note's tasks when nothing around them did: ticked,
// added, removed. Tasks are matched by their words, the first unmatched first.
function taskChanges(before: string, after: string): string[] | undefined {
  if (proseOf(before) !== proseOf(after)) return undefined;
  const unused = taskLines(before);
  const parts: string[] = [];
  for (const task of taskLines(after)) {
    const at = unused.findIndex((t) => t.text === task.text);
    if (at === -1) {
      parts.push(`added task "${clip(task.text, 60)}"`);
      continue;
    }
    const [prior] = unused.splice(at, 1);
    if (prior.done !== task.done) parts.push(`${task.done ? 'checked' : 'unchecked'} "${clip(task.text, 60)}"`);
  }
  for (const task of unused) parts.push(`removed task "${clip(task.text, 60)}"`);
  return parts.length ? parts : undefined;
}

export const server: ServerHalf<NoteTypes> = {
  patchFields: ['text', 'items'],

  create: (input) => ({ text: limited(input.text ?? '', LIMITS.text, 'Note text') }),

  change({ block, patch }) {
    if (patch.text === undefined && patch.items === undefined) return undefined;
    let text = patch.text ?? block.text;
    if (patch.items !== undefined) text = withTasks(text, checkedTasks(patch.items));
    limited(text, LIMITS.text, 'Note text');
    return {
      apply() {
        block.text = text;
      },
    };
  },

  describe: (before, after) => (before.text !== after.text ? (taskChanges(before.text, after.text) ?? ['edited the text']) : []),
  snapshot: (block) => ({ text: block.text }),
  restorePatch: (version) => ({ text: version.text }),

  // A note with tasks says how far along they are, then reads as written.
  digest(block, full) {
    if (!block.text.trim()) return '(empty note)';
    const text = full ? block.text : more(block.text);
    const { done, total } = taskProgress(block.text);
    return total ? `${done}/${total} done\n${text}` : text;
  },
  searchText: (block) => [plainMarkdown(block.text)],
  briefInFull: true,

  anchor(block, part) {
    return part.kind === 'text' ? wordsPin(block, part, () => ({ text: noteText(block.text) })) : undefined;
  },

  agent,
  people,
};
