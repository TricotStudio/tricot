import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BoardError, Store } from '../src/core/store';
import {
  agentsWithSkills,
  readSkillRequest,
  skillsFor,
  tasksOf,
  withTricot,
  type SkillList,
  type TricotSkill,
} from '../src/core/skills';
import type { Board } from '../src/core/types';
import { removeScratch } from './platform';

const own: SkillList[] = [
  { agent: 'Claude', reportedAt: '2026-11-01T10:00:00.000Z', skills: [{ name: 'review', description: 'Review a diff' }] },
  { agent: 'Codex', reportedAt: '2026-11-01T10:05:00.000Z', skills: [{ name: 'lint', description: 'Lint' }] },
];

const tricot = (patch: Partial<TricotSkill> & { name: string }): TricotSkill => ({
  id: patch.name,
  description: `Does ${patch.name}`,
  instructions: `Do ${patch.name} well.`,
  createdBy: 'Wassim',
  createdAt: '2026-11-01T11:00:00.000Z',
  updatedAt: '2026-11-01T11:00:00.000Z',
  ...patch,
});

describe('What an agent can be asked to run', () => {
  it('is its own skills, then the Tricot skills for every agent and for it alone', () => {
    const skills = [tricot({ name: 'release-notes' }), tricot({ name: 'for-codex', agent: 'codex' })];
    assert.deepEqual(skillsFor('Claude', own[0].skills, skills).map((s) => s.name), ['review', 'release-notes']);
    assert.deepEqual(skillsFor('Codex', own[1].skills, skills).map((s) => s.name), ['lint', 'release-notes', 'for-codex']);
    assert.deepEqual(skillsFor('Claude', own[0].skills, skills)[0], { name: 'review', description: 'Review a diff' }, 'an own skill is as reported');
    const [, notes] = skillsFor('Claude', own[0].skills, skills);
    assert.deepEqual(notes.tricot, { id: 'release-notes', instructions: 'Do release-notes well.' });
    assert.equal(notes.call, undefined);
  });

  it("keeps the agent's own skill on /name and calls the Tricot one /tricot:name", () => {
    const [mine, theirs] = skillsFor('Claude', own[0].skills, [tricot({ name: 'Review' })]);
    assert.equal(mine.name, 'review');
    assert.equal(theirs.call, 'tricot:Review');
    assert.equal(skillsFor('Codex', own[1].skills, [tricot({ name: 'Review' })])[1].call, undefined, 'no clash for an agent without its own');
  });

  it('lists every agent with the Tricot skills for it, whether it reported or was only seen', () => {
    const seen = [{ name: 'Pi', lastSeen: '2026-11-01T11:00:00.000Z', state: 'listening' as const, board: { id: 'b', title: 'Board' } }];
    const agents = agentsWithSkills(own, seen, [tricot({ name: 'release-notes' }), tricot({ name: 'only-pi', agent: 'Pi' })], ['Gemini']);
    assert.deepEqual(
      agents.map((a) => [a.name, a.skills.map((s) => s.name)]),
      [
        ['Pi', ['release-notes', 'only-pi']],
        ['Claude', ['review', 'release-notes']],
        ['Codex', ['lint', 'release-notes']],
        ['Gemini', ['release-notes']],
      ],
    );
    assert.deepEqual(agents[0].board, { id: 'b', title: 'Board' });
    assert.equal(agents[0].reportedAt, undefined, 'Tricot skills are not something it reported');
  });
});

describe('Calling a Tricot skill', () => {
  const lists = withTricot(own, [], [tricot({ name: 'release-notes', instructions: 'Group by area.' }), tricot({ name: 'only-codex', agent: 'Codex' }), tricot({ name: 'review' })]);
  const names = ['Claude', 'Codex', 'Sam'];

  it('carries its instructions to the agent it is called on', () => {
    const found = readSkillRequest('@Codex /release-notes since v2', lists, names)!;
    assert.deepEqual(found.skill, {
      name: 'release-notes',
      args: 'since v2',
      agents: ['Codex'],
      tricot: { instructions: 'Group by area.', agents: ['Codex'] },
    });
    assert.equal('@Codex /release-notes since v2'.slice(found.start, found.end), '/release-notes');
  });

  it('is not a request when it is for every agent and names none, so it does not ask them all', () => {
    assert.equal(readSkillRequest('/release-notes since v2', lists, names), undefined);
    assert.deepEqual(readSkillRequest('/only-codex x', lists, names)!.skill.agents, ['Codex'], 'one for a single agent needs no mention');
  });

  it('leaves an agent that has the skill itself to run its own, and calls the Tricot one with tricot:', () => {
    const own1 = readSkillRequest('@Claude /review the diff', lists, names)!.skill;
    assert.deepEqual(own1, { name: 'review', args: 'the diff', agents: ['Claude'] }, "Claude's own review, with no instructions");
    const viaTricot = readSkillRequest('@Claude /tricot:review the diff', lists, names)!.skill;
    assert.deepEqual(viaTricot, { name: 'tricot:review', args: 'the diff', agents: ['Claude'], tricot: { instructions: 'Do review well.', agents: ['Claude'] } });
    // Codex has no review of its own: the Tricot one is /review for it.
    assert.deepEqual(readSkillRequest('@Codex /review x', lists, names)!.skill.tricot?.agents, ['Codex']);
  });

  it('gives the instructions only to those who get the Tricot skill when both kinds are asked', () => {
    const found = readSkillRequest('@Claude @Codex /review x', lists, names)!.skill;
    assert.deepEqual(found.agents.sort(), ['Claude', 'Codex']);
    assert.deepEqual(found.tricot?.agents, ['Codex']);
  });
});

