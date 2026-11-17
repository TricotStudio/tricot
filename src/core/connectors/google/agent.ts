// What agents are told about Google Docs: people's requests to edit a
// paragraph, and what was pinned to a doc's paragraphs. Server-only (see
// server.ts).

import { clip, listNames, samePerson } from '../../format';
import { who, waitsOnAgent } from '../../digest';
import { agentsIn } from '../../mentions';
import { canvasesOf, canvasName, pinAsk, pinComments, placePin, type OwnedCanvas } from '../../pins';
import type { Block, Board, Comment, Pin } from '../../types';
import { DOCS_SCOPE } from './doc';
import { DRIVE_FILE } from './scopes';
import type { ConnectorStatus } from '../connector';

// What a connected Google offers agents: names on the cards of docs people
// chose, and those Docs. A sign-in from before choosing docs sees every doc.
export function googleSummary(status: ConnectorStatus): { shows: string; tools: string } {
  const granted = (scope: string) => status.access.some((a) => a.granted && a.scope === scope);
  if (granted(DRIVE_FILE)) {
    return {
      shows: 'the real names of the Google Docs people have chosen',
      tools: 'Google Docs people have chosen, on link cards: read_google_doc, and edit_google_doc to change their drafts, which people save to Google',
    };
  }
  return {
    shows: "the files' real names",
    tools: granted(DOCS_SCOPE)
      ? 'Google Docs on link cards: read_google_doc, and edit_google_doc to change their drafts, which people save to Google'
      : 'agents can read Google Docs once a person connects Google again and chooses them',
  };
}

// A request a person pinned to a Google Doc's paragraph, said to the agent
// who'll act on it: what to change, where, and how to answer.
function docAskLine(owned: OwnedCanvas, pin: Pin, block: Block, comments: Comment[]): string {
  const ask = pinAsk(comments)!;
  const anchor = pin.anchor.kind === 'doc' ? pin.anchor : undefined;
  const title = block.title || (block.type === 'link' ? block.docDraft?.title : undefined) || anchor?.title;
  const where = owned.task || owned.decision ? `, on ${canvasName(owned)}` : '';
  const doc = `${title ? `"${clip(title, 60)}"` : 'the Google Doc'} (draft${where})`;
  const latest = comments.findLast((c) => c.author.kind === 'human');
  const then = latest && latest !== ask ? `; then: "${clip(latest.body, 300)}"` : '';
  const said = `"${clip(ask.body, 500)}"${then}`;
  const part = docPart(pin);
  if (!placePin(block, pin)) return `${ask.author.name} asked you to edit ${doc}, ${part}, which is no longer there: ${said}. Reply in the thread with comment (pin_id: ${pin.id}).`;
  return `${ask.author.name} asked you to edit ${doc}, ${part}: ${said}. Change the draft with edit_google_doc (block_id: ${block.id}), then reply in the thread with comment (pin_id: ${pin.id}).`;
}

// Pinned words in a doc, with their paragraph's id while it has one: paragraph p7 "Hiring is slow".
function docPart(pin: Pin): string {
  const words = `"${clip(pin.quote, 60)}"`;
  return pin.anchor.kind === 'doc' && !pin.anchor.gone ? `paragraph ${pin.anchor.paragraph} ${words}` : words;
}

// The pins on a doc's paragraphs, each with its comments.
function docPins(board: Board, blockId?: string) {
  return canvasesOf(board).flatMap((owned) =>
    owned.canvas.pins.flatMap((pin) => {
      if (pin.anchor.kind !== 'doc' || !pin.discussion || (blockId && pin.blockId !== blockId)) return [];
      const block = owned.canvas.blocks.find((b) => b.id === pin.blockId);
      return block ? [{ owned, pin, block, comments: pinComments(pin, owned) }] : [];
    }),
  );
}

// People's requests to edit a Google Doc's paragraphs, waiting on an agent.
// Named when an agent reads the board, catches up or waits, until one replies.
// One that @-mentions other agents than the one reading it is theirs.
export function docAsksDigest(board: Board, viewer?: string): string | undefined {
  const asks = docPins(board).filter(({ pin, comments }) => pinAsk(comments) && waitsOnAgent(pin, comments));
  if (asks.length === 0) return undefined;
  return asks
    .map(({ owned, pin, block, comments }) => {
      const line = docAskLine(owned, pin, block, comments);
      const agents = agentsIn(board, pinAsk(comments)!.mentions);
      if (agents.length === 0 || (viewer && agents.some((a) => samePerson(a, viewer)))) return line;
      return `${line} For ${listNames(agents)}${viewer ? ': not for you; carry on.' : ' only.'}`;
    })
    .join('\n');
}

// What people pinned to a doc's paragraphs and left open, for read_google_doc:
// requests waiting on an agent first, then answered ones and comments.
export function docPinLines(board: Board, blockId: string): string[] {
  const open = docPins(board, blockId).filter(({ pin }) => !pin.discussion!.resolved);
  const line = ({ owned, pin, block, comments }: (typeof open)[number]) => {
    const ask = pinAsk(comments);
    if (ask && waitsOnAgent(pin, comments)) return `- ${docAskLine(owned, pin, block, comments)}`;
    const part = `${docPart(pin)}${placePin(block, pin) ? '' : ', no longer there'}`;
    const last = comments.at(-1);
    const latest = last ? `, last by ${who(last.author)}: "${clip(last.body, 200)}"` : '';
    if (ask) return `- Done, waiting on a person: ${ask.author.name}'s request on ${part} ("${clip(ask.body, 200)}")${latest} [pin id: ${pin.id}]`;
    const count = `${comments.length} comment${comments.length === 1 ? '' : 's'}`;
    return `- Comment on ${part}, not a request (${count}${latest}) [pin id: ${pin.id}]; reply with comment(pin_id) if it needs an answer`;
  };
  const waiting = open.filter(({ pin, comments }) => pinAsk(comments) && waitsOnAgent(pin, comments));
  return [...waiting, ...open.filter((p) => !waiting.includes(p))].map(line);
}
