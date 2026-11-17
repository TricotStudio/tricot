// A process for sqlite.test.ts to kill: it opens a data folder, makes changes
// without ever flushing, says so, and waits to be killed.
import { CardStore } from './madeUpCards';

const [dir] = process.argv.slice(2);
const store = new CardStore(dir);
store.load();
process.emitWarning('a warning of its own'); // must still be printed
const human = { kind: 'human', name: 'Sam' } as const;
const board = store.createBoard({ title: 'Survives a kill' }, human);
const card = store.postCard(board.id, { title: 'Still here?' }, { kind: 'agent', name: 'claude' });
store.addBlock(store.ref(card), { content: { type: 'note', text: 'Kept' } }, human);
process.stdout.write(`${board.id} ${card.id}\n`);
setInterval(() => {}, 1000);
