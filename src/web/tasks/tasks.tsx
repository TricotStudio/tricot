import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { taskNeedsYou } from '../../core/attention';
import { staleFromDeleted } from '../../core/cardLinks';
import { taskClosure } from '../../core/closure';
import { pendingAsks, samePerson } from '../../core/format';
import { waitsOn } from '../../core/holds';
import type { Board, BoardEvent, Decision, Task, TaskStatus } from '../../core/types';
import { api } from '../shared/api';
import { CommitLine, NoCommitLine } from './commit';
import { TaskAssignee } from './assignee';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { useReadOnly } from '../shared/hooks';
import { linkTo } from '../shared/pages';
import { useSeenOnBoard, type JustMade } from '../threads';
import { CardApprovals } from '../access';
import { FirstLookCue, TakingALook } from '../agents';
import { RefChip, RefText } from '../shared/refs';
import { DropSlot, useTaskDrag, type CardDragProps } from './taskDrag';

export const TASK_LANES: { status: TaskStatus; label: string; hint: string }[] = [
  { status: 'backlog', label: 'Backlog', hint: 'Being shaped; agents wait' },
  { status: 'todo', label: 'To do', hint: 'Ready for an agent' },
  { status: 'in_progress', label: 'In progress', hint: 'Claimed and being built' },
  { status: 'in_review', label: 'In review', hint: 'Waiting for a check' },
  { status: 'blocked', label: 'Blocked', hint: 'Needs something first' },
  { status: 'done', label: 'Done', hint: 'Verified' },
];

const LABEL = { ...Object.fromEntries(TASK_LANES.map((l) => [l.status, l.label])), dropped: 'Dropped' } as Record<TaskStatus, string>;

// Dropped tasks are out of the lanes. Shown, they fold in at the foot of
// Done, newest first, and don't drag.
const NO_DRAG: CardDragProps = { className: '' };
const droppedAt = (t: Task) => t.dropped?.at ?? t.updatedAt;

interface Props {
  board: Board;
  name: string;
  unseen: BoardEvent[]; // what others changed since the viewer last looked
  onSeeItem: (id: string) => void;
  showDropped: boolean; // the bar's Dropped (n) is on
  justMade: JustMade; // made from your conversation: lit until seen (justMade.ts)
}

