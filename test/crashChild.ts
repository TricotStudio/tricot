// A process for sqlite.test.ts to kill: it opens a data folder, makes changes
// without ever flushing, says so, and waits to be killed.
import { Store } from '../src/core/store';

const [dir] = process.argv.slice(2);
const store = new Store(dir);
store.load();
process.emitWarning('a warning of its own'); // must still be printed
const human = { kind: 'human', name: 'Sam' } as const;
const board = store.createBoard({ title: 'Survives a kill' }, human);
const decision = store.postDecision(board.id, { question: 'Still here?', options: [{ label: 'Yes' }] }, { kind: 'agent', name: 'claude' });
store.addBlock({ decisionId: decision.id }, { content: { type: 'note', text: 'Kept' } }, human);
process.stdout.write(`${board.id} ${decision.id}\n`);
setInterval(() => {}, 1000);
