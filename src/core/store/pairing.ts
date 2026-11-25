import type { CardKinds } from './cardKinds';
import type { Threads } from './threads';
import { BoardError } from './errors';
import type { EventAbout } from './eventTables';
import type { Located } from './inputs';
import type { BoardRepository } from './repository';
import { guardArchived } from './validate';
import { kindOf } from '../blocks/registry';
import { blockLabel } from '../canvas';
import { cardOwning } from '../cards';
import { connectorPinning } from '../connectors/registry';
import { clip } from '../format';
import { pairedPageName } from '../homePairing';
import { withoutLeadingMentions } from '../mentions';
import { pairedFor, pairingLine, pairingRequests, pairingSummary, requestCount, thePiece, type PairingEnd, type PairingSession } from '../pairing';
import { pairingName, pairingThread, pairingThreadOf } from '../roles';
import { partWords } from '../parts';
import { canvasName } from '../pins';
import { isFilesPage, pageName } from '../scratchPad';
import { boardKey, type Actor, type Block, type Comment, type Thread } from '../types';

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
//
// A session of its own (core/roles.ts pairingThread) pairs on a whole page (a
// Sketchbook page, Files, or the board context) and has a thread an agent
// owns, which the person's first request there makes, and a later one sets
// back to work after it was done; its end, once the person left the page,
// tells its agent, which sets its thread done with what changed, and is
// Tricot's to set done with the summary when the agent doesn't
// (server/pairing.ts).
export class Pairings {
  constructor(
    private readonly repo: BoardRepository,
    private readonly cards: CardKinds,
    private readonly threads: Threads,
  ) {}

  // The name a new session on the page a block is on takes for a person: the one they paired with there before with
  // that agent kind (`kind`, its id), else a new one after the page ("Claude · Pair Mood board"), `agent` being the
  // kind's name, and none the board has or a session not up yet holds (`reserved`). Refused on a card's canvas, whose
  // comments are its card's.
  sessionName(blockId: string, person: string, agent: string, kind: string, reserved: readonly string[] = []): string {
    const located = this.pageOf(blockId);
    const before = pairingThreadOf(located.board, located.page?.id, person, { kind });
    if (before) return before.owner!;
    const taken = [...boardAgentNames(located.board), ...(located.board.threads ?? []).flatMap((t) => (t.owner ? [t.owner] : [])), ...reserved];
    return pairingName(agent, pairedPageName(located.page), taken);
  }

  // A person's own session on the page a block is on, if they have had one there: the one an agent owns, or of an agent
  // kind, else their latest.
  sessionThread(blockId: string, person: string, which: { kind?: string; owner?: string } = {}): Thread | undefined {
    try {
      const located = this.pageOf(blockId);
      return pairingThreadOf(located.board, located.page?.id, person, which);
    } catch {
      return undefined;
    }
  }

  // The page a block is on, for a session of its own there (none for the board context). Refused on a card's canvas.
  place(blockId: string): { pageId?: string } {
    const { page } = this.pageOf(blockId);
    return page ? { pageId: page.id } : {};
  }

  // The page a block is on, for a session of its own there: its own canvas's page, or the board context.
  private pageOf(blockId: string): Located {
    const located = this.repo.locateItem(blockId);
    if (!located.canvas.blocks.some((b) => b.id === blockId)) throw new BoardError(`"${blockId}" is not a block.`);
    if (cardOwning(located)) throw new BoardError("A session of its own pairs on a Sketchbook page, Files or the board context: a card's canvas keeps its comments in its card.");
    return located;
  }

  // A request in a session of its own: its thread made, by the first on its page (its first message what was asked,
  // the page what it is about), or set back to work by a later one once it was done. None for a session with an agent
  // of the board's, which has no thread.
  request(session: PairingSession, body: string): Thread | undefined {
    const { located } = this.piece(session.blockId, session.part);
    const board = located.board;
    guardArchived(board);
    const before = pairingThreadOf(board, located.page?.id, session.person, { owner: session.agent });
    const person = { kind: 'human' as const, name: session.person };
    if (before) {
      if (before.status === 'done' || before.status === 'needs-you') {
        before.status = 'working';
        this.repo.record(board, person, 'thread_status_changed', `set the pairing of thread "${clip(before.title, 60)}" back to work`, { item: before.id });
      }
      return before;
    }
    if (!session.launch) return undefined;
    const asked = withoutLeadingMentions(body, [session.agent]) || body;
    return this.threads.startPairingThread(board, located.page, person, `Pair ${pairedPageName(located.page)}`, asked, { name: session.agent, launch: session.launch });
  }

