import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { decisionNeedsYou } from '../core/attention';
import {
  answerOf,
  buildTable,
  builtOn,
  shortDate,
  whenOf,
  type Section,
  type SectionKey,
  type TableFilter,
} from '../core/decisionTable';
import { listNames, pendingAsks, samePerson } from '../core/format';
import { driftAge, driftChanges, driftOf } from '../core/freshness';
import { decisionsMatching } from '../core/search';
import type { Board, BoardEvent, Decision } from '../core/types';
import { Icon } from './components';
import { DecisionMap } from './decisionMap';
import { cardHash, go, useReadOnly } from './hooks';
import { useSeenOnBoard, type JustMade } from './justMade';
import { TakingALook } from './looking';
import { RefChip } from './refs';

// The Decisions tab: every decision on the board as one reference table, what
// needs a call first, then what was decided, newest first, then what was set
// aside. A row opens its decision, as a card did. The Map switch shows the same
// decisions along time instead (decisionMap.tsx). People raise a question
// through the chat bar at the foot of the tab (threads.tsx), which an agent
// turns into a card, or which goes up as a plain question while none listens.

const FILTERS: { key: TableFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'call', label: 'Needs a call' },
  { key: 'decided', label: 'Decided' },
  { key: 'approvals', label: 'Approvals' },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A section's head: its name, then how many rows it has and what they are.
// Under All, Decided's approvals are counted on their own folded row.
const SECTION_HEAD: Record<SectionKey, { title: string; hint: (rows: number, filter: TableFilter) => string }> = {
  call: { title: 'Needs a call', hint: (n) => `${n} · open, being explored, or decided for now` },
  decided: {
    title: 'Decided',
    hint: (n, filter) => (n ? `${plural(n, filter === 'approvals' ? 'approval' : 'choice')} · newest first` : 'newest first'),
  },
  aside: { title: 'Deferred and retired', hint: (n) => `${n} · not now, or no longer relevant` },
};

const BUILT_SHOWN = 3; // task chips in a row before "+N"

// What the viewer had set on a board's table, kept while the page is open, so
// opening a decision and closing it again comes back to the same rows.
interface TableState {
  layout: 'table' | 'map';
  query: string;
  filter: TableFilter;
  showApprovals: boolean;
}
const remembered = new Map<string, TableState>();

interface Props {
  board: Board;
  name: string;
  unseen: BoardEvent[]; // what others changed since the viewer last looked
  newDecisions: ReadonlySet<string>; // decisions with unseen changes
  changed: ReadonlySet<string>; // decisions that just changed, for a brief highlight
  justMade: JustMade; // made from your conversation: lit until seen (justMade.ts)
}