// Lanes keep the order people put them in (taskOrder.ts); cards can be
// dragged within a lane and between lanes (taskDrag.tsx).
export function TasksView({ board, name, unseen, onSeeItem, showDropped, justMade }: Props) {
  const readOnly = useReadOnly();
  const drag = useTaskDrag(board, name, readOnly);
  const dropped = board.tasks.filter((t) => t.status === 'dropped').sort((a, b) => droppedAt(b).localeCompare(droppedAt(a)));
  // Turned on, the fold comes into view, however long Done is and wherever
  // the lanes are scrolled; shown as the page opens, it waits to be scrolled to.
  const fold = useRef<HTMLDivElement>(null);
  const wasShown = useRef(showDropped);
  useEffect(() => {
    if (showDropped && !wasShown.current) fold.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    wasShown.current = showDropped;
  }, [showDropped]);
  const card = (task: Task, drag: CardDragProps) => (
    <TaskCard
      key={task.id}
      board={board}
      task={task}
      name={name}
      unseen={unseen.filter((e) => e.taskId === task.id)}
      onSee={() => onSeeItem(task.id)}
      made={justMade.held.has(task.id) ? 'held' : justMade.fading.has(task.id) ? 'fading' : undefined}
      onSeen={justMade.seen}
      drag={drag}
    />
  );
  return (
    <>
      <div className={`lanes${drag.dragging ? ' is-dragging' : ''}`} ref={drag.lanesRef}>
        {TASK_LANES.map(({ status, label, hint }) => {
          const tasks = drag.lanes[status];
          const lane = drag.laneState(status);
          const slot = drag.slot(status);
          const cards = tasks.map((task, index) => card(task, drag.cardProps(task, status, index)));
          if (slot) cards.splice(slot.at, 0, <DropSlot key="drop-slot" label={slot.label} height={slot.height} />);
          return (
            <section key={status} className={`lane lane-task-${status}${lane.className}`} data-lane={status}>
              <header className="lane-head">
                <span className="lane-title">
                  <span className="lane-dot" /> {label}
                  <span className="lane-count">{tasks.length}</span>
                </span>
                <span className="lane-hint">{lane.hint ?? hint}</span>
              </header>
              <div className="lane-cards">
                {cards}
                {status === 'backlog' && <AddTask board={board} name={name} />}
                {status === 'done' && showDropped && dropped.length > 0 && (
                  <div className="lane-dropped" id="dropped-tasks" ref={fold} role="group" aria-label="Dropped tasks">
                    <p className="lane-dropped-head">
                      <span className="lane-dot" /> Dropped <span className="lane-count">{dropped.length}</span>
                      <span className="lane-hint">won’t be done; open one to bring it back</span>
                    </p>
                    {dropped.map((task) => card(task, NO_DRAG))}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {drag.layer}
    </>
  );
}

function TaskCard(props: {
  board: Board;
  task: Task;
  name: string;
  unseen: BoardEvent[];
  onSee: () => void;
  made?: 'held' | 'fading'; // just made from your conversation
  onSeen: (id: string) => void;
  drag: CardDragProps;
}) {
  const { board, task, name, unseen, onSee, made, onSeen, drag } = props;
  const cardRef = useRef<HTMLElement>(null);
  useSeenOnBoard(cardRef, made === 'held', () => onSeen(task.id));
  const readOnly = useReadOnly();
  const [error, setError] = useState<string | null>(null);
  const decisions = task.decisionIds
    .map((id) => board.decisions.find((d) => d.id === id))
    .filter((d): d is Decision => Boolean(d));
  const note = task.notes.at(-1);
  // An open question it waits on reads "Waits on #N" in place of its plain link.
  const waits = waitsOn(board, task);
  const linked = decisions.filter((d) => !waits.includes(d));
  const askedOfMe = (d: Decision) => pendingAsks(d).some((a) => samePerson(a.name, name));

  const update = (patch: Parameters<typeof api.updateTask>[2]) =>
    api.updateTask(task.id, name, patch).then(() => setError(null), (e: Error) => setError(e.message));

  const isNew = unseen.length > 0;
  const newComments = unseen.filter((e) => e.type === 'comment_added').length;
  // Waiting on the viewer outranks merely changed, as on decision cards. On
  // an archived board nothing waits on anyone.
  const highlight =
    made === 'held' ? 'card-made' : made === 'fading' ? 'card-made-fading' : !readOnly && taskNeedsYou(task, board, name, unseen) ? 'card-needs-you' : isNew && 'card-new';
  // Done work recedes, saying who finished it; it is reopened from its panel.
  const closure = taskClosure(board, task);
  const closedBy = closure?.by && (
    <span>
      {closure.kind === 'dropped' ? 'dropped' : closure.kind === 'done' && closure.approved ? 'approved' : 'marked done'} by {closure.by.name}
    </span>
  );
  const isDropped = closure?.kind === 'dropped';
  const classes = ['card', 'task-card', task.stale && 'is-stale', closure && 'card-closed', highlight].filter(Boolean).join(' ');
  const { className: dragClass, onPointerDown, ...dragProps } = drag;
  return (
    <article
      ref={cardRef}
      className={classes + dragClass}
      data-task-card={task.id}
      {...dragProps}
      onPointerDown={(e) => {
        if (isNew) onSee();
        onPointerDown?.(e);
      }}
    >
      <div className="card-meta">
        {isNew && <span className="new-dot" title="Changed since you last looked" />}
        <span className="card-number">T{task.number}</span>
        {isDropped ? (
          <span className="tag tag-dropped">dropped</span>
        ) : (
          closure && (
            <span className="tag tag-closed">
              <Icon name="check" /> done
            </span>
          )
        )}
        {task.stale && !isDropped && <span className="tag tag-stale">stale</span>}
        {made === 'held' && <span className="just-made">just made</span>}
        <span className="card-spacer" />
        {task.claimedBy && task.status !== 'todo' && <ActorBadge actor={task.claimedBy} />}
      </div>
      <a className="card-question task-title" draggable={false} href={linkTo.task(board.id, task.id)}>
        {task.title}
      </a>
      {task.detail && <p className="task-detail"><RefText text={task.detail} /></p>}
      <TaskAssignee task={task} name={name} />
      <TakingALook kind="task" id={task.id} task={task} />
      <CardApprovals kind="task" id={task.id} />
      <FirstLookCue board={board} task={task} />
      {waits.map((d) => (
        <p key={d.id} className={`task-waits${!readOnly && askedOfMe(d) ? ' is-asked' : ''}`}>
          <span className="task-waits-label">Waits on</span>
          <RefChip kind="decision" number={d.number} />
          <span className="task-waits-q" title={d.question}>
            {d.question}
          </span>
        </p>
      ))}

      {linked.length > 0 && (
        <div className="task-decisions">
          {linked.map((d) => (
            <a key={d.id} className={`relation relation-${d.status}`} href={linkTo.decision(board.id, d.id)}>
              #{d.number} {d.question}
            </a>
          ))}
        </div>
      )}

      {task.stale && !isDropped && (
        <div className="stale-banner">
          <p>
              {task.stale.reason}. {staleFromDeleted(board, task) ? 'Check the task still makes sense without it.' : 'Re-check the decision before continuing.'}
            </p>
          {!readOnly && (
            <button className="btn btn-small" onClick={() => update({ stillValid: true })} title="The task is still right for the new answer">
              Still holds
            </button>
          )}
        </div>
      )}

      {isDropped ? (
        closure.reason && (
          <p className="card-note">
            “<RefText text={closure.reason} />”
          </p>
        )
      ) : (
        note && (
          <p className="card-note">
            “<RefText text={note.text} />” <span className="faint">— {note.by.name}</span>
          </p>
        )
      )}
      {task.links.length > 0 && (
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
      )}

      {closure && <CommitLine task={task} />}
      {readOnly || closure ? (
        <div className="card-foot">
          {closedBy}
          <TaskMeta task={task} newComments={newComments} />
        </div>
      ) : task.status === 'in_review' ? (
        <>
          <ReviewControls board={board} task={task} name={name} compact />
          <div className="card-foot">
            <TaskMeta task={task} newComments={newComments} />
          </div>
        </>
      ) : task.status === 'backlog' ? (
        <div className="card-foot">
          <MarkReady task={task} name={name} small onError={setError} />
          <TaskMeta task={task} newComments={newComments} />
        </div>
      ) : (
        <StatusControl task={task} name={name}>
          <TaskMeta task={task} newComments={newComments} />
        </StatusControl>
      )}
      {error && <p className="error">{error}</p>}
    </article>
  );
}

// The same counts and time as a decision card's footer.
function TaskMeta({ task, newComments }: { task: Task; newComments: number }) {
  return (
    <>
      {task.comments.length > 0 && (
        <span>
          {task.comments.length} comment{task.comments.length === 1 ? '' : 's'}
          {newComments > 0 && <strong className="new-comments"> · {newComments} new</strong>}
        </span>
      )}
      {task.canvas.blocks.length > 0 && <span>{task.canvas.blocks.length} on canvas</span>}
      <span className="task-time">{timeAgo(task.updatedAt)}</span>
    </>
  );
}

// The status picker. Moving a task to blocked first asks what's in the way.
export function StatusControl({ task, name, children }: { task: Task; name: string; children?: ReactNode }) {
  const [blocking, setBlocking] = useState(false);
  const [why, setWhy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Parameters<typeof api.updateTask>[2]) =>
    api.updateTask(task.id, name, patch).then(() => setError(null), (e: Error) => setError(e.message));

  const changeStatus = (status: TaskStatus) => {
    if (status === 'blocked') return setBlocking(true);
    void update({ status });
  };

  const submitBlocked = async (event: FormEvent) => {
    event.preventDefault();
    if (!why.trim()) return;
    await update({ status: 'blocked', note: why });
    setBlocking(false);
    setWhy('');
  };

  return (
    <>
      {blocking ? (
        <form className="inline-form" onSubmit={submitBlocked}>
          <input autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What's blocking it?" />
          <button className="btn btn-small" disabled={!why.trim()}>
            Block
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setBlocking(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="card-foot">
          <select
            className="task-status"
            value={task.status}
            onChange={(e) => changeStatus(e.target.value as TaskStatus)}
            aria-label={`Status of T${task.number}`}
          >
            {TASK_LANES.map((lane) => (
              <option key={lane.status} value={lane.status}>
                {lane.label}
              </option>
            ))}
          </select>
          {children}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

// A task a person adds lands in the backlog unlinked; it can be linked to a
// decision later from its card.
function AddTask({ board, name }: { board: Board; name: string }) {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (readOnly) return null;
  if (!open) {
    return (
      <button className="add-question" onClick={() => setOpen(true)}>
        <Icon name="plus" /> Add a task
      </button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api.addTask(board.id, name, { title, decisionIds: [] });
      setTitle('');
      setOpen(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form className="card card-form" onSubmit={submit}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task" />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-primary btn-small" disabled={!title.trim()}>
          Add
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// A person's check on finished work: approve it and its commit (what people
// do almost every time, so it leads), approve it alone, or send it back with a
// note saying what to change (the agent works from the note). It takes the
// place of the actions on a card or in the task view's footer, rather than
// adding a box of its own; `children` sit at the end of the action row.
export function ReviewControls(props: { board: Board; task: Task; name: string; compact?: boolean; children?: ReactNode }) {
  const { board, task, name, compact = false, children } = props;
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const builder = task.claimedBy;
  const sentAt = board.activity.reviewSentAt[task.id];
  const size = compact ? ' btn-small' : '';

  const update = async (patch: Parameters<typeof api.updateTask>[2]) => {
    setBusy(true);
    try {
      await api.updateTask(task.id, name, patch);
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendBack = async (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim()) return;
    if (await update({ status: 'in_progress', note })) {
      setSendingBack(false);
      setNote('');
    }
  };

  if (sendingBack) {
    return (
      <form className="review-form" onSubmit={sendBack}>
        <textarea
          autoFocus
          rows={compact ? 2 : 3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setSendingBack(false)}
          placeholder={`What needs changing? ${builder?.name ?? 'The agent'} gets this note.`}
          aria-label="What needs changing"
        />
        <div className="review-actions">
          <button className={`btn${size}`} disabled={!note.trim() || busy}>
            Send back
          </button>
          <button type="button" className={`btn btn-quiet${size}`} onClick={() => setSendingBack(false)}>
            Cancel
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    );
  }

  return (
    <div className="review">
      {!compact && builder && (
        <p className="review-meta">
          <ActorBadge actor={builder} /> sent this for review{sentAt ? ` ${timeAgo(sentAt)}` : ''}
        </p>
      )}
      {task.noCommit && <NoCommitLine task={task} />}
      <div className="review-actions">
        {task.noCommit ? (
          <button
            className={`btn btn-approve btn-commit${size}`}
            disabled={busy}
            onClick={() => void update({ status: 'done' })}
            title={`Nothing to commit: ${task.noCommit.reason}`}
          >
            <Icon name="check" /> Looks good
          </button>
        ) : (
          <>
            <button
              className={`btn btn-approve btn-commit${size}`}
              disabled={busy}
              onClick={() => void update({ status: 'done', approveCommit: true })}
              title={`Approve it, and ask ${builder?.name ?? 'the agent'} to commit the work`}
            >
              <Icon name="check" /> Looks good, commit it
            </button>
            <button className={`btn${size}`} disabled={busy} onClick={() => void update({ status: 'done' })} title="Approve it without a commit">
              Looks good
            </button>
          </>
        )}
        <button className={`btn${size}`} disabled={busy} onClick={() => setSendingBack(true)}>
          Needs changes
        </button>
        {children && <span className="review-trailing">{children}</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// A person's own triage: tasks they add wait in the backlog, where agents can
// read and comment but not take them, until one click marks them ready and
// moves them to To do. On a card the button takes the status picker's place.
function MarkReady(props: { task: Task; name: string; small?: boolean; onError: (message: string | null) => void }) {
  const { task, name, small = false, onError } = props;
  const [busy, setBusy] = useState(false);
  const markReady = () => {
    setBusy(true);
    api
      .updateTask(task.id, name, { status: 'todo' })
      .then(() => onError(null), (e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <button
      className={`btn${small ? ' btn-small' : ''}`}
      disabled={busy}
      onClick={markReady}
      title="Move it to To do, where agents pick it up"
    >
      Mark ready <Icon name="arrow-right" />
    </button>
  );
}

// The same in the task view's footer, like ReviewControls: `children` sit at
// the end of the action row.
export function ReadyControls({ task, name, children }: { task: Task; name: string; children?: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="review">
      <p className="review-meta">Agents won't pick this up until it's marked ready.</p>
      <div className="review-actions">
        <MarkReady task={task} name={name} onError={setError} />
        {children && <span className="review-trailing">{children}</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// Reopening done work, from the band atop its panel: it goes back to To do,
// where any agent can pick it up, with an optional note on what's left. Like
// ending a decision it takes a second step, so a stray click doesn't send
// finished work back.
export function ReopenTask({ task, name }: { task: Task; name: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => (setOpen(false), setNote(''), setError(null));

  if (!open) {
    return (
      <button className="btn btn-small closed-action" onClick={() => setOpen(true)}>
        Reopen
      </button>
    );
  }
  const reopen = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.updateTask(task.id, name, { status: 'todo', ...(note.trim() ? { note } : {}) });
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="confirm-row closed-confirm" onSubmit={reopen}>
      <p>It goes back to To do, where agents pick it up.</p>
      <textarea
        autoFocus
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && close()}
        placeholder="What's left to do? Optional. Agents read it."
        aria-label="What's left to do"
      />
      <div className="row">
        <button className="btn btn-small" disabled={busy}>
          Reopen
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={close}>
          Cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// The work built on one decision, shown in its panel, and a way to ask
// agents to plan it.
export function TasksBuiltOn({ board, decision, name }: { board: Board; decision: Decision; name: string }) {
  const readOnly = useReadOnly();
  const [error, setError] = useState<string | null>(null);
  const tasks = board.tasks.filter((t) => t.decisionIds.includes(decision.id));
  const settled = decision.status === 'decided' || decision.status === 'provisional';
  if (tasks.length === 0 && !settled) return null;
  const request = decision.planRequest;
  const ask = () => api.requestPlan(decision.id, name).then(() => setError(null), (e: Error) => setError(e.message));

  return (
    <section className="section">
      <h3>Tasks built on this ({tasks.length})</h3>
      {request ? (
        <p className="plan-request">
          <ActorBadge actor={request.by} /> asked agents to plan this {timeAgo(request.at)}
        </p>
      ) : (
        settled &&
        !readOnly && (
          <div className="row">
            <button className="btn btn-small" onClick={ask}>
              Ask agents to plan tasks
            </button>
            {tasks.length === 0 && <span className="faint small">or add one on the Tasks tab</span>}
          </div>
        )
      )}
      {error && <p className="error">{error}</p>}
      <ul className="built-on">
        {tasks.map((task) => (
          <li key={task.id}>
            <a href={linkTo.task(board.id, task.id)}>
              <span className="card-number">T{task.number}</span> {task.title}
            </a>
            <span className={`task-chip task-chip-${task.status}`}>{LABEL[task.status]}</span>
            {task.stale && <span className="tag tag-stale">stale</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
