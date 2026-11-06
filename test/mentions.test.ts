import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decisionNeedsYou, needsInput, taskNeedsYou } from '../src/core/attention';
import { boardDigest, eventsDigest, taskDetail } from '../src/core/digest';
import { pendingAsks } from '../src/core/format';
import {
  agentsIn,
  boardAgents,
  findMentions,
  mentionsDigest,
  resolveMentions,
  splitQuestion,
  waitingMention,
  withoutLeadingMentions,
} from '../src/core/mentions';
import { requestsDigest, requestTitle, takeRefusal } from '../src/core/requests';
import { Store } from '../src/core/store';
import type { Actor, Board } from '../src/core/types';
import { eventsOf } from './tables';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const sam: Actor = { kind: 'human', name: 'Sam' };

describe('Finding @-mentions', () => {
  const names = ['Claude', 'Codex', 'Claude Code', 'Wassim'];

  it('resolves names whatever their case, as the board spells them', () => {
    assert.deepEqual(resolveMentions('@codex can you review this? cc @WASSIM', names), ['Codex', 'Wassim']);
    assert.deepEqual(resolveMentions('@Codex and @codex again', names), ['Codex'], 'once each');
  });

  it('leaves unknown names, emails and mid-word @ as text', () => {
    assert.deepEqual(resolveMentions('@Bob can you look? mail me@codex.dev, or see @types/node', names), []);
    assert.deepEqual(resolveMentions('@Claudette is not @Claude_', names), [], 'a name ends a word');
    assert.deepEqual(resolveMentions('(@Claude) and "@Codex"', names), ['Claude', 'Codex'], 'punctuation around it is fine');
  });

  it('prefers the longest name, and says where each is', () => {
    assert.deepEqual(resolveMentions('@Claude Code please, then @Claude', names), ['Claude Code', 'Claude']);
    assert.deepEqual(findMentions('hi @codex.', names), [{ name: 'Codex', start: 3, end: 9 }]);
  });

  it('drops the mentions a text opens with', () => {
    assert.equal(withoutLeadingMentions('@Codex can you review the diff?', names), 'can you review the diff?');
    assert.equal(withoutLeadingMentions('@Codex, @Claude: both of you', names), 'both of you');
    assert.equal(withoutLeadingMentions('can you, @Codex?', names), 'can you, @Codex?');
    assert.equal(withoutLeadingMentions('@Codex', names), '@Codex', 'all mentions stays as it is');
    assert.equal(requestTitle('@Codex get me an architecture view of the project', ['Codex']), 'Architecture view');
  });

  it('splits a question from who it is for', () => {
    assert.deepEqual(splitQuestion('Should the export include closed cards? @Claude explore it', names), {
      question: 'Should the export include closed cards?',
      comment: '@Claude explore it',
    });
    assert.deepEqual(splitQuestion('Which font, Sam? - @wassim', names), { question: 'Which font, Sam?', comment: '@wassim' });
    assert.deepEqual(splitQuestion('  Which retry strategy?  ', names), { question: 'Which retry strategy?' }, 'no mention: all question');
    assert.deepEqual(splitQuestion('Ask @Bob, or mail me@codex.dev?', names), { question: 'Ask @Bob, or mail me@codex.dev?' });
  });

  it('takes the mentions out of a question that opens with one', () => {
    assert.deepEqual(splitQuestion('@Codex should we cache tokens?', names), {
      question: 'should we cache tokens?',
      comment: '@Codex should we cache tokens?',
    });
    assert.deepEqual(splitQuestion('@Claude Code, @Codex: retry or fail fast, @Wassim ?', names), {
      question: 'retry or fail fast?',
      comment: '@Claude Code, @Codex: retry or fail fast, @Wassim ?',
    });
    assert.deepEqual(splitQuestion('@Codex ', names), { question: '', comment: '@Codex' }, 'nothing left to ask');
  });

  it("knows a board's agents from presence and its events, once each", () => {
    const board = {
      activity: {
        actors: [{ actor: { kind: 'agent', name: 'codex' } }, { actor: wassim }, { actor: claude }], // most recent first
      },
    } as unknown as Board;
    assert.deepEqual(boardAgents(board), ['codex', 'Claude'], 'latest first');
    assert.deepEqual(boardAgents(board, ['Codex', 'Gemini']), ['Codex', 'Gemini', 'Claude'], 'presence spells them');
  });
});

