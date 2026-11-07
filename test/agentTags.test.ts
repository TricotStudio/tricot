import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cantSwitch, perMessageAsk, tagAt, tagChoices, tagOn, tagText, tagWords } from '../src/core/agentTags';
import { agentKindOf, agentKinds, findAgent } from '../src/core/agents/registry';
import { meantFor } from '../src/core/delivery';
import { boardDigest, eventsDigest } from '../src/core/digest';
import { findMentions, leadingMentions, mentionsDigest, readTagTyping, resolveMentions, tagFor, withMention, withoutLeadingMentions } from '../src/core/mentions';
import { requestsDigest, requestTitle } from '../src/core/requests';
import { readSkillRequest } from '../src/core/skills';
import { Store } from '../src/core/store';
import { threadsDigest } from '../src/core/threads';
import type { Actor, Board } from '../src/core/types';
import { cellChoices, cellLabel, cellListName, cellValues, cellWords, stepCell, takesTag, writtenTag } from '../src/web/shared/mentionTags';
import { removeScratch } from './platform';

// A tag on a mention of an agent (T23, core/agentTags.ts): `@Claude:opus:high`
// asks that one message's work of a model and thinking level, and is still
// a mention of Claude everywhere a mention counts.

const claude = findAgent('claude')!;
const codex = findAgent('codex')!;
const wassim: Actor = { kind: 'human', name: 'Wassim' };
const names = ['Claude', 'Codex', 'Claude Code', 'Sam'];
const agents = ['Claude', 'Codex', 'Claude Code'];
const ASK_HIGH = 'asks you to do this on opus at high thinking: hand the work to a subagent on that model and thinking level, and keep your own session as it is.';

describe('Reading a tag', () => {
  it('leaves a plain mention as it was, with or without the agents given', () => {
    for (const text of ['@Claude can you look?', '@Claude: can you look?', 'cc @Claude, @Sam', '@Claude.', '@Claude Code please']) {
      assert.deepEqual(findMentions(text, names, agents), findMentions(text, names), text);
      assert.equal(withoutLeadingMentions(text, names, agents), withoutLeadingMentions(text, names), text);
    }
    assert.deepEqual(findMentions('@Claude can you look?', names, agents), [{ name: 'Claude', start: 0, end: 7 }]);
  });

  it('reads each form of a tag on an agent, which is still a mention of it', () => {
    const tagged = (text: string) => findMentions(text, names, agents).map(({ name, end, tag }) => ({ name, written: text.slice(0, end), tag }));
    assert.deepEqual(tagged('@Claude:opus:high fix it'), [{ name: 'Claude', written: '@Claude:opus:high', tag: { model: 'opus', effort: 'high' } }]);
    assert.deepEqual(tagged('@Claude:opus fix it'), [{ name: 'Claude', written: '@Claude:opus', tag: { model: 'opus' } }]);
    assert.deepEqual(tagged('@Claude::high fix it'), [{ name: 'Claude', written: '@Claude::high', tag: { effort: 'high' } }]);
    assert.deepEqual(tagged('@claude:OPUS:High'), [{ name: 'Claude', written: '@claude:OPUS:High', tag: { model: 'OPUS', effort: 'High' } }], 'whatever the case');
    assert.deepEqual(tagged('@Claude Code:gpt-6.1-sol:xhigh'), [{ name: 'Claude Code', written: '@Claude Code:gpt-6.1-sol:xhigh', tag: { model: 'gpt-6.1-sol', effort: 'xhigh' } }], 'the longer name');
    assert.deepEqual(tagged('@Claude:claude-opus-4-5. Then'), [{ name: 'Claude', written: '@Claude:claude-opus-4-5', tag: { model: 'claude-opus-4-5' } }], 'a full stop ends the sentence');
    assert.deepEqual(tagged('@Claude:opus: have a look'), [{ name: 'Claude', written: '@Claude:opus', tag: { model: 'opus' } }], 'a colon ending a phrase');
    for (const text of ['@Claude:opus:high fix it', '@Claude::high fix it', 'see @Claude:opus, then']) {
      assert.deepEqual(resolveMentions(text, names), ['Claude'], 'who it mentions is as before');
      assert.deepEqual(meantFor({ activity: { actors: [{ actor: wassim, at: '' }] } } as unknown as Board, { boardContext: true }, { mentions: resolveMentions(text, names) }), ['Claude'], 'and it is meant for Claude');
    }
  });

  it('reads none where there is only a colon, or something that is no tag', () => {
    for (const text of ['@Claude: fix it', '@Claude:: fix it', '@Claude:https://example.com', '@Claude:opus:high:extra', '@Claude:(opus)']) {
      assert.equal(findMentions(text, names, agents)[0].tag, undefined, text);
      assert.equal(findMentions(text, names, agents)[0].end, 7, text);
    }
    assert.equal(tagAt('@Claude:', 7), undefined);
    assert.deepEqual(tagAt('@Claude:-rf', 7), { tag: { model: '-rf' }, end: 11 }, 'read, to be refused (tagOn)');
  });

  it("leaves a person's name, an email and an unknown name as they always read", () => {
    assert.deepEqual(findMentions('@Sam:later can you look', names, agents), [{ name: 'Sam', start: 0, end: 4 }]);
    assert.equal(withoutLeadingMentions('@Sam:later can you look', names, agents), 'later can you look', 'as before');
    assert.deepEqual(findMentions('mail sam@claude:opus or me@example.com', names, agents), []);
    assert.deepEqual(findMentions('@Bob:opus:high', names, agents), []);
  });

  it('takes the tag with the mention a message opens with, for a skill and for a group title too', () => {
    assert.equal(withoutLeadingMentions('@Claude:opus:high fix the picker', names, agents), 'fix the picker');
    assert.deepEqual(leadingMentions('@Claude:opus /review the diff', names, agents), { names: ['Claude'], rest: '/review the diff' });
    const lists = [{ agent: 'Claude', skills: [{ name: 'review', description: 'Review' }], reportedAt: '' }];
    assert.deepEqual(readSkillRequest('@Claude:opus:high /review the diff', lists, names)?.skill, { name: 'review', args: 'the diff', agents: ['Claude'] });
    assert.equal(requestTitle('@Claude:opus get me an architecture view of the project', ['Claude']), 'Architecture view');
  });

  it('finds the tag a message gives one agent', () => {
    assert.deepEqual(tagFor('@Codex @Claude:opus look', names, agents, 'claude'), { model: 'opus' });
    assert.equal(tagFor('@Codex @Claude:opus look', names, agents, 'Codex'), undefined);
    assert.equal(tagText({ model: 'opus', effort: 'high' }), ':opus:high');
    assert.equal(tagText({ model: 'opus' }), ':opus');
    assert.equal(tagText({ effort: 'high' }), '::high');
    assert.equal(tagText({}), '');
  });
});

