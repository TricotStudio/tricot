// A process for changes.test.ts: it makes a burst of changes the way the server
// does, saved a moment later in one write (not as in the tests, where every call
// is saved and checked), and says what viewers were sent.
import { Store } from '../src/core/store';
import { peoplesCopy } from '../src/server/api';

const [dir] = process.argv.slice(2);
const store = new Store(dir);
store.load();
const human = { kind: 'human', name: 'Sam' } as const;
const agent = { kind: 'agent', name: 'claude' } as const;
const wire = (value: unknown) => JSON.parse(JSON.stringify(value, peoplesCopy));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const board = store.createBoard({ title: 'A burst' }, human);
const first = store.postDecision(board.id, { question: 'First?', options: [{ label: 'Yes' }] }, agent);
await sleep(300);

const before = wire({ ...store.getBoard(board.id), ver: store.changeVersion(board.id) });
const changes: unknown[] = [];
store.subscribeChanges(board.id, (change) => changes.push(wire(change)));
store.addComment(first.id, 'One', human);
store.postDecision(board.id, { question: 'Second?', options: [{ label: 'No' }] }, agent);
store.addComment(first.id, 'Two', human);
await sleep(300);
const after = wire({ ...store.getBoard(board.id), ver: undefined });
process.stdout.write(JSON.stringify({ before, after, changes }));
await store.flush();
process.exit(0);
