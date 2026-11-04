import { useState, type ReactNode } from 'react';
import { staleFromDeleted } from '../core/cardLinks';
import { taskClosure } from '../core/closure';
import { openedBy } from '../core/firstLook';
import type { Board, Decision, Task } from '../core/types';
import { api } from './api';
import { TaskAssignee } from './assignee';
import { CanvasView } from './canvas/CanvasView';
import { BringBackTask, CardMenu, DropTask } from './cardActions';
import { CardBar } from './CardBar';
import { besidePins, PinnedFrom } from './canvas/pins';
import { CLOSED_NOTE, ClosedBand } from './closed';
import { CommitLine } from './commit';
import { ActorBadge, Md, timeAgo } from './components';
import { Discussion } from './discussion';
import { useReadOnly } from './hooks';
import { CardApprovals } from './approvals';
import { TakingALook } from './looking';
import { CardViewBody } from './panelWidth';
import { RefText } from './refs';
import { History } from './history';
import { FromThreadLink } from './threadWork';
import { ReadyControls, ReopenTask, ReviewControls, StatusControl, TASK_LANES } from './tasks';

interface Props {
  board: Board;
  task: Task;
  name: string;
  onClose: () => void;
  newItems: ReadonlySet<string>;
  onSeeItem: (id: string) => void;
  topbar: ReactNode;
  notice?: ReactNode; // under the top bar, e.g. that the board is archived
  needsYou?: ReactNode; // at the right of the bar under it
  unreadSince: string | null;
}

const LABEL: Record<string, string> = { ...Object.fromEntries(TASK_LANES.map((l) => [l.status, l.label])), dropped: 'Dropped' };

// A task opened up, like a decision: its canvas holds the context and the
// results, and the panel holds the work's state and the conversation about it.
export function TaskView(props: Props) {
  const { board, task, name, onClose, newItems, onSeeItem, topbar, notice, needsYou, unreadSince } = props;
  // Dropping starts from the ⋯ on the bar (or the delete dialog's Drop it
  // instead) and asks why in the panel's footer; each ask counts up, so the
  // form opens afresh with the focus in it.
  const [dropping, setDropping] = useState(0);
  return (
    <div className="card-view">
      {topbar}
      {notice}
      <CardBar
        back="Tasks"
        onClose={onClose}
        meta={
          <>
            <span className="card-number">T{task.number}</span>
            <span className={`task-chip task-chip-${task.status}`}>{LABEL[task.status]}</span>
            {task.stale && <span className="tag tag-stale">stale</span>}
          </>
        }
        title={task.title}
        menu={<CardMenu board={board} card={{ task }} name={name} onDrop={() => setDropping((n) => n + 1)} />}
        end={needsYou}
      />
      <CardViewBody
        canvas={
          <section className="card-view-canvas" aria-label="Canvas">
            <CanvasView board={board} task={task} name={name} newItems={newItems} onSeeItem={onSeeItem} />
          </section>
        }
        panel={<TaskPanel board={board} task={task} name={name} unreadSince={unreadSince} dropping={dropping} onDropDone={() => setDropping(0)} />}
      />
    </div>
  );
}

