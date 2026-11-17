import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import path from 'node:path';
import { Store } from '../src/core/store';
import { DATABASE_FILE } from '../src/core/store/databaseFile';
import { openPrivate } from '../src/core/store/sqlite';
import type { PairingSession } from '../src/core/pairing';
import type { Actor } from '../src/core/types';
import { CardStore, TICKETS, cardPart } from './madeUpCards';

// One broad scenario that records the core's own kinds of event and those of a made-up kind of card (test/madeUpCards.ts),
// with the date held still and the ids made by a counter, so two runs of the same code agree to the byte. What `record`
// writes to the events table, what a board returns of its events and what a reloaded board is are held to the golden
// test/recordSubjects.digest.txt by recordSubjects.test.ts. A part's own events (decisions, tasks, first looks) are the
// scenario of its own, whose golden was made on the code before events named their subjects; this golden was made on the
// code as it was then, so it holds the core's events from here on.
//
// Three Stores are driven, one after the other, each with its own folder:
// - a Store with a made-up kind of card, through boards, the board context, requests, tickets, Sketchbook pages and canvases;
// - a Store whose part has the lists and owner of that kind and no kind of card, as Canvas's part is for a part's;
// - a Store with no part, which records only the core's own events.

const sam: Actor = { kind: 'human', name: 'Sam' };
const kim: Actor = { kind: 'human', name: 'Kim' };
const claude: Actor = { kind: 'agent', name: 'Claude' };
const codex: Actor = { kind: 'agent', name: 'Codex' };

const START = Date.parse('2026-11-10T09:00:00.000Z');
const passTime = (ms = 60_000): void => mock.timers.tick(ms);

// The date held still and moved by hand, and the ids a counter makes: both until `release`.
function hold(): () => void {
  mock.timers.enable({ apis: ['Date'], now: START });
  let n = 0;
  const bytes = mock.method(globalThis.crypto, 'getRandomValues', <T extends ArrayBufferView>(array: T): T => {
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < view.length; i++) view[i] = (n = (n * 1103515245 + 12345) & 0x7fffffff) >> 16;
    return array;
  });
  return () => {
    bytes.mock.restore();
    mock.timers.reset();
  };
}

