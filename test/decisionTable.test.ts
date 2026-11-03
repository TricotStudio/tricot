import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerOf,
  buildTable,
  builtOn,
  isApproval,
  shortAge,
  shortDate,
  whenOf,
  type TableFilter,
} from '../src/core/decisionTable';
import { decisionsMatching } from '../src/core/search';
import type { Actor, Board, Decision, Option, Task } from '../src/core/types';

const claude: Actor = { kind: 'agent', name: 'Claude' };
const sam: Actor = { kind: 'human', name: 'Sam' };

// Local times, so the dates read the same in any time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const NOW = Date.parse(at(30, 15));

let next = 1;
function decision(question: string, patch: Partial<Decision> = {}): Decision {
  const number = next++;
  return {
    id: `d${number}`,
    number,
    boardId: 'b',
    question,
    options: [],
    status: 'open',
    blocking: false,
    dependsOn: [],
    history: [],
    asks: [],
    criteria: [],
    marks: [],
    comments: [],
    findings: [],
    canvas: { blocks: [], groups: [], links: [], pins: [] },
    createdBy: claude,
    createdAt: at(29, 9),
    updatedAt: at(29, 9),
    ...patch,
  };
}

const option = (id: string, label: string, patch: Partial<Option> = {}): Option => ({
  id,
  label,
  proposedBy: claude,
  createdAt: at(29, 9),
  ...patch,
});

const decided = (question: string, day: number, hour: number, patch: Partial<Decision> = {}) =>
  decision(question, {
    status: 'decided',
    options: [option('a', 'Yes'), option('b', 'No')],
    resolution: { optionId: 'a', by: sam, at: at(day, hour) },
    ...patch,
  });

const numbers = (list: Decision[]) => list.map((d) => d.number);