function TaskPanel(props: { board: Board; task: Task; name: string; unreadSince: string | null; dropping: number; onDropDone: () => void }) {
  const { board, task, name, unreadSince, dropping, onDropDone } = props;
  const decisions = task.decisionIds
    .map((id) => board.decisions.find((d) => d.id === id))
    .filter((d): d is Decision => Boolean(d));
  const settled = board.decisions.filter((d) => d.status === 'decided' || d.status === 'provisional');
  const update = (patch: Parameters<typeof api.updateTask>[2]) => api.updateTask(task.id, name, patch);
  const readOnly = useReadOnly();
  const detail = besidePins(board, { taskId: task.id }, task.detail);
  // Done or dropped, it leads with who closed it and the way back, and the
  // rest recedes; the review and status controls go.
  const closure = taskClosure(board, task);

  return (
    <aside className={`decision-panel${closure ? ' is-closed' : ''}`} aria-label="Task">
      <TakingALook kind="task" id={task.id} task={task} band />
      <CardApprovals kind="task" id={task.id} name={name} band />
      {closure && (
        <ClosedBand closure={closure}>
          {!readOnly && (closure.kind === 'dropped' ? <BringBackTask task={task} name={name} /> : <ReopenTask task={task} name={name} />)}
        </ClosedBand>
      )}
      <div className="drawer-scroll">
        {closure && <CommitLine task={task} />}
        <p className="drawer-byline">
          {task.createdBy.kind === 'human' ? 'Added' : openedBy(task) ? 'Opened' : 'Planned'} by <ActorBadge actor={task.createdBy} /> {timeAgo(task.createdAt)}
          {task.claimedBy && task.status !== 'todo' && !(task.claimedBy.kind === 'agent' && task.claimedBy.name === task.assignee) && (
            <>
              {' '}
              · claimed by <ActorBadge actor={task.claimedBy} />
            </>
          )}
        </p>
        <FromThreadLink board={board} from={task.fromThread} view="tasks" />
        <TaskAssignee task={task} name={name} panel />

        {decisions.length > 0 ? (
          <div className="relation-row">
            <span className="faint small">Implements</span>
            {decisions.map((d) => (
              <a key={d.id} className={`relation relation-${d.status}`} href={`#/b/${encodeURIComponent(board.id)}/d/${encodeURIComponent(d.id)}`}>
                #{d.number} {d.question}
              </a>
            ))}
          </div>
        ) : (
          <div className="relation-row">
            <span className="faint small">Standalone task</span>
            {!readOnly && task.status !== 'dropped' && settled.length > 0 && (
              <select
                className="task-link"
                value=""
                onChange={(e) => e.target.value && update({ decisionIds: [e.target.value] })}
                aria-label="Link to a decision"
              >
                <option value="">Link to a decision…</option>
                {settled.map((d) => (
                  <option key={d.id} value={d.id}>
                    #{d.number} {d.question}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {closure?.kind === 'dropped' && closure.reason && (
          <p className="closed-quote">
            “<RefText text={closure.reason} />”
          </p>
        )}

        {task.stale && !closure && (
          <div className="stale-banner">
            <p>
              {task.stale.reason}. {staleFromDeleted(board, task) ? 'Check the task still makes sense without it.' : 'Re-check the decision before continuing.'}
            </p>
            {!readOnly && (
              <button className="btn btn-small" onClick={() => update({ stillValid: true })}>
                Still holds
              </button>
            )}
          </div>
        )}

        <PinnedFrom board={board} taskId={task.id} />

        {detail && (
          <section className="section">
            <h3>Detail</h3>
            <Md>{detail}</Md>
          </section>
        )}

        {task.links.length > 0 && (
          <section className="section">
            <h3>Links</h3>
            <ul className="task-links">
              {task.links.map((link) => (
                <li key={link}>
                  {/^https?:\/\//.test(link) ? (
                    <a href={link} target="_blank" rel="noreferrer">
                      {link.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    <code>{link}</code>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {task.notes.length > 0 && (
          <section className="section">
            <h3>Progress</h3>
            <ol className="progress-notes">
              {[...task.notes].reverse().map((note) => (
                <li key={`${note.at}-${note.by.name}`}>
                  <ActorBadge actor={note.by} showName={false} />
                  <span>
                    <RefText text={note.text} /> <span className="faint">{timeAgo(note.at)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <Discussion
          board={board}
          where={{ task }}
          comments={task.comments}
          pins={task.canvas.pins}
          name={name}
          unreadSince={unreadSince}
          place={{ taskId: task.id }}
          onSend={(body) => api.commentTask(task.id, name, body)}
          placeholder={closure ? CLOSED_NOTE[closure.kind] : undefined}
        />

        <History board={board} name={name} about={{ task: task.id }} />
      </div>

      {!readOnly && !closure && (
        <footer className="drawer-actions">
          {dropping > 0 && <DropTask key={dropping} task={task} name={name} onDone={onDropDone} />}
          {task.status === 'in_review' ? (
            <ReviewControls board={board} task={task} name={name}>
              <StatusControl task={task} name={name} />
            </ReviewControls>
          ) : task.status === 'backlog' ? (
            <ReadyControls task={task} name={name}>
              <StatusControl task={task} name={name} />
            </ReadyControls>
          ) : (
            <StatusControl task={task} name={name} />
          )}
        </footer>
      )}
    </aside>
  );
}