  // Once a session's pairing ended and its agent didn't set its thread done: done, with the summary, as the person who
  // paired, as a session's end says it today. Whether it did.
  done(threadId: string, person: string, summary: string): boolean {
    let found: { thread: Thread } | undefined;
    try {
      found = this.repo.getThread(threadId);
    } catch {
      return false;
    }
    if (!pairingThread(found.thread) || found.thread.status === 'done') return false;
    this.threads.setThreadStatus(threadId, 'done', { kind: 'human', name: person }, summary);
    return true;
  }

  // The sessions of their own at work on every board, for a server that starts with none running.
  atWork(): { thread: Thread; boardKey: string }[] {
    return this.repo.allBoards().flatMap((board) => (board.threads ?? []).filter((t) => t.status === 'working' && pairingThread(t)).map((thread) => ({ thread, boardKey: boardKey(board) })));
  }

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

  // A person began pairing: the agent hears of it at once. A new session of its own isn't an agent yet: its thread,
  // made by the first request, tells it.
  started(session: PairingSession): void {
    const { located, piece, where } = this.piece(session.blockId, session.part);
    guardArchived(located.board);
    if (session.launch && !pairingThreadOf(located.board, located.page?.id, session.person, { owner: session.agent })) return;
    const summary = `started pairing with ${session.agent} on ${thePiece(piece)} (${where})`;
    this.repo.record(located.board, person(session), 'pairing_started', summary, about(located, session), { forAgent: session.agent });
  }

  // The session ended: what it asked, summed up, on the card. Returns the
  // summary, and the comment when one was posted. A session of its own with a
  // thread at work tells its agent instead, in the activity, about its thread
  // (which is what makes it concern that agent alone, core/concerns.ts), to set
  // it done with what changed (`thread`: for Tricot to do so if it doesn't).
  ended(session: PairingSession, endedAt: number, why: PairingEnd): { summary: string; comment?: Comment; thread?: string } {
    const { located, piece, where } = this.piece(session.blockId, session.part);
    guardArchived(located.board);
    const requests = pairingRequests(located.canvas.pins, located, session);
    const summary = pairingSummary({ agent: session.agent, piece, startedAt: session.startedAt, endedAt, requests });
    const paired = { agent: session.agent, blockId: session.blockId };
    const actor = person(session);
    const own = pairingThreadOf(located.board, located.page?.id, session.person, { owner: session.agent });
    if (own && own.status !== 'done') {
      // A session of its own pairs on the whole page: what it asked on any of its blocks, since it began.
      const onPage = located.canvas.blocks.flatMap((b) => pairingRequests(located.canvas.pins, located, { ...session, blockId: b.id }));
      const place = located.page ? (isFilesPage(located.page) ? 'the Files view' : pageName(located.page)) : 'the board context';
      const said = pairingSummary({ agent: session.agent, piece: place, startedAt: session.startedAt, endedAt, requests: onPage });
      const lasted = pairedFor(endedAt - Date.parse(session.startedAt));
      const line = `stopped pairing with ${session.agent} on ${thePiece(place)} after ${lasted}: ${requestCount(onPage)}. The pairing ended: set thread "${clip(own.title, 60)}" [thread id: ${own.id}] done with a summary of what changed`;
      this.repo.record(located.board, actor, 'pairing_ended', line, { item: own.id }, { forAgent: session.agent });
      return { summary: said, thread: own.id };
    }
    // A new session of its own that asked nothing was never an agent: nothing to leave.
    if (session.launch && !own) return { summary };
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

// The agents a board names, as a new session's name must not be one of.
const boardAgentNames = (board: { activity: { actors: { actor: Actor }[] } }): string[] => board.activity.actors.flatMap(({ actor }) => (actor.kind === 'agent' ? [actor.name] : []));

// What a session's events are about: its block, and the card whose canvas it is on, if one (by the name of its kind).
function about(located: Located, session: PairingSession): EventAbout {
  const card = cardOwning(located);
  return { ...(card ? { [card.kind.kind]: card.id } : {}), item: session.blockId };
}