describe('Mentions on a board', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-mentions-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Roadmap' }, wassim).id;
    store.createBoard({ title: 'Other' }, sam); // Sam acts elsewhere first
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const board = () => store.getBoard(boardId);
  const task = (title = 'Review the diff on oauth.ts') => store.planTasks(boardId, [{ title }], wassim, { ready: true })[0];

  it('keeps who a comment mentions, on the comment and its event', () => {
    const t = task();
    store.addTaskComment(t.id, '@codex can you review the diff on oauth.ts? (not @Bob)', wassim);
    const comment = board().tasks[0].comments[0];
    assert.deepEqual(comment.mentions, ['Codex']);
    assert.deepEqual(eventsOf(store, board()).at(-1)!.mentions, ['Codex']);
    assert.equal(eventsOf(store, board()).at(-1)!.at, comment.createdAt, 'they share a timestamp');
    store.addTaskComment(t.id, 'No one in particular', wassim);
    assert.equal(board().tasks[0].comments[1].mentions, undefined, 'none without a mention');
  });

  it('tells the mentioned agent it was asked, and the others whose it is', () => {
    const t = task();
    const cursor = board().seq;
    store.addTaskComment(t.id, '@Codex can you review the diff on oauth.ts?', wassim);
    const asked = `Wassim asked you on T1 [task id: ${t.id}]: "can you review the diff on oauth.ts?". Reply with comment(task_id: ${t.id}).`;
    assert.equal(mentionsDigest(board(), 'Codex'), asked);
    assert.equal(mentionsDigest(board(), 'codex'), asked, 'whatever the case of its name');
    assert.equal(mentionsDigest(board(), 'Claude'), undefined);

    const events = store.eventsSince(boardId, cursor);
    const forCodex = eventsDigest(events, board().seq, { board: board(), viewer: 'Codex' });
    assert.match(forCodex, new RegExp(`Wassim \\(human\\) asked you on T1 \\[task id: ${t.id}\\]: "can you review the diff on oauth\\.ts\\?"\\. Reply with comment\\(task_id: ${t.id}\\)\\.`));
    const forClaude = eventsDigest(events, board().seq, { board: board(), viewer: 'Claude' });
    assert.match(forClaude, new RegExp(`Wassim \\(human\\) asked Codex on T1 \\[task id: ${t.id}\\]\\. Not for you; carry on\\.`));
    assert.doesNotMatch(forClaude, /oauth\.ts\?"/, "others don't get the question");

    assert.match(boardDigest(board(), 'Codex'), /Wassim asked you on T1/);
    assert.doesNotMatch(boardDigest(board(), 'Claude'), /asked you/);
    assert.match(taskDetail(board(), board().tasks[0], 'Claude'), /Wassim \(human\) at [^ ]+ \[comment id: \w+\] \(for Codex: not for you\): @Codex can you/);
    assert.match(taskDetail(board(), board().tasks[0], 'Codex'), /\(asks you\): @Codex/);

    // Codex answering clears it.
    store.addTaskComment(t.id, 'Looking now.', codex);
    assert.equal(mentionsDigest(board(), 'Codex'), undefined);
  });

  it('reads an unmentioned comment as logged, and to an agent with the call that answers it', () => {
    const t = task();
    const cursor = board().seq;
    store.addTaskComment(t.id, 'Ship it when ready', wassim);
    const events = store.eventsSince(boardId, cursor);
    assert.match(eventsDigest(events, board().seq), /Wassim \(human\) commented on T1 "Review the diff on oauth\.ts": "Ship it when ready"\n/);
    assert.equal(
      eventsDigest(events, board().seq, { board: board(), viewer: 'Claude' }),
      eventsDigest(events, board().seq).replace('"Ship it when ready"', `"Ship it when ready". Reply with comment(task_id: ${t.id}).`),
    );
  });

  it('gives a request that mentions an agent to that agent alone', () => {
    const request = store.askAgents(boardId, '@Codex get me an architecture view of the project', wassim);
    assert.deepEqual(request.mentions, ['Codex']);
    assert.match(eventsOf(store, board()).at(-1)!.summary, /^asked Codex: "@Codex get me/);
    assert.match(requestsDigest(board(), 'Codex')!, /^Wassim asked you on the board context \[request id: \w+\]: "get me an architecture view of the project"\. Take it with take_request/);
    assert.match(requestsDigest(board(), 'Claude')!, /^Wassim asked Codex on the board context .*For Codex: only Codex can take it; not for you, carry on\.$/);
    const refusal = 'Wassim asked Codex for "Architecture view", so only Codex can take it. Take a request addressed to you or to no agent.';
    assert.equal(takeRefusal(board(), request, claude), refusal);
    assert.throws(() => store.takeRequest(request.id, claude), { message: refusal });
    const { group } = store.takeRequest(request.id, codex);
    assert.equal(group?.title, 'Architecture view');

    const anyone = store.askAgents(boardId, 'What is left to build?', wassim);
    assert.equal(anyone.mentions, undefined);
    assert.equal(takeRefusal(board(), anyone, claude), undefined);
  });

  it("makes a person's mention an ask on a decision, and news on a task until they have seen it", () => {
    store.addTaskComment(task('Warm up').id, 'Hi', sam); // Sam is one of the board's people now
    const decision = store.postDecision(boardId, { question: 'Which provider?', options: [{ label: 'A' }, { label: 'B' }] }, claude);
    store.addComment(decision.id, '@sam which one do you prefer?', wassim);
    const d = board().decisions[0];
    assert.deepEqual(pendingAsks(d).map((a) => [a.name, a.by.name, a.note]), [['Sam', 'Wassim', 'which one do you prefer?']]);
    assert.match(eventsOf(store, board()).at(-1)!.summary, /\(asking Sam\)$/);
    assert.equal(needsInput(eventsOf(store, board()).at(-1)!, board(), 'sam'), true);
    assert.equal(decisionNeedsYou(d, board(), 'Sam', []), true, 'held while the ask stands');
    store.addComment(decision.id, 'B.', sam);
    assert.equal(pendingAsks(board().decisions[0]).length, 0, 'their next comment answers it');

    const t = task('Pick a font');
    store.addTaskComment(t.id, 'Can you check this, @Sam?', claude);
    const comment = board().tasks.at(-1)!.comments[0];
    assert.deepEqual(comment.mentions, ['Sam']);
    const mention = eventsOf(store, board()).at(-1)!;
    assert.equal(needsInput(mention, board(), 'Sam'), true);
    assert.equal(taskNeedsYou(board().tasks.at(-1)!, board(), 'Sam', [mention]), true, 'news until they have seen it');
    assert.equal(taskNeedsYou(board().tasks.at(-1)!, board(), 'Sam', []), false, 'seen: it only told them');
    assert.equal(taskNeedsYou(board().tasks.at(-1)!, board(), 'Wassim', []), false);
    assert.equal(waitingMention(board().tasks.at(-1)!.comments, 'Sam'), comment, 'an agent still reads it as waiting on it');
    assert.deepEqual(agentsIn(board(), ['Sam', 'Codex']), ['Codex']);
  });

  it('routes a question asked with a mention through a comment on it', () => {
    const names = [...boardAgents(board(), ['Claude', 'Codex']), 'Sam'];
    const { question, comment } = splitQuestion('Should the export include closed cards? @Claude explore it', names);
    const decision = store.postDecision(boardId, { question }, wassim);
    store.addComment(decision.id, comment!, wassim);
    const d = board().decisions[0];
    assert.equal(d.question, 'Should the export include closed cards?');
    assert.deepEqual(d.comments[0].mentions, ['Claude']);
    assert.match(mentionsDigest(board(), 'Claude')!, /Wassim asked you on #1 \[decision id: [^\]]+\]: "explore it"/);
    assert.equal(mentionsDigest(board(), 'Codex'), undefined);
  });

  it("doesn't mention the writer, and a pin's prompt hands its task to the agent it names", () => {
    const t = task();
    store.addTaskComment(t.id, '@Wassim note to self', wassim);
    assert.equal(board().tasks[0].comments[0].mentions, undefined);

    const block = store.addBlock({ boardId }, { content: { type: 'note', text: 'The retry banner flickers' } }, wassim);
    const { task: pinned } = store.pinTask(block.id, { kind: 'text', quote: 'flickers', prefix: 'banner ', suffix: '' }, { text: '@codex stop the flicker', ready: true }, wassim);
    assert.equal(pinned.title, 'stop the flicker');
    assert.equal(pinned.assignee, 'Codex');
    assert.deepEqual(pinned.assignedBy, wassim);
  });

  it("asks an agent in a thread on the board context, until it replies there", () => {
    const block = store.addBlock({ boardId }, { content: { type: 'note', text: 'Tokens refresh on every call' } }, wassim);
    const cursor = board().seq;
    const { pin } = store.pinComment(block.id, { kind: 'text', quote: 'every call', prefix: 'refresh on ', suffix: '' }, '@Claude is this still true?', wassim);
    assert.equal(
      mentionsDigest(board(), 'Claude'),
      `Wassim asked you on the board context, about "every call" [pin id: ${pin.id}]: "is this still true?". Reply with comment(pin_id: ${pin.id}).`,
    );
    const events = store.eventsSince(boardId, cursor);
    assert.match(eventsDigest(events, board().seq, { board: board(), viewer: 'Codex' }), /asked Claude on the board context, about "every call" \[pin id: \w+\]\. Not for you; carry on\./);
    store.commentOnPin(pin.id, 'No, only on expiry now.', claude);
    assert.equal(mentionsDigest(board(), 'Claude'), undefined);
  });
});

describe('Task assignees', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-assignee-'));
    store = new Store(dir);
    store.load();
    store.presentAgents = () => ['Claude', 'Codex'];
    boardId = store.createBoard({ title: 'Roadmap' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  const board = () => store.getBoard(boardId);

  it('lets a person assign a task, and only the assignee claim it', () => {
    const [review, templates] = store.planTasks(boardId, [{ title: 'Review the diff on oauth.ts' }, { title: 'Board templates' }], wassim, { ready: true });
    store.updateTask(review.id, { assignee: 'codex' }, wassim);
    assert.equal(board().tasks[0].assignee, 'Codex');
    assert.equal(eventsOf(store, board()).at(-1)!.summary, 'assigned T1 to Codex');
    assert.throws(() => store.claimTask(review.id, claude), {
      message: 'T1 is assigned to Codex. Ask Wassim to reassign it, or take an unassigned task.',
    });
    assert.throws(() => store.updateTask(review.id, { status: 'in_progress' }, claude), /T1 is assigned to Codex/);
    store.claimTask(templates.id, claude);
    assert.equal(store.claimTask(review.id, codex).claimedBy?.name, 'Codex');
    store.updateTask(review.id, { assignee: null }, wassim);
    assert.equal(eventsOf(store, board()).at(-1)!.summary, 'unassigned T1 from Codex: any agent can take it');
    assert.equal(board().tasks[0].assignedBy, undefined);
  });

  it("keeps a person's assignee from agents, and checks the name", () => {
    const [t] = store.planTasks(boardId, [{ title: 'Review' }], wassim, { ready: true });
    store.updateTask(t.id, { assignee: 'Codex' }, wassim);
    assert.throws(() => store.updateTask(t.id, { assignee: 'Claude' }, claude), {
      message: "Wassim assigned T1 to Codex, so agents can't change it. Ask Wassim in a comment if it should go to another agent.",
    });
    assert.throws(() => store.updateTask(t.id, { assignee: 'Bob' }, wassim), /No agent "Bob" on this board\. Assign it to Claude and Codex/);
    assert.throws(() => store.updateTask(t.id, { assignee: 'Wassim' }, wassim), /Wassim is a person; tasks are assigned to agents/);

    // Agents may assign as they plan, and change what an agent set.
    const [mine] = store.planTasks(boardId, [{ title: 'Split the module', assignee: 'codex' }], claude);
    assert.deepEqual([mine.assignee, mine.assignedBy], ['Codex', claude]);
    assert.match(eventsOf(store, board()).at(-1)!.summary, /planned T2 "Split the module", assigned to Codex/);
    store.updateTask(mine.id, { assignee: 'Claude' }, codex);
    assert.equal(board().tasks[1].assignee, 'Claude');
  });

  it('says who each ready task is for, the assigned agent first', () => {
    const [review, templates] = store.planTasks(boardId, [{ title: 'Review the diff on oauth.ts' }, { title: 'Board templates' }], wassim, { ready: true });
    store.updateTask(review.id, { assignee: 'Codex' }, wassim);
    const forCodex = boardDigest(board(), 'Codex');
    assert.match(forCodex, new RegExp(`Ready in to do, assigned to you: T1 \\[id: ${review.id}\\] Review the diff on oauth\\.ts\\. Take it first: hand it to a subagent with the brief from brief_task \\(or claim it yourself\\)\\.\\nReady in to do: T2 \\[id: ${templates.id}\\] Board templates\\. Then this one, the same way\\.`));
    assert.ok(forCodex.startsWith(`You're the chief of staff here: hand each ready task to a subagent (brief_task gives its brief) and stay on the board. Ready: T1 [task id: ${review.id}], T2 [task id: ${templates.id}].\nCan't run subagents? Claim them and do them one by one, checking the board in between.\n\n# `), forCodex);
    assert.match(forCodex, /- T1 \[id: \w+\] Review the diff on oauth\.ts — to do · assigned to you by Wassim/);
    const forClaude = boardDigest(board(), 'Claude');
    assert.match(forClaude, new RegExp(`Ready in to do: T2 \\[id: ${templates.id}\\] Board templates\\. Before you wait, hand it to a subagent with the brief from brief_task \\(or claim it yourself\\)\\.\\n`), "Codex's task isn't named to Claude");
    assert.ok(forClaude.startsWith(`You're the chief of staff here: hand each ready task to a subagent (brief_task gives its brief) and stay on the board. Ready: T2 [task id: ${templates.id}].\nCan't run subagents? Claim it and do it, checking the board in between.\n\n# `), forClaude);
    assert.match(forClaude, /- T1 \[id: \w+\] Review the diff on oauth\.ts — to do · assigned to Codex by Wassim/);
    assert.match(taskDetail(board(), board().tasks[0], 'Claude'), /Assigned to Codex by Wassim: only Codex claims it\./);
    assert.match(taskDetail(board(), board().tasks[0], 'Codex'), /Assigned to you by Wassim: it's yours to claim\./);

    store.claimTask(templates.id, claude);
    assert.doesNotMatch(boardDigest(board(), 'Claude'), /Ready in to do/, "only Codex's task is ready, so Claude's ready line goes");
    assert.match(boardDigest(board(), 'Claude'), /^# /, "only Codex's task is ready, so nothing leads for Claude");
    assert.match(boardDigest(board()), /Ready in to do, but not for you: T1 is assigned to Codex\. Leave it to them\./, 'read by no agent in particular, it is named');
    assert.match(boardDigest(board(), 'Codex'), /^You're the chief of staff here: .+ Ready: T1 \[task id: \w+\]\./);
  });
});
