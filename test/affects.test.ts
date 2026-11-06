import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { COULD_AFFECT_CAP, couldAffect, couldAffectLines, isLikely, mayChange, reasonWords, revisitGroups, revisitNote, revisitWhy, standingWords, type Affected } from '../src/core/affects';
import { decisionDetail, refreshDigest } from '../src/core/digest';
import { keyWords, similarDecisions } from '../src/core/search';
import { Store } from '../src/core/store';
import type { Actor, Board, Decision } from '../src/core/types';
import { removeScratch } from './platform';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const wassim: Actor = { kind: 'human', name: 'Wassim' };

// What each listed decision is, and why, in order: "#2 depends on this".
const shown = (listed: Affected[]) => listed.map((a) => `#${a.decision.number} ${a.reasons.map(reasonWords).join(' · ')}`);

describe('What a decision could affect', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  const board = (): Board => store.getBoard(boardId);
  const post = (question: string, extra: Partial<Parameters<Store['postDecision']>[1]> = {}): Decision =>
    store.postDecision(boardId, { question, options: [{ label: 'Yes' }, { label: 'No' }], ...extra }, claude);
  const decide = (decision: Decision, optionId = 'a', by: Actor = wassim) => store.resolve(decision.id, { optionId }, by);
  // Settles a decision a while ago, so an answer given now comes after it.
  const decidedAgo = (decision: Decision, minutes: number) => {
    decide(decision);
    decision.resolution!.at = new Date(Date.now() - minutes * 60_000).toISOString();
    return decision;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-affects-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Tricot launch' }, wassim).id;
  });

  afterEach(async () => {
    await store.flush();
    removeScratch(dir);
  });

  it('is empty for a decision that touches nothing', () => {
    const alone = post('Which licence should the core ship under?');
    post('What colour is the logo?');
    assert.deepEqual(couldAffect(board(), alone), []);
    assert.deepEqual(couldAffectLines([]), []);
    assert.doesNotMatch(decisionDetail(board(), alone), /Could affect/);
  });

  it('lists the decisions it depends on and those that depend on it, whatever their status', () => {
    const tiers = post('Which pricing tiers do we offer?');
    const licence = post('Which licence should the core ship under?', { dependsOn: [tiers.id] });
    const site = post('What does the website promise?', { dependsOn: [licence.id] });
    assert.deepEqual(shown(couldAffect(board(), licence)), ['#3 depends on this', '#1 this depends on it']);
    // Retired, a dependency still shows: it is linked on purpose.
    store.retire(tiers.id, 'Folded into #2', wassim);
    assert.deepEqual(shown(couldAffect(board(), licence)), ['#3 depends on this', '#1 this depends on it']);
    assert.deepEqual(shown(couldAffect(board(), site)), ['#2 this depends on it']);
  });

  it('lists past decisions a task implements together with it', () => {
    const licence = post('Which licence should the core ship under?');
    const tiers = post('Which pricing tiers do we offer?');
    const logo = post('What colour is the logo?');
    for (const d of [licence, tiers, logo]) decide(d);
    store.planTasks(boardId, [{ title: 'Write the pricing page', decisionIds: [licence.id, tiers.id] }, { title: 'Ship the logo', decisionIds: [logo.id] }], claude);
    // Reopened, the licence question keeps the task built on it, and so the link.
    store.reopen(licence.id, wassim);
    const listed = couldAffect(board(), licence);
    assert.deepEqual(shown(listed), ['#2 shares T1']);
    assert.deepEqual(listed[0].tasks.map((t) => t.number), [1], 'with the work built on it');
  });

  it('lists past decisions in the same area, but not open ones or retired ones', () => {
    const licence = post('Which licence should the core ship under?', { area: 'Licensing' });
    const cla = post('Do contributors sign a CLA?', { area: 'licensing' });
    const notice = post('Where does the copyright notice go?', { area: 'Licensing' });
    const fonts = post('Which fonts may we bundle?', { area: 'Licensing' });
    const parked = post('Do we offer a commercial licence?', { area: 'Licensing' });
    post('What colour is the logo?', { area: 'Brand' });
    decide(cla);
    store.resolve(notice.id, { optionId: 'b', provisional: true }, claude);
    store.retire(fonts.id, 'No fonts bundled', wassim);
    store.defer(parked.id, 'After launch', wassim);
    // Decided, provisional and deferred are past decisions; open and retired ones aren't.
    assert.deepEqual(shown(couldAffect(board(), licence)), ['#5 same area: Licensing', '#3 same area: Licensing', '#2 same area: Licensing']);
  });

  it('lists past decisions worded closely like it, through the search, and drops faint likenesses', () => {
    const licence = post('Which licence should the core ship under?', { options: [{ label: 'AGPL' }, { label: 'MIT' }] });
    const pricing = post('How do we price hosting?', {
      context: 'Assumes the core stays AGPL, so the hosted version is what we charge for.',
    });
    const notice = post('Where does the licence notice go?');
    const close = post('Does the core licence cover the plugins?');
    for (const d of [pricing, notice, close]) decide(d);
    // Its key words, found where a search finds them: in the other's question
    // they count 2, elsewhere on it 1.
    assert.deepEqual(keyWords('Which licence should the core ship under? AGPL MIT'), ['licence', 'core', 'ship', 'agpl', 'mit']);
    const scores = similarDecisions(board(), licence);
    assert.equal(scores.get(close.id), 4, 'licence and core, both in its question');
    assert.equal(scores.get(pricing.id), 2, 'core and AGPL, both in its context');
    assert.equal(scores.get(notice.id), 2, 'licence, in its question');
    // A likeness under three is too faint on its own to list.
    assert.deepEqual(shown(couldAffect(board(), licence)), ['#4 similar wording']);
  });

  it("doesn't count a word most of a board's decisions share", () => {
    const shared = ['Which agent hosts the board?', 'Does an agent see archived boards?', 'Can an agent delete a card?', 'May an agent reword options?'];
    for (const question of shared) decide(post(question));
    for (const question of ['Who owns the agent roster?', 'Does the agent sign commits?']) decide(post(question));
    const others = board().decisions.slice();
    const asking = post('Which agent hosts the board context?');
    const scores = similarDecisions(board(), asking);
    // "agent" is in every one of the six others, so it tells none apart: only
    // "hosts" and "board" count, where they are.
    assert.equal(scores.get(others[0].id), 4, 'hosts and board');
    assert.equal(scores.get(others[1].id), 2, '"boards" starts with board');
    assert.equal(scores.has(others[2].id), false, 'agent alone');
  });

  it('lists what an agent named, with its why, first and always', () => {
    const site = post('What does the website promise?');
    const tiers = post('Which pricing tiers do we offer?');
    decide(tiers);
    const licence = post('Which licence should the core ship under?', {
      dependsOn: [tiers.id],
      affects: [{ decisionId: site.id, why: 'the site copy names the licence' }],
    });
    const listed = couldAffect(board(), licence);
    assert.deepEqual(shown(listed), ['#1 the site copy names the licence', '#2 this depends on it']);
    const named = listed[0].reasons[0];
    assert.equal(named.kind === 'named' && named.by.name, 'Claude');
    assert.equal(standingWords(site), 'open', 'an open one an agent named shows as it stands');
  });

  it('orders by the strongest reason, several reasons counting a little more, and caps what it finds', () => {
    const decisions: Decision[] = [];
    for (let i = 1; i <= 8; i++) decisions.push(post(`Shipping question ${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'][i - 1]}?`, { area: 'Shipping' }));
    decisions.forEach((d) => decide(d));
    decide(post('Which releases ship nightly builds?', { options: [{ label: 'Nightly builds' }, { label: 'Weekly' }], area: 'Shipping' }));
    const asking = post('How often do nightly builds ship?', {
      area: 'Shipping',
      dependsOn: [decisions[7].id],
      affects: [{ decisionId: decisions[6].id, why: 'golf assumes weekly builds' }],
    });
    store.updateDecision(decisions[5].id, { dependsOn: [asking.id] }, claude);

    const listed = couldAffect(board(), asking);
    assert.deepEqual(shown(listed), [
      '#7 golf assumes weekly builds · same area: Shipping',
      '#6 depends on this · same area: Shipping',
      '#8 this depends on it · same area: Shipping',
      '#9 same area: Shipping · similar wording',
      '#5 same area: Shipping',
      '#4 same area: Shipping',
    ]);
    assert.equal(listed.length, COULD_AFFECT_CAP);
    assert.ok(listed.every((a, i) => i === 0 || listed[i - 1].strength >= a.strength), 'strongest first');

    // What it is linked to on purpose always shows, past the cap.
    const many = Array.from({ length: 7 }, (_, i) => ({ decisionId: decisions[i].id, why: `named ${i + 1}` }));
    store.updateDecision(asking.id, { affects: many }, claude);
    assert.equal(couldAffect(board(), asking).length, 8, 'seven named and the one it depends on');
  });

  it('keeps what agents name to decisions on the board, once each, with why', () => {
    const tiers = post('Which pricing tiers do we offer?');
    const licence = post('Which licence should the core ship under?');
    const on = (affects: { decisionId: string; why: string }[]) => () => store.updateDecision(licence.id, { affects }, claude);
    assert.throws(on([{ decisionId: 'nope', why: 'x' }]), /No decision "nope" on this board/);
    assert.throws(on([{ decisionId: licence.id, why: 'x' }]), /A decision cannot affect itself/);
    assert.throws(on([{ decisionId: tiers.id, why: '  ' }]), /why must not be empty/);
    assert.throws(on([{ decisionId: tiers.id, why: 'x'.repeat(201) }]), /Why is too long \(max 200 characters\)/);
    assert.throws(on([{ decisionId: tiers.id, why: 'a' }, { decisionId: tiers.id, why: 'b' }]), /Name each decision once/);
    assert.equal(licence.affects, undefined, 'a refused call changes nothing');

    store.updateDecision(licence.id, { affects: [{ decisionId: tiers.id, why: ' pricing assumes an open core ' }] }, claude);
    const named = store.getDecision(licence.id).decision.affects ?? [];
    assert.deepEqual(named.map((a) => [a.decisionId, a.why, a.by.name]), [[tiers.id, 'pricing assumes an open core', 'Claude']]);
    assert.match(store.events(boardId, { order: 'asc' }).at(-1)!.summary, /^updated #2 ".+": could affect #1$/);
    store.updateDecision(licence.id, { affects: [] }, claude);
    assert.equal(store.getDecision(licence.id).decision.affects, undefined);

    // Deleting a decision takes it off the lists that name it.
    store.updateDecision(licence.id, { affects: [{ decisionId: tiers.id, why: 'pricing assumes an open core' }] }, claude);
    store.deleteDecision(tiers.id, wassim);
    assert.equal(store.getDecision(licence.id).decision.affects, undefined);
  });

  it('tells agents what it could affect in get_decision, with ids, answers, work and why', () => {
    const tiers = post('Which pricing tiers do we offer?', { options: [{ label: 'Free and Pro' }, { label: 'Per seat' }] });
    decide(tiers, 'b');
    store.planTasks(boardId, [{ title: 'Build the pricing page', decisionIds: [tiers.id] }], claude);
    const licence = post('Which licence should the core ship under?', { affects: [{ decisionId: tiers.id, why: 'pricing assumes an open core' }] });
    assert.match(
      decisionDetail(board(), licence),
      new RegExp(
        `## Could affect\nOther decisions this one may change or rests on: weigh them when you recommend, and name any others with affects \\(update_decision\\)\\.\n- #1 \\[id: ${tiers.id}\\] Which pricing tiers do we offer\\? \\(decided: b\\) Per seat; T1 builds on it\\) — Claude: "pricing assumes an open core"`,
      ),
    );
  });

  describe('after a person answers it', () => {
    it('offers to revisit the listed decisions settled before, which the answer may change', () => {
      const tiers = decidedAgo(post('Which pricing tiers do we offer?'), 30);
      const site = decidedAgo(post('What does the website promise?'), 20);
      const upstream = decidedAgo(post('Do we open-source at all?'), 40);
      const later = post('Who writes the launch post?');
      const licence = post('Which licence should the core ship under?', {
        dependsOn: [upstream.id],
        affects: [
          { decisionId: tiers.id, why: 'pricing assumes an open core' },
          { decisionId: site.id, why: 'the site names the licence' },
          { decisionId: later.id, why: 'the post announces it' },
        ],
      });
      // Unanswered, there is nothing to revisit.
      assert.deepEqual(mayChange(licence, couldAffect(board(), licence)), []);

      decide(licence, 'b');
      const offered = () => mayChange(licence, couldAffect(board(), licence)).map((a) => a.decision.number);
      // #4 is still open, and #3 is what it rests on: an answer builds on that rather than changing it.
      assert.deepEqual(offered(), [2, 1]);

      // Asked about, a decision leaves the prompt; re-checked since the answer, it stays out.
      store.requestRefresh(tiers.id, revisitNote(licence), wassim);
      assert.deepEqual(offered(), [2]);
      store.updateDecision(tiers.id, { refreshed: true, note: 'Still holds' }, claude);
      assert.deepEqual(offered(), [2]);
      // Settled after the answer, a decision already knew it.
      decide(site, 'b');
      assert.deepEqual(offered(), []);
    });

    it('offers them to the person who answered, for a day', () => {
      const tiers = decidedAgo(post('Which pricing tiers do we offer?'), 30);
      const licence = post('Which licence should the core ship under?', { affects: [{ decisionId: tiers.id, why: 'pricing assumes an open core' }] });
      decide(licence);
      const listed = couldAffect(board(), licence);
      assert.deepEqual(mayChange(licence, listed, 'wassim').map((a) => a.decision.number), [1]);
      assert.deepEqual(mayChange(licence, listed, 'Sam'), [], 'not to someone opening it later');
      const answered = Date.parse(licence.resolution!.at);
      assert.equal(mayChange(licence, listed, 'Wassim', answered + 23 * 3_600_000).length, 1);
      assert.deepEqual(mayChange(licence, listed, 'Wassim', answered + 25 * 3_600_000), [], 'an old answer is left alone');
    });

    it('offers nothing for an answer an agent gave, until a person confirms it', () => {
      const tiers = decidedAgo(post('Which pricing tiers do we offer?'), 30);
      const licence = post('Which licence should the core ship under?', { affects: [{ decisionId: tiers.id, why: 'pricing assumes an open core' }] });
      store.resolve(licence.id, { optionId: 'a', provisional: true }, claude);
      assert.deepEqual(mayChange(licence, couldAffect(board(), licence)), []);
      store.resolve(licence.id, { optionId: 'a' }, wassim);
      assert.deepEqual(mayChange(licence, couldAffect(board(), licence)).map((a) => a.decision.number), [1]);
    });

    it('offers one it rests on when an agent named it too', () => {
      const upstream = decidedAgo(post('Do we open-source at all?'), 40);
      const licence = post('Which licence should the core ship under?', {
        dependsOn: [upstream.id],
        affects: [{ decisionId: upstream.id, why: 'AGPL may scare off contributors' }],
      });
      decide(licence);
      assert.deepEqual(mayChange(licence, couldAffect(board(), licence)).map((a) => a.decision.number), [1]);
    });

    // #93 on the roadmap: six came up, and only one had a real link.
    it('groups what it offers: linked ones likely and ticked to start, a shared area or wording alone less likely', () => {
      const site = decidedAgo(post('What does the website promise?'), 50); // #1, named by an agent
      const tiers = decidedAgo(post('Which pricing tiers do we offer?', { area: 'Launch' }), 40); // #2, a task builds on both
      decidedAgo(post('How should people install Tricot?', { area: 'Launch' }), 30); // #3, the area alone
      decidedAgo(post('Which board opens first when it starts?'), 20); // #4, the wording alone
      const later = decidedAgo(post('Who writes the launch post?'), 10); // #5, depends on it
      const join = post('Which board should the agent join when Tricot starts?', {
        area: 'Launch',
        affects: [{ decisionId: site.id, why: 'the site shows the picker' }],
      });
      store.updateDecision(later.id, { dependsOn: [join.id] }, claude);
      decide(join);
      const [task] = store.planTasks(boardId, [{ title: 'Ship the picker', decisionIds: [join.id, tiers.id] }], claude);

      const offered = mayChange(join, couldAffect(board(), join));
      const { likely, lessLikely } = revisitGroups(offered);
      const why = (listed: Affected[]) => listed.map((a) => `#${a.decision.number} ${a.reasons.map(revisitWhy).join(' · ')}`);
      assert.deepEqual(why(likely), ['#1 the site shows the picker', '#5 depends on this', '#2 a task builds on both · same area']);
      assert.deepEqual(why(lessLikely), ['#3 same area', '#4 similar wording']);
      // The likely ones start ticked; the rest wait for "Select all".
      assert.deepEqual(offered.filter(isLikely).map((a) => a.decision.number), [1, 5, 2]);
      assert.equal(revisitWhy({ kind: 'sharedTask', tasks: [task, task] }), '2 tasks build on both');
    });

    it('asks agents to check the ones picked as one request, a refresh on each card', () => {
      const tiers = decidedAgo(post('Which pricing tiers do we offer?', { options: [{ label: 'Free and Pro' }, { label: 'Per seat' }] }), 30);
      const site = decidedAgo(post('What does the website promise?'), 20);
      const logo = decidedAgo(post('What colour is the logo?'), 10);
      const open = post('Who writes the launch post?');
      const licence = post('Which licence should the core ship under?', {
        options: [{ label: 'MIT' }, { label: 'AGPL-3.0' }],
        affects: [
          { decisionId: tiers.id, why: 'pricing assumes an open core' },
          { decisionId: site.id, why: 'the site names the licence' },
        ],
      });
      const ask = (ids: string[], by: Actor = wassim) => () => store.askToRevisit(licence.id, ids, by);
      assert.throws(ask([tiers.id]), /has no answer standing: decide it before asking agents to check what it may change/);
      decide(licence, 'b');
      const before = store.events(boardId, { order: 'asc' }).length;
      assert.throws(ask([tiers.id], claude), /Only people ask for a refresh/);
      assert.throws(ask([]), /Pick at least one decision to check/);
      assert.throws(ask([tiers.id, 'nope']), /No decision "nope" on this board/);
      assert.throws(ask([licence.id]), /can't be asked to check itself/);
      assert.throws(ask([tiers.id, open.id]), /#4 ".+" is open; only decided and provisional cards are checked against a new answer/);
      assert.equal(tiers.refreshRequest, undefined, 'a refused request asks about none of them');
      assert.equal(store.events(boardId, { order: 'asc' }).length, before);

      const asked = store.askToRevisit(licence.id, [tiers.id, site.id, tiers.id], wassim);
      assert.deepEqual(asked.map((d) => d.number), [1, 2], 'each once');
      // One event, on the decision answered, naming them all.
      const events = store.events(boardId, { order: 'asc' }).slice(before);
      assert.deepEqual(
        events.map((e) => [e.type, e.decisionId, e.summary]),
        [['refresh_requested', licence.id, 'asked agents to check #1 and #2 still hold, after deciding #5 "Which licence should the core ship under?": b) AGPL-3.0']],
      );
      // Each card carries its own request, as one asked alone does, and leaves the prompt.
      for (const d of [tiers, site]) {
        assert.equal(d.status, 'decided');
        assert.deepEqual([d.refreshRequest?.by.name, d.refreshRequest?.text, d.refreshRequest?.after], ['Wassim', revisitNote(licence), licence.id]);
      }
      assert.equal(logo.refreshRequest, undefined);
      assert.deepEqual(mayChange(licence, couldAffect(board(), licence)), []);

      // Agents are told of them together, with ids; one asked alone keeps its own line.
      store.requestRefresh(logo.id, 'Check the logo still fits', wassim);
      assert.equal(
        refreshDigest(board()),
        [
          `Wassim asked you to check #1 [id: ${tiers.id}] and #2 [id: ${site.id}] still hold, after deciding #5 [id: ${licence.id}] (b) AGPL-3.0), which may change them: re-check each against the board and the app as they are now (get_decision says how), then update_decision on each with refreshed: true and a note saying whether it holds.`,
          `Refresh requested on #3 [id: ${logo.id}] by Wassim ("Check the logo still fits"): re-check each against the app as it is now (get_decision says how), then update_decision with refreshed: true.`,
        ].join('\n'),
      );
      assert.match(decisionDetail(board(), tiers), /## Refresh requested\nBy Wassim \(human\) at \S+: "#5 was just decided: b\) AGPL-3\.0\. It may change this one: check it still holds\."\nIt is decided/);

      // An agent answers each as any refresh; the line names those still waiting.
      store.updateDecision(tiers.id, { refreshed: true, note: 'Still holds: Pro stays per seat.' }, claude);
      assert.equal(tiers.refreshRequest, undefined);
      assert.equal(tiers.refreshed?.requestedBy?.name, 'Wassim');
      assert.match(refreshDigest(board()) ?? '', new RegExp(`^Wassim asked you to check #2 \\[id: ${site.id}\\] still holds, after deciding #5 \\[id: ${licence.id}\\] \\(b\\) AGPL-3\\.0\\), which may change it: re-check it .+ update_decision on it with refreshed: true`));
    });

    it('asks agents to check with a note that says what was decided', () => {
      const licence = post('Which licence should the core ship under?', { options: [{ label: 'MIT' }, { label: 'AGPL-3.0' }] });
      decide(licence, 'b');
      assert.equal(revisitNote(licence), '#1 was just decided: b) AGPL-3.0. It may change this one: check it still holds.');
      store.resolve(licence.id, { optionId: 'a', provisional: true }, wassim);
      assert.equal(revisitNote(licence), '#1 was just decided for now: a) MIT. It may change this one: check it still holds.');
    });
  });
});
