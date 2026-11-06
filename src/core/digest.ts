// Agent-facing renderings of the board: compact Markdown that tells an agent
// what it may build on, what is waiting on people, and where its cursor is.

import { couldAffect, couldAffectLines } from './affects';
import { answerContext, discussionAt, quote, type Shown } from './answering';
import { boardAreas } from './areas';
import { staleFromDeleted } from './cardLinks';
import { blockLabel, blockPerson, syncedBlocks } from './canvas';
import { clip, describeChoice, listNames, optionPerson, peopleOn, pendingAsks, samePerson } from './format';
import { driftAge, driftChanges, driftOf } from './freshness';
import { canvasesOf, canvasName, pinAsk, pinComments, pinLost, pinPart, pinsTo, pinTarget, placePin } from './pins';
import { kindOf } from './blocks/registry';
import { askingWords, partAsks, partOf, partWords } from './parts';
import { cell } from './blocks/shared';
import { taskClosure } from './closure';
import { requestHeading, requestsDigest } from './requests';
import { fromThreadLine, isThreadEvent, threadEventLine, threadsDigest, threadsSection } from './threads';
import { agentsIn, mentionEventLine, mentionTag, mentionsDigest, peopleIn, skillInstructionLines } from './mentions';
import { assigneeDetail, assigneeNote, forAgent, readyLines } from './assignee';
import { firstLookDetail, firstLookNote, firstLooksDigest, openedBy } from './firstLook';
import { laneTasks } from './taskOrder';
import { reactionEventLine, reactionsLine } from './reactions';
import type {
  Actor,
  Block,
  Board,
  BoardEvent,
  BoardSummary,
  Canvas,
  Comment,
  Decision,
  PastAnswer,
  Pin,
  Status,
  SyncRequest,
  Task,
  TaskStatus,
} from './types';

const SECTIONS: { status: Status; heading: string }[] = [
  { status: 'open', heading: 'Open: waiting on people' },
  { status: 'exploring', heading: 'Exploring: people want evidence before deciding' },
  { status: 'provisional', heading: 'Provisional: proceed, but keep it cheap to change' },
  { status: 'decided', heading: 'Decided: binding' },
  { status: 'deferred', heading: "Deferred: don't build on these; use a reversible default" },
];

const ENDED: Record<PastAnswer['ended'], string> = {
  replaced: 'replaced',
  confirmed: 'confirmed as decided',
  reopened: 'reopened',
  explore: 'sent back for exploration',
  deferred: 'deferred',
  retired: 'retired as no longer relevant',
};

export function who(actor: Actor): string {
  return `${actor.name} (${actor.kind})`;
}

// A comment as agents read it. One made on part of the card's canvas quotes
// the part, with its pin. `tag` says who it's for, when it @-mentions agents
// (mentionTag); `withId` gives its id, for get_task and get_decision, which
// react takes.
export function commentLine(comment: Comment, tag = '', withId = false): string {
  const asking = comment.ask ? `, ${askingWords(comment.askPart)?.asking}` : ''; // see partAsks
  const id = withId ? ` [comment id: ${comment.id}]` : '';
  const about = comment.pin ? ` on ${comment.pin.quote} [pin id: ${comment.pin.id}${asking}]` : '';
  const via = comment.via ? ` (via /${comment.via})` : '';
  return `- ${who(comment.author)} at ${comment.createdAt}${id}${about}${via}${tag}: ${comment.body}`;
}

// A card's discussion in get_task and get_decision: each comment with its id
// and who it's for, the instructions a Tricot skill it asks for carries, and
// its reactions (core/reactions.ts).
function discussionLines(board: Board, comments: Comment[], viewer?: string): string[] {
  return comments.flatMap((c) => [commentLine(c, mentionTag(board, c, viewer), true), ...skillInstructionLines(c.skill, viewer), ...reactionsLine(c)]);
}

const isSettled = (decision: Decision) => decision.status === 'decided' || decision.status === 'provisional';

function ref(decision: Decision): string {
  return `#${decision.number} [id: ${decision.id}]`;
}

function decisionLine(decision: Decision): string {
  const parts = [`- ${ref(decision)} ${decision.question}`];
  if (decision.area) parts.push(`(area: ${decision.area})`);
  if (decision.blocking && decision.status === 'open') parts.push('(blocking)');
  const waiting = pendingAsks(decision).map((a) => a.name);
  if (waiting.length) parts.push(`(waiting for ${listNames(waiting)})`);

  if (decision.resolution) {
    const why = decision.resolution.rationale ? `: "${decision.resolution.rationale}"` : '';
    parts.push(`→ ${describeChoice(decision)} — by ${who(decision.resolution.by)}${why}`);
  } else if (decision.options.length > 0) {
    const options = decision.options
      .map((o) => `${o.id}) ${o.label}${decision.recommendation?.optionId === o.id ? ' ★' : ''}${o.outdated ? ' (outdated)' : ''}`)
      .join(', ');
    parts.push(`— options: ${options}`);
  }
  if (decision.exploreRequest?.text) parts.push(`— asked: "${decision.exploreRequest.text}"`);
  for (const ask of [refreshAsk(decision), planAsk(decision)]) if (ask) parts.push(ask);
  if (decision.deferral?.text) parts.push(`— note: "${decision.deferral.text}"`);

  const extras: string[] = [];
  if (decision.comments.length) extras.push(`${decision.comments.length} comments`);
  if (decision.findings.length) extras.push(`${decision.findings.length} findings`);
  if (decision.canvas.blocks.length) extras.push(`${decision.canvas.blocks.length} canvas blocks`);
  if (decision.criteria.length) {
    const cells = decision.criteria.length * decision.options.length;
    extras.push(`${decision.criteria.length} criteria, ${decision.marks.length}/${cells} marked`);
  }
  if (extras.length) parts.push(`· ${extras.join(', ')}`);
  return parts.join(' ');
}

