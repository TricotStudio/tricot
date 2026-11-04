import { useId, useMemo, useState } from 'react';
import { couldAffect, isLikely, mayChange, reasonWords, revisitGroups, revisitWhy, standingWords, type Affected } from '../core/affects';
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
// offers to ask agents to check they still hold (a refresh of each), and never
// changes them. Several are ticked and asked about with one button: the
// likely ones (linked on purpose or through a task) start ticked, those that
// only share an area or wording don't (revisitGroups). One is asked about
// with its own button, as a question. Once asked, it says so for the rest of
// the visit, and asking, like "Not now", sets it aside for this answer.
export function RevisitPrompt({ board, decision, name }: { board: Board; decision: Decision; name: string }) {
  const readOnly = useReadOnly();
  const listed = useMemo(() => couldAffect(board, decision), [board, decision]);
  const offered = useMemo(() => mayChange(decision, listed, name), [decision, listed, name]);
  const answerAt = decision.resolution?.at;
  const [notNowAt, setNotNowAt] = useState(() => readDismissed()[decision.id]);
  const [asked, setAsked] = useState<{ at: string; ids: string[] }>({ at: '', ids: [] });
  // The ticks the person changed, for this answer; the rest keep their starting tick.
  const [ticks, setTicks] = useState<{ at: string; changed: Record<string, boolean> }>({ at: '', changed: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  if (readOnly || !answerAt) return null;

  const askedHere = asked.at === answerAt ? board.decisions.filter((d) => asked.ids.includes(d.id)).sort((a, b) => a.number - b.number) : [];
  if (askedHere.length > 0) {
    return (
      <div className="refresh-note is-done revisit" role="status">
        <p>
          <Icon name="check" className="sync-check" />
          <span>
            Asked agents to check <RefText text={listNames(askedHere.map((d) => `#${d.number}`))} /> still {askedHere.length === 1 ? 'holds' : 'hold'}.
            Nothing changes unless a person decides it again.
          </span>
        </p>
      </div>
    );
  }
  if (notNowAt === answerAt || offered.length === 0) return null;

  const changed = ticks.at === answerAt ? ticks.changed : {};
  const isTicked = (a: Affected) => changed[a.decision.id] ?? isLikely(a);
  const ticked = offered.filter(isTicked);
  const tick = (affected: Affected, on: boolean) => setTicks({ at: answerAt, changed: { ...changed, [affected.decision.id]: on } });
  const selectAll = () => setTicks({ at: answerAt, changed: Object.fromEntries(offered.map((a) => [a.decision.id, true])) });

  const ask = async (them: Affected[]) => {
    setBusy(true);
    setError(null);
    try {
      const ids = them.map((a) => a.decision.id);
      await api.revisit(decision.id, name, ids);
      // Asked, it is done with this answer: the confirmation shows for this visit.
      saveDismissed(decision.id, answerAt);
      setAsked({ at: answerAt, ids });
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
  const notNow = (
    <button className="btn btn-quiet btn-small" onClick={dismiss}>
      Not now
    </button>
  );

  if (offered.length === 1) {
    const [affected] = offered;
    const one = affected.decision;
    return (
      <div className="refresh-note is-drift revisit" role="status">
        <p>
          <span>
            This may change <RefText text={`#${one.number}`} />, settled before it. Ask for a refresh of <RefText text={`#${one.number}`} />?
          </span>
        </p>
        <ul className="revisit-list">
          <li>
            <RevisitWhat affected={affected} numbered={false} />
          </li>
        </ul>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn btn-small" disabled={busy} onClick={() => void ask(offered)}>
            <Icon name="sync" /> Ask for a refresh of #{one.number}
          </button>
          {notNow}
        </div>
      </div>
    );
  }

  const { likely, lessLikely } = revisitGroups(offered);
  const group = (title: string, members: Affected[]) =>
    members.length > 0 && (
      <fieldset className="revisit-group" disabled={busy}>
        <legend>{title}</legend>
        <ul className="revisit-list">
          {members.map((affected) => (
            <li key={affected.decision.id}>
              <label className="revisit-pick">
                <input type="checkbox" checked={isTicked(affected)} onChange={(e) => tick(affected, e.target.checked)} />
                <RevisitWhat affected={affected} numbered />
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    );

  return (
    <section className="refresh-note is-drift revisit" aria-labelledby={headingId}>
      <p id={headingId}>
        <span>This may change {offered.length} decisions settled before it. Ask agents to check the ones that matter still hold.</span>
      </p>
      {group('Likely', likely)}
      {group('Less likely: same area or similar words', lessLikely)}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-primary btn-small" disabled={busy || ticked.length === 0} onClick={() => void ask(ticked)}>
          <Icon name="sync" /> Ask for a refresh of {ticked.length}
        </button>
        <button className="btn btn-quiet btn-small" disabled={busy || ticked.length === offered.length} onClick={selectAll}>
          Select all
        </button>
        {notNow}
      </div>
    </section>
  );
}

const SHOWN_WHY = 2;

// A decision the prompt offers: its question, where it stands, and why it is listed.
function RevisitWhat({ affected, numbered }: { affected: Affected; numbered: boolean }) {
  const { decision, reasons } = affected;
  const shown = reasons.slice(0, SHOWN_WHY);
  return (
    <span className="revisit-what">
      <span className="revisit-question">
        {numbered && <span className="card-number">#{decision.number}</span>} {decision.question}
      </span>
      <span className="revisit-answer">{standingWords(decision)}</span>
      <span className="revisit-why" title={reasons.map(reasonTitle).join('\n')}>
        {shown.map((reason, i) => (
          <span key={reason.kind}>
            {i > 0 && <span aria-hidden> · </span>}
            {revisitWhy(reason)}
          </span>
        ))}
      </span>
    </span>
  );
}
