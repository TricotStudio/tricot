import { blockLabel } from '../core/canvas';
import { clip } from '../core/format';
import { TASK_STATUS_WORDS } from '../core/pins';
import { goneName, threadWork } from '../core/threads';
import type { Board, FromThread, ThreadRef } from '../core/types';
import { Icon, STATUS_META } from './components';
import { showComments } from './discussion';
import { cardHash, type BoardViewName } from './hooks';
import { focusBlock } from './search';
import { openThread, threadTab } from './threads';

// What a thread led to, under the reply that made it: a decision with its
// status and options, a task with its status, a block and where it is, a
// comment and its card. Each is read from the board as it is now, so it
// stays live, and opens what it is. `onOpen` lets the panel close first.

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

const canvasHash = (boardId: string) => `#/b/${encodeURIComponent(boardId)}/canvas`;

function WorkCard({ board, item, onOpen }: { board: Board; item: ThreadRef; onOpen: () => void }) {
  const work = threadWork(board, item);
  switch (work.kind) {
    case 'decision': {
      const { decision } = work;
      const chosen = decision.resolution?.optionId;
      const options = decision.options.filter((o) => !o.outdated || o.id === chosen).slice(0, 4);
      return (
        <a className={`work-card ref-${decision.status}`} href={cardHash.decision(board.id, decision.id)} onClick={onOpen}>
          <span className="work-meta">
            <span className="work-mark" aria-hidden />#{decision.number} · {STATUS_META[decision.status].label.toLowerCase()}
          </span>
          <span className="work-title">{decision.question}</span>
          {options.length > 0 && (
            <span className="work-options">
              {options.map((o) => (
                <span key={o.id} className={`work-option${o.id === chosen ? ' is-chosen' : ''}`}>
                  <span className="option-letter">{o.id}</span>
                  <span className="work-option-label">{o.label}</span>
                  {o.id === chosen && <Icon name="check" />}
                </span>
              ))}
            </span>
          )}
        </a>
      );
    }
    case 'task': {
      const { task } = work;
      return (
        <a className={`work-card is-row ref-task-${task.status}`} href={cardHash.task(board.id, task.id)} onClick={onOpen} title={task.title}>
          <span className="work-meta">
            <span className="work-mark" aria-hidden />T{task.number}
          </span>
          <span className="work-title">{task.title}</span>
          <span className="work-where">{TASK_STATUS_WORDS[task.status]}</span>
        </a>
      );
    }
    case 'block': {
      const { block, decision, task } = work;
      const title = block.title ?? blockLabel(block).replace(/^\w+ "(.*)"$/, '$1');
      const where = decision ? `#${decision.number}'s canvas` : task ? `T${task.number}'s canvas` : 'Board Context';
      const href = decision ? cardHash.decision(board.id, decision.id) : task ? cardHash.task(board.id, task.id) : canvasHash(board.id);
      return (
        <a
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
        </a>
      );
    }
    case 'comment': {
      const { comment, decision, task } = work;
      const href = decision ? cardHash.decision(board.id, decision.id) : cardHash.task(board.id, task!.id);
      return (
        <a
          className="work-card"
          href={href}
          onClick={() => {
            showComments([comment.id]);
            onOpen();
          }}
        >
          <span className="work-meta">
            <Icon name="comment" />
            Comment on {decision ? `#${decision.number}` : `T${task!.number}`}
          </span>
          <span className="work-quote">{clip(comment.body.replace(/\s+/g, ' '), 160)}</span>
        </a>
      );
    }
    case 'gone':
      return <span className="work-card is-gone">{capital(goneName(board, item))}</span>;
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// "From thread "Can we bundle Pi…"" under the byline of a decision or task
// made answering a thread: it opens the thread, docked beside the tab it was
// started from (else the card's own, `view`), or names it in plain text once
// the thread is deleted (until it's restored).
export function FromThreadLink({ board, from, view }: { board: Board; from: FromThread | undefined; view: BoardViewName }) {
  if (!from) return null;
  const title = `"${clip(from.title, 60)}"`;
  const live = board.threads?.some((t) => t.id === from.id);
  return (
    <p className="from-thread">
      <Icon name="thread" />
      <span className="from-thread-label">{live ? 'From thread' : 'From deleted thread'}</span>
      {live ? (
        <button type="button" onClick={() => openThread(from.id, undefined, { boardId: board.id, view: threadTab(board, from.id, view) })} title="Open the thread it came from">
          {title}
        </button>
      ) : (
        <span title={from.title}>{title}</span>
      )}
    </p>
  );
}