export function DecisionsView({ board, name, unseen, newDecisions, changed, justMade }: Props) {
  const readOnly = useReadOnly();
  const [state, setState] = useState<TableState>(
    () => remembered.get(board.id) ?? { layout: 'table', query: '', filter: 'all', showApprovals: false },
  );
  useEffect(() => {
    remembered.set(board.id, state);
  }, [board.id, state]);
  const { layout, query, filter, showApprovals } = state;
  const set = (patch: Partial<TableState>) => setState((current) => ({ ...current, ...patch }));

  const needsYou = useMemo(() => {
    const flagged = new Set(
      readOnly ? [] : board.decisions.filter((d) => decisionNeedsYou(d, board, name, unseen)).map((d) => d.id),
    );
    return (d: Decision) => flagged.has(d.id);
  }, [board, name, unseen, readOnly]);
  const matches = useMemo(() => decisionsMatching(board, query), [board, query]);
  const table = useMemo(
    () => buildTable(board.decisions, { filter, needsYou, matches }),
    [board.decisions, filter, needsYou, matches],
  );
  // A search shows every approval it finds, rather than folding them away.
  const expanded = showApprovals || matches !== null;
  const now = Date.now();

  // Comments on a decision's tasks carry its id too, but belong to the task's card.
  const row = (decision: Decision, extra?: string) => (
    <DecisionRow
      key={decision.id}
      board={board}
      decision={decision}
      me={name}
      now={now}
      flash={changed.has(decision.id)}
      made={justMade.held.has(decision.id) ? 'held' : justMade.fading.has(decision.id) ? 'fading' : undefined}
      onSeen={justMade.seen}
      isNew={newDecisions.has(decision.id)}
      needsYou={needsYou(decision)}
      newComments={unseen.filter((e) => e.type === 'comment_added' && e.decisionId === decision.id && !e.taskId).length}
      extra={extra}
    />
  );

  const sectionRows = (section: Section) => {
    const { approvals } = section;
    if (approvals.length === 0) return section.rows.map((d) => row(d));
    const latest = approvals[0];
    // Folded away, what is new on them or waits on the viewer still shows on the fold.
    const waiting = approvals.filter(needsYou).length;
    const fresh = approvals.filter((d) => newDecisions.has(d.id)).length;
    const toggle = () => set({ showApprovals: !showApprovals });
    const fold = ['dt-fold', waiting ? 'is-needs-you' : fresh ? 'is-new' : '', matches && 'is-static'].filter(Boolean).join(' ');
    return [
      <tr key="approvals" className={fold} onClick={matches ? undefined : toggle}>
        <td colSpan={5}>
          <div className="dt-fold-line">
            <span className="dt-fold-mark" aria-hidden>
              <Icon name="check" />
            </span>
            <strong>{plural(approvals.length, 'approval')}</strong>
            <span className="dt-fold-text" title={latest.question}>
              <span className="dt-fold-sep">· </span>
              latest “{latest.question}” · {shortDate(latest.resolution?.at ?? latest.updatedAt, now)}
            </span>
            {fresh > 0 && (
              <span className="dt-flag new-comments">
                <span className="new-dot" aria-hidden /> {fresh} changed
              </span>
            )}
            {waiting > 0 && <span className="tag tag-asked">{waiting} for you</span>}
            <span className="row-spacer" />
            {/* A search shows each approval it finds, so there is nothing to fold. */}
            {!matches && (
              <button
                type="button"
                className="dt-fold-toggle"
                aria-expanded={showApprovals}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
              >
                {showApprovals ? 'Hide' : 'Show'}
                <span className="dt-chevron" aria-hidden />
              </button>
            )}
          </div>
        </td>
      </tr>,
      ...(expanded ? approvals.map((d) => row(d, 'is-approval')) : []),
      ...section.rows.map((d) => row(d)),
    ];
  };

  const empty =
    board.decisions.length === 0
      ? 'No decisions yet. Say what you’re weighing in the bar below, or let an agent post one.'
      : table.sections.length === 0
        ? matches
          ? `Nothing here matches “${query.trim()}”.`
          : 'Nothing here right now.'
        : null;

  const layoutSwitch = (
    <div className="dt-seg dt-layout" role="group" aria-label="Layout">
      {(['table', 'map'] as const).map((key) => (
        <button
          key={key}
          type="button"
          className={layout === key ? 'is-active' : ''}
          aria-pressed={layout === key}
          onClick={() => set({ layout: key })}
        >
          {key === 'table' ? 'Table' : 'Map'}
        </button>
      ))}
    </div>
  );

  if (layout === 'map') {
    return (
      <section className="decisions" aria-label="Decisions">
        <DecisionMap board={board} name={name} switcher={layoutSwitch} onTable={() => set({ layout: 'table' })} />
      </section>
    );
  }

  return (
    <section className="decisions" aria-label="Decisions">
      <div className="dt-tools">
        {layoutSwitch}
        <label className="dt-search">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                set({ query: '' });
              }
            }}
            placeholder="Search questions, answers and reasons"
            aria-label="Search decisions"
          />
        </label>
        <div className="dt-seg dt-filters" role="group" aria-label="Show">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={filter === key ? 'is-active' : ''}
              aria-pressed={filter === key}
              onClick={() => set({ filter: key })}
            >
              {label} <span className="tab-count">{table.counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dt-scroll">
        {empty ? (
          <div className="empty dt-empty">
            <p>{empty}</p>
            {matches && (
              <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ query: '', filter: 'all' })}>
                Clear the search
              </button>
            )}
          </div>
        ) : (
          <table className="dt">
            <colgroup>
              <col className="dt-c-num" />
              <col className="dt-c-q" />
              <col className="dt-c-a" />
              <col className="dt-c-b" />
              <col className="dt-c-w" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Question</th>
                <th scope="col">Answer</th>
                <th scope="col">Built on it</th>
                <th scope="col" className="dt-w">
                  Decided
                </th>
              </tr>
            </thead>
            {table.sections.map((section) => {
              const head = SECTION_HEAD[section.key];
              return (
                <tbody key={section.key} className={`dt-section dt-section-${section.key}`}>
                  <tr className="dt-group">
                    <th colSpan={5} scope="colgroup">
                      <strong>{head.title}</strong>
                      <span className="dt-group-hint">{head.hint(section.rows.length, filter)}</span>
                    </th>
                  </tr>
                  {sectionRows(section)}
                </tbody>
              );
            })}
          </table>
        )}
      </div>
    </section>
  );
}

