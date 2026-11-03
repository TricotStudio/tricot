import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { needsInput } from '../src/core/attention';
import { boardDigest, canvasDigest, decisionDetail, eventsDigest, taskDetail } from '../src/core/digest';
import { readFlowchart } from '../src/core/blocks/diagram/flowchart';
import { pendingAsks } from '../src/core/format';
import { mentionsDigest } from '../src/core/mentions';
import { noteText, placePin, quoteAt } from '../src/core/pins';
import { Store } from '../src/core/store';
import type { Actor, Canvas } from '../src/core/types';
import { jsonFolder, savedBoard } from './savedBoard';
import { eventsOf } from './tables';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const agent: Actor = { kind: 'agent', name: 'planner' };
const sam: Actor = { kind: 'human', name: 'Sam' };

// What a person's selection sends: the words, and the text around them on
// the rendered note.
function selection(rendered: string, words: string, nth = 1) {
  let start = -1;
  for (let i = 0; i < nth; i++) start = rendered.indexOf(words, start + 1);
  assert.ok(start >= 0, `"${words}" is in the rendered note`);
  return { kind: 'text' as const, ...quoteAt(rendered, start, start + words.length)! };
}

describe('Pins', () => {
  let dir: string;
  let store: Store;
  let boardId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'tricot-pins-'));
    store = new Store(dir);
    store.load();
    boardId = store.createBoard({ title: 'Beta launch' }, sam).id;
  });

  afterEach(async () => {
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const note = (text: string, title = 'Where we are') => store.addBlock({ boardId }, { title, content: { type: 'note', text } }, sam);
  const blockOf = (id: string) => store.canvasOf(id).canvas.blocks.find((b) => b.id === id)!;
  const textOf = (id: string) => {
    const block = blockOf(id);
    return block.type === 'note' ? noteText(block.text) : '';
  };
  const summaries = (n: number) => eventsOf(store, boardId).slice(-n).map((e) => e.summary);
  const digest = () => canvasDigest(store.getBoard(boardId), store.getBoard(boardId).canvas);
  const task = (title: string) => store.planTasks(boardId, [{ title }], agent)[0];

  it("turns words a person pins into a backlog task that quotes them and the block they're on", () => {
    const where = note('**Goal:** ship the beta.\n\n- Board and tasks are in\n- Next: onboarding and the docs site');
    // The person selected the words on the rendered note, without its Markdown.
    const rendered = 'Goal: ship the beta.\nBoard and tasks are in\nNext: onboarding and the docs site';
    const { pin, task: created } = store.pinTask(
      where.id,
      selection(rendered, 'onboarding and the docs site'),
      { text: 'Draft the onboarding checklist\nAnd an outline for the docs site.' },
      sam,
    );

    assert.equal(created.title, 'Draft the onboarding checklist');
    assert.equal(created.status, 'backlog');
    assert.equal(
      created.detail,
      'And an outline for the docs site.\n\nPinned from note "Where we are" in the board context:\n> onboarding and the docs site',
    );
    assert.deepEqual([pin.blockId, pin.taskId, pin.quote], [where.id, created.id, 'onboarding and the docs site']);
    const place = placePin(blockOf(where.id), pin);
    assert.ok(place?.kind === 'text');
    assert.equal(textOf(where.id).slice(place.start, place.end), 'onboarding and the docs site');
    assert.deepEqual(summaries(2), [
      'added T1 "Draft the onboarding checklist" to the backlog',
      'pinned "onboarding and the docs site" in note "Where we are" (board context) to T1 "Draft the onboarding checklist"',
    ]);
    assert.equal(eventsOf(store, boardId).at(-1)!.taskId, created.id, "the pin shows in its task's history");
    assert.match(taskDetail(store.getBoard(boardId), created), /## Pinned from\n- "onboarding and the docs site" in note "Where we are" \(board context\) \[block id: \w+\], pinned by Sam \(human\)\n\n## Detail/);
    assert.match(digest(), /  pinned "onboarding and the docs site" → T1 \(backlog\) \[task id: \w+; pin id: \w+\]/);

    const ready = store.pinTask(where.id, selection(rendered, 'ship the beta'), { text: 'Cut the release', ready: true }, sam);
    assert.equal(ready.task.status, 'todo');
    assert.equal(summaries(2)[0], 'added T2 "Cut the release", ready to do');
  });

  it('finds pinned words again by the text around them, through edits elsewhere', () => {
    const plan = note('Then retry the queue, then retry payments.');
    const { pin } = store.pinTask(plan.id, selection('Then retry the queue, then retry payments.', 'retry', 2), { text: 'Cap payment retries' }, sam);
    const pinned = () => {
      const place = placePin(blockOf(plan.id), pin);
      assert.ok(place?.kind === 'text');
      return textOf(plan.id).slice(place.start, place.end + ' payments'.length);
    };
    assert.equal(pinned(), 'retry payments');
    store.updateBlock(plan.id, { text: '## Plan\n\nFirst retry the API. Then retry the _queue_, then retry payments.' }, sam);
    assert.equal(pinned(), 'retry payments', 'it is still the second "retry" it was');

    // An agent names the occurrence instead.
    const first = store.pin(plan.id, { kind: 'text', quote: 'retry', occurrence: 1 }, { taskId: task('Retry the API').id }, agent);
    const place = placePin(blockOf(plan.id), first);
    assert.ok(place?.kind === 'text');
    assert.equal(textOf(plan.id).slice(place.start - 6, place.end), 'First retry');
    assert.throws(() => store.pin(plan.id, { kind: 'text', quote: 'retry', occurrence: 9 }, { taskId: pin.taskId }, agent), /"retry" isn't in note "Where we are" 9 times/);
    assert.throws(() => store.pin(plan.id, { kind: 'text', quote: 'refund' }, { taskId: pin.taskId }, agent), /"refund" isn't in note "Where we are"\. Quote the words exactly/);
  });

  it('shows a pin whose words were edited away as changed, and keeps listing it', () => {
    const where = note('Next: onboarding and the docs site');
    const { pin, task: created } = store.pinTask(where.id, selection('Next: onboarding and the docs site', 'onboarding and the docs site'), { text: 'Draft the docs' }, sam);
    store.updateBlock(where.id, { text: 'Next: the pricing page' }, sam);

    assert.equal(placePin(blockOf(where.id), pin), null);
    assert.equal(store.getBoard(boardId).canvas.pins.length, 1);
    assert.equal(
      summaries(1)[0],
      'updated note "Where we are" in the board context: edited the text; "onboarding and the docs site", pinned to T1, is no longer there',
    );
    assert.match(digest(), /pinned "onboarding and the docs site" \(text changed\) → T1 \(backlog\)/);
    assert.match(taskDetail(store.getBoard(boardId), created), /- "onboarding and the docs site" \(text changed since\) in note "Where we are"/);
  });

  it("pins a task in a note's task list, or words in one, through ticks", () => {
    const launch = note('- [x] Board and tasks\n- [ ] Docs site\n- [ ] Pricing page', 'Launch');
    const rendered = 'Board and tasks\nDocs site\nPricing page';
    assert.equal(textOf(launch.id), rendered, 'the boxes are not words');
    const item = store.pinTask(launch.id, selection(rendered, 'Docs site'), { text: 'Stand up the docs site' }, sam);
    assert.equal(item.pin.quote, 'Docs site');
    const words = store.pinTask(launch.id, selection(rendered, 'Pricing'), { text: 'Set the prices' }, sam);
    assert.deepEqual(placePin(blockOf(launch.id), words.pin), { kind: 'text', start: 26, end: 33 });
    assert.match(summaries(1)[0], /^pinned "Pricing" in note "Launch" \(board context\) to T2/);
    assert.match(digest(), /pinned "Docs site" → T1 \(backlog\)[^\n]*\n  pinned "Pricing" → T2 \(backlog\)/);

    // Ticking its task keeps the pin; an agent's list without the task loses it, and says so.
    store.updateBlock(launch.id, { text: '- [x] Board and tasks\n- [x] Docs site\n- [ ] Pricing page' }, sam);
    assert.deepEqual(placePin(blockOf(launch.id), item.pin), { kind: 'text', start: 16, end: 25 });
    store.updateBlock(launch.id, { items: [{ text: 'Board and tasks' }, { text: 'Pricing page' }] }, agent);
    assert.equal(placePin(blockOf(launch.id), item.pin), null);
    assert.deepEqual(placePin(blockOf(launch.id), words.pin), { kind: 'text', start: 16, end: 23 });
    assert.match(summaries(1)[0], /removed task "Docs site"; "Docs site", pinned to T1, is no longer there$/);
    assert.match(digest(), /pinned "Docs site" \(text changed\) → T1/);
  });

  it('pins table cells, rows and columns, and follows them when rows move', () => {
    const budgets = store.addBlock(
      { boardId },
      { title: 'Retry budgets', content: { type: 'table', columns: ['Service', 'Attempts', 'p95'], rows: [['Payments', '5', '1.8s'], ['Search', '3', '0.4s']] } },
      sam,
    );
    const cell = store.pinTask(budgets.id, { kind: 'cells', rows: [0, 0], columns: [1, 1] }, { text: 'Lower payment retries' }, sam).pin;
    const row = store.pinTask(budgets.id, { kind: 'cells', rows: [1, 1] }, { text: 'Speed up search' }, sam).pin;
    const column = store.pinTask(budgets.id, { kind: 'cells', columns: [2, 2] }, { text: 'Track p95 per service' }, sam).pin;
    assert.deepEqual([cell.quote, row.quote, column.quote], ['Payments · Attempts: 5', 'Search row', 'p95 column']);
    assert.equal(summaries(1)[0], 'pinned p95 column in table "Retry budgets" (board context) to T3 "Track p95 per service"');

    // A row added above moves the pinned rows down with it.
    store.updateBlock(budgets.id, { rows: [['Auth', '2', '0.2s'], ['Payments', '5', '1.8s'], ['Search', '3', '0.4s']] }, sam);
    assert.deepEqual(placePin(blockOf(budgets.id), cell), { kind: 'cells', rows: [1, 1], columns: [1, 1] });
    assert.deepEqual(placePin(blockOf(budgets.id), row), { kind: 'cells', rows: [2, 2], columns: null });

    // Changing the pinned cell, or renaming the pinned column, changes the pin.
    store.updateBlock(budgets.id, { rows: [['Auth', '2', '0.2s'], ['Payments', '6', '1.8s'], ['Search', '3', '0.4s']] }, sam);
    assert.equal(placePin(blockOf(budgets.id), cell), null);
    assert.ok(placePin(blockOf(budgets.id), row));
    store.updateBlock(budgets.id, { columns: ['Service', 'Attempts', 'p99'] }, sam);
    assert.equal(placePin(blockOf(budgets.id), column), null);
    assert.match(digest(), /pinned Payments · Attempts: 5 \(cells changed\) → T1 \(backlog\)/);

    assert.throws(() => store.pinTask(budgets.id, { kind: 'cells', rows: [3, 3] }, { text: 'x' }, sam), /has 3 rows, so rows 4 isn't there/);
    assert.throws(() => store.pinTask(budgets.id, { kind: 'cells' }, { text: 'x' }, sam), /Pin a row, a column or a range of cells/);
  });

  it('pins a whole link card', () => {
    const design = store.addBlock({ boardId }, { title: 'Design file', content: { type: 'link', url: 'https://figma.com/file/abc' } }, sam);
    const { pin } = store.pinTask(design.id, { kind: 'block' }, { text: 'Match the new buttons' }, sam);
    assert.equal(pin.quote, 'Design file');
    assert.equal(summaries(1)[0], 'pinned the whole card in link "Design file" (board context) to T1 "Match the new buttons"');
    assert.match(digest(), /link "Design file" \(Figma\) → https:\/\/figma\.com\/file\/abc .*\n  pinned the whole card → T1 \(backlog\)/);
  });

  it('numbers boxes drawn on an image, kept as fractions of it', () => {
    const signup = store.addBlock({ boardId }, { title: 'Signup screen', content: { type: 'image', assetId: store.saveAsset(PNG) } }, sam);
    const box = { kind: 'box' as const, x: 0.1, y: 0.62, w: 0.333333, h: 0.15 };
    const { pin, task: created } = store.pinTask(signup.id, box, { text: 'Make the button brand green' }, sam);
    assert.deepEqual(pin.anchor, { kind: 'box', x: 0.1, y: 0.62, w: 0.3333, h: 0.15, n: 1 });
    assert.equal(pin.quote, 'box 1');
    assert.equal(created.detail, 'Pinned from image "Signup screen" in the board context:\n> box 1');
    assert.equal(summaries(1)[0], 'pinned box 1 in image "Signup screen" (board context) to T1 "Make the button brand green"');
    assert.deepEqual(placePin(blockOf(signup.id), pin), pin.anchor, 'resizing the block changes nothing: the box is in fractions');
    assert.match(digest(), /image "Signup screen".*\n  \(no caption\)\n  pinned box 1 \(x 0\.1, y 0\.62, w 0\.333, h 0\.15\) → T1 \(backlog\)/);

    // Numbers keep counting: a box keeps its number when an earlier one goes.
    const second = store.pinComment(signup.id, { ...box, y: 0.1 }, 'Is this headline final?', sam).pin;
    assert.equal(second.quote, 'box 2');
    store.removeItem(pin.id, sam);
    const third = store.pinTask(signup.id, box, { text: 'Add a loading state' }, sam).pin;
    assert.equal(third.quote, 'box 3');
    // An agent pinning the same box to the same work again changes nothing.
    const again = store.pin(signup.id, box, { taskId: third.taskId }, agent);
    assert.equal(again, third);
    // Work pinned beside a box people commented on is on that box, with its number.
    const headline = store.postDecision(boardId, { question: 'Final headline?' }, agent);
    const beside = store.pinAlongside(second.id, { decisionId: headline.id }, agent);
    assert.deepEqual([beside.anchor, beside.quote, beside.discussion], [second.anchor, 'box 2', undefined]);
    assert.equal(store.pinAlongside(second.id, { decisionId: headline.id }, agent), beside, 'once');

    assert.throws(() => store.pinTask(signup.id, { ...box, x: 0.8 }, { text: 'x' }, sam), /stays inside it/);
    assert.throws(() => store.pinTask(signup.id, { ...box, w: 0 }, { text: 'x' }, sam), /fractions of the image/);
    assert.throws(() => store.pinTask(note('Hi').id, box, { text: 'x' }, sam), /Boxes are drawn on images; note "Where we are" is a note/);
  });

  it('pins a flowchart node or arrow by its id, and notices when the source drops it', () => {
    const flow = store.addBlock(
      { boardId },
      { title: 'Request flow', content: { type: 'diagram', source: 'flowchart LR\n  C[Client] --> R(Retry)\n  R -->|5xx| A[API]\n  R --> Q[(Queue)]' } },
      sam,
    );
    const node = store.pinTask(flow.id, { kind: 'node', nodeId: 'R' }, { text: 'Cap retries at 3' }, sam);
    assert.deepEqual([node.pin.anchor, node.pin.quote], [{ kind: 'node', nodeId: 'R', label: 'Retry' }, 'Retry']);
    assert.equal(summaries(1)[0], 'pinned node "Retry" in diagram "Request flow" (board context) to T1 "Cap retries at 3"');
    const arrow = store.pinTask(flow.id, { kind: 'arrow', from: 'R', to: 'A' }, { text: 'Back off on 5xx' }, sam);
    assert.deepEqual([arrow.pin.anchor, arrow.pin.quote], [{ kind: 'arrow', from: 'R', to: 'A', n: 0, label: '5xx' }, 'Retry → API']);
    assert.deepEqual(placePin(blockOf(flow.id), arrow.pin), { kind: 'arrow', arrowId: 'L_R_A_0' });
    assert.match(digest(), /pinned node "Retry" \(id R\) → T1 \(backlog\)[^\n]*\n  pinned arrow "Retry → API" \(R --> A, text "5xx"\) → T2/);

    // Re-laid out, relabelled or its id renamed, the node is still found.
    store.updateBlock(flow.id, { source: 'flowchart TB\n  C[Client] --> Retry(Retry)\n  Retry -->|5xx| A[API]' }, sam);
    assert.deepEqual(placePin(blockOf(flow.id), node.pin), { kind: 'node', nodeId: 'Retry' });
    store.updateBlock(flow.id, { source: 'flowchart TB\n  C[Client] --> R(Retry with backoff)\n  R -->|5xx| A[API]' }, sam);
    assert.deepEqual(placePin(blockOf(flow.id), node.pin), { kind: 'node', nodeId: 'R' });
    assert.ok(placePin(blockOf(flow.id), arrow.pin));

    // Taken out of the source, both show as removed, and the edit says so.
    store.updateBlock(flow.id, { source: 'flowchart LR\n  C[Client] --> A[API]' }, sam);
    assert.equal(placePin(blockOf(flow.id), node.pin), null);
    assert.equal(placePin(blockOf(flow.id), arrow.pin), null);
    assert.match(summaries(1)[0], /node "Retry", pinned to T1, is no longer there; arrow "Retry → API", pinned to T2, is no longer there$/);
    assert.match(digest(), /pinned node "Retry" \(id R\) \(node removed\) → T1[^\n]*\n  pinned arrow "Retry → API" \(R --> A, text "5xx"\) \(arrow removed\) → T2/);

    assert.throws(() => store.pinTask(flow.id, { kind: 'node', nodeId: 'R' }, { text: 'x' }, sam), /diagram "Request flow" has no node "R"\. Its nodes: C and A\./);
    assert.throws(() => store.pinTask(flow.id, { kind: 'arrow', from: 'C', to: 'A', n: 1 }, { text: 'x' }, sam), /has 1 arrow from "C" to "A", so arrow 2 isn't there/);
    assert.throws(() => store.pinTask(flow.id, { kind: 'arrow', from: 'A', to: 'C' }, { text: 'x' }, sam), /has no arrow from "A" to "C"/);
    const sequence = store.addBlock({ boardId }, { content: { type: 'diagram', source: 'sequenceDiagram\n  A->>B: hi' } }, sam);
    assert.throws(() => store.pinTask(sequence.id, { kind: 'node', nodeId: 'A' }, { text: 'x' }, sam), /pinned in flowcharts, and untitled diagram isn't one\. Pin the whole diagram instead/);
  });

  it('reads the nodes and arrows of a flowchart as Mermaid draws them', () => {
    const chart = readFlowchart(
      [
        '---\ntitle: Flow\n---',
        'graph TD; A["Gateway [v2]"] & B --> C{{Check}}',
        '%% a comment',
        'C -- on fail --> D[(Queue)] -.-> E>Dead letter]',
        'classDef hot fill:#f96',
        'subgraph S [Workers]',
        '  api-gw:::hot ==> W1@{ shape: rounded, label: "Worker" }',
        'end',
        'C e1@--> D',
        'e1@{ animate: true }',
        'C --> D',
      ].join('\n'),
    );
    assert.ok(chart);
    assert.deepEqual(
      chart.nodes.map((n) => `${n.id}:${n.label}`),
      ['A:Gateway [v2]', 'B:B', 'C:Check', 'D:Queue', 'E:Dead letter', 'api-gw:api-gw', 'W1:Worker'],
    );
    assert.deepEqual(
      chart.arrows.map((a) => `${a.id} ${a.from}>${a.to}#${a.n}${a.label ? ` ${a.label}` : ''}`),
      ['L_A_C_0 A>C#0', 'L_B_C_0 B>C#0', 'L_C_D_0 C>D#0 on fail', 'L_D_E_0 D>E#0', 'L_api-gw_W1_0 api-gw>W1#0', 'e1 C>D#1', 'L_C_D_3 C>D#2'],
    );
    assert.equal(readFlowchart('sequenceDiagram\n  A->>B: hi'), null);
  });

  it('lets people unpin any pin, keeping the work it led to', () => {
    const where = note('Next: onboarding and the docs site');
    const docs = task('Write the docs');
    const theirs = store.pin(where.id, { kind: 'text', quote: 'docs site' }, { taskId: docs.id }, agent);
    const { pin: mine, task: created } = store.pinTask(where.id, selection('Next: onboarding and the docs site', 'onboarding'), { text: 'Onboarding flow' }, sam);

    store.removeItem(theirs.id, sam);
    assert.equal(summaries(1)[0], 'unpinned "docs site" in note "Where we are" (board context) from T1 "Write the docs"');
    assert.equal(eventsOf(store, boardId).at(-1)!.taskId, docs.id, "the unpinning shows in its task's history");
    store.removeItem(mine.id, sam);
    assert.deepEqual(store.getBoard(boardId).canvas.pins, []);
    assert.deepEqual(
      store.getBoard(boardId).tasks.map((t) => t.title),
      ['Write the docs', 'Onboarding flow'],
      'the work stays',
    );
    assert.equal(created.detail, 'Pinned from note "Where we are" in the board context:\n> onboarding', 'and still says where it came from');
    assert.doesNotMatch(taskDetail(store.getBoard(boardId), created), /## Pinned from/);
  });

  it("puts a comment on part of a task's canvas in the task's discussion, quoting the part", () => {
    const work = task('Ship the onboarding flow');
    const plan = store.addBlock({ taskId: work.id }, { title: 'Plan', content: { type: 'note', text: 'Sign-up with email, then a 3-step tour' } }, agent);
    const part = selection('Sign-up with email, then a 3-step tour', 'then a 3-step tour');
    const { pin, comment } = store.pinComment(plan.id, part, 'Is 3 steps too long for mobile?', sam);
    assert.deepEqual([pin.taskId, pin.decisionId, pin.discussion], [undefined, undefined, {}]);
    const { task: after } = store.getTask(work.id);
    assert.deepEqual(after.comments.at(-1), comment);
    assert.deepEqual([comment.author, comment.body, comment.pin], [sam, 'Is 3 steps too long for mobile?', { id: pin.id, quote: '“then a 3-step tour”' }]);
    // One event, the comment, which says what it's about.
    assert.equal(summaries(1)[0], 'commented on T1 "Ship the onboarding flow" about “then a 3-step tour”: "Is 3 steps too long for mobile?"');
    assert.equal(eventsOf(store, boardId).at(-1)!.taskId, work.id);

    // Agents read it as a comment on the task, quote included, and reply in the same thread.
    store.addTaskComment(work.id, 'Each step fits a 390px screen.', agent);
    const detail = taskDetail(store.getBoard(boardId), after);
    assert.match(detail, new RegExp(`## Discussion\n- Sam \\(human\\) at [^ ]+ \\[comment id: \\w+\\] on “then a 3-step tour” \\[pin id: ${pin.id}\\]: Is 3 steps too long for mobile\\?\n- planner \\(agent\\) at [^:]+:\\d+:[\\d.]+Z \\[comment id: \\w+\\]: Each step fits`));
    assert.doesNotMatch(detail, /## Pinned from/, 'a comment pin is not work pinned from the canvas');
    const taskCanvas = () => canvasDigest(store.getBoard(boardId), store.getTask(work.id).task.canvas, undefined, store.getTask(work.id).task);
    assert.match(taskCanvas(), new RegExp(`\n  pinned "then a 3-step tour" → 1 comment in the discussion, quoting it \\[pin id: ${pin.id}\\]`));

    // The same part again adds to its comments; an agent can reply about it by pin too.
    const again = store.pinComment(plan.id, part, 'And skip it for invited users?', sam);
    assert.equal(again.pin, pin);
    store.commentOnPin(pin.id, 'Invited users skip step 1.', agent);
    assert.deepEqual(store.getTask(work.id).task.comments.map((c) => c.pin?.id), [pin.id, undefined, pin.id, pin.id]);
    assert.match(taskCanvas(), /→ 3 comments in the discussion/);
    assert.throws(() => store.resolvePin(pin.id, true, sam), /"then a 3-step tour" has no comment thread to resolve/);

    // Unpinned, the comments stay, still quoting the part.
    store.removeItem(pin.id, sam);
    assert.equal(summaries(1)[0], `unpinned "then a 3-step tour" in note "Plan" (T1's canvas); its comments stay in the discussion`);
    assert.equal(store.getTask(work.id).task.comments[0].pin!.quote, '“then a 3-step tour”');
  });

  it("puts a comment on part of a decision's canvas in its discussion, answering an ask", () => {
    const decision = store.postDecision(boardId, { question: 'Which queue?', options: [{ label: 'SQS' }, { label: 'Kafka' }] }, agent);
    store.askPeople(decision.id, ['Sam'], undefined, agent);
    const sizes = store.addBlock(
      { decisionId: decision.id },
      { title: 'Limits', content: { type: 'table', columns: ['Queue', 'Max message'], rows: [['SQS', '256 KB'], ['Kafka', '1 MB']] } },
      agent,
    );
    const { pin, comment } = store.pinComment(sizes.id, { kind: 'cells', rows: [0, 0], columns: [1, 1] }, 'Is 256 KB enough for exports?', sam);
    assert.deepEqual(comment.pin, { id: pin.id, quote: 'Limits · SQS · Max message: 256 KB' });
    const after = store.getDecision(decision.id).decision;
    assert.equal(after.comments.at(-1)!.id, comment.id);
    assert.ok(after.asks[0].answeredAt, "Sam's comment answers the ask");
    assert.match(summaries(1)[0], /^commented on #1 "Which queue\?" about Limits · SQS · Max message: 256 KB: "Is 256 KB enough/);
    assert.match(decisionDetail(store.getBoard(boardId), after), /## Comments\n- Sam \(human\) at \S+ \[comment id: \w+\] on Limits · SQS · Max message: 256 KB \[pin id: \w+\]: Is 256 KB/);
  });

  it('starts a thread on a pin on the board context, which agents answer and people resolve', () => {
    const where = note('Next: onboarding and the docs site');
    const { pin, comment } = store.pinComment(where.id, selection('Next: onboarding and the docs site', 'docs site'), 'Hosted or our own domain?', sam);
    assert.deepEqual(pin.discussion?.thread, [comment]);
    assert.equal(comment.pin, undefined, 'the thread is the pin’s, so its comments need no quote');
    const event = eventsOf(store, boardId).at(-1)!;
    assert.deepEqual([event.type, event.itemId, event.decisionId, event.taskId], ['comment_added', pin.id, undefined, undefined]);
    assert.equal(event.summary, 'commented on "docs site" in note "Where we are" (board context): "Hosted or our own domain?"');
    assert.equal(store.getBoard(boardId).decisions.length, 0, 'no decision card is posted as the person');
    assert.match(boardDigest(store.getBoard(boardId)), /1 comment thread on the board context waits for a reply: read them in get_canvas\(board_id\)/);
    assert.match(digest(), new RegExp(`\n  pinned "docs site" → comment thread, open \\[pin id: ${pin.id}\\]; reply with comment\\(pin_id\\)\n    - Sam \\(human\\) at \\S+: Hosted or our own domain\\?`));

    // An agent replies in the thread; the person is the one it's for.
    store.commentOnPin(pin.id, 'Hosted: it ships this week.\nOur domain can come later.', agent);
    const reply = eventsOf(store, boardId).at(-1)!;
    assert.equal(reply.itemId, pin.id);
    assert.ok(needsInput(reply, store.getBoard(boardId), 'Sam'));
    assert.ok(!needsInput(reply, store.getBoard(boardId), 'Alex'), 'not for people outside the thread');
    assert.match(digest(), /\n    - planner \(agent\) at \S+: Hosted: it ships this week\.\n      Our domain can come later\./);
    assert.doesNotMatch(boardDigest(store.getBoard(boardId)), /waits for a reply/, 'answered');

    // Only people resolve it; then it goes quiet, and a reply reopens it.
    assert.throws(() => store.resolvePin(pin.id, true, agent), /Only people resolve a comment thread/);
    store.resolvePin(pin.id, true, sam);
    assert.deepEqual(pin.discussion!.resolved?.by, sam);
    assert.equal(summaries(1)[0], 'resolved the comment thread on "docs site" in note "Where we are" (board context)');
    assert.match(digest(), /pinned "docs site" → comment thread, resolved by Sam \(human\), 2 comments \[pin id: \w+\]$/);
    assert.equal(store.resolvePin(pin.id, true, sam), pin, 'resolving again changes nothing');
    store.commentOnPin(pin.id, 'One more thing: the docs need search.', sam);
    assert.equal(pin.discussion!.resolved, undefined);
    assert.equal(pin.discussion!.thread!.length, 3);

    // Work pinned to it can't take comments by pin: they go on the work.
    const docs = task('Write the docs');
    const linked = store.pin(where.id, { kind: 'text', quote: 'docs site' }, { taskId: docs.id }, agent);
    assert.throws(() => store.commentOnPin(linked.id, 'x', agent), /That pin links "docs site" to T1; comment on it with task_id \w+\./);
    assert.throws(() => store.commentOnPin(pin.id, '  ', agent), /comment must not be empty/);

    // Removing the pin removes its thread, and says so.
    store.removeItem(pin.id, sam);
    assert.equal(summaries(1)[0], 'removed the comment thread on "docs site" in note "Where we are" (board context), with its 3 comments');
  });

  it('asks the board a question about words a person pins: a decision quoting them, linked to them', () => {
    const where = note('Next: onboarding and the docs site');
    const part = selection('Next: onboarding and the docs site', 'docs site');
    const { pin, decision } = store.pinQuestion(where.id, part, { text: 'Docs on our own domain?\nHosting is free, but the domain is ours.' }, sam);

    assert.equal(decision.question, 'Docs on our own domain?');
    assert.equal(decision.context, 'Hosting is free, but the domain is ours.\n\nPinned from note "Where we are" in the board context:\n> docs site');
    assert.deepEqual([decision.status, decision.options, decision.createdBy, decision.comments], ['open', [], sam, []]);
    assert.deepEqual([pin.blockId, pin.decisionId, pin.taskId, pin.quote], [where.id, decision.id, undefined, 'docs site']);
    assert.deepEqual(summaries(2), [
      'asked #1 "Docs on our own domain?"',
      'pinned "docs site" in note "Where we are" (board context) to #1 "Docs on our own domain?"',
    ]);
    assert.equal(eventsOf(store, boardId).at(-1)!.decisionId, decision.id, "the pin shows in its decision's history");
    assert.match(digest(), /pinned "docs site" → #1 \(open\) \[decision id: \w+; pin id: \w+\]/);
    assert.match(decisionDetail(store.getBoard(boardId), decision), /## Pinned from\n- "docs site" in note "Where we are" \(board context\)/);
    assert.throws(() => store.commentOnPin(pin.id, 'x', sam), /comment on it with decision_id/);

    // A prompt with nothing in it asks nothing, and changes nothing.
    assert.throws(() => store.pinQuestion(where.id, part, { text: ' \n ' }, sam), /prompt must not be empty/);
    assert.equal(store.getBoard(boardId).decisions.length, 1);
    assert.equal(store.getBoard(boardId).canvas.pins.length, 1);
  });

  it('asks the people a pinned question mentions, and puts it to the agent it mentions in a first comment', () => {
    store.presentAgents = () => ['Codex', 'Claude'];
    const priya: Actor = { kind: 'human', name: 'Priya' };
    store.addTaskComment(task('Warm up').id, 'Hi', priya); // Priya is one of the board's people now
    const where = note('The export should include closed cards, or only what is still open.', 'Exporting a board');
    const part = selection('The export should include closed cards, or only what is still open.', 'include closed cards');

    // Only a person mentioned: they're asked, and there's no comment.
    const asked = store.pinQuestion(where.id, part, { text: '@priya Closed cards in the export?' }, sam).decision;
    assert.equal(asked.question, 'Closed cards in the export?', 'the mentions that open it only say who it is for');
    assert.deepEqual(pendingAsks(asked).map((a) => [a.name, a.by.name]), [['Priya', 'Sam']]);
    assert.deepEqual(asked.comments, []);
    assert.deepEqual(summaries(3), [
      'asked #1 "Closed cards in the export?"',
      'asked Priya about #1 "Closed cards in the export?"',
      'pinned "include closed cards" in note "Exporting a board" (board context) to #1 "Closed cards in the export?"',
    ]);

    // A person and an agent: the person is asked, and the prompt is the card's first comment, for the agent.
    const cursor = store.getBoard(boardId).seq;
    const text = '@Priya @Codex Should the export include closed cards?\nSam wants everything for the record.';
    const { decision } = store.pinQuestion(where.id, part, { text }, sam);
    assert.equal(decision.question, 'Should the export include closed cards?');
    assert.match(decision.context!, /^Sam wants everything for the record\.\n\nPinned from note "Exporting a board"/);
    assert.deepEqual(pendingAsks(decision).map((a) => a.name), ['Priya']);
    assert.deepEqual(
      decision.comments.map((c) => [c.author, c.body, c.mentions]),
      [[sam, text, ['Priya', 'Codex']]],
    );
    assert.deepEqual(summaries(4), [
      'asked #2 "Should the export include closed cards?"',
      'asked Priya about #2 "Should the export include closed cards?"',
      'pinned "include closed cards" in note "Exporting a board" (board context) to #2 "Should the export include closed cards?"',
      'commented on #2 "Should the export include closed cards?": "@Priya @Codex Should the export include closed cards? Sam wants everything for the record."',
    ]);
    const board = store.getBoard(boardId);
    assert.equal(
      mentionsDigest(board, 'Codex'),
      // Whole, its lines kept.
      `Sam asked you on #2 [decision id: ${decision.id}]: "Should the export include closed cards?\n  Sam wants everything for the record.". Reply with comment(decision_id: ${decision.id}).`,
    );
    assert.equal(mentionsDigest(board, 'Claude'), undefined);
    const updates = (viewer: string) => eventsDigest(store.eventsSince(boardId, cursor), board.seq, { board, viewer });
    assert.match(updates('Codex'), /Sam \(human\) asked you on #2 \[decision id: \w+\]: "Should the export/);
    assert.match(updates('Claude'), /Sam \(human\) asked Codex on #2 \[decision id: \w+\]\. Not for you; carry on\./);
  });

  it('links a task pinned on a settled decision to that decision', () => {
    const decision = store.postDecision(boardId, { question: 'Which queue?', options: [{ label: 'SQS' }, { label: 'Kafka' }] }, agent);
    const evidence = store.addBlock({ decisionId: decision.id }, { content: { type: 'note', text: 'SQS caps messages at 256 KB.' } }, agent);
    const part = selection('SQS caps messages at 256 KB.', '256 KB');
    assert.deepEqual(store.pinTask(evidence.id, part, { text: 'Measure our payload sizes' }, sam).task.decisionIds, []);
    store.resolve(decision.id, { optionId: 'a' }, sam);
    const { task: built } = store.pinTask(evidence.id, part, { text: 'Split payloads over 256 KB' }, sam);
    assert.deepEqual(built.decisionIds, [decision.id]);
    const event = eventsOf(store, boardId).at(-1)!;
    assert.deepEqual([event.decisionId, event.taskId], [decision.id, built.id]);
    assert.match(event.summary, /in note "SQS caps messages at 256 KB\." \(#1's canvas\) to T2/);
  });

  it('lets agents link existing work, once, and keeps people’s pins theirs', () => {
    const where = note('Next: onboarding and the docs site');
    const docs = task('Write the docs');
    const pin = store.pin(where.id, { kind: 'text', quote: 'docs site' }, { taskId: docs.id }, agent);
    assert.equal(store.pin(where.id, { kind: 'text', quote: 'docs site' }, { taskId: docs.id }, agent), pin, 'pinning it again changes nothing');
    assert.throws(() => store.pin(where.id, { kind: 'text', quote: 'docs site' }, {}, agent), /exactly one/);
    assert.throws(() => store.pin(where.id, { kind: 'block' }, { taskId: 'nope' }, agent), /No task "nope" on this board/);

    const mine = store.pinTask(where.id, selection('Next: onboarding and the docs site', 'onboarding'), { text: 'Onboarding flow' }, sam).pin;
    assert.throws(() => store.removeItem(mine.id, agent), /Sam made that pin, so only a person removes it/);
    store.removeItem(pin.id, agent);
    assert.equal(summaries(1)[0], 'unpinned "docs site" in note "Where we are" (board context) from T1 "Write the docs"');

    store.removeItem(where.id, sam);
    assert.equal(summaries(1)[0], 'removed note "Where we are" in the board context, with its pin to T2');
    assert.deepEqual(store.getBoard(boardId).canvas.pins, []);
    assert.throws(() => store.removeItem(mine.id, sam), /No canvas block, group, link or pin/);
  });

  it('loads boards saved before pins existed', async () => {
    note('Old note');
    await store.flush();
    const saved = savedBoard(dir, boardId);
    delete (saved.canvas as Partial<Canvas>).pins;
    const old = jsonFolder(saved);
    const reloaded = new Store(old);
    reloaded.load();
    assert.deepEqual(reloaded.getBoard(boardId).canvas.pins, []);
    await reloaded.flush();
    rmSync(old, { recursive: true, force: true });
  });

  it('reads a note the way it renders, near enough to find words in', () => {
    assert.equal(
      noteText('# Plan\n\n- **Goal:** ship\n1. See [the docs](https://x.test) and <https://y.test>\n> quoted \\*text\\* &amp; more\n\n---\n```\ncode\n```'),
      'Plan\n\n**Goal:** ship\nSee the docs and https://y.test\nquoted *text* & more\n\ncode',
    );
  });
});
