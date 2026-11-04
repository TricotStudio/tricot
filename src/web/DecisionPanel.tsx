import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { decisionClosure } from '../core/closure';
import { describeChoice, samePerson } from '../core/format';
import type { Board, Decision, Finding, Option } from '../core/types';
import { CouldAffect, RevisitPrompt } from './affects';
import { api } from './api';
import { Asks } from './asks';
import { CriteriaMatrix } from './criteria';
import { Comparison, comparisonData } from './canvas/blocks/comparison/comparison';
import { ActorBadge, Icon, Md, timeAgo } from './components';
import { go, ReadOnlyContext, useReadOnly } from './hooks';
import { History } from './history';
import { CardApprovals } from './approvals';
import { TakingALook } from './looking';
import { RefText } from './refs';
import { FromThreadLink } from './threadWork';
import { Discussion } from './discussion';
import { besidePins, PinnedFrom } from './canvas/pins';
import { CLOSED_NOTE, ClosedBand } from './closed';
import { canRevise, EarlierWording, FreshnessNote, OptionEditor, RefreshPrompt, WordingEditor } from './refresh';
import { TasksBuiltOn } from './tasks';

const OTHER = '__other__';

interface Props {
  board: Board;
  decision: Decision;
  name: string;
  onHoverOption: (optionId: string | null) => void;
  unreadSince?: string | null; // comments by others after this are unread
  retireAsk?: number; // counts up each time the delete dialog's Retire it instead asks for the retire form
}

