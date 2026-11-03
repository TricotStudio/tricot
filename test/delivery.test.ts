import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deliveryBusy, deliveryOf, deliveryTitle, deliveryWords, inWindow, leavesWithReply, meantFor, motionOf, newRepliesTo, stepText, type AgentNow, type DeliveryInput, type StepNow } from '../src/core/delivery';
import { pathParts, shortDuration } from '../src/core/format';
import type { Actor, Board, Comment, Decision, Reaction, Task, Thread } from '../src/core/types';
import type { AgentStep } from '../src/web/api';
import { newestMine, onItsWay, settledKeys, withOutgoing, type Outgoing } from '../src/web/outbox';
import { GONE_MS, LIVE_MS, busyOfPhase, latestSteps, phaseOf, rowStep } from '../src/web/steps';

// What becomes of a person's message to agents, as the line under it says it
// (core/delivery.ts), read from presence, reactions, steps and replies.

const NOW = Date.parse('2026-11-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const sam: Actor = { kind: 'human', name: 'Sam' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };

const task = (fields: Partial<Task> = {}): Task => ({ id: 't1', number: 5, status: 'todo', comments: [], ...fields }) as unknown as Task;
const other = task({ id: 't2', number: 6 });
const decision = { id: 'd1', number: 3, comments: [] } as unknown as Decision;
const thread = (fields: Partial<Thread> = {}): Thread => ({ id: 'th1', title: 'Ship it?', messages: [], ...fields }) as unknown as Thread;
const board = {
  activity: { actors: [{ actor: sam, at: ago(60_000) }, { actor: claude, at: ago(10 * 60_000) }, { actor: codex, at: ago(3 * 60 * 60_000) }], done: {}, reviewSentAt: {} },
  tasks: [task(), other],
  decisions: [decision],
} as unknown as Board;

const said = (fields: { mentions?: string[]; reactions?: Reaction[]; at?: string } = {}) => ({ id: 'c1', author: sam, at: fields.at ?? ago(12_000), ...fields });
const eyes = (by: Actor): Reaction => ({ emoji: '👀', by, at: ago(5_000) });
const listening = (name: string, fields: Partial<AgentNow> = {}): AgentNow => ({ name, state: 'listening', lastSeen: ago(1_000), ...fields });
const step = (fields: Partial<StepNow> = {}): StepNow => ({ agent: 'Claude', text: 'Running npm test', at: ago(3_000), card: { kind: 'task', id: 't1' }, ...fields });

function line(input: Partial<DeliveryInput> & Pick<DeliveryInput, 'said'>): string | undefined {
  const delivery = deliveryOf({ board, where: { task: task() }, after: [], agents: [], steps: [], ...input });
  return delivery && deliveryWords(delivery, NOW);
}

describe('who a message is for', () => {
  it('reads it as agents do: the agents it names, else the thread\'s or the task\'s agent, else any; nothing for people', () => {
    assert.deepEqual(meantFor(board, { task: task() }, { mentions: ['Claude'] }), ['Claude']);
    assert.equal(meantFor(board, { task: task() }, { mentions: ['Sam'] }), undefined, 'for a person only');
    assert.deepEqual(meantFor(board, { task: task({ status: 'in_progress', claimedBy: codex }) }, {}), ['Codex'], 'the agent working on it');
    assert.deepEqual(meantFor(board, { task: task({ status: 'todo', claimedBy: codex, assignee: 'Claude' }) }, {}), ['Claude'], 'its assignee');
    assert.deepEqual(meantFor(board, { task: task({ status: 'in_progress', claimedBy: codex, assignee: 'Claude' }) }, {}), ['Claude'], 'its assignee, reassigned from the agent that had it');
    assert.deepEqual(meantFor(board, { task: task({ assignee: 'Claude' }) }, { mentions: ['Codex'] }), ['Codex'], 'on an assigned task, the agent it names');
    assert.deepEqual(meantFor(board, { thread: thread({ lens: { name: 'Legal', agent: 'Codex' } }) }, {}), ['Codex'], 'a routed lens');
    assert.deepEqual(meantFor(board, { decision }, {}), [], 'any agent');
  });
});

describe('the line under a message on a task assigned to one agent', () => {
  const assigned = { task: task({ assignee: 'Claude' }) };
  const both = [listening('Claude'), listening('Codex')];

  it('follows its assignee alone, though another agent is listening too', () => {
    assert.equal(line({ where: assigned, said: said(), agents: both }), 'Delivered · Claude is listening');
    assert.equal(line({ where: assigned, said: said({ reactions: [eyes(claude)] }), agents: both }), 'Seen by Claude');
    assert.equal(line({ where: assigned, said: said({ reactions: [eyes(codex)] }), agents: both }), 'Delivered · Claude is listening', "another agent's 👀 isn't seen");
    assert.equal(line({ where: assigned, said: said(), agents: [listening('Claude'), listening('Codex', { state: 'working', focus: { kind: 'task', id: 't1' } })] }), 'Delivered · Claude is listening', "nor another agent's look");
    assert.equal(line({ where: assigned, said: said(), after: [{ author: codex }], agents: both }), 'Delivered · Claude is listening', "nor another agent's reply");
    assert.equal(line({ where: assigned, said: said(), after: [{ author: claude }], agents: both }), undefined, "the assignee's reply");
  });

  it('follows the agent a message there names', () => {
    assert.equal(line({ where: assigned, said: said({ mentions: ['Codex'], reactions: [eyes(codex)] }), agents: both }), 'Seen by Codex');
  });

  it('follows a new assignee once it changes', () => {
    assert.equal(line({ where: { task: task({ assignee: 'Codex', status: 'in_progress', claimedBy: claude }) }, said: said({ reactions: [eyes(claude)] }), agents: both }), 'Delivered · Codex is listening');
  });
});

describe('the line under a message to an agent', () => {
  const asked = said({ mentions: ['Claude'] });

  it('waits for an agent that is not listening, saying when it was last seen', () => {
    assert.equal(line({ said: asked }), 'Waiting for Claude · last seen 10 min ago', 'by what it last did on the board');
    assert.equal(line({ said: asked, agents: [listening('Claude', { state: 'away', lastSeen: ago(4 * 60_000) })] }), 'Waiting for Claude · last seen 4 min ago');
    assert.equal(line({ said: said({ mentions: ['Pi'] }), board: { ...board, activity: { ...board.activity, actors: [...board.activity.actors, { actor: { kind: 'agent', name: 'Pi' }, at: ago(26 * 60 * 60_000) }] } } }), 'Waiting for Pi · last seen 1 d ago');
  });

  it('is delivered to an agent listening, or busy on another card', () => {
    assert.equal(line({ said: asked, agents: [listening('Claude')] }), 'Delivered · Claude is listening');
    assert.equal(line({ said: asked, agents: [listening('Claude', { state: 'working', focus: { kind: 'task', id: 't2' } })] }), 'Delivered · Claude is on T6');
    assert.equal(line({ said: asked, agents: [listening('Claude', { state: 'working' })] }), 'Delivered · Claude is working');
  });

  it('is seen once the agent leaves its 👀', () => {
    assert.equal(line({ said: said({ mentions: ['Claude'], reactions: [eyes(claude)] }), agents: [listening('Claude')] }), 'Seen by Claude');
    const busy = [listening('Claude', { state: 'working', focus: { kind: 'task', id: 't2' } })];
    assert.equal(line({ said: said({ mentions: ['Claude'], reactions: [eyes(claude)] }), agents: busy }), 'Seen by Claude · now on T6');
    assert.equal(line({ said: said({ mentions: ['Claude'], reactions: [eyes(codex)] }), agents: [listening('Claude')] }), 'Delivered · Claude is listening', "another agent's 👀 isn't Claude's");
  });

  it('shows the agent working on it: its latest step here since the message, else its focus on this card', () => {
    const seen = said({ mentions: ['Claude'], reactions: [eyes(claude)] });
    assert.equal(line({ said: seen, steps: [step()] }), 'Claude · Running npm test');
    assert.equal(line({ said: seen, steps: [step({ text: 'Ran npm test', ended: true, ms: 42_000 })] }), 'Claude · Ran npm test (42 s)');
    assert.equal(line({ said: seen, steps: [step({ at: ago(60_000) })] }), 'Seen by Claude', 'a step from before the message is not about it');
    assert.equal(line({ said: seen, steps: [step({ card: { kind: 'task', id: 't2' } })] }), 'Seen by Claude', 'nor one on another card');
    assert.equal(line({ said: seen, steps: [step({ text: 'Finished its turn', done: true })] }), 'Seen by Claude', 'nor the end of its turn');
    assert.equal(line({ said: seen, steps: [step({ agent: 'Codex' })] }), 'Seen by Claude', "nor another agent's");
    assert.equal(line({ said: seen, agents: [listening('Claude', { state: 'working', focus: { kind: 'task', id: 't1' } })] }), 'Claude is taking a look');
    const stale = [listening('Claude', { state: 'working', focus: { kind: 'task', id: 't1' }, lastSeen: ago(30_000) })];
    assert.equal(line({ said: seen, agents: stale }), 'Seen by Claude', 'on the card since before the message');
  });

  it('says listening, not taking a look, once the agent that called about the card waits for updates', () => {
    // Its step about the call ended as the call landed (server/steps.ts): presence speaks.
    const back = [listening('Claude', { focus: { kind: 'task', id: 't1' } })];
    assert.equal(line({ said: said({ mentions: ['Claude'] }), agents: back }), 'Delivered · Claude is listening');
    assert.equal(line({ said: said({ mentions: ['Claude'], reactions: [eyes(claude)] }), agents: back }), 'Seen by Claude');
  });

  it('gives way to the reply: a comment from the agent after it, or its 👍 or 👎', () => {
    assert.equal(line({ said: asked, after: [{ author: claude }], steps: [step()] }), undefined);
    assert.equal(line({ said: said({ mentions: ['Claude'], reactions: [{ emoji: '👍', by: claude, at: ago(1_000) }] }) }), undefined);
    assert.equal(line({ said: asked, after: [{ author: codex }], agents: [listening('Claude')] }), 'Delivered · Claude is listening', "Codex's reply doesn't answer what Claude was asked");
    const both = said({ mentions: ['Claude', 'Codex'] });
    assert.equal(line({ said: both, after: [{ author: claude }], agents: [listening('Codex')] }), 'Delivered · Codex is listening', 'still waits on the other');
  });

  it('says nothing under a message only for people', () => {
    assert.equal(line({ said: said({ mentions: ['Sam'] }), agents: [listening('Claude')] }), undefined);
  });
});

describe('the line under a message to any agent', () => {
  const where = { decision };

  it('says no agent is listening when none is on the board, and who was last seen when one has gone quiet', () => {
    assert.equal(line({ where, said: said() }), 'No agent is listening on this board');
    assert.equal(line({ where, said: said(), agents: [listening('Claude', { state: 'away', lastSeen: ago(4 * 60_000) })] }), 'Waiting for an agent · Claude was last seen 4 min ago');
  });

  it('names every agent listening, then the furthest along', () => {
    assert.equal(line({ where, said: said(), agents: [listening('Claude'), listening('Codex')] }), 'Delivered · Claude and Codex are listening');
    assert.equal(line({ where, said: said({ reactions: [eyes(codex)] }), agents: [listening('Claude'), listening('Codex')] }), 'Seen by Codex');
    const working = step({ agent: 'Claude', card: { kind: 'decision', id: 'd1' } });
    assert.equal(line({ where, said: said({ reactions: [eyes(codex)] }), agents: [listening('Claude'), listening('Codex')], steps: [working] }), 'Claude · Running npm test');
  });

  it('gives way to any agent\'s reply', () => {
    assert.equal(line({ where, said: said(), after: [{ author: codex }], agents: [listening('Claude')] }), undefined);
    assert.equal(line({ where, said: said(), after: [{ author: sam }], agents: [listening('Claude')] }), 'Delivered · Claude is listening', "a person's doesn't");
  });
});

describe('the line in a thread', () => {
  it("takes the agent's steps on that thread, not on a card", () => {
    const where = { thread: thread() };
    const seen = said({ reactions: [eyes(claude)] });
    assert.equal(line({ where, said: seen, steps: [step({ card: undefined, thread: 'th1', text: 'Reading the thread' })] }), 'Claude · Reading the thread');
    assert.equal(line({ where, said: seen, steps: [step()] }), 'Seen by Claude', "a step on a card isn't the thread's");
    assert.equal(line({ where, said: seen, steps: [step({ card: undefined, thread: 'th2' })] }), 'Seen by Claude', "nor one on another thread");
  });
});

describe('the "working on it" sign on the line', () => {
  const asked = said({ mentions: ['Claude'] });
  // Live as the page judges a step: by its phase now (web/steps.tsx).
  function busy(input: Partial<DeliveryInput> & Pick<DeliveryInput, 'said'>) {
    const delivery = deliveryOf({ board, where: { task: task() }, after: [], agents: [], steps: [], ...input });
    return delivery && deliveryBusy(delivery, (s) => phaseOf(s, NOW) === 'live');
  }

  // Seen 5 s ago (eyes), by an agent whose wait began before the message
  // came: presence hasn't been told anything since, as just after a wait
  // hands an agent the message.
  const seen = said({ mentions: ['Claude'], reactions: [eyes(claude)] });
  const justWoken = listening('Claude', { lastSeen: ago(20_000) });

  it('is not there while the message is only delivered: words only', () => {
    assert.equal(busy({ said: asked, agents: [listening('Claude')] }), undefined, 'listening');
    assert.equal(busy({ said: asked, agents: [listening('Claude', { state: 'working', focus: { kind: 'task', id: 't2' } })] }), undefined, 'busy on another card');
  });

  it('casts on as the agent sees it, while it takes it in before its first step', () => {
    assert.equal(busy({ said: seen, agents: [justWoken] }), 'casting');
    assert.equal(busy({ said: seen, agents: [listening('Claude', { lastSeen: ago(4_000) })] }), 'casting', 'presence told within a moment of its 👀: still the same wait');
    assert.equal(busy({ said: seen, agents: [listening('Claude', { state: 'working' })] }), 'casting', 'thinking past the grace after its wait');
    const elsewhere = [listening('Claude', { focus: { kind: 'task', id: 't2' } })];
    assert.equal(busy({ said: seen, agents: elsewhere }), 'casting', 'reading another card since: maybe for this, so not set down');
    assert.equal(busy({ said: seen, agents: [justWoken], steps: [step({ agent: 'Claude', done: true, role: 'Explore' })] }), 'casting', "a subagent's end is not its turn's");
    assert.equal(busy({ said: seen }), 'casting', 'no presence yet: its 👀 is news enough');
  });

  it('moves while the agent works on it: a live step here, or its calls about this card', () => {
    assert.equal(busy({ said: asked, steps: [step()] }), 'working');
    assert.equal(busy({ said: seen, agents: [justWoken], steps: [step()] }), 'working', 'seen, then its first step');
    const running = { ...step({ at: ago(5 * 60_000) }), running: true };
    assert.equal(busy({ said: said({ mentions: ['Claude'], at: ago(6 * 60_000) }), steps: [running] }), 'working', 'a test run stays live until it ends');
    assert.equal(busy({ said: asked, agents: [listening('Claude', { state: 'working', focus: { kind: 'task', id: 't1' } })] }), 'working', 'taking a look, no step');
  });

  it('rests once the agent sets it down without replying: back to listening, or its turn over', () => {
    assert.equal(busy({ said: seen, agents: [listening('Claude')] }), 'resting', 'presence says listening, told after its 👀: a new wait');
    assert.equal(busy({ said: seen, agents: [justWoken], steps: [step({ text: 'Finished its turn', done: true, card: undefined })] }), 'resting', 'its turn ended after its 👀');
    assert.equal(busy({ said: seen, agents: [justWoken], steps: [step({ done: true, at: ago(30_000) })] }), 'casting', 'a turn that ended before it saw it');
    const back = deliveryOf({ board, where: { task: task() }, said: seen, after: [], agents: [listening('Claude')], steps: [] });
    assert.equal(back && deliveryWords(back, NOW), 'Seen by Claude', 'the words stay');
  });

  it('rests once the agent goes quiet on it: its step here no longer live, or none since its 👀 for as long', () => {
    const earlier = said({ mentions: ['Claude'], at: ago(LIVE_MS + 10_000) });
    assert.equal(busy({ said: earlier, steps: [step({ at: ago(LIVE_MS + 1_000) })] }), 'resting', 'still its step on the line, but quiet for a while');
    const long = said({ mentions: ['Claude'], at: ago(LIVE_MS + 10_000), reactions: [{ emoji: '👀', by: claude, at: ago(LIVE_MS + 1_000) }] });
    assert.equal(busy({ said: long, agents: [listening('Claude', { lastSeen: ago(LIVE_MS + 20_000) })] }), 'resting', 'seen, then nothing for as long as a step stays live');
  });

  it('is not there while the message waits for an agent, or once it is answered', () => {
    assert.equal(busy({ said: asked }), undefined, 'waiting for Claude');
    assert.equal(busy({ said: said(), where: { decision } }), undefined, 'no agent on the board');
    assert.equal(busy({ said: asked, after: [{ author: claude }], steps: [step()] }), undefined, 'replied: the line is gone');
  });

  it('makes its exit as the reply lands, if it was there', () => {
    const replied = deliveryOf({ board, where: { task: task() }, said: asked, after: [{ author: claude }], agents: [], steps: [] });
    const waiting = deliveryOf({ board, where: { task: task() }, said: asked, after: [], agents: [], steps: [] });
    assert.equal(leavesWithReply('working', replied), true);
    assert.equal(leavesWithReply('casting', replied), true, 'seen, then answered before a step');
    assert.equal(leavesWithReply('resting', replied), true, 'set down, then answered');
    assert.equal(leavesWithReply(undefined, replied), false, 'only delivered: the line had no sign, and just goes');
    assert.equal(leavesWithReply('working', waiting), false, 'not answered');
    assert.equal(leavesWithReply('working', undefined), false, 'the line gone for another reason: its hour is up');
  });

  it('moves on a card and a project row while their step is live, and rests once it dims', () => {
    assert.deepEqual([busyOfPhase('live'), busyOfPhase('dim')], ['working', 'resting']);
  });

  it('casts on only as it starts to move, and keeps that motion through a first step', () => {
    assert.equal(motionOf('casting', undefined), 'cast', 'seen: it starts with the cast-on');
    assert.equal(motionOf('working', 'cast'), 'cast', 'the first step: the same animations, nothing restarts');
    assert.equal(motionOf('working', undefined), 'knit', 'a step already under way when it shows: straight into the knit');
    assert.equal(motionOf('casting', 'knit'), 'knit', 'knitting already: it knits on');
    assert.deepEqual([motionOf('resting', 'cast'), motionOf(undefined, 'knit')], [undefined, undefined], 'still, or gone');
    assert.equal(motionOf('casting', motionOf('resting', 'cast')), 'cast', 'set down, then picked up again: a new cast-on');
  });
});

describe('the parts of the line', () => {
  it('puts how long ago it was asked in the tooltip, not the line, for an hour', () => {
    assert.equal(deliveryTitle('Seen by Claude', said({ at: ago(42_400) }), NOW), 'Seen by Claude\nAsked 42 s ago');
    assert.equal(deliveryTitle('Claude · Running npm test', said({ at: ago(95_000) }), NOW), 'Claude · Running npm test\nAsked 1 min 35 s ago');
    assert.equal(deliveryTitle('Seen by Claude', said({ at: ago(-1_500) }), NOW), 'Seen by Claude\nAsked 0 s ago', "the server's clock a little ahead");
    assert.equal(inWindow(said({ at: ago(59 * 60_000) }), NOW), true);
    assert.equal(inWindow(said({ at: ago(61 * 60_000) }), NOW), false);
  });

  it('says a step as its line does', () => {
    assert.equal(stepText({ text: 'Ran npm test', ended: true, ms: 400 }), 'Ran npm test', 'too quick to time');
    assert.equal(stepText({ text: 'Ran npm test', ended: true, ms: 3 * 60_000 + 5_000 }), 'Ran npm test (3 min 5 s)');
    assert.equal(stepText({ text: "I'll run the tests now.", narration: true }), '“I\'ll run the tests now.”');
  });

  it('says how long things took', () => {
    assert.deepEqual([0, 999, 42_000, 60_000, 90_000, 14 * 60_000 + 30_000, 65 * 60_000, 2 * 60 * 60_000].map(shortDuration), ['0 s', '0 s', '42 s', '1 min', '1 min 30 s', '14 min', '1 h 5 min', '2 h']);
  });
});

describe('long paths on a narrow line', () => {
  it('splits a line around its first path, for the folders to give way before the file name, and the name before its end', () => {
    assert.deepEqual(pathParts('Reading src/web/canvas/ReceiptSummaryPanel.tsx'), { lead: 'Reading ', dirs: 'src/web/canvas/', head: 'ReceiptSummary', tail: 'Panel.tsx', after: '' });
    assert.deepEqual(pathParts('Claude · Editing src/a.ts, lib/b.ts and 2 more on T5'), { lead: 'Claude · Editing ', dirs: 'src/', head: '', tail: 'a.ts', after: ', lib/b.ts and 2 more on T5' });
    assert.deepEqual(pathParts('Reading docs.example.com/hooks'), { lead: 'Reading ', dirs: 'docs.example.com/', head: '', tail: 'hooks', after: '' });
    assert.deepEqual(pathParts('Editing lib/csvExport.test.ts on T1'), { lead: 'Editing ', dirs: 'lib/', head: 'csvExport', tail: '.test.ts', after: ' on T1' });
    assert.equal(pathParts('Running npm test'), undefined);
    assert.equal(pathParts('Seen by Claude · now on T6'), undefined);
  });
});

describe("a project's row on the home page", () => {
  const at = (ms: number, fields: Partial<AgentStep>): AgentStep => ({ agent: 'Claude', text: 'Reading a.ts', at: ago(ms), ...fields });

  it("shows the busiest agent's latest step while it shows, else the latest of any", () => {
    const steps = [at(30_000, { text: 'Reading a.ts' }), at(5_000, { text: 'Running npm test' }), at(2_000, { agent: 'Codex', text: 'Editing b.ts' })];
    assert.equal(rowStep(['Claude', 'Codex'], steps, NOW)?.text, 'Running npm test', 'the busiest first');
    assert.equal(rowStep(['codex', 'Claude'], steps, NOW)?.text, 'Editing b.ts');
    assert.equal(rowStep([], steps, NOW)?.text, 'Editing b.ts', 'no agent on it by presence yet: the latest');
    assert.equal(rowStep(['Claude'], [at(GONE_MS + 1_000, {})], NOW), undefined, 'gone, as on a card');
    assert.equal(rowStep(['Claude'], [at(LIVE_MS + 1_000, { running: true })], NOW)?.running, true, 'a step still running stays');
    assert.deepEqual([...latestSteps(steps, NOW).values()].map((s) => s.text), ['Running npm test', 'Editing b.ts']);
  });

  it('keeps a running step live until its end comes, for up to ten minutes', () => {
    const running = (ms: number) => phaseOf(at(ms, { running: true }), NOW);
    assert.deepEqual([running(LIVE_MS + 1_000), running(9 * 60_000), running(11 * 60_000), running(13 * 60_000)], ['live', 'live', 'dim', undefined]);
    assert.deepEqual([phaseOf(at(LIVE_MS + 1_000, {}), NOW), phaseOf(at(LIVE_MS + 1_000, { ended: true, ms: 42_000 }), NOW)], ['dim', 'dim'], 'an ended one dims as any step does');
  });
});

describe('replies counted on a hidden tab', () => {
  const comment = (id: string, author: Actor): Comment => ({ id, author, body: id, createdAt: ago(0) });
  const withComments = (comments: Comment[], messages: Comment[] = []) =>
    ({ ...board, tasks: [task({ comments })], decisions: [], threads: [thread({ messages: messages.map((m) => ({ ...m, at: m.createdAt })) })] }) as unknown as Board;

  it("counts agents' new comments and thread messages after this person's message", () => {
    const before = withComments([comment('c1', sam)], [comment('m1', sam)]);
    const after = withComments([comment('c1', sam), comment('c2', claude)], [comment('m1', sam), comment('m2', codex)]);
    assert.equal(newRepliesTo('sam', before, after), 2);
    assert.equal(newRepliesTo('Ana', before, after), 0, "someone else's");
    assert.equal(newRepliesTo('Sam', after, after), 0, 'nothing new');
    const others = withComments([comment('c1', { kind: 'human', name: 'Ana' }), comment('c2', claude)]);
    assert.equal(newRepliesTo('Sam', withComments([comment('c1', { kind: 'human', name: 'Ana' })]), others), 0, "a reply to Ana's");
  });
});

describe('what a person sends, until the board has it', () => {
  const sent = (fields: Partial<Outgoing> = {}): Outgoing => ({ key: 'out-1', place: 'task:t1', body: 'Can you fix it?', at: ago(0), known: ['c1'], state: 'sending', ...fields });
  const draft = (o: Outgoing): Comment => ({ id: o.key, author: sam, body: o.body, createdAt: o.at });
  const old = { id: 'c1', author: sam, body: 'Can you fix it?', createdAt: ago(60_000) } as Comment;
  const keyOf = () => undefined;

  it('draws it at once, after what the board has', () => {
    const drawn = withOutgoing([old], [sent()], 'Sam', draft, keyOf);
    assert.deepEqual(drawn.map((d) => [d.key, d.item.id]), [['c1', 'c1'], ['out-1', 'out-1']]);
    assert.equal(onItsWay(drawn[1]), 'sending');
    assert.equal(onItsWay({ ...drawn[1], outgoing: sent({ state: 'failed', error: 'Too long' }) }), 'failed');
    assert.equal(onItsWay({ ...drawn[1], outgoing: sent({ state: 'sent' }) }), undefined, 'the server has it; the board will');
  });

  it('draws the board\'s under the same key once it comes, by its text before the server has said its id', () => {
    const arrived = { id: 'c2', author: sam, body: 'Can you fix it? ', createdAt: ago(0) } as Comment;
    const drawn = withOutgoing([old, arrived], [sent()], 'Sam', draft, keyOf);
    assert.deepEqual(drawn.map((d) => [d.key, d.item.id]), [['c1', 'c1'], ['out-1', 'c2']], 'not the same text sent before');
    assert.equal(onItsWay(drawn[1]), undefined);
    assert.deepEqual(settledKeys(drawn), [], 'kept while the server has yet to answer');
    const confirmed = withOutgoing([old, arrived], [sent({ state: 'sent', id: 'c2' })], 'Sam', draft, keyOf);
    assert.deepEqual(confirmed.map((d) => d.key), ['c1', 'out-1']);
    assert.deepEqual(settledKeys(confirmed), ['out-1']);
    const later = withOutgoing([old, arrived], [], 'Sam', draft, (id) => (id === 'c2' ? 'out-1' : undefined));
    assert.deepEqual(later.map((d) => d.key), ['c1', 'out-1'], 'and after the outbox lets it go');
  });

  it("finds the one just sent in the server's answer, though another sent at once is in it too", () => {
    const first = { id: 'c2', author: sam, body: 'First', createdAt: ago(0) } as Comment;
    const second = { id: 'c3', author: sam, body: 'Second', createdAt: ago(0) } as Comment;
    assert.deepEqual(newestMine([old, first, second], ['c1'], 'Sam', 'First'), { id: 'c2' });
    assert.deepEqual(newestMine([old, first, second], ['c1'], 'Sam', 'Second '), { id: 'c3' });
    assert.equal(newestMine([old], ['c1'], 'Sam', 'First'), undefined);
  });
});