export interface Digest {
  lines: string[]; // one per stored event: store, board, seq, type, and a short hash of the row's body
  total: string; // a hash of everything the run produced
  types: string[]; // the distinct event types the run recorded
  shapes: string[]; // the distinct key orders the stored bodies have, with what each was found on
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');


// The scenario of a Store with the made-up kind of card. Returns the ids of its boards, for the digest to read by.
async function cardStore(store: CardStore): Promise<string[]> {
  store.load();
  store.presentAgents = () => ['Claude', 'Codex'];
  const board = store.createBoard({ title: 'Shop', goal: 'Take card payments' }, sam);
  const b = board.id;
  const other = store.createBoard({ title: 'Elsewhere' }, kim);
  passTime();
  store.updateBoard(b, { title: 'The shop', goal: 'Take card payments, and refunds' }, sam);
  store.setStanding(b, 'Checkout takes card payments through Stripe.', claude);
  store.setArchived(other.id, true, kim);
  passTime();
  store.setArchived(other.id, false, kim);
  store.announceSeats('Sam let a browser act for them', sam);
  passTime();

  // The board context: a note, a thread on a pin of it, a sync asked for, cancelled, asked again and finished.
  const note = store.addBlock({ boardId: b }, { title: 'Where we are', content: { type: 'note', text: 'Goal: card payments.\n\nNext: the checkout page.' } }, sam);
  const second = store.addBlock({ boardId: b }, { title: 'Risks', content: { type: 'note', text: 'Chargebacks.' } }, claude);
  const pin = store.pinComment(note.id, { kind: 'text', quote: 'Goal' }, 'Is this still the goal?', sam).pin;
  store.commentOnPin(pin.id, 'Yes, still the goal.', claude);
  store.resolvePin(pin.id, true, sam);
  store.resolvePin(pin.id, false, sam);
  const group = store.addGroup({ boardId: b }, { title: 'Context' }, sam);
  store.renameGroup(group.id, 'Where things stand', sam);
  const link = store.addLink(note.id, second.id, 'leads to', sam);
  store.relabelLink(link.id, 'is followed by', sam);
  store.updateBlock(note.id, { title: 'Where we are now' }, sam, note.rev);
  store.updateBlock(note.id, { text: 'Goal: card payments.\n\nNext: receipts.' }, sam);
  store.restoreBlock(note.id, 1, sam);
  store.deleteEarlierVersions(note.id, sam);
  store.requestSync(b, undefined, sam);
  store.cancelSync(b, sam);
  store.requestSync(b, [note.id], sam);
  store.finishSync(b, 'Done.', claude);
  passTime();

  // Requests on the board context: taken and finished, and one cancelled.
  const first = store.askAgents(b, 'Get me an architecture view of the project', sam);
  const named = store.askAgents(b, '@Codex draw the payment flow', kim);
  const taken = store.takeRequest(first.id, claude, 'Architecture');
  store.addBlock({ boardId: b }, { title: 'Architecture', content: { type: 'note', text: 'Server, store, page.' }, groupId: taken.group?.id }, claude);
  store.finishRequest(first.id, 'Drew it.', claude);
  store.takeRequest(named.id, codex);
  store.cancelRequest(named.id, kim);
  passTime();

  // Tickets, the made-up kind of card: posted, discussed, changed, with a canvas, a pin and a reaction on it.
  const provider = store.postCard(b, { title: 'Which provider?', detail: 'Fees and payouts.' }, claude);
  const currencies = store.postCard(b, { title: 'Which currencies?' }, claude);
  store.postCard(other.id, { title: 'Unrelated' }, kim);
  passTime();
  store.commentOnCard(provider.id, 'Stripe has the better docs. @Codex can you check the fees?', sam);
  store.commentOnCard(provider.id, 'Fees checked.', codex);
  store.commentOnCard(provider.id, '@Claude the volume tiers?', codex);
  store.commentOnCard(provider.id, '@Codex they start at 10k.', claude);
  store.updateCard(provider.id, { title: 'Which payment provider?', detail: 'Fees, payouts and refunds.' }, sam);
  store.updateCard(currencies.id, { title: 'Which currencies do we take?' }, claude);
  const fees = store.addBlock(store.ref(provider), { title: 'Fee table', content: { type: 'note', text: 'Stripe 1.4% + 25c. Adyen 0.6% + 11c.' } }, claude);
  store.addBlock(store.ref(provider), { title: 'Option note', content: { type: 'note', text: 'Cost.' } }, claude);
  const feesPin = store.pinComment(fees.id, { kind: 'text', quote: 'Adyen' }, 'Check the volume tiers.', sam).pin;
  store.commentOnPin(feesPin.id, 'They start at 10k.', claude);
  const comment = store.commentOnCard(provider.id, 'The volume tiers start at 10k.', claude);
  void comment;
  passTime();

  // The Sketchbook: a page with notes, a group, links, a code block and pins; asks about it; pairing on it.
  const page = store.addPage(b, 'Checkout flow', sam);
  const pageNote = store.addBlock({ pageId: page.id }, { title: 'Steps', content: { type: 'note', text: 'Cart, address, pay.' } }, claude);
  const pageTable = store.addBlock({ pageId: page.id }, { title: 'Costs', content: { type: 'table', columns: ['Step', 'Cost'], rows: [['Cart', '1'], ['Pay', '2']] } }, claude);
  const code = store.addBlock({ pageId: page.id }, { title: 'retry.ts', content: { type: 'code', path: 'src/retry.ts', text: 'export const retry = 3;\nexport const wait = 10;\n' } }, claude);
  const pageGroup = store.addGroup({ pageId: page.id }, { title: 'Open ideas' }, claude);
  store.renameGroup(pageGroup.id, 'Ideas', sam);
  const pageLink = store.addLink(pageNote.id, pageTable.id, undefined, sam);
  store.updateBlock(pageNote.id, { text: 'Cart, pay, receipt.' }, claude, pageNote.rev);
  store.moveItems({ pageId: page.id }, [{ id: pageTable.id, x: 400, y: 40 }], sam);
  store.moveItems({ pageId: page.id }, [{ id: pageNote.id, x: 20, y: 20, groupId: pageGroup.id }], sam);
  store.moveItems({ pageId: page.id }, [{ id: pageNote.id, x: 60, y: 60, groupId: null }], sam);
  const pagePin = store.pinComment(pageNote.id, { kind: 'text', quote: 'pay' }, 'Do we need the address step?', sam).pin;
  store.commentOnPin(pagePin.id, 'Only for shipped goods.', claude);
  const codePin = store.pinComment(code.id, { kind: 'line', file: 'src/retry.ts', line: 1 }, 'Make it five.', sam, { ask: true }).pin;
  passTime();
  const pageAsk = store.askOnPage(page.id, { text: 'Draw this as a flow', blockIds: [pageNote.id] }, sam);
  const pageTaken = store.takeRequest(pageAsk.id, claude);
  store.addBlock({ pageId: page.id }, { title: 'The flow', content: { type: 'note', text: 'Cart, pay.' }, groupId: pageTaken.group?.id }, claude);
  store.finishRequest(pageAsk.id, 'Drew it as a flow.', claude);
  const session: PairingSession = { id: 'pair1', blockId: code.id, board: b, part: 'code', person: 'Sam', agent: 'Claude', startedAt: new Date().toISOString() };
  store.pairingStarted(session);
  passTime(5 * 60_000);
  store.pairingEnded(session, Date.now(), 'left');
  const quiet: PairingSession = { ...session, id: 'pair2', blockId: code.id };
  store.removeItem(codePin.id, sam);
  store.pairingStarted(quiet);
  store.pairingEnded(quiet, Date.now(), 'idle');
  passTime();

  // Threads from every door, replied to, given a lens, deleted and restored.
  const selection = store.startThread(b, 'Which of these steps can we drop?', sam, null, { pageId: page.id, blockIds: [pageNote.id, pageTable.id] });
  store.postToThread(selection.id, 'Probably the address step.', claude);
  store.postToThread(selection.id, 'And the receipt screen?', sam);
  store.setThreadLens(selection.id, { name: 'Legal' }, sam);
  store.setThreadLens(selection.id, null, sam);
  const fileThread = store.startThreadOnFile(b, 'What does this retry do?', sam, null, { path: 'src/retry.ts', text: 'export const retry = 3;\n' });
  store.postToThread(fileThread.id, 'It retries three times.', codex);
  store.askInGeneral(b, 'How is the board looking?', sam);
  store.askInGeneral(b, 'And the refunds?', sam);
  const doomedThread = store.startThread(b, 'Draw the payment flow as a diagram', sam, null, { door: 'canvas' });
  passTime();
  store.removeItem(doomedThread.id, sam);
  store.restoreItem(doomedThread.id, sam);
  passTime();

  // A person's reaction to an agent's message, which is logged, and to a person's, which is not.
  store.react({ threadId: selection.id }, { commentId: selection.messages[1].id, emoji: '👍' } as never, sam);
  passTime();

  // The canvases: pasted, kept in context, removed and restored, pages renamed, moved and deleted.
  store.pasteBlocks(store.ref(currencies), { ids: [pageNote.id] }, sam);
  store.keepInContext(page.id, [pageNote.id, pageTable.id], sam);
  store.removeItem(pageLink.id, sam);
  store.restoreItem(pageLink.id, sam);
  store.removeItem(pageGroup.id, sam);
  store.restoreItem(pageGroup.id, sam);
  store.removeItem(pageTable.id, sam);
  store.restoreItem(pageTable.id, sam);
  store.removeItem(pagePin.id, sam);
  store.restoreItem(pagePin.id, sam);
  store.removeItem(fees.id, sam);
  store.restoreItem(fees.id, sam);
  store.updateBlock(pageNote.id, { text: 'Cart, pay, receipt, thanks.' }, claude);
  const gone = store.deleteVersion(pageNote.id, 1, sam);
  store.restoreItem(gone.id, sam);
  const second2 = store.addPage(b, 'Error states', claude, { tool: 'add_page', asked: 'show me the error states' });
  store.movePage(second2.id, null, sam);
  store.renamePage(second2.id, 'Errors', sam);
  store.addBlock({ pageId: second2.id }, { title: 'Declined', content: { type: 'note', text: 'Try another card.' } }, claude);
  store.deletePage(second2.id, sam);
  store.filesPage(b, sam);
  store.fileBlock(b, { path: 'src/a.ts', text: 'export {};\n' }, sam);
  await store.flush();
  return [b, other.id];
}

// A part of the made-up kind with its lists and owner and no kind of card: the second Store of the scenario.
async function listsOnlyStore(dir: string): Promise<string[]> {
  const store = new CardStore(dir, { parts: [cardPart(TICKETS, { cards: false })] });
  store.load();
  const board = store.createBoard({ title: 'Lists' }, sam);
  const ticket = store.postCard(board.id, { title: 'Which font?' }, claude);
  store.commentOnCard(ticket.id, 'Sans, please.', sam);
  passTime();
  store.addBlock(store.ref(ticket), { title: 'Samples', content: { type: 'note', text: 'Serif, Sans.' } }, claude);
  store.updateCard(ticket.id, { title: 'Which font to use?' }, sam);
  const page = store.addPage(board.id, 'Notes', sam);
  store.addBlock({ pageId: page.id }, { title: 'A note', content: { type: 'note', text: 'Hello.' } }, sam);
  store.startThread(board.id, 'Anything else?', sam);
  await store.flush();
  return [board.id];
}

// No part at all: the core's own events.
async function bareStore(dir: string): Promise<string[]> {
  const store = new Store(dir, { parts: [] });
  store.load();
  const board = store.createBoard({ title: 'Bare', goal: 'Nothing but pages' }, sam);
  store.updateBoard(board.id, { goal: 'Pages and threads' }, sam);
  store.setStanding(board.id, 'Pages are drawn.', claude);
  const page = store.addPage(board.id, 'Sketch', sam);
  const note = store.addBlock({ pageId: page.id }, { title: 'A note', content: { type: 'note', text: 'Hello there.' } }, sam);
  store.addBlock({ boardId: board.id }, { title: 'Context', content: { type: 'note', text: 'Plain.' } }, sam);
  store.pinComment(note.id, { kind: 'text', quote: 'Hello' }, 'Is this right?', sam);
  store.renamePage(page.id, 'Sketches', sam);
  const thread = store.startThread(board.id, 'What next?', sam);
  store.postToThread(thread.id, 'The next page.', claude);
  store.askAgents(board.id, 'Draw the next page', sam);
  store.requestSync(board.id, undefined, sam);
  store.cancelSync(board.id, sam);
  store.removeItem(note.id, sam);
  store.restoreItem(note.id, sam);
  store.setArchived(board.id, true, sam);
  store.setArchived(board.id, false, sam);
  store.announceSeats('Sam removed a seat', sam);
  await store.flush();
  return [board.id];
}

// What a data folder holds: every stored event (body byte for byte), what the boards return of their events, and the
// boards as they load again from disk, which says each save marked the rows that changed.
function digestOf(label: string, dir: string, reloaded: Store, boards: string[], out: Digest, types: Set<string>, shapes: Set<string>): void {
  const db = openPrivate(path.join(dir, DATABASE_FILE));
  const rows = db.prepare('SELECT board, seq, at, body FROM events ORDER BY board, seq').all() as { board: string; seq: number; at: string; body: string }[];
  db.close();
  const stored = rows.map((row) => `${row.board}\t${row.seq}\t${row.at}\t${row.body}`).join('\n');
  reloaded.load();
  let returned = '';
  let reread = '';
  for (const id of boards) {
    returned += JSON.stringify(reloaded.events(id, { order: 'asc' })) + JSON.stringify(reloaded.eventsSince(id, 0)) + JSON.stringify(reloaded.getBoard(id).activity);
    reread += JSON.stringify(reloaded.getBoard(id));
  }
  for (const row of rows) {
    const event = JSON.parse(row.body) as { type: string };
    types.add(event.type);
    shapes.add(Object.keys(event).join(','));
    out.lines.push(`${label} ${row.board}:${row.seq} ${event.type} ${hash(row.body).slice(0, 12)}`);
  }
  out.lines.push(`${label} rows ${rows.length} ${hash(stored).slice(0, 16)}`);
  out.lines.push(`${label} returned ${hash(returned).slice(0, 16)}`);
  out.lines.push(`${label} reloaded ${hash(reread).slice(0, 16)}`);
}

// Runs the scenario in the three folders given and digests what they hold.
export async function runRecordScenario(dirs: { full: string; canvas: string; bare: string }): Promise<Digest> {
  const release = hold();
  try {
    const full = await cardStore(new CardStore(dirs.full));
    const canvas = await listsOnlyStore(dirs.canvas);
    const bare = await bareStore(dirs.bare);
    const out: Digest = { lines: [], total: '', types: [], shapes: [] };
    const types = new Set<string>();
    const shapes = new Set<string>();
    digestOf('full', dirs.full, new CardStore(dirs.full), full, out, types, shapes);
    digestOf('lists', dirs.canvas, new CardStore(dirs.canvas, { parts: [cardPart(TICKETS, { cards: false })] }), canvas, out, types, shapes);
    digestOf('bare', dirs.bare, new Store(dirs.bare, { parts: [] }), bare, out, types, shapes);
    out.types = [...types].sort();
    out.shapes = [...shapes].sort();
    out.total = hash(out.lines.join('\n')).slice(0, 16);
    return out;
  } finally {
    release();
  }
}

// The digest as the golden file holds it.
export function renderDigest(digest: Digest): string {
  return [
    `event types ${digest.types.length}: ${digest.types.join(' ')}`,
    `key orders ${digest.shapes.length}:`,
    ...digest.shapes.map((shape) => `  ${shape}`),
    '',
    ...digest.lines,
    '',
    `total ${digest.total}`,
    '',
  ].join('\n');
}
