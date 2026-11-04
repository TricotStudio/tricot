import type { Decisions } from './decisions';
import { BoardError } from './errors';
import type { Located } from './inputs';
import type { BoardRepository } from './repository';
import type { Tasks } from './tasks';
import { guardArchived } from './validate';
import { kindOf } from '../blocks/registry';
import { blockLabel } from '../canvas';
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
// agent paired with alone, which is how it hears the session is over. A
// session that asked nothing, or a piece on the board context (which has no
// discussion), leaves an activity line instead.
export class Pairings {
  constructor(
    private readonly repo: BoardRepository,
    private readonly tasks: Tasks,
    private readonly decisions: Decisions,
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
    this.repo.record(located.board, person(session), 'pairing_started', summary, located.decision?.id, session.blockId, located.task?.id, undefined, undefined, undefined, session.agent);
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
    if (requests.length > 0 && located.task) {
      const comment = this.tasks.addTaskComment(located.task.id, summary, actor, undefined, undefined, undefined, paired).comments.at(-1)!;
      return { summary, comment };
    }
    if (requests.length > 0 && located.decision) {
      const comment = this.decisions.addComment(located.decision.id, summary, actor, undefined, undefined, undefined, paired).comments.at(-1)!;
      return { summary, comment };
    }
    const lasted = pairedFor(endedAt - Date.parse(session.startedAt));
    const idle = why === 'idle' ? ', idle' : why === 'gone' ? ', its page closed' : '';
    const line = `stopped pairing with ${session.agent} on ${thePiece(piece)} (${where}) after ${lasted}${idle}: ${requestCount(requests)}`;
    this.repo.record(located.board, actor, 'pairing_ended', line, located.decision?.id, session.blockId, located.task?.id, undefined, undefined, undefined, session.agent);
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
