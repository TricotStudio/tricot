import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import type { Board } from '../src/core/types';
import { defineTool, text, type Tool } from '../src/server/mcp/tool';
import { ToolGroups } from '../src/server/mcp/toolGroups';
import type { ToolContext } from '../src/server/mcp/tools/context';
import { Phrases, compose, describedIn, plain, type Edit, type Phrasing, type Piece } from '../src/server/mcp/words';

// What the board's own tools say, in named pieces (src/server/mcp/words.ts): the core says what is true without
// a part, and a tool group places its own pieces among them. test/canvasAgent.test.ts shows a server with no group tells
// none of a part's words, and a part's own goldens that its group makes every text read as it did.

const PIECES: Piece[] = [
  ['open', 'Open a thread'],
  ['kind', ': a risk, a question.'],
  ['end', ' Replies come later.'],
];
const edit = (name: string, text: string, position: Partial<Edit>): Edit => ({ name, text, ...position });
const given = (group: string, ...edits: Edit[]) => edits.map((of) => ({ group, of }));

describe('A text in named pieces', () => {
  it('reads as its pieces joined as written, and as a plain string where it is one', () => {
    assert.equal(plain(PIECES), 'Open a thread: a risk, a question. Replies come later.');
    assert.equal(plain('one piece'), 'one piece');
    assert.equal(compose('x', PIECES, []), plain(PIECES));
    assert.equal(compose('x', 'one piece', []), 'one piece');
  });

  it('puts a group\'s piece before, after or in place of a piece of the core\'s, inside a sentence as well as between two', () => {
    const edits = given(
      'extra',
      edit('what', " that isn't a decision yet", { after: 'open' }),
      edit('first', 'Please. ', { before: 'open' }),
      edit('others', ' And others.', { after: 'kind' }),
      edit('later', ' Replies come in a thread.', { replaces: 'end' }),
    );
    assert.equal(compose('x', PIECES, edits), "Please. Open a thread that isn't a decision yet: a risk, a question. And others. Replies come in a thread.");
  });

  it('keeps pieces that take the same place in the order they were given, the groups\' in the order they were added', () => {
    const edits = [...given('one', edit('a', ' A.', { after: 'kind' }), edit('b', ' B.', { after: 'kind' })), ...given('two', edit('c', ' C.', { after: 'kind' }))];
    assert.equal(compose('x', PIECES, edits), 'Open a thread: a risk, a question. A. B. C. Replies come later.');
  });

  it('lets one group say a piece in several of its own, and refuses a second group that does', () => {
    const several = given('extra', edit('a', 'X', { replaces: 'kind' }), edit('b', 'Y', { replaces: 'kind' }));
    assert.equal(compose('x', PIECES, several), 'Open a threadXY Replies come later.');
    assert.throws(() => compose('x', PIECES, [...given('extra', edit('a', 'X', { replaces: 'kind' })), ...given('other', edit('b', 'Y', { replaces: 'kind' }))]), /tool groups extra and other both replace kind of x/);
  });

  it('refuses a mistake in a group where the text is made, naming the group', () => {
    const cases: [string, Edit, RegExp][] = [
      ['no position', edit('a', 'X', {}), /tool group extra gives its entry a no position: say one of before, after, replaces/],
      ['two positions', edit('a', 'X', { before: 'open', after: 'end' }), /tool group extra gives its entry a 2 positions \(before, after\)/],
      ['a piece that is none', edit('a', 'X', { after: 'nowhere' }), /tool group extra puts its entry a of x after nowhere, which is none of the core's/],
      ['a name the core has', edit('end', 'X', { after: 'open' }), /Two entries of x are named end: the core and the tool group extra/],
    ];
    for (const [what, bad, said] of cases) assert.throws(() => compose('x', PIECES, given('extra', bad)), said, what);
    assert.throws(() => compose('x', [...PIECES, ['open', 'again']], []), /Two pieces of x are named open/);
    assert.throws(() => compose('x', 'one piece', given('extra', edit('a', 'X', { after: 'open' }))), /tool group extra edits x, which the core says in one piece/);
  });
});

describe('The groups\' phrasing for a session', () => {
  afterEach(() => mock.restoreAll());

  const phrasing = (extra: Phrasing): Phrasing => extra;
  const phrases = (...contributions: [string, Phrasing][]) => new Phrases(contributions.map(([group, each]) => ({ group, phrasing: each })));

  it('says a text with the edits of every group registered for its id, and as the core does with none', () => {
    const said = phrases(['extra', phrasing({ edits: { 'start_thread.description': [edit('what', ' (a decision)', { after: 'open' })] } })]);
    assert.equal(said.say('start_thread.description', PIECES), 'Open a thread (a decision): a risk, a question. Replies come later.');
    assert.equal(said.say('another.description', PIECES), plain(PIECES), 'a text no group edits');
    assert.equal(new Phrases().say('start_thread.description', PIECES), plain(PIECES));
  });

  it("gives a sentence a group makes for the call at hand, and none when no group gives it; two groups can't give one", () => {
    const said = phrases(['extra', phrasing({ lines: { 'take_request.decision': ({ id }) => `Post it as ${id}.` } })]);
    assert.equal(said.line('take_request.decision', { id: 'r1' }), 'Post it as r1.');
    assert.equal(said.line('take_request.tasks', { id: 'r1' }), undefined);
    assert.equal(new Phrases().line('take_request.decision', { id: 'r1' }), undefined);
    const both = { lines: { same: () => 'x' } };
    assert.throws(() => phrases(['one', both], ['two', both]), /tool groups one and two both give the sentence same/);
  });

  it("gives a part of a digest the core leaves out and says what a group offers, and neither when no group does; two groups can't give one part", () => {
    const board = { id: 'b1' } as Board;
    const said = phrases(['extra', phrasing({ parts: { context: (given, viewer) => `Context of ${given.id} for ${viewer}.`, quiet: () => undefined }, offers: ['board-context'] })]);
    assert.equal(said.part('context', board, 'Claude'), 'Context of b1 for Claude.');
    assert.equal(said.part('quiet', board), undefined, 'a part with nothing to say');
    assert.equal(said.part('sync', board), undefined, 'a part no group gives');
    assert.equal(said.offers('board-context'), true);
    assert.equal(said.offers('other'), false);
    assert.equal(new Phrases().part('context', board), undefined);
    assert.equal(new Phrases().offers('board-context'), false);
    const both = { parts: { same: () => 'x' } };
    assert.throws(() => phrases(['one', both], ['two', both]), /tool groups one and two both give the part same/);
  });

  it("adds an argument at a position among the core's, replaces one, and describes an edited argument anew", () => {
    const shape = {
      pin_id: describedIn(z.string().optional(), [['pin', 'The part']]),
      body: z.string(),
      then_wait: z.number().optional(),
    };
    const said = phrases([
      'extra',
      phrasing({
        edits: { 'comment.pin_id': [edit('work', ', e.g. a decision', { after: 'pin' })] },
        params: {
          comment: [
            { name: 'task_id', schema: z.string().optional(), before: 'pin_id' },
            { name: 'decision_id', schema: z.string().optional(), before: 'pin_id' },
            { name: 'thread_id', schema: z.string().optional(), after: 'body' },
            { name: 'then_wait', schema: z.number().int().optional(), replaces: 'then_wait' },
          ],
        },
      }),
    ]);
    const made = said.shape('comment', shape);
    assert.deepEqual(Object.keys(made), ['task_id', 'decision_id', 'pin_id', 'body', 'thread_id', 'then_wait']);
    assert.equal(made.pin_id.description, 'The part, e.g. a decision');
    assert.equal(shape.pin_id.description, 'The part', 'the core\'s own is left as it was');
    assert.notEqual(made.then_wait, shape.then_wait, 'one that stands in for the core\'s');
    assert.deepEqual(Object.keys(new Phrases().shape('comment', shape)), ['pin_id', 'body', 'then_wait']);
    assert.throws(
      () => phrases(['extra', phrasing({ edits: { 'comment.body': [edit('x', ' more', { after: 'a' })] } })]).shape('comment', shape),
      /tool group extra edits comment.body, which the core describes in one piece/,
    );
    assert.throws(() => phrases(['extra', phrasing({ params: { comment: [{ name: 'body', schema: z.string(), after: 'body' }] } })]).shape('comment', shape), /Two entries of the arguments of comment are named body/);
  });
});

describe('The groups\' phrasing in the tools a session lists', () => {
  afterEach(() => mock.restoreAll());

  const board = (): Tool[] => [
    defineTool({
      name: 'ask',
      title: 'Ask',
      description: PIECES,
      guide: { topic: 'conversation', text: [['guide', 'Ask well.']] },
      schema: { note: describedIn(z.string().optional(), [['note', 'What to ask']]) },
      handler: async () => text('done'),
    }),
    defineTool({ name: 'plain', title: 'Plain', description: 'Says it as one text.', handler: async () => text('done') }),
  ];
  const context = {} as ToolContext;

  it("lists a board tool with the group's pieces in its description, its guide and its arguments, and the group's tools beside it", () => {
    const groups = new ToolGroups();
    groups.add({
      id: 'extra',
      tools: () => [defineTool({ name: 'extra', title: 'Extra', description: 'Its own.', handler: async () => text('done') })],
      after: 'ask',
      phrasing: () => ({
        edits: {
          'ask.description': [edit('what', ' (a decision)', { after: 'open' })],
          'ask.guide': [edit('more', ' Or plan a task.', { after: 'guide' })],
          'ask.note': [edit('more', ' (or a decision)', { after: 'note' })],
        },
        params: { ask: [{ name: 'decision_id', schema: z.string().optional(), after: 'note' }] },
      }),
    });
    const { tools } = groups.compose(board(), context);
    assert.deepEqual(tools.map((tool) => tool.name), ['ask', 'extra', 'plain']);
    assert.equal(tools[0].description, 'Open a thread (a decision): a risk, a question. Replies come later.');
    assert.equal(tools[0].guide!.text, 'Ask well. Or plan a task.');
    assert.deepEqual(Object.keys(tools[0].schema!), ['note', 'decision_id']);
    assert.equal(tools[0].schema!.note.description, 'What to ask (or a decision)');
    assert.equal(tools[2].description, 'Says it as one text.');
    // With no group, the core's own.
    const bare = new ToolGroups().compose(board(), context).tools;
    assert.equal(bare[0].description, plain(PIECES));
    assert.equal(bare[0].guide!.text, 'Ask well.');
    assert.deepEqual(Object.keys(bare[0].schema!), ['note']);
  });

  it('refuses arguments for a tool the board does not have, which is a mistake in Tricot', () => {
    const groups = new ToolGroups();
    groups.add({ id: 'extra', tools: () => [], phrasing: () => ({ params: { nowhere: [{ name: 'x', schema: z.string(), after: 'y' }] } }) });
    assert.throws(() => groups.compose(board(), context), /A tool group adds arguments to nowhere, which is no tool of the board/);
  });

  it('leaves out a group whose phrasing cannot be built, serves the rest, and says why once', () => {
    const said = mock.method(console, 'error', () => {});
    const boom = new Error('boom');
    const groups = new ToolGroups();
    groups.add({ id: 'broken', tools: () => [], phrasing: () => { throw boom; } });
    groups.add({ id: 'fine', tools: () => [], phrasing: () => ({ edits: { 'ask.description': [edit('what', '!', { after: 'end' })] } }) });
    for (let session = 0; session < 3; session++) assert.equal(groups.compose(board(), context).tools[0].description, `${plain(PIECES)}!`);
    assert.equal(said.mock.callCount(), 1, 'three sessions, one line in the output');
    assert.match(String(said.mock.calls[0].arguments[0]), /tool group broken could not build its phrasing/);
    assert.equal(said.mock.calls[0].arguments[1], boom);
  });
});
