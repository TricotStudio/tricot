// A brief for a subagent: everything it needs to build one task, as one text
// the main session pastes into the subagent's prompt (brief_task). The main
// session stays on the board as chief of staff, and the subagent may not reach
// Tricot at all, so the brief carries the task's decisions, discussion and
// canvas rather than pointing at them. Read-only: it changes nothing.

import { kindOf } from './blocks/registry';
import { blockLabel } from './canvas';
import { blockContentDigest, commentLine, indent, readingOrder, TASK_STATUS_LABEL, who } from './digest';
import { describeChoice, listNames, peopleOn } from './format';
import { canvasName, partQuote, pinLost, pinsTo, placePin } from './pins';
import type { Board, Comment, Decision, Status, Task } from './types';

// What a decision's status means for the work built on it.
const STATUS_MEANS: Record<Status, string> = {
  decided: 'binding',
  provisional: 'build on it, but keep it cheap to change',
  open: "not settled now: don't build on what it leaves open",
  exploring: "people want evidence before deciding: don't build on it yet",
  deferred: "don't build on it; use a reversible default",
  retired: "set aside as no longer relevant; don't build on it",
};

// Blocks whose text the brief carries in full; the rest it describes.

// `agents` are the board's agents by name (mentions.ts boardAgents).
export function taskBrief(board: Board, task: Task, agents: string[]): string {
  const ref = `T${task.number}`;
  const lines = [`# Brief: ${ref} ${task.title}`];
  const claimed = task.claimedBy && task.status !== 'todo' ? `, claimed by ${who(task.claimedBy)}` : '';
  const assigned = task.assignee ? ` · assigned to ${task.assignee}` : '';
  lines.push(`Task id: ${task.id} · board "${board.title}" [board id: ${board.id}] · status: ${TASK_STATUS_LABEL[task.status]}${claimed}${assigned}`);
  if (board.goal) lines.push(`Board goal: ${board.goal}`);
  lines.push(
    `You're building ${ref} for the main session, which stays on the board with the people. Everything you need is below; "How to work", at the end, says how to work and what to bring back.`,
  );
  if (task.status === 'backlog') lines.push('', "Not ready: it's in the backlog, and a person is still shaping it. Check with the main session before building it.");
  if (task.dropped) lines.push('', `DROPPED: ${task.dropped.by.name} set it aside as work that won't be done${task.dropped.text ? ` ("${task.dropped.text}")` : ''}. Don't build it.`);
  if (task.stale) lines.push('', `STALE: ${task.stale.reason}. A decision it builds on changed: check with the main session before building on it.`);
  if (task.commit) lines.push('', task.commit.hash ? `Committed as ${task.commit.hash}.` : `${task.commit.approvedBy.name} approved it and asked for a commit.`);
  else if (task.noCommit) lines.push('', `Nothing to commit: ${task.noCommit.reason}.`);

  const detail = task.detail?.trim();
  lines.push('', '## The task', `${ref}: ${task.title}`, detail || 'No detail beyond the title: ask the main session if anything is unclear.');
  lines.push(
    '',
    '## What done looks like',
    detail ? '- What the detail above describes works, as the decisions below settle it.' : '- What the title says works, as the decisions below settle it.',
    "- The project's tests pass, and nothing outside the task changes behaviour.",
    '- There is something to look at for review: screenshots for UI work, the diff for code.',
  );
  if (task.links.length) lines.push('', '## Links', ...task.links.map((l) => `- ${l}`));

  const latest = latestFromPeople(task);
  if (latest.length) lines.push('', "## Latest from people (newest first; a note sent with work sent back says what to fix)", ...latest);

  lines.push(...decisionsSection(board, task));
  if (task.comments.length) lines.push('', '## Discussion (oldest first)', ...task.comments.map(said));
  if (task.notes.length) lines.push('', '## Progress notes (oldest first)', ...task.notes.map((n) => item(`${who(n.by)} at ${n.at}: ${n.text}`)));
  lines.push(...canvasSection(task));
  lines.push(...pinnedSection(board, task));

  const people = peopleOn(board).map((p) => p.name);
  lines.push(
    '',
    '## People and agents on the board',
    `People: ${people.length ? listNames(people) : 'nobody yet'}. Questions for them go through the main session.`,
    `Agents: ${agents.length ? listNames(agents) : 'none yet'}.`,
  );
  lines.push('', '## How to work', ...rules(task).map((rule) => `- ${rule}`));
  return lines.join('\n');
}

