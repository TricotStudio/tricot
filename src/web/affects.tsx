import { useMemo, useState } from 'react';
import { couldAffect, mayChange, reasonWords, revisitNote, standingWords, type Affected } from '../core/affects';
import { describeChoice, listNames } from '../core/format';
import type { Board, Decision } from '../core/types';
import { api } from './api';
import { ActorBadge, Icon, STATUS_META } from './components';
import { cardHash, useReadOnly } from './hooks';
import { RefText } from './refs';
import './affects.css';

// The other decisions this one may change or rests on, so whoever decides it
// has them at hand: each with where it stands, the work built on it and why it
// is listed, strongest reason first (core/affects.ts). Each opens that
// decision. Nothing shows when there are none.
export function CouldAffect({ board, decision }: { board: Board; decision: Decision }) {
  const listed = useMemo(() => couldAffect(board, decision), [board, decision]);
  if (listed.length === 0) return null;
  const heading = `could-affect-${decision.id}`;
  return (
    <section className="section could-affect" aria-labelledby={heading}>
      <div className="could-affect-head">
        <h3 id={heading}>Could affect</h3>
        <span className="faint small">Earlier decisions this one may change or rests on</span>
      </div>
      <ul className="affects">
        {listed.map((affected) => (
          <AffectRow key={affected.decision.id} board={board} affected={affected} />
        ))}
      </ul>
    </section>
  );
}

const SHOWN_REASONS = 2;

function AffectRow({ board, affected }: { board: Board; affected: Affected }) {
  const { decision, reasons, tasks } = affected;
  const answered = (decision.status === 'decided' || decision.status === 'provisional') && decision.resolution;
  const shown = reasons.slice(0, SHOWN_REASONS);
  return (
    <li>
      <a className={`affect status-${decision.status}`} href={cardHash.decision(board.id, decision.id)}>
        <span className="affect-question">
          <span className="card-number">#{decision.number}</span> {decision.question}
        </span>
        <span className="affect-standing">
          <span className="affect-status">{STATUS_META[decision.status].label}</span>
          {answered && <span className="affect-answer">{describeChoice(decision)}</span>}
          {decision.refreshRequest && <span className="card-refreshing">refresh asked</span>}
        </span>
        <span className="affect-foot">
          <span className="affect-why" title={reasons.map(reasonTitle).join('\n')}>
            {shown.map((reason, i) => (
              <span key={reason.kind} className="affect-reason">
                {i > 0 && <span aria-hidden> · </span>}
                {reason.kind === 'named' && <ActorBadge actor={reason.by} showName={false} />}
                {reasonWords(reason)}
              </span>
            ))}
          </span>
          {tasks.length > 0 && (
            <span className="affect-tasks" aria-label={`Built on by ${listNames(tasks.map((t) => `T${t.number}`))}`}>
              {tasks.map((task) => (
                <span key={task.id} className="affect-task" title={`T${task.number} ${task.title}`}>
                  T{task.number}
                </span>
              ))}
            </span>
          )}
        </span>
      </a>
    </li>
  );
}

function reasonTitle(reason: Affected['reasons'][number]): string {
  return reason.kind === 'named' ? `${reason.by.name}: ${reason.why}` : reasonWords(reason);
}

// ---- after deciding ---------------------------------------------------------

// What a person set aside on this browser: the answer, by when it was given,
// for which they said "Not now".
const DISMISSED_KEY = 'tricot:revisit-not-now';
const KEPT = 100;

function readDismissed(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveDismissed(decisionId: string, answerAt: string): void {
  try {
    const kept = Object.entries(readDismissed()).filter(([id]) => id !== decisionId).slice(-(KEPT - 1));
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(Object.fromEntries([...kept, [decisionId, answerAt]])));
  } catch {
    // Private windows and full storage: it shows again next time.
  }
}

// Once a person has answered a decision, the listed decisions settled before
// it that the answer may change (core/affects.ts mayChange): for a day, it
// offers them to ask agents to check each one still holds (a refresh), and
// never changes them. Those asked here stay in it, marked asked, until all
// are; "Not now" sets it aside for this answer.
export function RevisitPrompt({ board, decision, name }: { board: Board; decision: Decision; name: string }) {
  const readOnly = useReadOnly();
  const listed = useMemo(() => couldAffect(board, decision), [board, decision]);
  const offered = useMemo(() => mayChange(decision, listed, name), [decision, listed, name]);
  const answerAt = decision.resolution?.at;
  const [notNowAt, setNotNowAt] = useState(() => readDismissed()[decision.id]);
  const [asked, setAsked] = useState<{ at: string; ids: string[] }>({ at: '', ids: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (readOnly || !answerAt || notNowAt === answerAt) return null;
  const askedHere = asked.at === answerAt ? asked.ids : [];
  const items = listed.filter((a) => offered.includes(a) || askedHere.includes(a.decision.id));
  if (items.length === 0) return null;
  const isAsked = (a: Affected) => askedHere.includes(a.decision.id);
  const refs = (affected: Affected[]) => listNames(affected.map((a) => `#${a.decision.number}`));

  if (items.every(isAsked)) {
    return (
      <div className="refresh-note is-done revisit" role="status">
        <p>
          <Icon name="check" className="sync-check" />
          <span>
            Asked agents to check <RefText text={refs(items)} /> still {items.length === 1 ? 'holds' : 'hold'}. Nothing changes unless a
            person decides it again.
          </span>
        </p>
      </div>
    );
  }

  const ask = async (other: Decision) => {
    setBusy(true);
    setError(null);
    try {
      await api.requestRefresh(other.id, name, revisitNote(decision));
      setAsked((was) => ({ at: answerAt, ids: [...(was.at === answerAt ? was.ids : []), other.id] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    saveDismissed(decision.id, answerAt);
    setNotNowAt(answerAt);
  };
  const one = items.length === 1 ? items[0].decision : null;

  return (
    <div className="refresh-note is-drift revisit" role="status">
      <p>
        <span>
          {one ? (
            <>
              This may change <RefText text={`#${one.number}`} />, settled before it. Ask for a refresh of <RefText text={`#${one.number}`} />?
            </>
          ) : (
            `This may change ${items.length} decisions settled before it. Ask for a refresh of the ones to check?`
          )}
        </span>
      </p>
      <ul className="revisit-list">
        {items.map((affected) => {
          const other = affected.decision;
          return (
            <li key={other.id}>
              <span className="revisit-what">
                {!one && <span className="card-number">#{other.number}</span>} {other.question}
                <span className="revisit-answer">{standingWords(other)}</span>
              </span>
              {!one &&
                (isAsked(affected) ? (
                  <span className="revisit-asked">
                    <Icon name="check" /> Asked
                  </span>
                ) : (
                  <button className="btn btn-small" disabled={busy} onClick={() => void ask(other)}>
                    <Icon name="sync" /> Ask for a refresh
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {error && <p className="error">{error}</p>}
      <div className="row">
        {one && (
          <button className="btn btn-small" disabled={busy} onClick={() => void ask(one)}>
            <Icon name="sync" /> Ask for a refresh of #{one.number}
          </button>
        )}
        <button className="btn btn-quiet btn-small" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