describe('Decisions table', () => {
  it('tells approvals by their question', () => {
    assert.equal(isApproval(decision('Commit the inbox work?')), true);
    assert.equal(isApproval(decision('  commit T17–T27?')), true);
    assert.equal(isApproval(decision('Should we commit to a date?')), false);
    assert.equal(isApproval(decision('Committee or solo review?')), false);
  });

  it('puts what needs a call first, then decided newest first, then what was set aside', () => {
    const asked = decision('Asked of Sam', { updatedAt: at(28, 9) });
    const blocking = decision('Blocking', { blocking: true, updatedAt: at(28, 10) });
    const exploring = decision('Exploring', { status: 'exploring', updatedAt: at(29, 12) });
    const provisional = decision('Provisional', {
      status: 'provisional',
      resolution: { optionId: 'a', by: claude, at: at(29, 11) },
      updatedAt: at(29, 11),
    });
    const older = decided('Older', 27, 10);
    const newer = decided('Newer', 29, 10);
    const approvalOld = decided('Commit the old work?', 28, 10);
    const approvalNew = decided('Commit the new work?', 30, 10);
    const retired = decision('Retired', { status: 'retired', retirement: { by: sam, at: at(30, 9) } });
    const deferred = decision('Deferred', { status: 'deferred', deferral: { by: sam, at: at(26, 9) } });
    const all = [asked, blocking, exploring, provisional, older, newer, approvalOld, approvalNew, retired, deferred];
    const needsYou = (d: Decision) => d === asked;

    const table = buildTable(all, { filter: 'all', needsYou });
    assert.deepEqual(
      table.sections.map((s) => s.key),
      ['call', 'decided', 'aside'],
    );
    const [call, settled, aside] = table.sections;
    assert.deepEqual(numbers(call.rows), numbers([asked, blocking, exploring, provisional]), 'needs you, then blocking, then latest');
    assert.deepEqual(numbers(settled.rows), numbers([newer, older]), 'newest decided first, approvals left out');
    assert.deepEqual(numbers(settled.approvals), numbers([approvalNew, approvalOld]), 'approvals fold, newest first');
    assert.deepEqual(numbers(aside.rows), numbers([deferred, retired]), 'deferred before retired');
    assert.deepEqual(call.approvals, []);
    assert.deepEqual(table.counts, { all: 10, call: 4, decided: 2, approvals: 2 });
  });

  it('filters by chip, and by a search', () => {
    const open = decision('Open approval: Commit?');
    const openCommit = decision('Commit the sync work?');
    const choice = decided('Which mark?', 29, 10);
    const approval = decided('Commit the mark?', 29, 11);
    const all = [open, openCommit, choice, approval];
    const view = (filter: TableFilter, matches?: Set<string>) =>
      buildTable(all, { filter, needsYou: () => false, matches }).sections.map((s) => [s.key, numbers(s.rows), numbers(s.approvals)]);

    assert.deepEqual(view('call'), [['call', numbers([openCommit, open]), []]], 'an open approval still needs a call');
    assert.deepEqual(view('decided'), [['decided', numbers([choice]), []]], 'Decided leaves the approvals to their chip');
    assert.deepEqual(
      view('approvals'),
      [
        ['call', numbers([openCommit]), []],
        ['decided', numbers([approval]), []],
      ],
      'every approval, shown rather than folded',
    );
    const matches = new Set([choice.id, approval.id]);
    assert.deepEqual(view('all', matches), [['decided', numbers([choice]), numbers([approval])]], 'empty sections drop out');
    assert.deepEqual(buildTable(all, { filter: 'all', needsYou: () => false, matches }).counts, {
      all: 2,
      call: 0,
      decided: 1,
      approvals: 1,
    });
  });

  it('says what was answered, or what is recommended', () => {
    const options = [option('a', 'Core first'), option('b', 'Shells first'), option('c', 'Old idea', { outdated: { by: sam, at: at(29, 9) } })];
    assert.deepEqual(answerOf(decided('Q', 29, 9, { options, resolution: { optionId: 'b', by: sam, at: at(29, 9) } })), {
      kind: 'chosen',
      letter: 'b',
      label: 'Shells first',
    });
    assert.deepEqual(answerOf(decided('Q', 29, 9, { resolution: { answer: '  let’s migrate\n to this name ', by: sam, at: at(29, 9) } })), {
      kind: 'words',
      text: 'let’s migrate to this name',
    });
    assert.deepEqual(answerOf(decision('Q', { options, recommendation: { optionId: 'a', by: claude } })), {
      kind: 'recommended',
      letter: 'a',
      label: 'Core first',
    });
    assert.deepEqual(answerOf(decision('Q', { status: 'exploring', options })), { kind: 'none', text: 'exploring' });
    assert.deepEqual(
      answerOf(decision('Q', { options, recommendation: { optionId: 'c', by: claude } })),
      { kind: 'none', text: '2 options, none recommended' },
      'an outdated option is no recommendation',
    );
    assert.deepEqual(answerOf(decision('Q')), { kind: 'none', text: 'no options yet' });
    assert.deepEqual(answerOf(decision('Q', { status: 'retired', retirement: { text: 'Moot now', by: sam, at: at(29, 9) } })), {
      kind: 'none',
      text: 'retired',
      note: 'Moot now',
    });
    assert.deepEqual(answerOf(decision('Q', { status: 'deferred', deferral: { by: sam, at: at(29, 9) } })), {
      kind: 'none',
      text: 'deferred',
      note: undefined,
    });
  });

  it('lists the tasks built on a decision, and whether it holds them', () => {
    const d = decision('Q');
    const task = (number: number, decisionIds: string[]) => ({ id: `t${number}`, number, decisionIds }) as Task;
    const board = { tasks: [task(9, [d.id]), task(3, [d.id, 'other']), task(5, ['other'])] } as Pick<Board, 'tasks'>;
    const open = builtOn(board, d);
    assert.deepEqual(
      open.tasks.map((t) => t.number),
      [3, 9],
    );
    assert.equal(open.holds, true);
    assert.equal(builtOn(board, { ...d, status: 'decided' }).holds, false);
  });

  it('says who decided and when, or how long a question has waited', () => {
    assert.equal(shortDate(at(30, 14, 6), NOW), '14:06');
    assert.equal(shortDate(at(29, 23, 27), NOW), 'yesterday');
    assert.equal(shortDate(at(3, 9), NOW), 'Oct 3');
    assert.equal(shortDate(new Date(2025, 11, 31, 9).toISOString(), NOW), 'Dec 31, 2025');
    assert.equal(shortAge(at(30, 14, 59), NOW), '1m');
    assert.equal(shortAge(new Date(NOW - 20_000).toISOString(), NOW), null);
    assert.equal(shortAge(at(29, 21), NOW), '18h');
    assert.equal(shortAge(at(27, 15), NOW), '3d');
    assert.equal(shortAge(at(1, 15), NOW), '4w');

    const when = (d: Decision) => whenOf(d, NOW).text;
    assert.equal(when(decided('Q', 30, 14)), 'Sam · 14:00');
    assert.equal(when(decision('Q', { createdAt: at(30, 14) })), 'waiting 1h');
    assert.equal(when(decision('Q', { createdAt: new Date(NOW - 10_000).toISOString() })), 'asked just now');
    const reopened = decision('Q', {
      createdAt: at(20, 9),
      history: [{ status: 'decided', by: sam, at: at(21, 9), ended: 'reopened', endedBy: sam, endedAt: at(30, 13) }],
    });
    assert.equal(when(reopened), 'waiting 2h', 'waiting since it was reopened');
    assert.equal(when(decision('Q', { status: 'exploring', exploreRequest: { by: sam, at: at(29, 21) } })), 'exploring 18h');
    const provisional = decision('Q', { status: 'provisional', resolution: { optionId: 'a', by: claude, at: at(30, 12) } });
    assert.equal(when(provisional), 'to confirm 3h');
    assert.match(whenOf(provisional, NOW).title, /^Decided for now by Claude, Oct 30, 2026 at 12:00/);
    assert.equal(when(decision('Q', { status: 'retired', retirement: { by: sam, at: at(29, 9) } })), 'Sam · yesterday');
  });

  it('filters with the search that finds decisions', () => {
    const board = {
      decisions: [
        decision('How should the backlog work?', { context: 'Triage first' }),
        decided('Which mark?', 29, 9, { resolution: { optionId: 'a', rationale: 'Reads at favicon size', by: sam, at: at(29, 9) } }),
        decision('Commit the sync work?'),
      ],
    } as Board;
    const ids = (q: string) => {
      const found = decisionsMatching(board, q);
      return found && board.decisions.filter((d) => found.has(d.id)).map((d) => d.question);
    };
    assert.deepEqual(ids('backlog'), ['How should the backlog work?']);
    assert.deepEqual(ids('favicon'), ['Which mark?'], 'reasons are searched too');
    assert.deepEqual(ids('triage'), ['How should the backlog work?'], 'and context');
    assert.deepEqual(ids('nothing like it'), []);
    assert.equal(ids('a'), null, 'too short to search: no filter');
  });
});