describe('What a tag asks of an agent', () => {
  it("is read against Claude Code's subagents: its models by name or a full one's family, its levels", () => {
    assert.deepEqual(tagOn(claude, 'Claude', { model: 'opus', effort: 'high' }), { on: { model: 'opus', effort: 'high' } });
    assert.deepEqual(tagOn(claude, 'Claude', { model: 'Claude-Opus-4-5' }), { on: { model: 'opus' } });
    assert.deepEqual(tagOn(claude, 'Claude', { model: 'sonnet[1m]', effort: 'MAX' }), { on: { model: 'sonnet', effort: 'max' } });
    assert.deepEqual(tagOn(claude, 'Claude', { effort: 'low' }), { on: { effort: 'low' } });
  });

  it('refuses a level it has not, a model like an option, and one its subagents never run on, saying why', () => {
    assert.deepEqual(tagOn(claude, 'Claude', { model: 'opus', effort: 'ultra' }), {
      problem: 'Claude\'s thinking level is one of low, medium, high, xhigh or max: "ultra" isn\'t one. Claude will use its own.',
    });
    assert.deepEqual(tagOn(claude, 'Claude', { model: '-rf' }), {
      problem: '"-rf" can\'t be a model\'s name: it starts with -, so the agent would read it as an option. Claude will use its own.',
    });
    assert.deepEqual(tagOn(claude, 'Claude', { model: 'gpt-6.1-sol' }), {
      problem: 'Claude\'s subagents run on opus, sonnet, haiku or fable: "gpt-6.1-sol" isn\'t one. Claude will use its own.',
    });
  });

  it("says plainly that an agent that can't take one uses its own", () => {
    assert.deepEqual(tagOn(codex, 'Codex', { model: 'gpt-6.1-sol', effort: 'high' }), { problem: "Codex can't switch models for one message: it will use its own." });
    assert.deepEqual(tagOn(undefined, 'Reviewer', { model: 'opus' }), { problem: cantSwitch('Reviewer') }, 'nor one Tricot does not know');
    assert.deepEqual(
      agentKinds().filter((kind) => kind.perMessage).map((kind) => kind.id),
      ['claude'],
      'Claude Code alone, for now',
    );
    assert.deepEqual(tagChoices(codex, 'model'), []);
  });

  it('says what it runs on to people, and what to do to the agent', () => {
    assert.equal(tagWords(claude, { model: 'opus', effort: 'high' }), 'on Opus at high thinking');
    assert.equal(tagWords(claude, { model: 'opus' }), 'on Opus');
    assert.equal(tagWords(claude, { effort: 'xhigh' }), 'at extra high thinking');
    assert.equal(perMessageAsk({ model: 'opus', effort: 'high' }), ASK_HIGH);
    assert.equal(perMessageAsk({ model: 'opus' }), 'asks you to do this on opus: hand the work to a subagent on that model, and keep your own session as it is.');
    assert.equal(perMessageAsk({ effort: 'high' }), 'asks you to do this at high thinking: hand the work to a subagent at that thinking level, and keep your own session as it is.');
  });

  it('knows an agent by its session, else by its name on the board', () => {
    assert.equal(agentKindOf({ name: 'Reviewer', tool: 'claude' }), claude);
    assert.equal(agentKindOf({ name: 'claude' }), claude);
    assert.equal(agentKindOf({ name: 'Reviewer' }), undefined);
  });
});

