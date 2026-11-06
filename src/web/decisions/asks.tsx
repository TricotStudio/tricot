import { useState, type FormEvent } from 'react';
import { peopleOn, pendingAsks, samePerson } from '../../core/format';
import type { Board, Decision } from '../../core/types';
import { api } from '../shared/api';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { useReadOnly } from '../shared/hooks';
import { RefText } from '../shared/refs';

// Who a decision is waiting for, a callout when it's waiting for the viewer,
// and a way to route it to someone else.
export function Asks({ board, decision, name }: { board: Board; decision: Decision; name: string }) {
  const readOnly = useReadOnly();
  const [asking, setAsking] = useState(false);
  const [who, setWho] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pending = pendingAsks(decision);
  const mine = pending.filter((a) => samePerson(a.name, name));
  const others = pending.filter((a) => !samePerson(a.name, name));
  const canAsk = !readOnly && !['decided', 'deferred', 'retired'].includes(decision.status);
  const suggestions = peopleOn(board)
    .map((p) => p.name)
    .filter((p) => !samePerson(p, name) && !pending.some((a) => samePerson(a.name, p)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const names = who.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) return;
    try {
      await api.askPeople(decision.id, name, names, note);
      setWho('');
      setNote('');
      setAsking(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unask = (person: string) => api.unask(decision.id, name, person).catch((e: Error) => setError(e.message));

  return (
    <>
      {mine.map((ask) => (
        <div key={`${ask.name}-${ask.at}`} className="ask-callout">
          <p>
            <ActorBadge actor={ask.by} /> asked you {timeAgo(ask.at)}
          </p>
          {ask.note && <p className="banner-quote">“<RefText text={ask.note} />”</p>}
          {!readOnly && <p className="small muted">Comment, mark the criteria or decide; {ask.by.name} will see your answer.</p>}
        </div>
      ))}

      {(others.length > 0 || canAsk) && (
        <div className="waiting">
          {others.length > 0 && <span className="faint small">Waiting for</span>}
          {others.map((ask) => (
            <span
              key={`${ask.name}-${ask.at}`}
              className="waiting-chip"
              title={`Asked by ${ask.by.name} ${timeAgo(ask.at)}${ask.note ? `: ${ask.note}` : ''}`}
            >
              <ActorBadge actor={{ kind: 'human', name: ask.name }} />
              {!readOnly && (
                <button className="chip-remove" onClick={() => unask(ask.name)} aria-label={`Stop waiting for ${ask.name}`}>
                  <Icon name="x" />
                </button>
              )}
            </span>
          ))}
          {canAsk && !asking && (
            <button className="link-button" onClick={() => setAsking(true)}>
              <Icon name="plus" /> Ask someone
            </button>
          )}
        </div>
      )}

      {asking && (
        <form className="ask-form" onSubmit={submit}>
          <input
            autoFocus
            list={`people-${decision.id}`}
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="Who? Separate several names with commas"
          />
          <datalist id={`people-${decision.id}`}>
            {suggestions.map((person) => (
              <option key={person} value={person} />
            ))}
          </datalist>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What do you need from them? (optional)" />
          <div className="row">
            <button className="btn btn-small" disabled={!who.trim()}>
              Ask
            </button>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
