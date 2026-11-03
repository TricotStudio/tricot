import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { samePerson } from '../core/format';
import { driftAge, driftChanges, driftOf } from '../core/freshness';
import type { Board, Decision, Option, Revision } from '../core/types';
import { api } from './api';
import { ActorBadge, Icon, timeAgo } from './components';
import { useReadOnly } from './hooks';
import { RefText } from './refs';

// A card can change what it offers until it is answered: a standing answer
// keeps its options as they were answered, and a retired card is set aside.
export function canRevise(decision: Decision): boolean {
  return decision.status === 'open' || decision.status === 'exploring' || decision.status === 'deferred';
}

export function canRefresh(decision: Decision): boolean {
  return decision.status === 'open' || decision.status === 'exploring';
}

// A settled card keeps its answer; a refresh asked of it checks the answer
// still holds (affects.tsx asks for one when a decision may change it).
function isSettled(decision: Decision): boolean {
  return decision.status === 'decided' || decision.status === 'provisional';
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>, onDone?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

// Where a card stands with the app as it is now: a refresh agents are working
// on, a note that the board has moved on since it caught up, or the last
// refresh agents finished. On a settled card, a refresh is a check that its
// answer still holds.
export function FreshnessNote({ board, decision, name }: { board: Board; decision: Decision; name: string }) {
  const readOnly = useReadOnly();
  const { busy, error, run } = useAction();
  const [asking, setAsking] = useState(false);
  const settled = isSettled(decision);
  if (!canRefresh(decision) && !settled) return null;
  const request = decision.refreshRequest;
  if (request) {
    const mine = samePerson(request.by.name, name);
    return (
      <div className="refresh-note is-pending" role="status">
        <p>
          <span className="sync-dot" aria-hidden />
          <span>
            {mine ? 'You asked' : `${request.by.name} asked`} agents to {settled ? 'check it still holds' : 'refresh the options'}{' '}
            {timeAgo(request.at)} · waiting for agents
          </span>
        </p>
        {request.text && <p className="refresh-quote">“<RefText text={request.text} />”</p>}
        {!readOnly && (
          <button className="btn btn-quiet btn-small" disabled={busy} onClick={() => run(() => api.cancelRefresh(decision.id, name))}>
            Cancel
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const drift = driftOf(board, decision);
  if (drift) {
    return (
      <div className="refresh-note is-drift">
        <p>
          <span>
            <strong>{driftAge(drift)}.</strong> Since then, {driftChanges(drift)}. The options may be out of date.
          </span>
        </p>
        {!readOnly &&
          (asking ? (
            <RefreshForm decision={decision} name={name} onClose={() => setAsking(false)} />
          ) : (
            <button className="btn btn-small" onClick={() => setAsking(true)}>
              <Icon name="sync" /> Ask agents to refresh
            </button>
          ))}
      </div>
    );
  }

  const done = decision.refreshed;
  if (!done) return null;
  if (settled) {
    // Only a check of the answer standing now: an earlier refresh was of the options.
    if (!decision.resolution || done.at < decision.resolution.at) return null;
    return (
      <div className="refresh-note is-done">
        <p>
          <Icon name="check" className="sync-check" />
          <span>
            Checked by <ActorBadge actor={done.by} /> {timeAgo(done.at)}
            {done.requestedBy ? `, as ${samePerson(done.requestedBy.name, name) ? 'you' : done.requestedBy.name} asked` : ''}.
          </span>
        </p>
        {done.note && <p className="refresh-quote">“<RefText text={done.note} />”</p>}
      </div>
    );
  }
  return (
    <div className="refresh-note is-done">
      <p>
        <Icon name="check" className="sync-check" />
        <span>
          Refreshed by <ActorBadge actor={done.by} /> {timeAgo(done.at)}:{' '}
          {done.changes.length ? done.changes.join(', ') : 'no changes; the options still hold'}.
        </span>
      </p>
      {done.note && <p className="refresh-quote">“<RefText text={done.note} />”</p>}
    </div>
  );
}

// Asks agents to re-check the card against the app as it is now, with an
// optional note on what to look at.
export function RefreshForm({ decision, name, onClose }: { decision: Decision; name: string; onClose: () => void }) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.requestRefresh(decision.id, name, note), onClose);
  };
  return (
    <form className="refresh-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <textarea
        autoFocus
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What should they re-check? Optional"
        aria-label="Note for agents"
      />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-small" disabled={busy}>
          <Icon name="sync" /> Ask agents to refresh the options
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// The way in when the card doesn't say it may be out of date: under the
// options, beside adding one.
export function RefreshPrompt({ decision, name }: { decision: Decision; name: string }) {
  const [open, setOpen] = useState(false);
  if (!canRefresh(decision) || decision.refreshRequest) return null;
  if (open) return <RefreshForm decision={decision} name={name} onClose={() => setOpen(false)} />;
  return (
    <button className="link-button" onClick={() => setOpen(true)}>
      <Icon name="sync" /> Ask agents to refresh the options
    </button>
  );
}

// Editing one option in place: its wording, or marking it outdated with a
// short why. That is how a person takes an option off the table; nothing is
// deleted, and agents are told what changed.
export function OptionEditor(props: { decision: Decision; option: Option; name: string; mode: 'edit' | 'outdate'; onDone: () => void }) {
  const { decision, option, name, mode, onDone } = props;
  const [label, setLabel] = useState(option.label);
  const [description, setDescription] = useState(option.description ?? '');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const changed = label.trim() !== option.label || description.trim() !== (option.description ?? '');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const change =
      mode === 'outdate'
        ? { id: option.id, outdated: true, reason }
        : {
            id: option.id,
            label: label.trim() !== option.label ? label : undefined,
            description: description.trim() !== (option.description ?? '') ? description : undefined,
          };
    void run(() => api.revise(decision.id, name, { options: [change] }), onDone);
  };
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && onDone();

  return (
    <form className="option option-editor" onSubmit={submit} onKeyDown={escape} aria-label={`Option ${option.id}`}>
      <div className="option-head">
        <span className="option-letter">{option.id}</span>
        {mode === 'edit' ? (
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Option" />
        ) : (
          <span className="option-label">{option.label}</span>
        )}
      </div>
      {mode === 'edit' ? (
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What choosing it means (optional)"
          aria-label="Description"
        />
      ) : (
        <>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why doesn't it apply any more? Optional"
            aria-label="Why it is outdated"
          />
          <p className="faint small">It stays on the card, dimmed, and can't be picked. Agents are told.</p>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-small" disabled={busy || (mode === 'edit' && (!changed || !label.trim()))}>
          {mode === 'edit' ? 'Save' : 'Mark outdated'}
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Rewording the question and its context. The earlier wording is kept.
export function WordingEditor({ decision, name, onDone }: { decision: Decision; name: string; onDone: () => void }) {
  const [question, setQuestion] = useState(decision.question);
  const [context, setContext] = useState(decision.context ?? '');
  const { busy, error, run } = useAction();
  const changed = question.trim() !== decision.question || context.trim() !== (decision.context ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api.revise(decision.id, name, {
          question: question.trim() !== decision.question ? question : undefined,
          context: context.trim() !== (decision.context ?? '') ? context : undefined,
        }),
      onDone,
    );
  };
  return (
    <form className="section wording-editor" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onDone()}>
      <h3>Edit the question</h3>
      <input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question" />
      <textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Context (optional)" aria-label="Context" />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-small" disabled={busy || !changed || !question.trim()}>
          Save
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function fieldName(revision: Revision): string {
  if (revision.field === 'label') return `Option ${revision.optionId}`;
  if (revision.field === 'description') return `Option ${revision.optionId}'s description`;
  return revision.field === 'question' ? 'Question' : 'Context';
}

// What the question, context and options said before they were changed,
// newest first, so nothing the card offered is lost.
export function EarlierWording({ decision }: { decision: Decision }) {
  const revisions = decision.revisions ?? [];
  if (revisions.length === 0) return null;
  return (
    <details className="section earlier">
      <summary>Earlier wording ({revisions.length})</summary>
      <ol>
        {[...revisions].reverse().map((revision, i) => (
          <li key={`${revision.at}-${i}`}>
            <p>
              <span className="earlier-status">{fieldName(revision)}</span>{' '}
              {revision.before ? <span className="earlier-before">“{revision.before}”</span> : <span className="faint">was empty</span>}
            </p>
            <p className="faint small">
              Changed by {revision.by.name} {timeAgo(revision.at)}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}