// What a person asked agents to do on a card: check it still holds or refresh
// its options, or plan its tasks. It stays with the card however briefly the
// card is listed.
function refreshAsk(decision: Decision): string | undefined {
  if (!decision.refreshRequest) return undefined;
  const note = decision.refreshRequest.text ? `: "${decision.refreshRequest.text}"` : '';
  return isSettled(decision)
    ? `— ${decision.refreshRequest.by.name} asked agents to check it still holds${note} (re-check it, then update_decision with refreshed: true and a note)`
    : `— ${decision.refreshRequest.by.name} asked agents to refresh the options${note} (re-check it, then update_decision with refreshed: true)`;
}

function planAsk(decision: Decision): string | undefined {
  if (!decision.planRequest) return undefined;
  const note = decision.planRequest.text ? `: "${decision.planRequest.text}"` : '';
  return `— ${decision.planRequest.by.name} asked for a task plan${note} (use plan_tasks)`;
}

// A decided card in a line: its question and its answer. get_decision reads
// the rest (who decided it and why, its discussion and canvas).
function decidedLine(decision: Decision): string {
  const choice = describeChoice(decision);
  const parts = [`- ${ref(decision)} ${decision.question}${choice ? ` → ${choice}` : ''}`];
  for (const ask of [refreshAsk(decision), planAsk(decision)]) if (ask) parts.push(ask);
  return parts.join(' ');
}

// Archived boards come last, apart: they can be read for reference but not changed.
export function boardListDigest(boards: BoardSummary[]): string {
  if (boards.length === 0) return 'No boards yet. Create one with create_board.';
  const line = (b: BoardSummary) => {
    const goal = b.goal ? ` — ${b.goal}` : '';
    const blocking = b.blockingOpen ? `, ${b.blockingOpen} blocking` : '';
    return `- ${b.title} [id: ${b.id}]${goal} (open ${b.counts.open}${blocking}, exploring ${b.counts.exploring}, decided ${b.counts.decided + b.counts.provisional})`;
  };
  const active = boards.filter((b) => !b.archived);
  const archived = boards.filter((b) => b.archived);
  const lines = active.length ? active.map(line) : ['No active boards. Create one with create_board.'];
  if (archived.length) lines.push('', 'Archived (read-only):', ...archived.map(line));
  return lines.join('\n');
}

// The calm "may be out of date" line, for agents: the same rule people see on the card.
function driftLine(board: Board, decision: Decision, now?: number): string | undefined {
  const drift = driftOf(board, decision, now);
  if (!drift) return undefined;
  return `May be out of date: ${driftAge(drift).toLowerCase()}, and since then ${driftChanges(drift)}. Re-check it against the app as it is now: refresh the options with update_decision (refreshed: true), or suggest retiring it in a comment.`;
}

// The board's areas, so agents file new decisions under the names already in use.
function areasLine(board: Board): string | undefined {
  if (board.decisions.length === 0) return undefined;
  const areas = boardAreas(board);
  if (areas.length === 0) return 'Areas: none yet. Give each decision a short area (theme) with area on post_decision or update_decision.';
  const without = board.decisions.filter((d) => !d.area).length;
  const none = without ? `; ${without} decision${without === 1 ? ' has' : 's have'} none yet` : '';
  return `Areas: ${areas.map((a) => `${a.name} (${a.count})`).join(', ')}${none}. Reuse one when it fits.`;
}

// The board lists closed work in brief, so one with hundreds of closed cards
// stays cheap to read: each decided decision in a line, the latest done tasks,
// and how many were retired or dropped.
export const LATEST_DONE = 10;
const CLOSED = 'Closed cards are summarised here: search finds anything older, and get_task and get_decision read any card in full.';

function hasClosed(board: Board): boolean {
  return board.decisions.some((d) => d.status === 'decided' || d.status === 'retired') || board.tasks.some((t) => t.status === 'done' || t.status === 'dropped');
}

// `viewer` is the agent reading it: what's asked of it, and the tasks for it,
// say so. `now` is when, for first looks running out of time. `shown` is what
// the agent's session has read already, which it isn't told again (answering.ts).
export function boardDigest(board: Board, viewer?: string, now = Date.now(), shown?: Shown): string {
  const lead = viewer ? delegateLine(board, viewer) : undefined;
  const lines = [...(lead ? [lead, ''] : []), `# ${board.title} [id: ${board.id}]`];
  if (board.archived) {
    lines.push(`Archived by ${who(board.archived.by)} at ${board.archived.at}: read-only. Read it for reference; changes are refused.`);
  }
  if (board.goal) lines.push(`Goal: ${board.goal}`);
  lines.push(`Cursor: ${board.seq} (pass as "since" to get_updates / wait_for_updates)`);
  const people = peopleOn(board).map((p) => p.name);
  lines.push(people.length ? `People: ${people.join(', ')} (route questions to them with ask_people)` : 'People: nobody has acted here yet.');
  const areas = areasLine(board);
  if (areas) lines.push(areas);
  const shared = board.canvas.blocks.length;
  lines.push(
    shared
      ? `Board context: ${shared} block${shared === 1 ? '' : 's'} on the board's global context and current state. Read it with get_canvas(board_id) before planning, and update it when a decision settles or a task finishes.`
      : "Board context: empty. Put the board's global context and current state there (goal, constraints, architecture, what's done), and keep it current.",
  );
  // Requests to edit a doc or change a website are named on their own (partAsks), as work.
  const threads = threadsAwaitingReply(board).filter((pin) => !pinAsk(pin.discussion!.thread!)).length;
  if (threads) {
    const many = threads === 1 ? 'thread on the board context waits' : 'threads on the board context wait';
    lines.push(`${threads} comment ${many} for a reply: read them in get_canvas(board_id) and answer with comment(pin_id).`);
  }
  const asks = partAsks(board, viewer);
  if (asks) lines.push(asks);
  const mentioned = mentionsDigest(board, viewer, shown);
  if (mentioned) lines.push(mentioned);
  const sync = syncDigest(board);
  if (sync) lines.push(sync);
  const asked = requestsDigest(board, viewer);
  if (asked) lines.push(asked);
  const talk = threadsDigest(board, viewer, shown);
  if (talk) lines.push(talk);
  const looks = firstLooksDigest(board, viewer, now);
  if (looks) lines.push(looks);

  const refresh = refreshDigest(board);
  if (refresh) lines.push(refresh);
  const commits = commitsDigest(board, viewer);
  if (commits) lines.push(commits);
  const talks = threadsSection(board, viewer, now);
  if (talks) lines.push('', talks);

  // What's in play is listed in full; decided cards in brief, retired ones as a count.
  for (const { status, heading } of SECTIONS) {
    const decisions = board.decisions.filter((d) => d.status === status);
    if (decisions.length === 0) continue;
    const entries = decisions.flatMap((d) => {
      if (status === 'decided') return [decidedLine(d)];
      const drift = driftLine(board, d);
      return drift ? [decisionLine(d), `  ${drift}`] : [decisionLine(d)];
    });
    lines.push('', `## ${heading} (${decisions.length})`, ...entries);
  }
  const retired = board.decisions.filter((d) => d.status === 'retired').length;
  if (retired) {
    const one = retired === 1;
    lines.push('', `Retired: ${retired} decision${one ? '' : 's'} a person set aside as no longer relevant; don't build on ${one ? 'it' : 'them'}.`);
  }
  if (board.decisions.length === 0) lines.push('', 'No decisions yet.');
  if (board.tasks.length) lines.push('', tasksDigest(board, viewer));
  if (hasClosed(board)) lines.push('', CLOSED);
  return lines.join('\n');
}