// A list item whose text may run over several lines: the lines after the
// first sit under it, so a comment's own bullets don't read as the brief's.
function item(text: string): string {
  return `- ${text.replace(/\n/g, '\n  ')}`;
}

// A comment as get_task shows it, its lines kept under its item.
function said(comment: Comment): string {
  return commentLine(comment).replace(/\n/g, '\n  ');
}

// People's notes and comments on the task, newest first: what they asked for
// last, such as their note when they sent the work back.
function latestFromPeople(task: Task, max = 3): string[] {
  const theirs = [
    ...task.notes.filter((n) => n.by.kind === 'human').map((n) => ({ at: n.at, line: item(`${who(n.by)} at ${n.at}, note: ${n.text}`) })),
    ...task.comments.filter((c) => c.author.kind === 'human').map((c) => ({ at: c.createdAt, line: said(c) })),
  ];
  return theirs
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, max)
    .map((s) => s.line);
}

function decisionsSection(board: Board, task: Task): string[] {
  const decisions = task.decisionIds
    .map((id) => board.decisions.find((d) => d.id === id))
    .filter((d): d is Decision => Boolean(d));
  if (decisions.length === 0) return ['', '## Decisions it implements', 'None: it stands alone.'];
  return ['', '## Decisions it implements', ...decisions.flatMap(decisionLines)];
}

// A decision as the work needs it: the question, what was chosen and why,
// and what people said on it.
function decisionLines(decision: Decision): string[] {
  const lines = ['', `### #${decision.number} ${decision.question} [decision id: ${decision.id}]`];
  lines.push(`Status: ${decision.status} (${STATUS_MEANS[decision.status]})`);
  const r = decision.resolution;
  if (r) {
    lines.push(`Chosen: ${describeChoice(decision)}, by ${who(r.by)}`);
    const option = decision.options.find((o) => o.id === r.optionId);
    if (option?.description) lines.push(indent(option.description));
    if (r.rationale) lines.push(`Rationale: ${r.rationale}`);
  } else {
    lines.push('Not answered now.');
  }
  if (decision.context?.trim()) lines.push('Context:', indent(decision.context.trim()));
  const theirs = decision.comments.filter((c) => c.author.kind === 'human');
  if (theirs.length) lines.push("People's comments:", ...theirs.map(said));
  return lines;
}

function canvasSection(task: Task): string[] {
  const { blocks, groups } = task.canvas;
  if (blocks.length === 0) return ['', '## On its canvas', 'Nothing yet.'];
  const entries = readingOrder(blocks).map((block) => {
    const group = groups.find((g) => g.id === block.groupId);
    const head = `- ${blockLabel(block)} (${block.type}) [block id: ${block.id}]${group ? ` · group "${group.title}"` : ''}`;
    return `${head}\n${indent(blockContentDigest(block, Boolean(kindOf(block.type).briefInFull)))}`;
  });
  return ['', '## On its canvas (reading order)', ...entries];
}

// The parts of blocks pinned to the task, wherever they are on the board, quoted.
function pinnedSection(board: Board, task: Task): string[] {
  const pins = pinsTo(board, { taskId: task.id });
  if (pins.length === 0) return [];
  return [
    '',
    '## Pinned to this task',
    ...pins.map(({ pin, block, decision, task: owner }) => {
      const lost = placePin(block, pin) ? '' : ` (${pinLost(pin)} since)`;
      return `- ${partQuote(pin, block)}${lost} in ${blockLabel(block)} (${canvasName({ decision, task: owner })}), pinned by ${who(pin.author)}`;
    }),
  ];
}

function rules(task: Task): string[] {
  const id = task.id;
  return [
    `Build only T${task.number}. Work in your own git worktree or branch, and stay in it: other subagents may be working on other tasks at the same time.`,
    "Don't commit. The main session merges your work, and commits only when a person asks.",
    "Run the project's tests (and its typecheck or lint, if it has them) before you report, and fix what you broke.",
    'Bring back a patch or diff of your changes, screenshots of the result for UI work (as file paths), and a short report: what you did, how you checked it, and anything you were unsure about.',
    "Where the decisions above don't settle something that would be costly to change, don't guess: say so in your report.",
    `If you can reach Tricot (its tools, such as get_task), check get_task (task_id: ${id}) between steps for new comments from people, and report progress with update_task (task_id: ${id}, note). Leave its status to the main session. If you can't reach Tricot, report back to the main session instead.`,
  ];
}