describe("An agent's tasks", () => {
  it('are those it claimed and has not finished, those in progress first', () => {
    const task = (id: string, number: number, status: string, by?: string) => ({
      id,
      number,
      title: `Task ${number}`,
      status,
      ...(by ? { claimedBy: { kind: 'agent', name: by } } : {}),
    });
    const boards = [
      { id: 'a', title: 'A', tasks: [task('t1', 1, 'in_review', 'claude'), task('t2', 2, 'done', 'Claude'), task('t3', 3, 'todo'), task('t4', 4, 'in_progress', 'Codex')] },
      { id: 'b', title: 'B', tasks: [task('t5', 1, 'in_progress', 'Claude')] },
    ] as unknown as Board[];
    assert.deepEqual(tasksOf(boards, 'Claude').map((t) => [t.boardId, t.number, t.status]), [['b', 1, 'in_progress'], ['a', 1, 'in_review']]);
  });
});

describe('Keeping Tricot skills', () => {
  let dir: string;
  let store: Store;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-skills-store-'));
    store = new Store(dir);
    store.load();
  });
  after(async () => {
    await store.flush();
    removeScratch(dir);
  });
  const refused = (work: () => unknown, message: string, code = 'invalid') =>
    assert.throws(work, (e: BoardError) => e instanceof BoardError && e.message === message && e.code === code);

  it('adds one for every agent, or for one agent, and lists them in order', () => {
    const all = store.addTricotSkill('Wassim', { name: '/release-notes', description: 'Write  release\nnotes', instructions: '  Read the commits.\n\nGroup them.  ' });
    assert.equal(all.name, 'release-notes', 'slash off');
    assert.equal(all.description, 'Write release notes', 'on one line');
    assert.equal(all.instructions, 'Read the commits.\n\nGroup them.', 'trimmed, its lines kept');
    assert.equal(all.agent, undefined);
    assert.equal(all.createdBy, 'Wassim');
    const one = store.addTricotSkill('Wassim', { name: 'plan', description: 'Plan', instructions: 'Plan it.', agent: ' Claude ' });
    assert.equal(one.agent, 'Claude');
    assert.deepEqual(store.tricotSkills().map((s) => s.name), ['release-notes', 'plan']);
  });

  it('refuses a name that is not one word, one used already, and what is blank or too long', () => {
    const base = { description: 'd', instructions: 'i' };
    refused(() => store.addTricotSkill('Wassim', { ...base, name: 'two words' }), 'A skill name is one word, e.g. review or plugin:review.');
    refused(() => store.addTricotSkill('Wassim', { ...base, name: ' ' }), 'skill name must not be empty.');
    refused(() => store.addTricotSkill('Wassim', { ...base, name: 'Release-Notes' }), 'There is a Tricot skill called /Release-Notes already.', 'conflict');
    refused(() => store.addTricotSkill('Wassim', { name: 'x', description: ' ', instructions: 'i' }), 'description must not be empty.');
    refused(() => store.addTricotSkill('Wassim', { name: 'x', description: 'd', instructions: ' ' }), 'instructions must not be empty.');
    refused(() => store.addTricotSkill('Wassim', { name: 'x', description: 'd'.repeat(201), instructions: 'i' }), 'A description is too long (max 200 characters).');
    refused(() => store.addTricotSkill('Wassim', { name: 'x', description: 'd', instructions: 'i'.repeat(8001) }), 'Instructions is too long (max 8000 characters).');
    assert.equal(store.tricotSkills().length, 2);
  });

  it('edits what is given, keeping the rest, and a blank agent makes it for every agent', () => {
    const [, plan] = store.tricotSkills();
    const renamed = store.editTricotSkill(plan.id, { name: 'plan-work', instructions: 'Plan it well.' });
    assert.deepEqual([renamed.name, renamed.description, renamed.instructions, renamed.agent], ['plan-work', 'Plan', 'Plan it well.', 'Claude']);
    assert.equal(renamed.createdAt, plan.createdAt);
    assert.ok(renamed.updatedAt >= plan.updatedAt);
    assert.equal(store.editTricotSkill(plan.id, { agent: 'Codex' }).agent, 'Codex');
    assert.equal(store.editTricotSkill(plan.id, { agent: '' }).agent, undefined);
    assert.deepEqual(store.tricotSkills().map((s) => s.name), ['release-notes', 'plan-work'], 'keeps its place');
    refused(() => store.editTricotSkill(plan.id, { name: 'RELEASE-notes' }), 'There is a Tricot skill called /RELEASE-notes already.', 'conflict');
    assert.equal(store.editTricotSkill(plan.id, { name: 'PLAN-work' }).name, 'PLAN-work', 'its own name in another case is fine');
    refused(() => store.editTricotSkill('nope', { name: 'x' }), 'No Tricot skill with id "nope".', 'not_found');
  });

  it('deletes one, and is kept when Tricot starts again', async () => {
    const [notes, plan] = store.tricotSkills();
    assert.equal(store.deleteTricotSkill(plan.id).name, 'PLAN-work');
    refused(() => store.deleteTricotSkill(plan.id), `No Tricot skill with id "${plan.id}".`, 'not_found');
    await store.flush();
    const reopened = new Store(dir);
    reopened.load();
    assert.deepEqual(reopened.tricotSkills(), [notes]);
    store.addTricotSkill('Wassim', { name: 'PLAN-work', description: 'Again', instructions: 'Again.' });
    assert.equal(store.tricotSkills().length, 2, 'a deleted name can be used again');
  });
});
