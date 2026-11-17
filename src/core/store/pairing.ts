import type { CardKinds } from './cardKinds';
import { BoardError } from './errors';
import type { EventAbout } from './eventTables';
import type { Located } from './inputs';
import type { BoardRepository } from './repository';
import { guardArchived } from './validate';
import { kindOf } from '../blocks/registry';
import { blockLabel } from '../canvas';
import { cardOwning } from '../cards';
import { connectorPinning } from '../connectors/registry';
import { pairedFor, pairingLine, pairingRequests, pairingSummary, requestCount, thePiece, type PairingEnd, type PairingSession } from '../pairing';
import { partWords } from '../parts';
import { canvasName } from '../pins';
import type { Actor, Block, Comment } from '../types';

// What the board keeps of pairing sessions (core/pairing.ts): a line in the
// activity as one starts, for the agent paired with, and as it ends, the
// summary. The sessions themselves are the server's, in memory
// (server/pairing.ts).
//
// The summary is the person's comment on the card the piece is on, marked
// `paired`: it reads to agents as news, never as asking them, and reaches the
// agent paired with alone, which is how it hears the session is over. Pairings
// names no kind of card: the card's discussion is the registry's
// (store/cardKinds.ts), as it is for Pins. A session that asked nothing, a
// piece on the board context or a Sketchbook page (which have no discussion),
// a Store with no such cards, or a discussion that can't take the comment,
// leaves an activity line instead, so a session always ends.
export class Pairings {
  constructor(
    private readonly repo: BoardRepository,
    private readonly cards: CardKinds,
  ) {}

  // The piece a session is on: its block, where it is, and how it is named
  // ("website "Tricot site"", on "T135's canvas"). Refused for a block whose
  // parts of that kind take no requests.
  piece(blockId: string, part: string): { located: Located; block: Block; piece: string; where: string } {
    const located = this.repo.locateItem(blockId);
    const block = located.canvas.blocks.find((b) => b.id === blockId);
    if (!block) throw new BoardError(`"${blockId}" is not a block.`);
    const words = partWords(part);
    const fits = kindOf(block.type).pins?.part?.kind === part || (block.type === 'link' && connectorPinning(part) !== undefined);
    if (!words?.ask || !fits) throw new BoardError(`${blockLabel(block)} has no parts to pair on.`);
    return { located, block, piece: words.label?.(block) ?? blockLabel(block), where: canvasName(located) };
  }

  // A person began pairing: the agent hears of it at once.
  started(session: PairingSession): void {
    const { located, piece, where } = this.piece(session.blockId, session.part);
    guardArchived(located.board);
    const summary = `started pairing with ${session.agent} on ${thePiece(piece)} (${where})`;
    this.repo.record(located.board, person(session), 'pairing_started', summary, about(located, session), { forAgent: session.agent });
  }

  // The session ended: what it asked, summed up, on the card. Returns the
  // summary, and the comment when one was posted.
  ended(session: PairingSession, endedAt: number, why: PairingEnd): { summary: string; comment?: Comment } {
    const { located, piece, where } = this.piece(session.blockId, session.part);
    guardArchived(located.board);
    const requests = pairingRequests(located.canvas.pins, located, session);
    const summary = pairingSummary({ agent: session.agent, piece, startedAt: session.startedAt, endedAt, requests });
    const paired = { agent: session.agent, blockId: session.blockId };
    const actor = person(session);
    const discussion = requests.length > 0 ? this.cards.discussionOn(located) : undefined;
    if (discussion) {
      try {
        return { summary, comment: discussion.comment(summary, actor, { paired }) };
      } catch {
        // The card won't take it, and ending the session is not the place to say so: it is recorded as a line below.
      }
    }
    const lasted = pairedFor(endedAt - Date.parse(session.startedAt));
    const idle = why === 'idle' ? ', idle' : why === 'gone' ? ', its page closed' : '';
    const line = `stopped pairing with ${session.agent} on ${thePiece(piece)} (${where}) after ${lasted}${idle}: ${requestCount(requests)}`;
    this.repo.record(located.board, actor, 'pairing_ended', line, about(located, session), { forAgent: session.agent });
    return { summary };
  }

  // What the agent paired with is told while the session lasts; nothing once
  // the piece has gone.
  line(session: PairingSession): string | undefined {
    try {
      const { piece, where } = this.piece(session.blockId, session.part);
      return pairingLine(session, piece, where);
    } catch {
      return undefined;
    }
  }
}

const person = (session: PairingSession): Actor => ({ kind: 'human', name: session.person });

// What a session's events are about: its block, and the card whose canvas it is on, if one (by the name of its kind).
function about(located: Located, session: PairingSession): EventAbout {
  const card = cardOwning(located);
  return { ...(card ? { [card.kind.kind]: card.id } : {}), item: session.blockId };
}
