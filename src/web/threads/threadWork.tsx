import { blockLabel } from '../../core/canvas';
import { clip } from '../../core/format';
import { inConversation } from '../../core/threadList';
import { goneName, threadWork } from '../../core/threads';
import type { Board, FromThread, ThreadRef } from '../../core/types';
import { CardAnchor, useCardKinds } from '../shared/cardKindsContext';
import { useRefs } from '../shared/refs';
import { Icon } from '../shared/components';
import { showComments } from '../conversation';
import { useBoardViews, useViewLink } from '../shared/boardViewsContext';
import { linkTo, type BoardViewName } from '../shared/pages';
import { focusBlock } from '../canvas';
import { openConversation, openThread, threadTab } from './threads';

// What a thread led to, under the reply that made it: a decision with its
// status and options, a task with its status, a block and where it is, a
// comment and its card. Each is read from the board as it is now, so it
// stays live, and opens what it is, where the kind of card registered for it
// says where it is (shared/cardKinds.ts): with none, the card is plain text.
// `onOpen` lets the panel close first.

export function WorkCards({ board, refs, onOpen }: { board: Board; refs: ThreadRef[]; onOpen: () => void }) {
  return (
    <ul className="work-cards" aria-label="What it led to">
      {refs.map((ref) => (
        <li key={`${ref.kind}:${ref.id}`}>
          <WorkCard board={board} item={ref} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function WorkCard({ board, item, onOpen }: { board: Board; item: ThreadRef; onOpen: () => void }) {
  const cards = useCardKinds();
  const refs = useRefs();
  const context = useBoardViews().boardContext()?.name ?? 'board';
  const work = threadWork(board, item);
  if ('card' in work) return cards.workCard(work.kind, { board, id: work.card.id, onOpen });
  switch (work.kind) {
    case 'block': {
      const { block, on, page } = work;
      const title = block.title ?? blockLabel(block).replace(/^\w+ "(.*)"$/, '$1');
      const where = on ? `${on.label}'s canvas` : page ? `Sketchbook page “${page.title}”` : context;
      const href = on ? cards.byId(on.kind.kind, board.id, on.id)?.href : page ? linkTo.page(board.id, page.id) : linkTo.context(board.id);
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
