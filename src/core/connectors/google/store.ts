import { blockLabel } from '../../canvas';
import { clip } from '../../format';
import { placePin } from '../../pins';
import { BoardError } from '../../store/errors';
import { where } from '../../store/labels';
import { lostPins } from '../../store/pinParts';
import { type BoardRepository, refOf } from '../../store/repository';
import { guardArchived, sameActor } from '../../store/validate';
import type { Actor, Block, DocDraft, Pin, PinAnchor } from '../../types';
import { docFileId } from './doc';
import { docName } from './pins';

// What a change to a Google Doc's draft says in the board's activity.
export type DocActivity =
  | { kind: 'edited' }
  | { kind: 'saved'; paragraphs: number }
  | { kind: 'discarded' }
  | { kind: 'conflict'; conflicts: number }
  | { kind: 'resolved' };

export type DocAnchor = Extract<PinAnchor, { kind: 'doc' }>;

// A Google Doc's paragraphs renumbered, by a save or a newer version from
// Google: pins on version `from` follow their paragraph onto version `to`,
// where `paragraph` finds it, or are gone.
export interface DocFollow {
  from: string;
  to: string;
  paragraph: (id: string, words: { quote: string; prefix: string; suffix: string }) => string | null;
}

// Moves pins on a doc's paragraphs onto a newer version of the doc.
function followPins(pins: (Pin & { anchor: DocAnchor })[], follow: DocFollow): void {
  for (const { anchor, quote } of pins) {
    if (anchor.revision !== follow.from || anchor.gone) continue;
    const to = follow.paragraph(anchor.paragraph, { quote, prefix: anchor.prefix, suffix: anchor.suffix });
    anchor.revision = follow.to;
    if (to) anchor.paragraph = to;
    else anchor.gone = true;
  }
}

// Google's part of the store: a Google Doc link's draft of edits, and the pins on its paragraphs.
export class DocDraftStore {
  constructor(private readonly repo: BoardRepository) {}

  // The draft of edits to the Google Doc a link block points to, as people
  // and agents change it, save it to Google, or discard it. It isn't the
  // block's content (that's its address and title), so it makes no version.
  // Edits to a draft show in the activity once per person or agent every few
  // minutes, not on every keystroke.
  // Pins on the doc's paragraphs follow (see DocFollow) when the paragraphs
  // are renumbered, and one whose paragraph the change took away is said.
  setDocDraft(blockId: string, draft: DocDraft | undefined, actor: Actor, activity: DocActivity, follow?: DocFollow): Block {
    const located = this.repo.locateItem(blockId);
    guardArchived(located.board);
    const block = located.canvas.blocks.find((b) => b.id === blockId);
    if (block?.type !== 'link' || !docFileId(block.url)) throw new BoardError(`"${blockId}" is not a link to a Google Doc.`);
    if (draft && draft.fileId !== docFileId(block.url)) throw new BoardError(`That draft is of another doc than ${blockLabel(block)}.`);
    const doc = `Google Doc "${clip(block.title || draft?.title || block.docDraft?.title || 'Untitled', 60)}"`;
    const pins = located.canvas.pins.filter((p): p is Pin & { anchor: DocAnchor } => p.blockId === block.id && p.anchor.kind === 'doc');
    const there = pins.filter((p) => placePin(block, p));
    if (draft) block.docDraft = draft;
    else delete block.docDraft;
    if (follow) followPins(pins, follow);
    // A paragraph added in the draft and taken out of it is gone for good: a later one may get its id.
    for (const { anchor } of pins) {
      const kept = block.docDraft?.revision === anchor.revision && block.docDraft.edits.some((e) => e.op === 'add' && e.id === anchor.paragraph);
      if (anchor.paragraph.startsWith('n') && !kept) anchor.gone = true;
    }
    const lost = lostPins(located.board, block, there);
    const now = new Date().toISOString();
    let summary: string;
    switch (activity.kind) {
      case 'edited': {
        summary = `edited the draft of ${doc} ${where(located)}`;
        const [last] = this.repo.events(located.board, { itemId: block.id, limit: 1 });
        const recent = last && sameActor(last.actor, actor) && last.summary === summary && Date.parse(now) - Date.parse(last.at) < DRAFT_ACTIVITY_MS;
        if (recent && !lost.length) {
          this.repo.touch(located.board, refOf(located));
          return block;
        }
        break;
      }
      case 'saved':
        summary = `saved ${activity.paragraphs} paragraph${activity.paragraphs === 1 ? '' : 's'} to Google, in ${doc} ${where(located)}`;
        break;
      case 'discarded':
        summary = `discarded the draft of ${doc} ${where(located)}`;
        break;
      case 'conflict':
        summary = activity.conflicts
          ? `stopped saving ${doc} ${where(located)}: it changed in Google, and ${activity.conflicts} paragraph${activity.conflicts === 1 ? '' : 's'} changed on both sides`
          : `moved the draft of ${doc} ${where(located)} onto the newer version in Google`;
        break;
      case 'resolved':
        summary = `chose between versions in the draft of ${doc} ${where(located)}`;
        break;
    }
    this.repo.recordCanvas(located, actor, [summary, ...lost].join('; '), block.id);
    return block;
  }

  // The doc changed in Google with no draft open on it: pins on its
  // paragraphs follow them onto the version just pulled. Says which are no
  // longer there. An archived board is left as it is.
  followDocPins(blockId: string, follow: DocFollow, actor: Actor): void {
    const located = this.repo.locateItem(blockId);
    const block = located.canvas.blocks.find((b) => b.id === blockId);
    if (!block || located.board.archived) return;
    const pins = located.canvas.pins.filter(
      (p): p is Pin & { anchor: DocAnchor } => p.blockId === block.id && p.anchor.kind === 'doc' && p.anchor.revision === follow.from && !p.anchor.gone,
    );
    if (pins.length === 0) return;
    const there = pins.filter((p) => placePin(block, p));
    followPins(pins, follow);
    const lost = lostPins(located.board, block, there);
    if (lost.length) this.repo.recordCanvas(located, actor, `${docName(block)} changed in Google ${where(located)}: ${lost.join('; ')}`, block.id);
    else this.repo.touch(located.board, refOf(located));
  }
}

const DRAFT_ACTIVITY_MS = 10 * 60_000;