export function decisionDetail(board: Board, decision: Decision, now?: number, viewer?: string): string {
  const lines = [
    `# ${ref(decision)} ${decision.question}`,
    `Status: ${decision.status}${decision.blocking ? ' (blocking)' : ''} · board ${board.id} · asked by ${who(decision.createdBy)}`,
  ];
  const from = fromThreadLine(board, decision.fromThread);
  if (from) lines.push(from);
  if (decision.area) {
    const whose = decision.areaPerson ? ` (set by ${decision.areaPerson.name}, so it's theirs: leave it)` : '';
    lines.push(`Area: ${decision.area}${whose}`);
  }
  if (decision.refreshRequest) {
    const r = decision.refreshRequest;
    lines.push(
      '',
      '## Refresh requested',
      `By ${who(r.by)} at ${r.at}${r.text ? `: "${r.text}"` : ''}`,
      isSettled(decision)
        ? `It is ${decision.status} (${describeChoice(decision)}) and stays so: check its answer still holds against the board and the app as they are now, then pass refreshed: true with a one-line note saying whether it does (update_decision), changing nothing else. If it no longer holds, say so in a comment, so a person can reopen it.`
        : `Re-check this card against the app as it is now, then in update_decision: reword the question or context, update or add options, mark options that no longer apply as outdated with a reason (revise_options), and pass refreshed: true with a one-line note. Nothing is deleted. Options people proposed or reworded are theirs: leave them and mention them in your note.`,
    );
  }
  const drift = driftLine(board, decision, now);
  if (drift) lines.push('', drift);
  if (decision.dependsOn.length) {
    const deps = decision.dependsOn
      .map((id) => board.decisions.find((d) => d.id === id))
      .filter((d): d is Decision => Boolean(d))
      .map((d) => `${ref(d)} (${d.status})`);
    lines.push(`Depends on: ${deps.join(', ')}`);
  }
  if (decision.context) lines.push('', '## Context', decision.context);
  lines.push(...pinnedFrom(board, { decisionId: decision.id }));
  lines.push(...couldAffectLines(couldAffect(board, decision)));

  if (decision.options.length) {
    lines.push('', '## Options');
    for (const option of decision.options) {
      const star = decision.recommendation?.optionId === option.id ? ' ★ recommended' : '';
      const person = optionPerson(option);
      const unanswered = decision.status === 'open' || decision.status === 'exploring';
      const whose = person && unanswered ? ` · ${person.name}'s option` : '';
      lines.push(`### ${option.id}) ${option.label}${star}${whose}`);
      if (option.outdated) {
        const why = option.outdated.reason ? `: "${option.outdated.reason}"` : '';
        lines.push(`OUTDATED (can't be picked), marked by ${who(option.outdated.by)} at ${option.outdated.at}${why}`);
      }
      if (option.description) lines.push(option.description);
      if (option.pros?.length) lines.push(`Pros: ${option.pros.join('; ')}`);
      if (option.cons?.length) lines.push(`Cons: ${option.cons.join('; ')}`);
    }
    if (decision.recommendation?.reason) lines.push('', `Recommendation reason: ${decision.recommendation.reason}`);
  }

  if (decision.resolution) {
    const r = decision.resolution;
    lines.push('', `## Resolution (${decision.status})`, `${describeChoice(decision)} — by ${who(r.by)} at ${r.at}`);
    if (r.rationale) lines.push(`Rationale: ${r.rationale}`);
  }
  if (decision.asks.length) {
    lines.push('', '## Asked');
    for (const ask of decision.asks) {
      const note = ask.note ? `: "${ask.note}"` : '';
      const state = ask.answeredAt ? `answered at ${ask.answeredAt}` : 'waiting';
      lines.push(`- ${ask.name}, by ${who(ask.by)} at ${ask.at}${note} (${state})`);
    }
  }
  if (decision.criteria.length) {
    lines.push('', '## Criteria (only people mark these; read the marks as their judgement)', criteriaTable(decision));
  }
  if (decision.refreshed) {
    const r = decision.refreshed;
    const asked = r.requestedBy ? `, asked by ${r.requestedBy.name}` : '';
    const changes = r.changes.length ? r.changes.join(', ') : 'no changes';
    lines.push('', '## Last refreshed', `By ${who(r.by)} at ${r.at}${asked}: ${changes}${r.note ? `. Note: ${r.note}` : ''}`);
  }
  if (decision.revisions?.length) {
    lines.push('', '## Earlier wording (what it said before it was changed)');
    for (const revision of decision.revisions) {
      const what = revision.optionId ? `${revision.optionId}) ${revision.field}` : revision.field;
      lines.push(`- ${what} was ${revision.before ? `"${clip(revision.before, 200)}"` : 'empty'}; changed by ${who(revision.by)} at ${revision.at}`);
    }
  }
  if (decision.history.length) {
    lines.push('', '## Earlier answers (no longer standing)');
    for (const past of decision.history) {
      const option = decision.options.find((o) => o.id === past.optionId);
      const choice = option ? `${option.id}) ${past.label ?? option.label}` : `"${clip(past.answer ?? '', 80)}"`;
      const why = past.rationale ? `: "${past.rationale}"` : '';
      lines.push(`- ${past.status} ${choice} by ${who(past.by)}${why}; ${ENDED[past.ended]} by ${who(past.endedBy)} at ${past.endedAt}`);
    }
  }
  if (decision.exploreRequest) {
    const e = decision.exploreRequest;
    lines.push('', '## Exploration requested', `By ${who(e.by)} at ${e.at}${e.text ? `: ${e.text}` : ''}`);
  }
  if (decision.planRequest) {
    const p = decision.planRequest;
    lines.push('', '## Task plan requested', `By ${who(p.by)} at ${p.at}${p.text ? `: ${p.text}` : ''}. Break it into tasks with plan_tasks.`);
  }
  if (decision.deferral) {
    const d = decision.deferral;
    lines.push('', '## Deferred', `By ${who(d.by)} at ${d.at}${d.text ? `: ${d.text}` : ''}`);
  }
  if (decision.retirement) {
    const r = decision.retirement;
    lines.push('', '## Retired as no longer relevant', `By ${who(r.by)} at ${r.at}${r.text ? `: ${r.text}` : ''}. Don't build on it; a person can bring it back.`);
  }

  if (decision.findings.length) {
    lines.push('', '## Findings');
    for (const f of decision.findings) {
      const outdated = decision.options.find((o) => o.id === f.optionId)?.outdated ? ', now outdated' : '';
      const target = f.optionId ? ` [option ${f.optionId}${outdated}]` : '';
      lines.push(`- ${who(f.author)}${target}: ${f.summary}`);
      if (f.metrics) lines.push(`  metrics: ${Object.entries(f.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      if (f.links) lines.push(`  links: ${f.links.join(', ')}`);
    }
  }
  if (decision.comments.length) {
    lines.push('', '## Comments');
    lines.push(...discussionLines(board, decision.comments, viewer));
  }
  const tasks = board.tasks.filter((t) => t.decisionIds.includes(decision.id));
  if (tasks.length) lines.push('', '## Tasks built on this', ...tasks.map((t) => taskLine(board, t, viewer)));
  if (decision.canvas.blocks.length) {
    const titles = readingOrder(decision.canvas.blocks).map(blockLabel).join(', ');
    lines.push('', '## Canvas', `${titles}. Read with get_canvas(decision_id).`);
  }
  return lines.join('\n');
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'backlog, not ready',
  todo: 'to do',
  in_progress: 'in progress',
  in_review: 'in review',
  blocked: 'blocked',
  done: 'done',
  dropped: "dropped, won't be done",
};

function taskLine(board: Board, task: Task, viewer?: string): string {
  const parts = [`- T${task.number} [id: ${task.id}] ${task.title} — ${TASK_STATUS_LABEL[task.status]}`];
  if (task.claimedBy && task.status !== 'todo') parts[0] += `, ${who(task.claimedBy)}`;
  const assigned = assigneeNote(task, viewer);
  if (assigned) parts.push(assigned);
  const refs = task.decisionIds.map((id) => `#${board.decisions.find((d) => d.id === id)?.number ?? '?'}`);
  parts.push(refs.length ? `implements ${refs.join(', ')}` : 'standalone (no decision, so no stale warnings)');
  if (task.links.length) parts.push(`links: ${task.links.join(', ')}`);
  const note = task.notes.at(-1);
  if (note) parts.push(`last note (${note.by.name}): "${clip(note.text, 120)}"`);
  const extras = [
    task.comments.length && `${task.comments.length} comments`,
    task.canvas.blocks.length && `${task.canvas.blocks.length} canvas blocks`,
  ].filter(Boolean);
  if (extras.length) parts.push(extras.join(', '));
  const look = firstLookNote(board, task, viewer);
  if (look) parts.push(look);
  if (task.commit) parts.push(commitNote(task));
  if (task.noCommit) parts.push(`nothing to commit: ${clip(task.noCommit.reason, 120)}`);
  if (task.dropped) parts.push(`dropped by ${task.dropped.by.name}${task.dropped.text ? `: "${clip(task.dropped.text, 120)}"` : ''}`);
  else if (task.stale) parts.push(`STALE: ${task.stale.reason}; re-check before continuing`);
  return parts.join(' · ');
}

// A commit a person approved with the work, as it stands.
function commitNote(task: Task): string {
  const { approvedBy, hash } = task.commit!;
  return hash ? `committed as ${hash.slice(0, 7)} (commit approved by ${approvedBy.name})` : `commit approved by ${approvedBy.name}, not reported yet`;
}

// What a person asking for a commit asks of the agent that built the work:
// its main session commits that task's work alone, not a subagent.
function commitAsk(task: Task, id = ''): string {
  return `${task.commit!.approvedBy.name} approved T${task.number}${id} and asked you to commit it. Commit that task's work alone, from your main session, then report the hash with update_task (commit); if there is nothing to commit, say why with update_task (nothing_to_commit).`;
}

// Done tasks a person approved with "Looks good, commit it", until the hash is
// reported. Named when an agent reads the board, catches up or waits; to the
// agent reading it (`viewer`), not those assigned to another agent.
export function commitsDigest(board: Board, viewer?: string): string | undefined {
  const asked = board.tasks.filter((t) => t.status === 'done' && t.commit && !t.commit.hash && (!viewer || forAgent(t, viewer)));
  if (asked.length === 0) return undefined;
  return asked.map((t) => commitAsk(t, ` [id: ${t.id}]`)).join('\n');
}

// One task in full, for get_task. `viewer` is the agent reading it.
export function taskDetail(board: Board, task: Task, viewer?: string, now = Date.now()): string {
  const lines = [`# T${task.number} [id: ${task.id}] ${task.title}`];
  const claimed = task.claimedBy && task.status !== 'todo' ? `, claimed by ${who(task.claimedBy)}` : '';
  const made = openedBy(task) ? 'opened in the backlog' : 'planned';
  lines.push(`Status: ${TASK_STATUS_LABEL[task.status]}${claimed} · board ${board.id} · ${made} by ${who(task.createdBy)}`);
  const from = fromThreadLine(board, task.fromThread);
  if (from) lines.push(from);
  const assigned = assigneeDetail(task, viewer);
  if (assigned) lines.push(assigned);
  const decisions = task.decisionIds
    .map((id) => board.decisions.find((d) => d.id === id))
    .filter((d): d is Decision => Boolean(d));
  lines.push(
    decisions.length
      ? `Implements: ${decisions.map((d) => `#${d.number} ${d.question} [id: ${d.id}] (${d.status})`).join('; ')}`
      : 'Standalone: implements no decision.',
  );
  if (task.status === 'backlog') {
    lines.push('', 'Not ready: a person is still shaping it. Comment and add to its canvas, but claim it only once they mark it ready.');
  }
  if (task.dropped) {
    const d = task.dropped;
    lines.push('', "## Dropped as work that won't be done", `By ${who(d.by)} at ${d.at}${d.text ? `: ${d.text}` : ''}. Don't work on it; a person can bring it back.`);
  }
  const look = firstLookDetail(board, task, viewer, now);
  if (look) lines.push(...(task.status === 'backlog' ? [look] : ['', look]));
  if (task.stale && !task.dropped) {
    const check = staleFromDeleted(board, task) ? 'Check it still makes sense without that decision' : 'Re-read the decision';
    lines.push('', `STALE: ${task.stale.reason}. ${check}, then confirm with still_valid or revise the task.`);
  }
  if (task.commit?.hash) lines.push('', `Committed as ${task.commit.hash}; ${task.commit.approvedBy.name} approved the commit.`);
  else if (task.commit) lines.push('', commitAsk(task));
  else if (task.noCommit) lines.push('', `Nothing to commit: ${task.noCommit.reason}.`);
  lines.push(...pinnedFrom(board, { taskId: task.id }));
  if (task.detail) lines.push('', '## Detail', task.detail);
  if (task.links.length) lines.push('', '## Links', ...task.links.map((l) => `- ${l}`));
  if (task.notes.length) {
    lines.push('', '## Progress notes', ...task.notes.map((n) => `- ${who(n.by)} at ${n.at}: ${n.text}`));
  }
  if (task.comments.length) {
    lines.push('', '## Discussion', ...discussionLines(board, task.comments, viewer));
  }
  if (task.canvas.blocks.length) {
    const titles = readingOrder(task.canvas.blocks).map(blockLabel).join(', ');
    lines.push('', '## Canvas', `${titles}. Read with get_canvas(task_id).`);
  }
  return lines.join('\n');
}

// The parts of blocks a task or decision is pinned to: where it came from, or
// where an agent connected it.
function pinnedFrom(board: Board, target: { taskId?: string; decisionId?: string }): string[] {
  const pins = pinsTo(board, target);
  if (pins.length === 0) return [];
  return [
    '',
    '## Pinned from',
    ...pins.map(({ pin, block, decision, task }) => {
      const lost = placePin(block, pin) ? '' : ` (${pinLost(pin)} since)`;
      return `- ${pinPart(pin, block)}${lost} in ${blockLabel(block)} (${canvasName({ decision, task })}) [block id: ${block.id}], pinned by ${who(pin.author)}`;
    }),
  ];
}

// Where a pinned box or diagram part is, for agents to find it: the box's
// fractions of the image, a spot's point on a 3D scene, the ids the Mermaid
// source gives a node or arrow.
export function pinWhere(pin: Pin): string {
  const { anchor } = pin;
  const at = (v: number) => String(Math.round(v * 1000) / 1000);
  if (anchor.kind === 'box') return ` (x ${at(anchor.x)}, y ${at(anchor.y)}, w ${at(anchor.w)}, h ${at(anchor.h)})`;
  if (anchor.kind === 'spot') {
    const short = (v: number) => String(Number(v.toPrecision(3)) + 0); // 3 significant figures; + 0 turns -0 into 0
    const at = `x ${short(anchor.x)}, y ${short(anchor.y)}, z ${short(anchor.z)}`;
    return anchor.name ? ` (at ${at} on the object${anchor.object ? `, uuid ${anchor.object}` : ''})` : ` (at ${at} in the scene)`;
  }
  if (anchor.kind === 'node') return ` (id ${anchor.nodeId})`;
  if (anchor.kind === 'arrow') {
    const which = anchor.n ? `, occurrence ${anchor.n + 1}` : ''; // as the pin tool counts them
    return ` (${anchor.from} --> ${anchor.to}${anchor.label ? `, text "${anchor.label}"` : ''}${which})`;
  }
  if (anchor.kind === 'line') return pin.quote ? ` ("${clip(pin.quote, 80)}")` : ' (a blank line)';
  return partWords(anchor.kind)?.where?.(pin) ?? '';
}

// The pins on a block, as get_canvas lists them under it. A board context
// pin people commented on lists its thread under it, until it's resolved.
export function pinLines(board: Board, canvas: Canvas, block: Block): string[] {
  const owner = canvasesOf(board).find((o) => o.canvas === canvas) ?? {};
  return canvas.pins
    .filter((pin) => pin.blockId === block.id)
    .map((pin) => {
      const lost = placePin(block, pin) ? '' : ` (${pinLost(pin)})`;
      const pinned = `pinned ${pinPart(pin, block)}${pinWhere(pin)}${lost}`;
      if (pin.discussion) {
        const comments = pinComments(pin, owner);
        const count = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;
        // A diff's or code block's line reads with what people said about it, wherever it was said.
        const said =
          pin.anchor.kind === 'line'
            ? `; answer on the line with comment(pin_id)${comments.map((c) => `\n    - ${who(c.author)} at ${c.createdAt}: ${c.body.replace(/\n/g, '\n      ')}`).join('')}`
            : '';
        // A person asking agents to edit a doc's paragraph, change a website's element or a code block's lines…: work, until an agent answers.
        const ask = pinAsk(comments);
        const words = ask ? partOf(block, pin.anchor.kind)?.ask : undefined;
        const request = words?.request ?? '';
        const act = words && waitsOnAgent(pin, comments) && !lost ? words.act : '';
        if (!pin.discussion.thread) return `${pinned} → ${request}${count} in the discussion, quoting it [pin id: ${pin.id}]${act && `; ${act}reply with comment(pin_id)`}${said}`;
        const { resolved } = pin.discussion;
        if (resolved) return `${pinned} → ${request}comment thread, resolved by ${who(resolved.by)}, ${count} [pin id: ${pin.id}]`;
        const thread = comments.map((c) => `\n    - ${who(c.author)} at ${c.createdAt}${c.ask ? ' (asking agents)' : ''}: ${c.body.replace(/\n/g, '\n      ')}`).join('');
        return `${pinned} → ${request}comment thread, open [pin id: ${pin.id}]; ${act}reply with comment(pin_id)${thread}`;
      }
      const target = pinTarget(board, pin);
      const to = target ? `${target.ref} (${target.status})` : 'work that is gone';
      const ids = pin.taskId ? `task id: ${pin.taskId}` : `decision id: ${pin.decisionId}`;
      return `${pinned} → ${to} [${ids}; pin id: ${pin.id}]`;
    });
}

// Whether a pin's comments wait on an agent: open, and a person's last.
export function waitsOnAgent(pin: Pin, comments: Comment[]): boolean {
  return !pin.discussion?.resolved && comments.at(-1)?.author.kind === 'human';
}

// Board context threads whose last word is a person's, for an agent to answer.
export function threadsAwaitingReply(board: Board): Pin[] {
  return board.canvas.pins.filter((pin) => {
    const thread = pin.discussion?.thread;
    return Boolean(thread?.length) && !pin.discussion!.resolved && thread!.at(-1)!.author.kind === 'human';
  });
}

// A person's open request to bring the board context up to date. Named when an
// agent reads the board, catches up or waits, until an agent finishes it. A
// sync of selected blocks lists them, so agents know exactly what to refresh.
export function syncDigest(board: Board): string | undefined {
  const request = board.syncRequest;
  if (!request) return undefined;
  const asked = `Sync requested by ${who(request.by)} at ${request.at}`;
  if (!request.blockIds) {
    return `${asked}: bring the board context up to date with the board (agent-made blocks only; blocks people made or edited are theirs, and changes to them are refused). Re-read the decisions, tasks and recent activity, update or add board-context blocks to match, then call finish_sync.`;
  }
  const blocks = syncedBlocks(board.canvas, request.blockIds);
  const list = blocks.map((b) => `${blockLabel(b)} [id: ${b.id}]`).join(', ') || 'none left (they were removed)';
  return `${asked}: bring the ${blocks.length === 1 ? 'block' : 'blocks'} ${request.by.name} selected in the board context up to date with the board: ${list}. Refresh exactly those, people's included; changes to other blocks, and new blocks, are refused until you finish. Re-read the decisions, tasks and recent activity, update those blocks to match, then call finish_sync.`;
}

// People's open requests to refresh a card's options. Named when an agent reads
// the board, catches up or waits, until an agent finishes each one. Those a
// person asked together after deciding a card, to check its answer leaves
// them standing, are named together, one line for each answer.
export function refreshDigest(board: Board): string | undefined {
  const asked = board.decisions.filter((d) => d.refreshRequest);
  if (asked.length === 0) return undefined;
  const together = new Map<string, { after: Decision; by: string; asked: Decision[] }>();
  const alone: Decision[] = [];
  for (const d of asked) {
    const { after: afterId, by } = d.refreshRequest!;
    const after = afterId ? board.decisions.find((other) => other.id === afterId) : undefined;
    if (!after) {
      alone.push(d);
      continue;
    }
    const key = `${after.id}\0${by.name.toLowerCase()}`;
    const group = together.get(key) ?? { after, by: by.name, asked: [] };
    group.asked.push(d);
    together.set(key, group);
  }
  const lines = [...together.values()].map(({ after, by, asked: them }) => {
    const one = them.length === 1;
    const answer = isSettled(after) ? ` (${describeChoice(after)})` : '';
    return `${by} asked you to check ${listNames(them.map(ref))} still ${one ? 'holds' : 'hold'}, after deciding ${ref(after)}${answer}, which may change ${one ? 'it' : 'them'}: re-check ${one ? 'it' : 'each'} against the board and the app as they are now (get_decision says how), then update_decision on ${one ? 'it' : 'each'} with refreshed: true and a note saying whether it holds.`;
  });
  if (alone.length) {
    const list = alone
      .map((d) => `${ref(d)} by ${d.refreshRequest!.by.name}${d.refreshRequest!.text ? ` ("${clip(d.refreshRequest!.text, 120)}")` : ''}`)
      .join('; ');
    lines.push(`Refresh requested on ${list}: re-check each against the app as it is now (get_decision says how), then update_decision with refreshed: true.`);
  }
  return lines.join('\n');
}

// The chief of staff's cue, leading get_board when tasks are ready for the
// agent reading it (to do, unclaimed, not stale, for it or for any agent):
// hand each to a subagent and stay on the board, or do them one by one.
const LEAD_TASKS = 5;
export function delegateLine(board: Board, viewer: string): string | undefined {
  if (board.archived) return undefined;
  const ready = laneTasks(board.tasks, 'todo').filter((t) => !t.claimedBy && !t.stale && forAgent(t, viewer));
  if (ready.length === 0) return undefined;
  // Its own first, as the ready hint lists them.
  const ordered = [...ready.filter((t) => t.assignee), ...ready.filter((t) => !t.assignee)];
  const shown = ordered.slice(0, LEAD_TASKS).map((t) => `T${t.number} [task id: ${t.id}]`);
  const rest = ordered.length - shown.length;
  const list = `${shown.join(', ')}${rest ? `, and ${rest} more under Tasks` : ''}`;
  return [
    `You're the chief of staff here: hand each ready task to a subagent (brief_task gives its brief) and stay on the board. Ready: ${list}.`,
    `Can't run subagents? Claim ${ready.length === 1 ? 'it and do it' : 'them and do them one by one'}, checking the board in between.`,
  ].join('\n');
}

// Tasks an agent could start now: to do, unclaimed and not stale. Named when an
// agent reads the board and whenever it waits, so ready work isn't left sitting.
// Those assigned to the agent reading it (`viewer`) come first; others'
// assigned tasks are named so it leaves them (assignee.ts).
export function readyWork(board: Board, viewer?: string): string | undefined {
  const ready = laneTasks(board.tasks, 'todo').filter((t) => !t.claimedBy && !t.stale);
  return readyLines(ready, viewer, (tasks) => tasks.map((t) => `T${t.number} [id: ${t.id}] ${clip(t.title, 80)}`).join('; '));
}

// Stale tasks first: they need re-checking before anything else moves. The
// backlog comes after to do: people are still shaping it, so it's not work yet.
// Done comes in brief, the latest first, and dropped ones as a count, apart:
// set aside, never work to pick up.
function tasksDigest(board: Board, viewer?: string): string {
  const order: TaskStatus[] = ['blocked', 'in_progress', 'in_review', 'todo', 'backlog'];
  const stale = board.tasks.filter((t) => t.stale && t.status !== 'dropped');
  const lines = [`## Tasks (${board.tasks.length})`];
  if (stale.length) lines.push(`Stale, re-check first (${stale.length}):`, ...stale.map((t) => taskLine(board, t, viewer)));
  const ready = readyWork(board, viewer);
  if (ready) lines.push(ready);
  for (const status of order) {
    const tasks = laneTasks(board.tasks, status).filter((t) => !t.stale);
    if (tasks.length) lines.push(`${TASK_STATUS_LABEL[status]} (${tasks.length}):`, ...tasks.map((t) => taskLine(board, t, viewer)));
  }
  lines.push(...doneLines(board));
  const dropped = board.tasks.filter((t) => t.status === 'dropped').length;
  if (dropped) {
    const one = dropped === 1;
    lines.push(`Dropped: ${dropped} task${one ? '' : 's'} a person set aside as work that won't be done; don't work on ${one ? 'it' : 'them'}.`);
  }
  return lines.join('\n');
}

// The latest done tasks, by when they were finished, each in a line with who
// did it; then how many came before them.
function doneLines(board: Board): string[] {
  const finished = (t: Task) => taskClosure(board, t)?.at ?? t.updatedAt;
  const done = board.tasks
    .filter((t) => t.status === 'done' && !t.stale)
    .sort((a, b) => finished(b).localeCompare(finished(a)) || b.number - a.number);
  if (done.length === 0) return [];
  const shown = done.slice(0, LATEST_DONE);
  const line = (t: Task) => `- T${t.number} [id: ${t.id}] ${clip(t.title, 80)}${t.claimedBy ? ` — by ${who(t.claimedBy)}` : ''}`;
  const rest = done.length - shown.length;
  return [
    rest ? `done (${done.length}), the latest ${shown.length}:` : `done (${done.length}):`,
    ...shown.map(line),
    ...(rest ? [`and ${rest} done before them.`] : []),
  ];
}

function criteriaTable(decision: Decision): string {
  const header = `| criterion | ${decision.options.map((o) => `${o.id}) ${cell(o.label)}${o.outdated ? ' (outdated)' : ''}`).join(' | ')} |`;
  const rule = `| --- | ${decision.options.map(() => '---').join(' | ')} |`;
  const rows = decision.criteria.map((criterion) => {
    const marks = decision.options.map((option) => {
      const mark = decision.marks.find((m) => m.criterionId === criterion.id && m.optionId === option.id);
      return mark ? `${mark.value} (${mark.by.name})` : '·';
    });
    const described = criterion.description ? ` — ${cell(criterion.description)}` : '';
    return `| ${cell(criterion.label)}${described} [${criterion.id}] | ${marks.join(' | ')} |`;
  });
  return [header, rule, ...rows].join('\n');
}

export function readingOrder<T extends { x: number; y: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
}

export function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// The content of a block as an agent should read it.
export function blockContentDigest(block: Block, full = false): string {
  return kindOf(block.type).digest(block, full);
}

// `sync` is the open sync request, on the board context: each block it may
// touch or must leave says so. Its pins follow its content.
function blockEntry(board: Board, canvas: Canvas, block: Block, decision: Decision | undefined, sync?: SyncRequest): string {
  const meta = [`[id: ${block.id}]`, `rev ${block.rev}`];
  const option = decision?.options.find((o) => o.id === block.optionId);
  if (option) meta.push(`pinned to ${option.id}) ${option.label}`);
  meta.push(`by ${who(block.author)}`);
  if (block.updatedBy.name !== block.author.name || block.updatedBy.kind !== block.author.kind) {
    meta.push(`last edited by ${who(block.updatedBy)}`);
  }
  const mark = sync && syncMark(block, sync);
  if (mark) meta.push(mark);
  const pins = pinLines(board, canvas, block).map((line) => `\n  ${line}`).join('');
  // A link is all label and address, so it fits on its line: link "Design file" → https://…
  if (kindOf(block.type).inline) return `- ${blockLabel(block)} ${blockContentDigest(block)} ${meta.join(' · ')}${pins}`;
  return `- ${blockLabel(block)} ${meta.join(' · ')}\n${indent(blockContentDigest(block))}${pins}`;
}

// During a sync of all, a person's block is theirs to leave; during a sync of
// selected blocks, each block is in it or not, whoever's it is.
function syncMark(block: Block, sync: SyncRequest): string | undefined {
  const person = blockPerson(block);
  if (!sync.blockIds) return person && `${person.name}'s block: leave it during this sync`;
  const mark = sync.blockIds.includes(block.id) ? 'in this sync' : 'leave it during this sync';
  return person ? `${person.name}'s block: ${mark}` : mark;
}

export function canvasDigest(board: Board, canvas: Canvas, decision?: Decision, task?: Task): string {
  const heading = task
    ? `# Canvas of T${task.number} ${task.title} [task id: ${task.id}]`
    : decision
      ? `# Canvas of #${decision.number} ${decision.question} [decision id: ${decision.id}]`
      : `# Board context: ${board.title} [board id: ${board.id}]`;
  const { blocks, groups, links } = canvas;
  const lines = [heading];
  if (blocks.length === 0 && groups.length === 0) {
    lines.push('Empty. Add context with add_block.');
    return lines.join('\n');
  }
  const pins = canvas.pins.length;
  const pinned = pins ? `, ${pins} pin${pins === 1 ? '' : 's'} (parts of blocks linked to tasks and decisions or commented on, listed under their block)` : '';
  lines.push(
    `${blocks.length} blocks, ${groups.length} groups, ${links.length} links${pinned}. Blocks are listed in reading order; people may have arranged, edited or ticked things since you last looked.`,
  );
  const sync = decision || task ? undefined : board.syncRequest;
  if (sync) lines.push(syncDigest(board)!);

  for (const group of readingOrder(groups)) {
    const members = readingOrder(blocks.filter((b) => b.groupId === group.id));
    const answers = decision || task ? '' : requestHeading(board, group.id);
    lines.push('', `## Group "${group.title}" [id: ${group.id}]${answers}`);
    lines.push(...(members.length ? members.map((b) => blockEntry(board, canvas, b, decision, sync)) : ['(empty)']));
  }
  const loose = readingOrder(blocks.filter((b) => !b.groupId));
  if (loose.length) {
    lines.push('', groups.length ? '## Not in a group' : '## Blocks', ...loose.map((b) => blockEntry(board, canvas, b, decision, sync)));
  }
  if (links.length) {
    lines.push('', '## Links');
    for (const link of links) {
      const from = blocks.find((b) => b.id === link.from);
      const to = blocks.find((b) => b.id === link.to);
      if (!from || !to) continue;
      const said = link.label ? `: "${clip(link.label, 80)}"` : '';
      lines.push(`- ${blockLabel(from)} → ${blockLabel(to)}${said} [id: ${link.id}] by ${who(link.author)}`);
    }
  }
  return lines.join('\n');
}

// A person's comment or thread message that reaches the agent reading its
// updates without asking an agent by name (mentionEventLine and
// threadEventLine say those): whole, with the call that answers it and what
// its session needs to (answering.ts). Not one for people (it @-mentions
// them), on another agent's task, or that an agent has answered since: those
// read as logged.
function personLine(e: BoardEvent, board: Board, viewer: string | undefined, shown: Shown | undefined, target: string): string | undefined {
  if (e.actor.kind !== 'human' || !viewer || (e.type !== 'comment_added' && !isThreadEvent(e))) return undefined;
  if (agentsIn(board, e.mentions).length || peopleIn(board, e.mentions).length) return undefined;
  const found = discussionAt(e, board);
  if (!found) return undefined;
  const { discussion, said } = found;
  if (said.paired) return undefined; // a pairing session's summary asks nothing
  if (discussion.items.slice(discussion.items.indexOf(said) + 1).some((m) => m.author.kind === 'agent')) return undefined;
  const task = e.taskId ? board.tasks.find((t) => t.id === e.taskId) : undefined;
  if (task && (!forAgent(task, viewer) || (task.claimedBy?.kind === 'agent' && task.status !== 'todo' && !samePerson(task.claimedBy.name, viewer)))) return undefined;
  const short = `: "${clip(said.body, 200)}"`; // as the event logged it
  if (!e.summary.includes(short)) return undefined;
  const summary = e.summary.replace(short, quote(said.body, said.id, shown));
  const reply = task ? `comment(task_id: ${task.id})` : e.decisionId ? `comment(decision_id: ${e.decisionId})` : isThreadEvent(e) ? undefined : `comment(pin_id: ${e.itemId})`;
  const line = `- (${e.seq}) ${who(e.actor)} ${summary}${target}${reply ? `. Reply with ${reply}.` : ''}`;
  return [line, ...answerContext(discussion, said, viewer, shown)].join('\n');
}

// `about` is the board and the agent reading it: a comment, request or
// thread message that @-mentions agents reads as asked of it, or as for them
// (mentionEventLine, threadEventLine), and a person's reaction to its comment
// as to "your comment" (reactionEventLine). A person's message for it comes
// whole, with what its session (`shown`) needs to answer it.
export function eventsDigest(events: BoardEvent[], cursor: number, about?: { board: Board; viewer?: string; shown?: Shown }, more = false): string {
  if (events.length === 0) return `No new activity. Cursor: ${cursor}`;
  const lines = events.map((e) => {
    const addressed =
      about &&
      (mentionEventLine(e, about.board, about.viewer, about.shown) ??
        threadEventLine(e, about.board, about.viewer, about.shown) ??
        reactionEventLine(e, about.board, about.viewer));
    if (addressed) return addressed;
    // A board context thread's comments are about its pin.
    const pin = e.type === 'comment_added' && !e.decisionId && !e.taskId && e.itemId;
    const thread = isThreadEvent(e) && e.itemId;
    const target = e.decisionId ? ` [id: ${e.decisionId}]` : pin ? ` [pin id: ${pin}]` : thread ? ` [thread id: ${thread}]` : '';
    return (about && personLine(e, about.board, about.viewer, about.shown, target)) || `- (${e.seq}) ${who(e.actor)} ${e.summary}${target}`;
  });
  // A person changing what a card offers may change what's best on it.
  const revised = [...new Set(events.filter((e) => e.type === 'decision_revised' && e.actor.kind === 'human').map((e) => e.decisionId!))];
  if (revised.length) {
    const ids = revised.map((id) => `[id: ${id}]`).join(', ');
    lines.push(`People changed what ${ids} offer${revised.length === 1 ? 's' : ''}: re-check your recommendation there (get_decision), and update it with update_decision if it no longer holds.`);
  }
  const next = more ? [`There are more updates after these: call get_updates with since: ${cursor} for the next page.`] : [];
  return [...lines, ...next, '', `Cursor: ${cursor}`].join('\n');
}
