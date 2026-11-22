import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { blockLabel } from '../../core/canvas';
import { clip } from '../../core/format';
import { inConversation } from '../../core/threadList';
import { goneName, threadWork, type ThreadWork } from '../../core/threads';
import type { Board, FromThread, ThreadRef } from '../../core/types';
import { CardAnchor, useCardKinds } from '../shared/cardKindsContext';
import { useRefs } from '../shared/refs';
import { Icon } from '../shared/components';
import { showComments } from '../conversation';
import { useBoardViews, useViewLink } from '../shared/boardViewsContext';
import { linkTo, type BoardViewName } from '../shared/pages';
import { BlockPreview, focusBlock, hasPreview } from '../canvas';
import { openConversation, openThread, threadTab } from './threads';

// What a thread led to, under the reply that made it: a decision with its
// status and options, a task with its status, a block and where it is, a
// comment and its card. Each is read from the board as it is now, so it
// stays live, and opens what it is, where the kind of card registered for it
// says where it is (shared/cardKinds.ts): with none, the card is plain text.
// The blocks whose kind draws a picture of them (canvas/blocks/preview.tsx)
// show as pictures, a few side by side, before the rest (BlockPreviews); a
// block of a kind with none, or of one this page has not registered, is a
// line as the rest are. `onOpen` lets the panel close first.

type BlockWork = Extract<ThreadWork, { kind: 'block' }>;

