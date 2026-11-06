import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { samePerson } from '../../core/format';
import type { Task } from '../../core/types';
import { api } from '../shared/api';
import { ActorBadge } from '../shared/components';
import { useDismiss, useReadOnly } from '../shared/hooks';
import { useRoster } from '../shared/mentions';

// Who should take a task: any agent, first to claim, or one the person picks.
// On a card the chip sits under the title; once the assignee has claimed it,
// the claimer's badge says it, and the card only notes who assigned it. In
// the task's panel it is a row of its own.

const isClaimed = (task: Task) => Boolean(task.claimedBy) && task.status !== 'todo';
const claimedByAssignee = (task: Task) =>
  isClaimed(task) && task.claimedBy!.kind === 'agent' && Boolean(task.assignee) && samePerson(task.claimedBy!.name, task.assignee!);

export function TaskAssignee({ task, name, panel = false }: { task: Task; name: string; panel?: boolean }) {
  const readOnly = useReadOnly() || task.status === 'done' || task.status === 'dropped';
  const [error, setError] = useState<string | null>(null);
  const by = task.assignedBy && <span>by {task.assignedBy.name}</span>;
  const pick = (assignee: string | null) => {
    if ((assignee ?? '') === (task.assignee ?? '')) return;
    api.updateTask(task.id, name, { assignee }).then(() => setError(null), (e: Error) => setError(e.message));
  };

  if (!panel) {
    // The claimer's badge already shows the assignee: say once who asked for it.
    if (claimedByAssignee(task)) return task.assignedBy ? <p className="task-assignee">Assigned by {task.assignedBy.name}</p> : null;
    // Claimed work shows who has it; "any agent" no longer says anything.
    if ((isClaimed(task) || readOnly) && !task.assignee) return null;
  } else if (readOnly && !task.assignee) return null;

  return (
    <div className="task-assignee">
      {panel && <span className="faint small">Assigned to</span>}
      <AssigneeChip task={task} readOnly={readOnly} onPick={pick} />
      {panel && task.assignee && by}
      {panel && claimedByAssignee(task) && <span>· claimed</span>}
      {error && (
        <span className="assignee-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function AssigneeChip({ task, readOnly, onPick }: { task: Task; readOnly: boolean; onPick: (assignee: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const who = task.assignee ? <ActorBadge actor={{ kind: 'agent', name: task.assignee }} title={task.assignee} /> : 'Any agent';
  if (readOnly) return <span className="assignee-chip is-static">{who}</span>;
  const title = task.assignee
    ? `Only ${task.assignee} can claim T${task.number}${task.assignedBy ? ` (assigned by ${task.assignedBy.name})` : ''}. Change who takes it.`
    : `Any agent can claim T${task.number}, first come. Pick one to take it.`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`assignee-chip${task.assignee ? '' : ' is-any'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {who}
        {!task.assignee && (
          <svg className="assignee-caret" viewBox="0 0 16 16" aria-hidden>
            <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
          </svg>
        )}
      </button>
      {open && (
        <AssigneeMenu
          anchor={anchor}
          current={task.assignee}
          onPick={(assignee) => {
            setOpen(false);
            onPick(assignee);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const MENU_WIDTH = 250;

// "Who should take it?": any agent, then the board's agents with what each is doing.
function AssigneeMenu(props: {
  anchor: { current: HTMLElement | null };
  current?: string;
  onPick: (assignee: string | null) => void;
  onClose: () => void;
}) {
  const { anchor, current, onPick, onClose } = props;
  const { agents } = useRoster();
  const root = useRef<HTMLDivElement>(null);
  const choices: (string | null)[] = [null, ...agents.map((a) => a.name)];
  const [active, setActive] = useState(() => Math.max(0, choices.findIndex((c) => (c ?? '') === (current ?? ''))));
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useLayoutEffect(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - MENU_WIDTH - 8));
    const height = 48 + choices.length * 34;
    setPlace(box.bottom + 6 + height < window.innerHeight ? { left, top: box.bottom + 6 } : { left, bottom: window.innerHeight - box.top + 6 });
    root.current?.focus({ preventScroll: true });
  }, [anchor, choices.length]);

  // Clicking away, Escape, or the page moving under it, closes it.
  useDismiss(true, onClose, root, anchor);
  useEffect(() => {
    const moved = (e: Event) => !root.current?.contains(e.target as Node) && onClose();
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setActive((active + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length);
    else if (e.key === 'Enter' || e.key === ' ') onPick(choices[active]);
    else if (e.key === 'Escape') {
      onClose();
      anchor.current?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={root}
      className="assignee-menu"
      role="listbox"
      aria-label="Who should take it?"
      aria-activedescendant={`assignee-${active}`}
      tabIndex={-1}
      style={{ left: place?.left ?? -9999, top: place?.top, bottom: place?.bottom, width: MENU_WIDTH, visibility: place ? undefined : 'hidden' }}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="assignee-menu-head">Who should take it?</div>
      {choices.map((choice, i) => {
        const agent = agents.find((a) => a.name === choice);
        return (
          <div
            key={choice ?? ''}
            id={`assignee-${i}`}
            role="option"
            aria-selected={(choice ?? '') === (current ?? '')}
            className={`assignee-option${i === active ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(choice)}
          >
            {choice ? <ActorBadge actor={{ kind: 'agent', name: choice }} title={choice} /> : <span>Any agent</span>}
            <span className="assignee-state">{agent ? agent.state : 'first to claim'}</span>
          </div>
        );
      })}
      {agents.length === 0 && <div className="assignee-empty">No agent has used this board yet. Connect one to pick it here.</div>}
    </div>,
    document.body,
  );
}