// Everything about a decision except its canvas: context, options, evidence,
// discussion, and the controls for deciding.
export function DecisionPanel({ board, decision, name, onHoverOption, unreadSince = null, retireAsk = 0 }: Props) {
  // Nothing is preselected, not even the recommendation: the human should
  // make the call, not drift into the default.
  const readOnly = useReadOnly();
  const [selected, setSelected] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An action that would end the standing answer waits here for a second click.
  const [pending, setPending] = useState<{ verb: string; act: () => void } | null>(null);
  const [editing, setEditing] = useState<{ optionId: string; mode: 'edit' | 'outdate' } | null>(null);
  const [rewording, setRewording] = useState(false);
  const [retiring, setRetiring] = useState<string | null>(null); // the reason, while asking for it
  // Asked for from the delete dialog: the retire form opens, with the focus in its reason.
  const retireBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!retireAsk) return;
    setRetiring((reason) => reason ?? '');
    requestAnimationFrame(() => retireBox.current?.focus());
  }, [retireAsk]);

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

  const resetDraft = () => {
    setNote('');
    setSelected(null);
    setAnswer('');
  };

  // An option that went outdated while it was selected can't be picked any more.
  const pickable = selected && !decision.options.find((o) => o.id === selected)?.outdated ? selected : null;
  const choice = selected === OTHER ? (answer.trim() ? { answer } : null) : pickable ? { optionId: pickable } : null;
  // Decided or retired, the panel leads with who closed it and the way back,
  // in place of the controls for deciding, and the rest recedes.
  const closure = decisionClosure(decision);
  const answerable = !readOnly && !closure;
  const revisable = !readOnly && canRevise(decision);
  const standing = decision.status === 'decided' || decision.status === 'provisional' ? decision.resolution : undefined;
  const builtOn = board.tasks.filter((t) => t.decisionIds.includes(decision.id));

  // Ending a standing answer, or one with tasks built on it, takes a second
  // click: one stray click shouldn't discard a decision.
  const guarded = (verb: string, endsAnswer: boolean, act: () => void) => {
    if (endsAnswer && (standing || builtOn.length > 0)) setPending({ verb, act });
    else act();
  };

  const decide = (provisional: boolean) => {
    if (!choice) return;
    const changes = !standing || standing.optionId !== choice.optionId || (standing.answer ?? undefined) !== choice.answer;
    const act = () => run(() => api.resolve(decision.id, name, { ...choice, rationale: note, provisional }), resetDraft);
    guarded(provisional ? 'Decide for now' : 'Decide', Boolean(standing) && changes, act);
  };

  const resolution = decision.resolution;
  const confirm = () =>
    resolution &&
    run(() =>
      api.resolve(decision.id, name, {
        optionId: resolution.optionId,
        answer: resolution.optionId ? undefined : resolution.answer,
        rationale: resolution.rationale,
        provisional: false,
      }),
    );

  const dependencies = decision.dependsOn
    .map((id) => board.decisions.find((d) => d.id === id))
    .filter((d): d is Decision => Boolean(d));
  const dependents = board.decisions.filter((d) => d.dependsOn.includes(decision.id));
  const generalFindings = decision.findings.filter((f) => !f.optionId);
  const comparable = comparisonData(decision) !== null;
  const context = besidePins(board, { decisionId: decision.id }, decision.context);

  // The second click that ends a standing answer, or changes one with work
  // built on it: in the footer, or in the band of a closed card.
  const confirmRow = pending && (
    <div className="confirm-row" role="alert">
      <p>
        {standing ? (
          <>
            This sets aside the current answer, <strong>{describeChoice(decision)}</strong>.
          </>
        ) : (
          'This changes a decision that has work built on it.'
        )}
        {builtOn.length > 0 && (
          <>
            {' '}
            {builtOn.map((t) => `T${t.number}`).join(', ')} {builtOn.length === 1 ? 'builds' : 'build'} on it and will be marked
            stale until re-checked.
          </>
        )}
      </p>
      <div className="row">
        <button
          className="btn btn-small"
          onClick={() => {
            pending.act();
            setPending(null);
          }}
        >
          {pending.verb} anyway
        </button>
        <button className="btn btn-quiet btn-small" onClick={() => setPending(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
  const reopen = () => guarded('Reopen', true, () => run(() => api.reopen(decision.id, name)));

  // Retiring asks why first: in the footer, or in the band of a decided card.
  const retireForm = retiring !== null && (
    <form
      className="confirm-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (retiring.trim()) void run(() => api.retire(decision.id, name, retiring), () => (setRetiring(null), resetDraft()));
      }}
    >
      <p>
        {standing && (
          <>
            This sets aside the current answer, <strong>{describeChoice(decision)}</strong>.{' '}
          </>
        )}
        Retired, it waits under Deferred as no longer relevant, without counting as decided, and you can bring it back.
        {builtOn.length > 0 && (
          <>
            {' '}
            {builtOn.map((t) => `T${t.number}`).join(', ')} {builtOn.length === 1 ? 'builds' : 'build'} on it and will be
            marked stale.
          </>
        )}
      </p>
      <textarea
        ref={retireBox}
        autoFocus
        rows={2}
        value={retiring}
        onChange={(e) => setRetiring(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setRetiring(null)}
        placeholder="Why is it no longer relevant?"
        aria-label="Why is it no longer relevant?"
      />
      <div className="row">
        <button className="btn btn-small" disabled={busy || !retiring.trim()}>
          Retire
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setRetiring(null)}>
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <aside className={`decision-panel${closure ? ' is-closed' : ''}`} aria-label="Decision">
      <TakingALook kind="decision" id={decision.id} band />
      <CardApprovals kind="decision" id={decision.id} name={name} band />
      {closure && (
        <ClosedBand closure={closure}>
          {!readOnly &&
            !pending &&
            (closure.kind === 'retired' ? (
              <button
                className="btn btn-small closed-action"
                disabled={busy}
                onClick={() => run(() => api.reopen(decision.id, name))}
                title="It returns to Open, with its options as they were"
              >
                Bring it back
              </button>
            ) : (
              <button className="btn btn-small closed-action" disabled={busy} onClick={reopen}>
                Reopen
              </button>
            ))}
          {!readOnly && confirmRow && <div className="closed-confirm">{confirmRow}</div>}
          {!readOnly && closure.kind === 'decided' && retireForm && <div className="closed-confirm">{retireForm}</div>}
          {error && <p className="error closed-confirm">{error}</p>}
        </ClosedBand>
      )}
      <div className="drawer-scroll">
        <p className="drawer-byline">
          Asked by <ActorBadge actor={decision.createdBy} /> {timeAgo(decision.createdAt)}
          {revisable && !rewording && (
            <>
              <span className="row-spacer" />
              <button className="btn btn-quiet btn-small" onClick={() => setRewording(true)} title="Reword the question or its context">
                <Icon name="edit" /> Edit
              </button>
            </>
          )}
        </p>
        <FromThreadLink board={board} from={decision.fromThread} view="decisions" />
        {rewording && <WordingEditor decision={decision} name={name} onDone={() => setRewording(false)} />}
        <RevisitPrompt key={decision.id} board={board} decision={decision} name={name} />

        {(dependencies.length > 0 || dependents.length > 0) && (
          <div className="relations">
            {dependencies.length > 0 && (
              <RelationRow label="Depends on" decisions={dependencies} boardId={board.id} />
            )}
            {dependents.length > 0 && <RelationRow label="Blocks" decisions={dependents} boardId={board.id} />}
          </div>
        )}

        <Asks board={board} decision={decision} name={name} />
        {closure ? (
          closure.kind === 'retired' &&
          closure.reason && (
            <p className="closed-quote">
              “<RefText text={closure.reason} />”
            </p>
          )
        ) : (
          <StatusBanner decision={decision} onConfirm={readOnly ? undefined : confirm} busy={busy} />
        )}
        <FreshnessNote board={board} decision={decision} name={name} />
        <EarlierAnswers decision={decision} />
        <EarlierWording decision={decision} />
        <TasksBuiltOn board={board} decision={decision} name={name} />

        {context && (
          <section className="section">
            <h3>Context</h3>
            <Md>{context}</Md>
          </section>
        )}
        <PinnedFrom board={board} decisionId={decision.id} />
        <CouldAffect board={board} decision={decision} />

        <Comparison decision={decision} />

        <section className="section">
          <h3>Options</h3>
          <div className="options" role={answerable ? 'radiogroup' : undefined} aria-label="Options">
            {decision.options.map((option) =>
              editing?.optionId === option.id ? (
                <OptionEditor
                  key={option.id}
                  decision={decision}
                  option={option}
                  name={name}
                  mode={editing.mode}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <OptionCard
                  key={option.id}
                  option={option}
                  decision={decision}
                  findings={decision.findings.filter((f) => f.optionId === option.id)}
                  pinned={decision.canvas.blocks.filter((b) => b.optionId === option.id).length}
                  onHover={onHoverOption}
                  showMetrics={!comparable}
                  selected={selected === option.id}
                  onSelect={answerable ? () => setSelected(selected === option.id ? null : option.id) : undefined}
                  onEdit={revisable ? (mode) => setEditing({ optionId: option.id, mode }) : undefined}
                  onRestore={
                    revisable ? () => run(() => api.revise(decision.id, name, { options: [{ id: option.id, outdated: false }] })) : undefined
                  }
                  fresh={freshness(option, decision, name, unreadSince)}
                />
              ),
            )}
            {answerable && (
              <div
                className={`option option-other${selected === OTHER ? ' is-selected' : ''}`}
                role="radio"
                aria-checked={selected === OTHER}
                tabIndex={0}
                onClick={() => setSelected(OTHER)}
                onKeyDown={(e) => e.key === 'Enter' && setSelected(OTHER)}
              >
                <div className="option-head">
                  <span className="option-letter">…</span>
                  <span className="option-label">Something else</span>
                </div>
                {selected === OTHER && (
                  <textarea
                    autoFocus
                    rows={2}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Your answer"
                  />
                )}
              </div>
            )}
          </div>
          {closure?.kind === 'decided' && closure.rationale && (
            <p className="closed-quote">
              “<RefText text={closure.rationale} />”
            </p>
          )}
          {answerable && (
            <div className="option-actions">
              <AddOption decisionId={decision.id} name={name} />
              <RefreshPrompt decision={decision} name={name} />
            </div>
          )}
        </section>

        {/* A closed card's criteria and marks are a record: read, not added to. */}
        <ReadOnlyContext.Provider value={!answerable}>
          <CriteriaMatrix decision={decision} name={name} />
        </ReadOnlyContext.Provider>

        {generalFindings.length > 0 && (
          <section className="section">
            <h3>Findings</h3>
            {generalFindings.map((finding) => (
              <FindingView key={finding.id} finding={finding} />
            ))}
          </section>
        )}

        <Discussion
          board={board}
          where={{ decision }}
          comments={decision.comments}
          pins={decision.canvas.pins}
          name={name}
          unreadSince={unreadSince}
          place={{ decisionId: decision.id }}
          onSend={(body) => api.comment(decision.id, name, body)}
          placeholder={closure ? CLOSED_NOTE[closure.kind] : undefined}
        />

        <History board={board} name={name} about={{ decision: decision.id }} />
      </div>

      {answerable && (
        <footer className="drawer-actions">
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why? Optional. Sent with whatever you do next, so agents know your reasoning."
          />
          {error && <p className="error">{error}</p>}
          {confirmRow}
          {retireForm}
          <div className="row">
            <button className="btn btn-primary" disabled={!choice || busy} onClick={() => decide(false)}>
              Decide
            </button>
            <button
              className="btn"
              disabled={!choice || busy}
              onClick={() => decide(true)}
              title="Provisional: agents proceed, but keep it cheap to change"
            >
              Decide for now
            </button>
            <span className="row-spacer" />
            <button
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => guarded('Explore', true, () => run(() => api.explore(decision.id, name, note), resetDraft))}
              title="Ask agents to research or prototype the options before you decide"
            >
              Ask agents to explore
            </button>
            {decision.status !== 'deferred' && (
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => guarded('Defer', true, () => run(() => api.defer(decision.id, name, note), resetDraft))}
              >
                Defer
              </button>
            )}
            {decision.status !== 'open' && (
              <button className="btn btn-quiet" disabled={busy} onClick={reopen}>
                Reopen
              </button>
            )}
            <button
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => setRetiring(note)}
              title="Set it aside as no longer relevant, without deciding it"
            >
              Retire
            </button>
          </div>
        </footer>
      )}
    </aside>
  );
}

