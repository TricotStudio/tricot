// Pairing on Home: what an agent said back while a person paired with it on a
// piece (core/pairing.ts), brought into Home's conversation
// (homeConversation.ts) so the person gets the answer, and can go on from
// there, without going back to the Sketchbook page or the file they paired on.
//
// A pairing leaves what it said on the pins of the piece: each request is a
// comment on the part pointed at that @-mentions the agent paired with, and
// the agent replies there, one conversation a pin. On the board context and a
// Sketchbook page, the Files canvas included, the pin keeps it as its own
// thread (Pin.discussion.thread), which is read here; a card's canvas keeps it
// in the card's discussion, which is a part's, and is left out. The line a
// session leaves as it ends is in the board's activity there, never on a pin,
// so it is never relayed (core/store/pairing.ts).
//
// What comes to Home is a pairing session of its own's (core/roles.ts
// pairingThread), the viewer's: on a page they paired on with one (a Sketchbook
// page, Files, or the board context), its agent's latest word on each pin of
// any of its blocks since the session began, one per pin, all of a page's on
// its session's one strand,
// at when it was said, with how many of its words before it stay on the pin;
// a person writing on the pin after it answers it. A pin's thread that no
// such session wrote in (a pairing with an agent of the board's, a comment on
// the canvas that @-mentioned one) stays on its pin, so the pins a board had
// before sessions of their own bring nothing back. Another person's pairing is
// theirs, and doesn't come to this viewer's Home. A reply from Home goes where
// a pairing's request goes: a comment on the pin, addressed to the agent
// (core/pairing.ts addressTo), which it reads as asked of it.

import { kindOf } from './blocks/registry';
import { fileOfBlock } from './fileThread';
import { clip, samePerson } from './format';
import { pinPart } from './pins';
import { pairingThreadsOf } from './roles';
import { FILES_NAME, isFilesPage } from './scratchPad';
import type { Block, Board, Canvas, Comment, Pin, ScratchPage, Thread } from './types';

// The piece a pairing is on, and how Home reaches it: its pin, its block, the
// Sketchbook page or the Files canvas it is on (none on the board context),
// the file it is (on the Files canvas), the agent a reply is addressed to, the
// part pointed at, as a sentence names it ("lines 12–18"), and the thread of
// the pairing session of its own that agent is (core/roles.ts), whose strand
// the card is stitched to and whose colour it takes.
export interface PairedOn {
  pinId: string;
  blockId: string;
  pageId?: string;
  file?: string;
  agent: string;
  part: string;
  thread: string;
}

// The agent's latest word in a pairing: the comment, the piece's name and
// where it is ("styles.css in Files", "Mood board · code block"), who first
// answered it on the pin, how many of the agent's words before it stay there,
// and its session's thread.
export interface PairingWord {
  comment: Comment;
  title: string;
  answer?: Comment;
  earlier: number;
  session: Thread;
  on: PairedOn;
}

// A block as Home names the piece: its title, the name its kind gives it (a
// code block's file, by its name alone), else what its kind is called ("code
// block").
function pieceName(block: Block): string {
  if (block.title) return clip(block.title, 40);
  const kind = kindOf(block.type);
  const quoted = kind.named?.(block)?.match(/"(.+)"$/)?.[1];
  return quoted?.split('/').at(-1) ?? kind.noun ?? kind.label.toLowerCase();
}

// Where a piece is, with its name: "styles.css in Files" (by its name alone, as
// a code block's is), "Mood board · code block", "code block on the board".
export function pieceTitle(block: Block, page?: ScratchPage): string {
  if (!page) return `${pieceName(block)} on the board`;
  if (!isFilesPage(page)) return `${clip(page.title, 40)} · ${pieceName(block)}`;
  const file = fileOfBlock(page, block);
  return `${file ? (file.split('/').at(-1) ?? file) : pieceName(block)} in ${FILES_NAME}`;
}

// The part paired on, as a sentence names it, without the file it is in, which the piece's name says: "lines 12–18".
function partOf(pin: Pin, block: Block): string {
  const { file: _file, ...anchor } = pin.anchor as Pin['anchor'] & { file?: string };
  return pinPart({ ...pin, anchor: anchor as Pin['anchor'] }, block);
}

// The page a block is on, for the pairing session of its own that pairs there (core/roles.ts): a Sketchbook page's or
// the Files canvas's id, none for the board context; nothing for a block on a card's canvas, or none the board has.
export function pairedPlace(board: Partial<Pick<Board, 'canvas' | 'pages'>>, blockId: string): { pageId?: string } | undefined {
  if (board.canvas?.blocks.some((b) => b.id === blockId)) return {};
  const page = board.pages?.find((p) => p.canvas.blocks.some((b) => b.id === blockId));
  return page && { pageId: page.id };
}

// A page as a pairing session is named after it: its title, Files, or the board context.
export const pairedPageName = (page: Pick<ScratchPage, 'title'> & Partial<Pick<ScratchPage, 'files'>> | undefined): string =>
  page ? (isFilesPage(page) ? FILES_NAME : clip(page.title, 40)) : 'board context';

// The canvases whose pins keep a pairing's conversation: the board context and each page, the Files canvas included.
function pairedCanvases(board: Partial<Pick<Board, 'canvas' | 'pages'>>): { canvas: Canvas; page?: ScratchPage }[] {
  return [...(board.canvas ? [{ canvas: board.canvas }] : []), ...(board.pages ?? []).map((page) => ({ canvas: page.canvas, page }))];
}

// The latest word of each pairing `name` has on the board, oldest first.
export function pairingWords(board: Partial<Pick<Board, 'canvas' | 'pages' | 'threads'>>, name: string): PairingWord[] {
  const words: PairingWord[] = [];
  for (const { canvas, page } of pairedCanvases(board)) {
    const sessions = pairingThreadsOf(board, page?.id, name);
    if (!sessions.length) continue;
    for (const pin of canvas.pins) {
      const comments = pin.discussion?.thread ?? [];
      const block = canvas.blocks.find((b) => b.id === pin.blockId);
      if (!comments.length || !block) continue;
      // The latest word here of a session of the viewer's own on this page, since it began.
      const sessionOf = (c: Comment) => (c.author.kind === 'agent' ? sessions.find((t) => samePerson(t.owner!, c.author.name) && c.createdAt >= t.startedAt) : undefined);
      const at = comments.findLastIndex((c) => sessionOf(c));
      if (at < 0) continue;
      const comment = comments[at];
      const session = sessionOf(comment)!;
      const agent = comment.author.name;
      const answer = comments.slice(at + 1).find((c) => c.author.kind === 'human');
      const earlier = comments.slice(0, at).filter((c) => c.author.kind === 'agent' && samePerson(c.author.name, agent)).length;
      const file = page && fileOfBlock(page, block);
      const on: PairedOn = { pinId: pin.id, blockId: block.id, ...(page && { pageId: page.id }), ...(file && { file }), agent, part: partOf(pin, block), thread: session.id };
      words.push({ comment, title: pieceTitle(block, page), ...(answer && { answer }), earlier, session, on });
    }
  }
  return words.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt));
}