function DecisionRow(props: {
  board: Board;
  decision: Decision;
  me: string;
  now: number;
  flash: boolean;
  made?: 'held' | 'fading'; // just made from your conversation
  onSeen: (id: string) => void;
  isNew: boolean;
  needsYou: boolean;
  newComments: number;
  extra?: string;
}) {
  const { board, decision, me, now, flash, made, onSeen, isNew, needsYou, newComments, extra } = props;
  const rowRef = useRef<HTMLTableRowElement>(null);
  useSeenOnBoard(rowRef, made === 'held', () => onSeen(decision.id));
  const drift = driftOf(board, decision, now);
  const waiting = pendingAsks(decision).map((a) => a.name);
  const askedOfMe = waiting.some((n) => samePerson(n, me));
  const others = waiting.filter((n) => !samePerson(n, me));
  const agentCall = decision.status === 'provisional' && decision.resolution?.by.kind === 'agent';
  const answer = answerOf(decision);
  const built = builtOn(board, decision);
  const when = whenOf(decision, now);
  const href = cardHash.decision(board.id, decision.id);
  // A click anywhere on the row opens the decision, as a card did; the links
  // in it (the question, the task chips) go where they say.
  const open = (e: MouseEvent) => {
    if ((e.target as Element).closest('a, button')) return;
    go.decision(board.id, decision.id);
  };
  const classes = [
    'dt-row',
    `dt-row-${decision.status}`,
    // Just made from your conversation outranks the rest until seen; then
    // waiting on the viewer outranks merely changed, as on cards: amber, else blue.
    made === 'held' ? 'is-made' : needsYou ? 'is-needs-you' : isNew ? 'is-new' : '',
    made === 'fading' ? 'is-made-fading' : flash && !made ? 'is-flash' : '',
    extra,
  ];
  return (
    <tr
      ref={rowRef}
      className={classes.filter(Boolean).join(' ')}
      onClick={open}
      style={{ '--lane': `var(--${decision.status === 'retired' ? 'deferred' : decision.status})` } as CSSProperties}
    >
      <td className="dt-num">
        <span className={`dt-marker ref-${decision.status}`} title={decision.status} />
        <span>#{decision.number}</span>
        {isNew && made !== 'held' && <span className="new-dot" title="Changed since you last looked" />}
      </td>
      <td className="dt-q-cell">
        <div className="dt-q-line">
          <a className="dt-q" href={href} title={decision.question}>
            {decision.question}
          </a>
          {decision.blocking && decision.status === 'open' && <span className="tag tag-blocking">blocking</span>}
          {agentCall && <span className="tag tag-agent">agent's call</span>}
          {askedOfMe && <span className="tag tag-asked">asked of you</span>}
          {drift && (
            <span className="dt-flag card-drift" title={`${driftAge(drift)}. Since then, ${driftChanges(drift)}.`}>
              may be out of date
            </span>
          )}
          {decision.refreshRequest && <span className="dt-flag card-refreshing">refresh asked</span>}
          {!askedOfMe && others.length > 0 && (
            <span className="dt-flag card-waiting" title={`Waiting for ${listNames(others)}`}>
              waiting for {others.length > 2 ? `${others.length} people` : listNames(others)}
            </span>
          )}
          {newComments > 0 && (
            <span className="dt-flag new-comments">
              {newComments} new comment{newComments === 1 ? '' : 's'}
            </span>
          )}
          <TakingALook kind="decision" id={decision.id} />
        </div>
      </td>
      <td className="dt-a-cell">
        <AnswerCell answer={answer} status={decision.status} />
      </td>
      <td className="dt-b-cell">
        <div className="dt-built">
          {built.tasks.length > 0 ? (
            <>
              {built.holds && <span className="dt-built-note">holds</span>}
              {built.tasks.slice(0, BUILT_SHOWN).map((t) => (
                <RefChip key={t.id} kind="task" number={t.number} />
              ))}
              {built.tasks.length > BUILT_SHOWN && (
                <span
                  className="dt-built-note"
                  title={built.tasks
                    .slice(BUILT_SHOWN)
                    .map((t) => `T${t.number} ${t.title}`)
                    .join('\n')}
                >
                  +{built.tasks.length - BUILT_SHOWN}
                </span>
              )}
            </>
          ) : (
            decision.findings.length > 0 &&
            !['decided', 'retired'].includes(decision.status) && (
              <span className="dt-built-note">
                {decision.findings.length} finding{decision.findings.length === 1 ? '' : 's'}
              </span>
            )
          )}
        </div>
      </td>
      <td className="dt-w" title={made === 'held' ? 'Made from your conversation just now' : when.title}>
        {made === 'held' ? <span className="just-made">just made</span> : when.text}
      </td>
    </tr>
  );
}

function AnswerCell({ answer, status }: { answer: ReturnType<typeof answerOf>; status: Decision['status'] }) {
  switch (answer.kind) {
    case 'chosen':
      return (
        <div className={`dt-a is-chosen${status === 'provisional' ? ' is-provisional' : ''}`} title={`${answer.letter}) ${answer.label}`}>
          <span className="option-letter">{answer.letter}</span>
          <span className="dt-a-text">{answer.label}</span>
        </div>
      );
    case 'recommended':
      return (
        <div className="dt-a is-recommended" title={`Recommended: ${answer.letter}) ${answer.label}`}>
          <span className="option-letter">{answer.letter}</span>
          <span className="dt-a-text">
            {answer.label}{' '}
            <span className="star" role="img" aria-label="Recommended">
              <Icon name="star" />
            </span>
          </span>
        </div>
      );
    case 'words':
      return (
        <div className="dt-a is-words" title={answer.text}>
          <span className="dt-a-text">“{answer.text}”</span>
        </div>
      );
    case 'none':
      return (
        <div className="dt-a is-none" title={answer.note ? `${answer.text}: “${answer.note}”` : undefined}>
          <span className="dt-a-text">
            {answer.text}
            {answer.note && <> · “{answer.note}”</>}
          </span>
        </div>
      );
  }
}
