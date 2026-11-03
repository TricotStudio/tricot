import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentsWithSkills, normalizeSkills, pendingSkill, readSkillRequest, type SkillList } from '../src/core/skills';
import type { Actor } from '../src/core/types';
import { Presence } from '../src/server/presence';

const lists: SkillList[] = [
  { agent: 'Claude', reportedAt: '2026-11-01T10:00:00.000Z', skills: [{ name: 'avoid-ai-writing', description: 'Tighten prose' }, { name: 'review', description: 'Review a diff' }] },
  { agent: 'Codex', reportedAt: '2026-11-01T10:05:00.000Z', skills: [{ name: 'review', description: 'Review the tree' }, { name: 'plugin:lint', description: 'Lint' }] },
];
const names = ['Claude', 'Codex', 'Sam'];

describe('Reading a skill request', () => {
  it('asks every agent that has the skill when the text starts with it', () => {
    const found = readSkillRequest('/review the oauth change', lists, names)!;
    assert.deepEqual(found.skill, { name: 'review', args: 'the oauth change', agents: ['Claude', 'Codex'] });
    assert.deepEqual([found.start, found.end], [0, '/review'.length]);
    assert.deepEqual(readSkillRequest('/avoid-ai-writing', lists, names)!.skill, { name: 'avoid-ai-writing', args: '', agents: ['Claude'] });
  });

  it('asks the agent the text opens with a mention of, once it has the skill', () => {
    const found = readSkillRequest('  @Codex /REVIEW it\nplease', lists, names)!;
    assert.deepEqual(found.skill, { name: 'review', args: 'it\nplease', agents: ['Codex'] });
    assert.equal('  @Codex /REVIEW it\nplease'.slice(found.start, found.end), '/REVIEW');
    assert.deepEqual(readSkillRequest('@Codex, @Claude: /review', lists, names)!.skill.agents, ['Claude', 'Codex']);
    assert.deepEqual(readSkillRequest('@Codex @Claude /avoid-ai-writing x', lists, names)!.skill.agents, ['Claude'], 'those that have it');
    assert.equal(readSkillRequest('@codex /plugin:lint src', lists, names)!.skill.name, 'plugin:lint');
  });

  it('knows an agent that is not on the board by its reported skills', () => {
    assert.deepEqual(readSkillRequest('@Codex /review x', lists, []), readSkillRequest('@Codex /review x', lists, names));
  });

  it('is not a request when it does not start with a skill that some agent has', () => {
    for (const text of ['', 'review', '/', '/nope', '/usr/bin', 'please /review', '@Sam /review', '@Gemini /review', '@Codex /avoid-ai-writing', '@Codex fix /review', '//review', '/review.']) {
      assert.equal(readSkillRequest(text, lists, names), undefined, text);
    }
    assert.equal(readSkillRequest('/review', [], names), undefined);
  });
});

describe('Keeping skills', () => {
  it('takes slashes off, keeps a name once, and puts a description on one line, clipped', () => {
    const kept = normalizeSkills([
      { name: '/review', description: 'Review\n a   diff' },
      { name: 'Review', description: 'again' },
      { name: 'long', description: 'x'.repeat(300) },
    ]);
    assert.deepEqual(kept.map((s) => s.name), ['review', 'long']);
    assert.equal(kept[0].description, 'Review a diff');
    assert.equal(kept[1].description.length, 200);
    assert.ok(kept[1].description.endsWith('…'));
  });
});

describe('Marking the reply to a skill request', () => {
  const person: Actor = { kind: 'human', name: 'Wassim' };
  const claude: Actor = { kind: 'agent', name: 'Claude' };
  const codex: Actor = { kind: 'agent', name: 'Codex' };
  const request = { name: 'review', args: '', agents: ['Claude'] };

  it('is the skill an agent was asked and has not answered', () => {
    assert.equal(pendingSkill([{ author: person, skill: request }], claude)?.name, 'review');
    assert.equal(pendingSkill([{ author: person, skill: request }], { ...claude, name: 'claude' })?.name, 'review');
    assert.equal(pendingSkill([{ author: person, skill: request }, { author: claude }], claude), undefined, 'answered');
    assert.equal(pendingSkill([{ author: person, skill: request }], codex), undefined, 'not asked');
    assert.equal(pendingSkill([{ author: person, skill: request }, { author: codex }], claude)?.name, 'review', "another agent's reply doesn't answer it");
    assert.equal(pendingSkill([{ author: person, skill: request }, { author: person }], claude)?.name, 'review', 'a later plain message leaves it open');
  });
});

describe('Which agents there are, and where', () => {
  it('lists those that reported or were seen, those on first, and greys the rest', () => {
    const seen = [
      { name: 'codex', lastSeen: '2026-11-01T11:00:00.000Z', state: 'away' as const },
      { name: 'Pi', lastSeen: '2026-11-01T11:01:00.000Z', state: 'listening' as const },
    ];
    const agents = agentsWithSkills(lists, seen);
    assert.deepEqual(agents.map((a) => [a.name, a.state, a.present]), [
      ['Pi', 'listening', true],
      ['Codex', 'idle', false],
      ['Claude', 'absent', false],
    ]);
    assert.deepEqual(agents[0].skills, []);
    assert.equal(agents[0].reportedAt, undefined);
    assert.equal(agents[1].reportedAt, lists[1].reportedAt);
    assert.equal(agents[1].lastSeen, seen[0].lastSeen);
    assert.equal(agents[2].lastSeen, undefined);
  });
});

describe('Presence across boards', () => {
  it('gives each agent its busiest state and latest call, on one board or all', () => {
    let now = 1_000_000_000;
    const presence = new Presence(() => {}, () => now);
    try {
      presence.seen('a', 'Claude');
      now += 10 * 60_000;
      presence.seen('b', 'Claude');
      presence.startWaiting('b', 'Codex');
      now += 10 * 60_000;
      const all = presence.agents();
      assert.deepEqual(all.map((a) => [a.name, a.state]), [['Claude', 'away'], ['Codex', 'listening']]);
      assert.equal(all[0].lastSeen, new Date(now - 10 * 60_000).toISOString());
      assert.deepEqual(presence.agents('a').map((a) => a.name), ['Claude']);
      assert.deepEqual(presence.agents('c'), []);
      assert.deepEqual(presence.list('a'), [], 'a board lists only those present lately');
      presence.seen('a', 'Claude');
      assert.equal(presence.agents().find((a) => a.name === 'Claude')!.state, 'working');
    } finally {
      presence.close();
    }
  });
});
