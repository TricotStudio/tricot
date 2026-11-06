import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { cardRef, type Card } from '../../core/cardLinks';
import { clip } from '../../core/format';
import type { Board, Task } from '../../core/types';
import { useConnected, webConnectors } from '../connectors';
import { api } from '../shared/api';
import { Icon } from '../shared/components';
import { useMenu, useReadOnly } from '../shared/hooks';
import { go } from '../shared/pages';
import { RefText } from '../shared/refs';
import '../shared/dialog.css';
import './cardActions.css';

// A card's own actions, kept out of the way in the ⋯ on its bar: dropping a
// task, which keeps it out of the lanes, and deleting a card made by mistake,
// which keeps nothing (decision #73). `onDrop` opens the drop form in the
// task's panel, and `onRetire` the retire form in a decision's: the delete
// dialog offers them as the way to keep the card.
export function CardMenu(props: { board: Board; card: Card; name: string; onDrop?: () => void; onRetire?: () => void }) {
  const { board, card, name, onDrop, onRetire } = props;
  const readOnly = useReadOnly();
  const { open, setOpen, close, root, button, menu, onKeyDown } = useMenu();
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState<string | null>(null);
  const connected = useConnected();
  if (readOnly) return null;

  const task = 'task' in card ? card.task : undefined;
  const decision = 'decision' in card ? card.decision : undefined;
  // What a decision can be sent to: each connected service that takes one (Slack), by the person's own choice from here.
  const shares = decision ? webConnectors().flatMap((c) => (c.share && connected.has(c.id) ? [{ id: c.id, share: c.share }] : [])) : [];
  const what = task ? 'task' : 'decision';
  const ref = cardRef(card);
  const pick = (action: () => void) => () => {
    close(false);
    action();
  };
  const canDrop = Boolean(task && onDrop && task.status !== 'dropped' && task.status !== 'done');
  const canRetire = Boolean(!task && onRetire && 'decision' in card && card.decision.status !== 'retired');
  // Deleting offers the way to keep it instead, when there is one.
  const instead = canDrop ? { label: 'Drop it instead', run: onDrop! } : canRetire ? { label: 'Retire it instead', run: onRetire! } : undefined;
  const items = [
    ...shares.map(({ id, share }) => ({ key: `share-${id}`, label: share.label, note: share.note, run: pick(() => setSharing(id)) })),
    ...(canDrop
      ? [{ key: 'drop', label: 'Drop task…', note: "Set it aside as work that won't be done. It stays readable, and you can bring it back.", run: pick(onDrop!) }]
      : []),
    {
      key: 'delete',
      label: `Delete ${what}…`,
      note: `For a ${what} made by mistake: removes it and its canvas for good, once you confirm.`,
      run: pick(() => setDeleting(true)),
    },
  ];

  return (
    <div className="board-menu card-menu" ref={root}>
      <button
        ref={button}
        className="menu-button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${ref} actions`}
        title={`${task ? 'Task' : 'Decision'} actions`}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu-panel" role="menu" aria-label={`${ref} actions`} ref={menu} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button key={item.key} type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={item.run}>
              <strong>{item.label}</strong>
              <span>{item.note}</span>
            </button>
          ))}
        </div>
      )}
      {deleting && <DeleteCardDialog board={board} card={card} name={name} instead={instead} onClose={() => setDeleting(false)} />}
      {decision && shares.map(({ id, share }) => sharing === id && <share.Dialog key={id} board={board} decision={decision} onClose={() => setSharing(null)} />)}
    </div>
  );
}