function RelationRow({ label, decisions, boardId }: { label: string; decisions: Decision[]; boardId: string }) {
  return (
    <div className="relation-row">
      <span className="faint small">{label}</span>
      {decisions.map((d) => (
        <button key={d.id} className={`relation relation-${d.status}`} onClick={() => go.decision(boardId, d.id)}>
          #{d.number} {d.question}
        </button>
      ))}
    </div>
  );
}

// Where an open card stands. A closed one, decided or retired, says it in the
// band atop its panel instead.
function StatusBanner({ decision, onConfirm, busy }: { decision: Decision; onConfirm?: () => void; busy: boolean }) {
  let body: ReactNode = null;
  const { resolution, exploreRequest, deferral } = decision;

  if (resolution && decision.status === 'provisional') {
    body = (
      <>
        <p className="banner-choice">
          <span>For now</span>
          <Icon name="arrow-right" />
          <strong>{describeChoice(decision)}</strong>
        </p>
        <p className="banner-by">
          by <ActorBadge actor={resolution.by} /> {timeAgo(resolution.at)}
        </p>
        {resolution.rationale && <p className="banner-quote">“<RefText text={resolution.rationale} />”</p>}
        {onConfirm && (
          <button className="btn btn-small" disabled={busy} onClick={onConfirm}>
            Confirm as decided
          </button>
        )}
      </>
    );
  } else if (exploreRequest && decision.status === 'exploring') {
    body = (
      <>
        <p>
          <ActorBadge actor={exploreRequest.by} /> asked agents to explore {timeAgo(exploreRequest.at)}
        </p>
        {exploreRequest.text && <p className="banner-quote">“<RefText text={exploreRequest.text} />”</p>}
      </>
    );
  } else if (deferral && decision.status === 'deferred') {
    body = (
      <>
        <p>
          Deferred by <ActorBadge actor={deferral.by} /> {timeAgo(deferral.at)}
        </p>
        {deferral.text && <p className="banner-quote">“<RefText text={deferral.text} />”</p>}
      </>
    );
  }
  return body ? <div className={`banner banner-${decision.status}`}>{body}</div> : null;
}