export function WorkCards({ board, refs, onOpen }: { board: Board; refs: ThreadRef[]; onOpen: () => void }) {
  const works = refs.map((ref) => ({ ref, work: threadWork(board, ref) }));
  const pictured = works.flatMap(({ work }) => (!('card' in work) && work.kind === 'block' && hasPreview(work.block) ? [work] : []));
  const listed = works.filter(({ work }) => !pictured.includes(work as BlockWork));
  return (
    <>
      {pictured.length > 0 && <BlockPreviews board={board} blocks={pictured} onOpen={onOpen} />}
      {listed.length > 0 && (
        <ul className="work-cards" aria-label="What it led to">
          {listed.map(({ ref, work }) => (
            <li key={`${ref.kind}:${ref.id}`}>
              <WorkCard board={board} item={ref} work={work} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// A block's name, where it is in words, and the address of the canvas that holds it.
function useBlockPlace(): (board: Board, work: BlockWork) => { title: string; where: string; href: string | undefined } {
  const cards = useCardKinds();
  const context = useBoardViews().boardContext()?.name ?? 'board';
  return (board, { block, on, page }) => ({
    title: block.title ?? blockLabel(block).replace(/^\w+ "(.*)"$/, '$1'),
    where: on ? `${on.label}'s canvas` : page ? `Sketchbook page “${page.title}”` : context,
    href: on ? cards.byId(on.kind.kind, board.id, on.id)?.href : page ? linkTo.page(board.id, page.id) : linkTo.context(board.id),
  });
}

function WorkCard({ board, item, work, onOpen }: { board: Board; item: ThreadRef; work: ThreadWork; onOpen: () => void }) {
  const cards = useCardKinds();
  const refs = useRefs();
  const place = useBlockPlace();
  if ('card' in work) return cards.workCard(work.kind, { board, id: work.card.id, onOpen });
  switch (work.kind) {
    case 'block': {
      const { block } = work;
      const { title, where, href } = place(board, work);
      return (
        <CardAnchor
          className="work-card is-row"
          href={href}
          title={`${title}, on the ${where}`}
          onClick={() => {
            focusBlock(block.id);
            onOpen();
          }}
        >
          <span className="work-meta">
            <Icon name="canvas" />
            {block.type.charAt(0).toUpperCase() + block.type.slice(1)}
          </span>
          <span className="work-title">{title}</span>
          <span className="work-where">on the {where}</span>
        </CardAnchor>
      );
    }
    case 'comment': {
      const { comment, on } = work;
      const href = cards.byId(on.kind.kind, board.id, on.id)?.href;
      return (
        <CardAnchor
          className="work-card"
          href={href}
          onClick={() => {
            showComments([comment.id]);
            onOpen();
          }}
        >
          <span className="work-meta">
            <Icon name="comment" />
            Comment on {on.label}
          </span>
          <span className="work-quote">{clip(comment.body.replace(/\s+/g, ' '), 160)}</span>
        </CardAnchor>
      );
    }
    case 'gone':
      return <span className="work-card is-gone">{capital(goneName(board, item, (kind, number) => refs?.label(kind, number)))}</span>;
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ---- the blocks a message made, as pictures -------------------------------------
// As many side by side as the message has room for, each at least TILE wide
// and no more than MOST, then "+N more", which shows the rest under them. A
// picture opens its block on its page, as its line would. Under them, where
// they are, when it is one place for all of them.

const TILE = 150;
const GAP = 8;
const MOST = 3;

function BlockPreviews({ board, blocks, onOpen }: { board: Board; blocks: BlockWork[]; onOpen: () => void }) {
  const place = useBlockPlace();
  const strip = useRef<HTMLDivElement>(null);
  const across = Math.min(useAcross(strip), blocks.length);
  const [all, setAll] = useState(false);
  const placed = blocks.map((work) => ({ work, ...place(board, work) }));
  const shown = all ? placed : placed.slice(0, across);
  const more = blocks.length - shown.length;
  const where = placed.every((p) => p.where === placed[0].where) ? placed[0].where : undefined;
  return (
    <div ref={strip} className={`block-previews${across === 1 ? ' is-one' : ''}`} style={{ '--across': across } as CSSProperties}>
      <ul aria-label="What it made">
        {shown.map(({ work, title, where: at, href }) => (
          <li key={work.block.id}>
            <CardAnchor
              className="block-tile"
              href={href}
              title={`${title}, on the ${at}`}
              onClick={() => {
                focusBlock(work.block.id);
                onOpen();
              }}
            >
              <BlockPreview block={work.block} />
              <span className="block-tile-name">{title}</span>
            </CardAnchor>
          </li>
        ))}
      </ul>
      {(where || blocks.length > across) && (
        <p className="block-previews-foot">
          {where && <span className="block-previews-where">on the {where}</span>}
          {blocks.length > across && (
            <button type="button" className="block-previews-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `+${more} more`}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

// How many pictures fit side by side in what holds them, as it is resized (the dock dragged wider).
function useAcross(element: RefObject<HTMLElement | null>): number {
  const [across, setAcross] = useState(MOST);
  useLayoutEffect(() => {
    const holder = element.current;
    if (!holder) return;
    const measure = () => setAcross(Math.max(1, Math.min(MOST, Math.floor((holder.clientWidth + GAP) / (TILE + GAP)))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(holder);
    return () => observer.disconnect();
  }, [element]);
  return across;
}

// "From thread "Can we bundle Pi…"" under the byline of a decision or task
// made answering a thread: it opens the thread, docked beside the tab it was
// started from (else the card's own, `view`), or for a quick question, the
// board's conversation at it on Home ("From the conversation"); or names it
// in plain text once the thread is deleted (until it's restored).
export function FromThreadLink({ board, from, view }: { board: Board; from: FromThread | undefined; view: BoardViewName }) {
  const viewLink = useViewLink();
  if (!from) return null;
  const title = `"${clip(from.title, 60)}"`;
  const thread = board.threads?.find((t) => t.id === from.id);
  const asked = thread && inConversation(thread);
  const open = () => (asked ? openConversation(board.id, thread.messages[0]?.id) : openThread(from.id, undefined, { boardId: board.id, href: viewLink(board.id, threadTab(board, from.id, view)) }));
  return (
    <p className="from-thread">
      <Icon name="thread" />
      <span className="from-thread-label">{!thread ? 'From deleted thread' : asked ? 'From the conversation' : 'From thread'}</span>
      {thread ? (
        <button type="button" onClick={open} title={asked ? "Open it in the board's conversation" : 'Open the thread it came from'}>
          {title}
        </button>
      ) : (
        <span title={from.title}>{title}</span>
      )}
    </p>
  );
}
