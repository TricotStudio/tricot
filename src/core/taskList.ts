// Task lists in a note's Markdown: "- [ ] step" lines people tick, which is
// all a checklist is (#83). They are read and rewritten a line at a time, so a
// tick, or an agent's new list, changes those lines and leaves every other
// byte of the note as it was. Pure, for the server and the web alike.

import { noteText } from './pins';

// A list item that opens with a task box, as GitHub-style Markdown reads one:
// in a quote or not, its bullet or number (after another item's on the same
// line, for a list in a list), then the box. The box is followed by a space or
// the line's end.
const TASK = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})+)\[([ \txX])\](?=[ \t]|$)/;
// A fence that opens or closes a code block, where a box is just text.
const FENCE = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/;

export interface TaskLine {
  line: number; // 1-based, as a Markdown renderer numbers lines
  done: boolean;
  text: string; // what follows the box, trimmed
  lead: string; // the line up to the box: indent, quote and marker
}

// What an agent sends for a task: its words, and whether it is done.
export interface TaskInput {
  text: string;
  done?: boolean;
}

// A line without the \r of a Windows line ending, which is kept where it was.
const bare = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

function readTask(line: string, last: boolean): Omit<TaskLine, 'line'> | null {
  const body = bare(line);
  const match = TASK.exec(body);
  if (!match) return null;
  const text = body.slice(match[0].length).trim();
  if (!text && last) return null; // a box at the very end of the text is not one yet
  return { lead: match[1], done: match[2] === 'x' || match[2] === 'X', text };
}

// The tasks in a note, in order, those in code blocks aside.
export function taskLines(markdown: string): TaskLine[] {
  const lines = markdown.split('\n');
  const tasks: TaskLine[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const fenced = FENCE.exec(bare(line));
    if (fence) {
      if (fenced && fenced[1][0] === fence[0] && fenced[1].length >= fence.length && !fenced[2].trim()) fence = null;
      return;
    }
    if (fenced && !(fenced[1][0] === '`' && fenced[2].includes('`'))) {
      fence = fenced[1];
      return;
    }
    const task = readTask(line, i === lines.length - 1);
    if (task) tasks.push({ line: i + 1, ...task });
  });
  return tasks;
}

// A note without its tasks: the lines around them, as they are.
export function proseOf(markdown: string): string {
  const tasks = new Set(taskLines(markdown).map((t) => t.line - 1));
  return markdown
    .split('\n')
    .filter((_, i) => !tasks.has(i))
    .join('\n');
}

// How many of a note's tasks are done, of how many.
export function taskProgress(markdown: string): { done: number; total: number } {
  const tasks = taskLines(markdown);
  return { done: tasks.filter((t) => t.done).length, total: tasks.length };
}

// The note with the task on `line` (1-based) ticked, or not: only the
// character in its box changes. The same note when it already reads so; null
// when that line has no task box.
export function setTask(markdown: string, line: number, done: boolean): string | null {
  const lines = markdown.split('\n');
  const at = line - 1;
  if (!Number.isInteger(at) || at < 0 || at >= lines.length) return null;
  const task = readTask(lines[at], false);
  if (!task) return null;
  if (task.done === done) return markdown;
  const box = task.lead.length + 1;
  lines[at] = `${lines[at].slice(0, box)}${done ? 'x' : ' '}${lines[at].slice(box + 1)}`;
  return lines.join('\n');
}

// A tick made again on a note someone changed meanwhile: the same task (its
// words, nearest the line it was on) ticked or not. The same note when it
// already reads so; null when the task is gone.
export function retick(markdown: string, was: { line: number; text: string }, done: boolean): string | null {
  const same = taskLines(markdown).filter((t) => t.text === was.text);
  if (same.length === 0) return null;
  const nearest = same.reduce((a, b) => (Math.abs(b.line - was.line) < Math.abs(a.line - was.line) ? b : a));
  return setTask(markdown, nearest.line, done);
}

// A task's words on one line, as a list item holds them.
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

// Tasks as Markdown: "- [x] Ship" a line each.
export function tasksMarkdown(items: readonly TaskInput[]): string {
  return items.map((item) => `- [${item.done ? 'x' : ' '}] ${oneLine(item.text)}`).join('\n');
}

// The note with its task list replaced by `items`, as an agent sends a
// checklist's items: a task whose words are already there keeps its tick
// (unless the item says) and its place in any nesting; the list goes where the
// first task was; every other line stays as it was. A note with no tasks gets
// them at its end.
export function withTasks(markdown: string, items: readonly TaskInput[]): string {
  const tasks = taskLines(markdown);
  if (tasks.length === 0) {
    if (items.length === 0) return markdown;
    const before = markdown.replace(/\s+$/, '');
    return before ? `${before}\n\n${tasksMarkdown(items)}` : tasksMarkdown(items);
  }
  const lines = markdown.split('\n');
  const unused = [...tasks];
  const written = items.map((item) => {
    const text = oneLine(item.text);
    const at = unused.findIndex((t) => t.text === text);
    const prior = at === -1 ? undefined : unused.splice(at, 1)[0];
    const done = item.done ?? prior?.done ?? false;
    if (prior) return setTask(lines[prior.line - 1], 1, done)!; // as it was written, ticked as asked
    return `${tasks[0].lead}[${done ? 'x' : ' '}] ${text}`;
  });
  const first = tasks[0].line - 1;
  const gone = new Set(tasks.map((t) => t.line - 1));
  return lines.flatMap((line, i) => [...(i === first ? written : []), ...(gone.has(i) ? [] : [line])]).join('\n');
}

// Where a task's words are in the note as it reads (noteText), which is where
// pins on them are found: offsets, or null when they can't be told apart.
export function taskWords(markdown: string, line: number): { start: number; end: number } | null {
  const lines = markdown.split('\n');
  const own = noteText(lines[line - 1] ?? '');
  const all = noteText(markdown);
  const before = noteText(lines.slice(0, line - 1).join('\n'));
  // The lines before it read as `before`, then a line break, unless none of them shows.
  for (const start of [before.length + 1, before.length]) {
    if (all.slice(start, start + own.length) === own) {
      // Its words, without the space either side.
      const lead = own.length - own.trimStart().length;
      const trail = own.length - own.trimEnd().length;
      return { start: start + lead, end: start + own.length - trail };
    }
  }
  return null;
}