const ENDED: Record<Decision['history'][number]['ended'], string> = {
  replaced: 'Replaced',
  confirmed: 'Confirmed',
  reopened: 'Reopened',
  explore: 'Sent back to explore',
  deferred: 'Deferred',
  retired: 'Retired',
};

// Answers that no longer stand, newest first, so a reopened or changed
// decision still shows who decided what before and why.
function EarlierAnswers({ decision }: { decision: Decision }) {
  if (decision.history.length === 0) return null;
  return (
    <details className="section earlier">
      <summary>Earlier answers ({decision.history.length})</summary>
      <ol>
        {[...decision.history].reverse().map((past) => {
          const option = decision.options.find((o) => o.id === past.optionId);
          return (
            <li key={`${past.at}-${past.endedAt}`}>
              <p>
                <span className="earlier-status">{past.status === 'provisional' ? 'For now' : 'Decided'}</span>{' '}
                <strong>{option ? `${option.id}) ${past.label ?? option.label}` : `“${past.answer}”`}</strong> by{' '}
                <ActorBadge actor={past.by} /> <span className="faint">{timeAgo(past.at)}</span>
              </p>
              {past.rationale && <p className="banner-quote">“<RefText text={past.rationale} />”</p>}
              <p className="faint small">
                {ENDED[past.ended]} by {past.endedBy.name} {timeAgo(past.endedAt)}
              </p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

// Whether others added or reworded an option since this person last looked.
function freshness(option: Option, decision: Decision, me: string, since: string | null): 'new' | 'updated' | undefined {
  if (!since) return undefined;
  const others = (actor: { kind: string; name: string }) => !(actor.kind === 'human' && samePerson(actor.name, me));
  if (option.createdAt > since && others(option.proposedBy)) return 'new';
  const revised = decision.revisions?.some((r) => r.optionId === option.id && r.at > since && others(r.by));
  return revised || (option.outdated && option.outdated.at > since && others(option.outdated.by)) ? 'updated' : undefined;
}

function OptionCard(props: {
  option: Option;
  decision: Decision;
  findings: Finding[];
  pinned: number;
  onHover: (optionId: string | null) => void;
  showMetrics: boolean;
  selected: boolean;
  onSelect?: () => void; // absent when the board is read-only
  onEdit?: (mode: 'edit' | 'outdate') => void; // absent once the card is answered
  onRestore?: () => void;
  fresh?: 'new' | 'updated';
}) {
  const { option, decision, findings, pinned, onHover, showMetrics, selected, onSelect, onEdit, onRestore, fresh } = props;
  const outdated = option.outdated;
  const recommended = decision.recommendation?.optionId === option.id && !outdated;
  const chosen = decision.resolution?.optionId === option.id;
  const classes = ['option', selected && !outdated && 'is-selected', chosen && 'is-chosen', outdated && 'is-outdated']
    .filter(Boolean)
    .join(' ');
  // An outdated option is read, not picked.
  const select = outdated ? undefined : onSelect;

  return (
    <div
      className={classes}
      role={onSelect && 'radio'}
      aria-checked={onSelect && selected && !outdated}
      aria-disabled={onSelect && outdated ? true : undefined}
      tabIndex={select && 0}
      onMouseEnter={() => onHover(option.id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('a, button')) select?.();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || !select || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        select();
      }}
    >
      <div className="option-head">
        <span className="option-letter">{option.id}</span>
        <span className="option-label">{option.label}</span>
        {outdated && <span className="tag tag-outdated">outdated</span>}
        {fresh && <span className="tag tag-new">{fresh}</span>}
        {chosen && <span className="tag tag-chosen">chosen</span>}
        {pinned > 0 && (
          <span className="tag tag-pinned" title="Hover to highlight its evidence on the canvas">
            {pinned} on canvas
          </span>
        )}
        {recommended && (
          <span className="tag tag-recommended" title={decision.recommendation?.reason}>
            <Icon name="star" /> recommended
          </span>
        )}
        {onEdit && (
          <span className="option-tools">
            <button className="icon-button" onClick={() => onEdit('edit')} aria-label={`Edit option ${option.id}`} title="Edit">
              <Icon name="edit" />
            </button>
            {!outdated && (
              <button
                className="icon-button"
                onClick={() => onEdit('outdate')}
                aria-label={`Mark option ${option.id} outdated`}
                title="Mark outdated: it no longer applies"
              >
                <Icon name="x" />
              </button>
            )}
          </span>
        )}
      </div>
      {option.description && (
        <div className="option-desc">
          <Md>{option.description}</Md>
        </div>
      )}
      {outdated && (
        <p className="option-outdated">
          <span>
            Outdated by {outdated.by.name} {timeAgo(outdated.at)}
            {outdated.reason && <>: “<RefText text={outdated.reason} />”</>}
          </span>
          {onRestore && (
            <button className="link-button" onClick={onRestore}>
              Bring it back
            </button>
          )}
        </p>
      )}
      {recommended && decision.recommendation?.reason && (
        <p className="option-reason">
          <ActorBadge actor={decision.recommendation.by} showName={false} />
          <span>
            <RefText text={decision.recommendation.reason} />
          </span>
        </p>
      )}
      {(option.pros?.length || option.cons?.length) && (
        <ul className="tradeoffs">
          {option.pros?.map((pro) => (
            <li key={`p-${pro}`} className="pro">
              {pro}
            </li>
          ))}
          {option.cons?.map((con) => (
            <li key={`c-${con}`} className="con">
              {con}
            </li>
          ))}
        </ul>
      )}
      {findings.map((finding) => (
        <FindingView key={finding.id} finding={finding} showMetrics={showMetrics} />
      ))}
    </div>
  );
}

function FindingView({ finding, showMetrics = true }: { finding: Finding; showMetrics?: boolean }) {
  return (
    <div className="finding">
      <div className="finding-head">
        <ActorBadge actor={finding.author} /> <span className="faint small">{timeAgo(finding.createdAt)}</span>
      </div>
      <Md>{finding.summary}</Md>
      {showMetrics && finding.metrics && (
        <dl className="metrics">
          {Object.entries(finding.metrics).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {finding.links && (
        <ul className="links">
          {finding.links.map((link) => (
            <li key={link}>{/^https?:\/\//.test(link) ? <a href={link} target="_blank" rel="noreferrer">{link}</a> : <code>{link}</code>}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddOption({ decisionId, name }: { decisionId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  if (!open) {
    return (
      <button className="link-button" onClick={() => setOpen(true)}>
        <Icon name="plus" /> Add an option
      </button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return;
    await api.addOption(decisionId, name, label).catch(() => {});
    setLabel('');
    setOpen(false);
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Another option worth considering" />
      <button className="btn btn-small" disabled={!label.trim()}>
        Add
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