describe('Typing a tag', () => {
  it('reads the model, then the level, after an agent and a colon', () => {
    assert.deepEqual(readTagTyping('@Claude:', agents), { agent: 'Claude', part: 'model', at: 8, query: '' });
    assert.deepEqual(readTagTyping('hi @claude:op', agents), { agent: 'Claude', part: 'model', at: 11, query: 'op' });
    assert.deepEqual(readTagTyping('@Claude:opus:hi', agents), { agent: 'Claude', part: 'level', at: 13, query: 'hi', model: 'opus' });
    assert.deepEqual(readTagTyping('@Claude::', agents), { agent: 'Claude', part: 'level', at: 9, query: '' });
    assert.deepEqual(readTagTyping('@Claude Code:', agents), { agent: 'Claude Code', part: 'model', at: 13, query: '' });
    for (const before of ['@Sam:', 'me@Claude:', '@Claude:opus high', '@Claude', '@Claude:opus:high:']) assert.equal(readTagTyping(before, agents), undefined, before);
  });

  it('writes a mention with its tag', () => {
    assert.deepEqual(withMention('@Cl redo it', { at: 0, query: 'Cl' }, 'Claude', ':opus:high'), { text: '@Claude:opus:high redo it', caret: 18 });
    assert.equal(writtenTag('Claude', { model: 'opus', effort: 'high' }), '@Claude:opus:high');
    assert.equal(writtenTag('Claude', {}), '@Claude');
  });
});

describe("The @ list's model and thinking cells", () => {
  const rule = { model: 'sonnet', effort: 'medium' };

  it('offer them for an agent that takes a tag, and step through its values from its rule', () => {
    assert.ok(takesTag(claude));
    assert.ok(!takesTag(codex));
    assert.deepEqual(cellValues(claude, 'model', rule), ['opus', undefined, 'haiku', 'fable'], 'the rule is no value');
    assert.deepEqual(cellValues(claude, 'model', {}), [undefined, 'opus', 'sonnet', 'haiku', 'fable'], 'with none, its own first');
    assert.equal(stepCell(claude, 'model', rule, undefined, 1), 'haiku', 'down from the rule');
    assert.equal(stepCell(claude, 'model', rule, undefined, -1), 'opus', 'up from the rule');
    assert.equal(stepCell(claude, 'model', rule, 'opus', 1), undefined, 'back at the rule');
    assert.equal(stepCell(claude, 'level', rule, undefined, 1), 'high');
    assert.equal(stepCell(claude, 'level', {}, 'max', 1), undefined, 'round to its own');
  });

  it('show the rule faintly, a value in ink, each by its name, and name each to a screen reader', () => {
    assert.deepEqual(cellWords(claude, 'model', rule, undefined), { words: 'Sonnet', set: false });
    assert.deepEqual(cellWords(claude, 'level', {}, undefined), { words: 'Default', set: false });
    assert.deepEqual(cellWords(claude, 'model', rule, 'opus'), { words: 'Opus', set: true });
    assert.deepEqual(cellWords(claude, 'level', rule, 'xhigh'), { words: 'Extra high', set: true });
    assert.deepEqual(cellWords(claude, 'model', { model: 'claude-opus-4-1' }, undefined), { words: 'claude-opus-4-1', set: false }, 'a model of its own, as written');
    assert.equal(cellLabel(claude, 'model', rule, 'opus'), 'Model for this message: Opus');
    assert.equal(cellLabel(claude, 'level', rule, undefined), 'Thinking: Medium, its rule');
    assert.equal(cellLabel(claude, 'level', {}, undefined), 'Thinking: its own');
  });

  it("list a cell's values in the order the arrows step, the rule's marked default", () => {
    assert.deepEqual(cellChoices(claude, 'model', rule), [
      { value: 'opus', words: 'Opus' },
      { value: undefined, words: 'Sonnet', note: 'default' },
      { value: 'haiku', words: 'Haiku' },
      { value: 'fable', words: 'Fable' },
    ]);
    assert.deepEqual(
      cellChoices(claude, 'level', {}).map((c) => c.words),
      ['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max'],
      "with no rule, the agent's own first, called Default",
    );
    assert.equal(cellChoices(claude, 'level', {})[0].note, undefined);
    assert.deepEqual(cellChoices(claude, 'model', { model: 'claude-opus-4-1' })[0], { value: undefined, words: 'claude-opus-4-1', note: 'default' }, 'a rule off the list, first');
    assert.equal(cellListName('model'), 'Model for this message');
    assert.equal(cellListName('level'), 'Thinking for this message');
  });
});