// A second step before a card goes for good: it names what links to it and
// what happens to each, says it can't be undone and what keeps a card
// instead, and deletes it only on the red button. A board asks for its name
// typed out; a card doesn't. Keep it has the focus, so Enter keeps the card;
// Escape and a click outside do too. `instead` keeps it on record another way
// (Drop it instead, Retire it instead): the dialog closes and that form opens.
export function DeleteCardDialog(props: {
  board: Board;
  card: Card;
  name: string;
  instead?: { label: string; run: () => void };
  onClose: () => void;
}) {
  const { board, card, name, instead, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const task = 'task' in card ? card.task : undefined;
  const what = task ? 'task' : 'decision';
  const ref = cardRef(card);
  const title = 'task' in card ? card.task.title : card.decision.question;
  // What links to it, from the server, which reads canvases' words as search does.
  const [links, setLinks] = useState<string[] | null>(null);
  const cardId = 'task' in card ? card.task.id : card.decision.id;
  useEffect(() => {
    let live = true;
    api.cardLinks(task ? { taskId: cardId } : { decisionId: cardId }).then(
      ({ lines }) => live && setLinks(lines),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [cardId, task]);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose, busy]);

  const remove = () => {
    if (busy) return;
    setBusy(true);
    const deleting = 'task' in card ? api.deleteTask(card.task.id, name) : api.deleteDecision(card.decision.id, name);
    deleting.then(
      () => (task ? go.tasks(board.id) : go.decisions(board.id)),
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  };

  const keep = task
    ? 'To keep it on record without it asking for anything, drop it instead: it leaves the lanes and can be brought back.'
    : 'To keep it on record without it asking for anything, retire it instead: it’s set aside as no longer relevant and can be brought back.';
  return createPortal(
    <div className="delete-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className="delete-dialog card-delete"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-card-title"
        aria-describedby="delete-card-what"
      >
        <h2 id="delete-card-title">
          Delete {ref} “{clip(title, 90)}”{/[?？]$/.test(title.trim()) ? '' : '?'}
        </h2>
        <p id="delete-card-what">This deletes the {what}, its canvas and its discussion for good. It can’t be undone.</p>
        {instead && (
          <div className="card-delete-keep">
            <p>{keep}</p>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => {
                onClose();
                instead.run();
              }}
            >
              {instead.label}
            </button>
          </div>
        )}
        <section className="card-delete-links" aria-labelledby="delete-card-links">
          <h3 id="delete-card-links">What links to it</h3>
          {links === null ? (
            <p>Looking…</p>
          ) : links.length ? (
            <ul>
              {links.map((line) => (
                <li key={line}>
                  <RefText text={line} />
                </li>
              ))}
            </ul>
          ) : (
            <p>Nothing else on the board links to it.</p>
          )}
        </section>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="delete-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy} autoFocus>
            Keep it
          </button>
          <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
            Delete {what}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Dropping a task, once chosen from its ⋯: in the panel's footer, like
// retiring a decision, it says what dropping means and asks why, if the
// person wants to say.
export function DropTask({ task, name, onDone }: { task: Task; name: string; onDone: () => void }) {
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const holder = task.claimedBy?.kind === 'agent' ? task.claimedBy.name : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.dropTask(task.id, name, why.trim() || undefined);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="confirm-row drop-task" onSubmit={submit}>
      <p>
        Dropped, it leaves the lanes as work that won’t be done, without counting as done. It stays readable and searchable, keeps
        its links, and you can bring it back.{holder && ` ${holder} lets go of it.`}
      </p>
      <textarea
        autoFocus
        rows={2}
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onDone()}
        placeholder="Why won’t it be done? Optional. Agents read it."
        aria-label="Why won’t it be done?"
      />
      <div className="row">
        <button className="btn btn-small" disabled={busy}>
          Drop task
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// A dropped task back into the lanes, from the band atop its panel: to the
// backlog, to shape it again, or to To do, where agents pick it up. A second
// step, as reopening done work is.
export function BringBackTask({ task, name }: { task: Task; name: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn btn-small closed-action" onClick={() => setOpen(true)}>
        Bring it back
      </button>
    );
  }
  const back = (to: 'backlog' | 'todo') => {
    setBusy(true);
    api
      .bringBackTask(task.id, name, to)
      .then(() => setOpen(false), (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="confirm-row closed-confirm">
      <p>Back to the backlog, to shape it again, or to To do, where agents pick it up?</p>
      <div className="row">
        <button className="btn btn-small" disabled={busy} onClick={() => back('backlog')}>
          Backlog
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => back('todo')}>
          To do
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