describe('Tagged messages on a board', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-tags-'));
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

  it('asks Claude, as Claude Code, to hand the work to a subagent; and reads as before to another agent or without its kind', () => {
    const t = store.planTasks(boardId, [{ title: 'Picker spacing' }], wassim, { ready: true })[0];
    const cursor = board().seq;
    store.addTaskComment(t.id, '@Claude:opus:high can you redo the picker spacing?', wassim);
    assert.deepEqual(board().tasks[0].comments[0].mentions, ['Claude'], 'a mention of Claude, stored as one');

    const asked = `Wassim asked you on T1 [task id: ${t.id}]: "can you redo the picker spacing?". Wassim ${ASK_HIGH} Reply with comment(task_id: ${t.id}).`;
    assert.equal(mentionsDigest(board(), 'Claude', undefined, claude), asked);
    const events = store.eventsSince(boardId, cursor);
    assert.ok(eventsDigest(events, board().seq, { board: board(), viewer: 'Claude', kind: claude }).includes(`Wassim (human) ${asked.slice('Wassim '.length)}`));
    assert.ok(boardDigest(board(), 'Claude', Date.now(), undefined, claude).includes(asked));

    // Without knowing it is Claude Code, nothing is asked, and the text reads as it always has.
    assert.equal(mentionsDigest(board(), 'Claude'), `Wassim asked you on T1 [task id: ${t.id}]: "opus:high can you redo the picker spacing?". Reply with comment(task_id: ${t.id}).`);
    // Another agent reads it as for Claude.
    assert.match(eventsDigest(events, board().seq, { board: board(), viewer: 'Codex', kind: codex }), /asked Claude on T1 .*Not for you; carry on\./);
  });

  it("gives an agent that can't take a tag the message as it reads without one", () => {
    const t = store.planTasks(boardId, [{ title: 'Migrations' }], wassim, { ready: true })[0];
    store.addTaskComment(t.id, '@Codex:gpt-6.1-sol:high can you check the migration order?', wassim);
    assert.equal(
      mentionsDigest(board(), 'Codex', undefined, codex),
      `Wassim asked you on T1 [task id: ${t.id}]: "gpt-6.1-sol:high can you check the migration order?". Reply with comment(task_id: ${t.id}).`,
    );
  });

  it('asks the same in a thread and on the board context', () => {
    store.startThread(boardId, '@Claude::high is the retry logic safe?', wassim);
    const digest = threadsDigest(board(), 'Claude', undefined, claude)!;
    assert.match(digest, /^Wassim asked you in thread "Is the retry logic safe\?" \[thread id: \w+\]: "is the retry logic safe\?"\. Wassim asks you to do this at high thinking: hand the work to a subagent at that thinking level, and keep your own session as it is\. Reply with reply_in_thread/);
    store.askAgents(boardId, '@Claude:opus get me an architecture view', wassim);
    assert.match(requestsDigest(board(), 'Claude', claude)!, /Wassim asked you on the board context \[request id: \w+\]: "get me an architecture view"\. Wassim asks you to do this on opus: hand the work to a subagent on that model, and keep your own session as it is\. Take it with take_request/);
    assert.match(requestsDigest(board(), 'Codex', codex)!, /asked Claude on the board context \[request id: \w+\]: "get me an architecture view"\. For Claude: only Claude can take it; not for you, carry on\./);
  });

  it("asks nothing for a tag Claude can't read, and keeps the words", () => {
    const t = store.planTasks(boardId, [{ title: 'Bug' }], wassim, { ready: true })[0];
    store.addTaskComment(t.id, '@Claude:fix the login bug', wassim);
    assert.equal(mentionsDigest(board(), 'Claude', undefined, claude), `Wassim asked you on T1 [task id: ${t.id}]: "fix the login bug". Reply with comment(task_id: ${t.id}).`);
  });
});
