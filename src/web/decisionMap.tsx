// The decision map: a board's decisions in rows by area along time, with the
// tasks they come from and lead to, and approvals on a Commits track. Click
// a decision to read it in the panel beside the map. The layout itself is
// worked out in core/decisionMap; this draws it.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { boardAreas } from '../core/areas';
import { decisionClosure } from '../core/closure';
import { decisionLinks, duration, layoutDecisionMap, type DecisionMapLayout, type MapNode, type MapShow } from '../core/decisionMap';
import { clip, listNames, pendingAsks, samePerson } from '../core/format';
import type { Board, Decision } from '../core/types';
import { api } from './api';
import { ActorBadge, Icon, STATUS_META, timeAgo } from './components';
import { go, useReadOnly, useStoredFlag } from './hooks';
import { RefChip, RefText } from './refs';
import './decisionMap.css';

export interface DecisionMapProps {
  board: Board;
  name: string; // the viewer, for "asked of you"
  onTable?: () => void; // back to the table, from the note on a narrow screen
  switcher?: ReactNode; // the Table / Map switch, drawn first in the map's toolbar
  onOpen?: (decisionId: string) => void; // Decide and Open the card; opens the card by default
}

// Narrower than this, the map can't show its rows and the panel side by side.
const MIN_WIDTH = 700;

function Glyph({ name }: { name: 'clock' | 'chevron' | 'layers' }) {
  const paths = {
    clock: (
      <>
        <circle cx="8" cy="8" r="5.75" />
        <path d="M8 5v3.25l2 1.25" />
      </>
    ),
    chevron: <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />,
    layers: (
      <>
        <path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5Z" />
        <path d="m2.5 8.5 5.5 3 5.5-3" />
      </>
    ),
  };
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name]}
    </svg>
  );
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// The decision a map opens on: the first one waiting on the viewer, else the
// first open one.
function firstToRead(layout: DecisionMapLayout): string | null {
  const current = layout.nodes.filter((n) => !n.replaced);
  return (current.find((n) => n.call) ?? current.find((n) => n.pending))?.decisionId ?? null;
}

export function DecisionMap({ board, name, onTable, switcher, onOpen }: DecisionMapProps) {
  const [rootRef, rootWidth] = useWidth<HTMLDivElement>();
  const [showAll, setShowAll] = useStoredFlag('tricot:map-all', () => false);
  const [extras, setExtras] = useStoredFlag('tricot:map-extras', () => true);
  const [picked, setPicked] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const show: MapShow = showAll ? 'all' : 'open';
  const narrow = rootWidth > 0 && rootWidth < MIN_WIDTH;
  const panelWidth = rootWidth >= 1180 ? 360 : 320;
  const mapWidth = Math.max(0, rootWidth - panelWidth);
  const minute = Math.floor(Date.now() / 60_000);
  const layout = useMemo(
    () => (mapWidth > 0 ? layoutDecisionMap(board, { now: minute * 60_000, width: mapWidth, viewer: name, show, extras }) : null),
    [board, mapWidth, name, show, extras, minute],
  );
  const open = onOpen ?? ((id: string) => go.decision(board.id, id));

  // Opened on the right, where "now" is, when the map is wider than the room.
  const wide = layout ? layout.width > mapWidth : false;
  useEffect(() => {
    if (wide && scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, [wide]);

  const onMap = layout?.nodes.some((n) => n.decisionId === picked) ? picked : null;
  const selectedId = onMap ?? (layout ? firstToRead(layout) : null);
  const selected = selectedId ? board.decisions.find((d) => d.id === selectedId) : undefined;

  // One root throughout, so its width is measured whichever way it shows.
  if (narrow) {
    return (
      <div className="dmap dmap-is-narrow" ref={rootRef}>
        <div className="dmap-narrow">
          <p>The map needs a wider screen.</p>
          {onTable && (
            <button className="btn btn-small" onClick={onTable}>
              Back to the table
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="dmap" ref={rootRef} style={{ gridTemplateColumns: `minmax(0, 1fr) ${panelWidth}px` }}>
      <section className="dmap-main" aria-label="Decision map">
        <div className="dmap-scroll" ref={scrollRef}>
          {layout && <MapCanvas board={board} layout={layout} selectedId={selectedId} onSelect={setPicked} />}
          {layout?.empty && (
            <div className="dmap-empty">
              {layout.empty === 'none' ? (
                <p>No decisions on this board yet.</p>
              ) : (
                <>
                  <p>Nothing is open right now.</p>
                  <button className="btn btn-small" onClick={() => setShowAll(true)}>
                    Show everything
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="dmap-tool">
          <div className="canvas-toolbar dmap-toolbar">
            {switcher}
            {switcher && <span className="dmap-sep" aria-hidden />}
            <label className="dmap-filter">
              Show
              <select value={show} onChange={(e) => setShowAll(e.target.value === 'all')}>
                <option value="open">open and what they touch</option>
                <option value="all">everything</option>
              </select>
              <Glyph name="chevron" />
            </label>
            <span className="dmap-sep" aria-hidden />
            <button
              className={`dmap-filter dmap-toggle${extras ? ' is-on' : ''}`}
              aria-pressed={extras}
              onClick={() => setExtras(!extras)}
              title={extras ? 'Hide tasks, board context marks and commits' : 'Show tasks, board context marks and commits'}
            >
              <span className="dmap-check" aria-hidden>
                {extras && <Icon name="check" />}
              </span>
              Tasks, context, commits
            </button>
          </div>
        </div>
        {layout && !layout.empty && <Legend layout={layout} />}
      </section>
      <aside className="dmap-panel" aria-label="Selected decision">
        {selected ? (
          <Summary key={selected.id} board={board} decision={selected} name={name} onOpen={() => open(selected.id)} />
        ) : (
          <p className="dmap-panel-hint">Select a decision on the map to read it here.</p>
        )}
      </aside>
    </div>
  );
}

function MapCanvas(props: { board: Board; layout: DecisionMapLayout; selectedId: string | null; onSelect: (id: string) => void }) {
  const { board, layout, selectedId, onSelect } = props;
  const { width, height, nowX, axisY } = layout;
  if (layout.empty) return null;
  return (
    <div className="dmap-content" style={{ width, height }}>
      {layout.ticks.map((tick) => (
        <div key={`band-${tick.t}`} className="dmap-band" style={{ left: tick.x, top: axisY - 2 }} />
      ))}
      {layout.gaps.map((gap) => (
        <div key={`gap-${gap.x}`} className="dmap-gap" style={{ left: gap.x, width: gap.w, top: axisY - 2 }} />
      ))}
      <div className="dmap-now" style={{ left: nowX, top: axisY - 2 }} />

      {layout.rows.map((row) => (
        <div key={`row-${row.key}`} className={`dmap-row${row.key ? '' : ' is-none'}`} style={{ top: row.y, height: row.h, width }}>
          <span className="dmap-row-label">
            {row.name}
            <span>{row.counts}</span>
          </span>
        </div>
      ))}

      {layout.bars.map((bar) => (
        <div key={`bar-${bar.key}`}>
          <div className={`dmap-bar b-${bar.status}`} style={{ left: bar.x1, width: bar.x2 - bar.x1, top: bar.y }} />
          {bar.label && (
            <span className={`dmap-bar-label l-${bar.status}`} style={{ left: (bar.x1 + bar.x2) / 2, top: bar.y }}>
              {bar.label}
            </span>
          )}
        </div>
      ))}

      <svg className="dmap-edges" width={width} height={height} aria-hidden>
        {layout.edges.map((edge) => (
          <path key={edge.key} className={`e-${edge.kind}`} d={edge.d} />
        ))}
      </svg>

      {layout.nodes.map((node) => (
        <Node key={node.key} node={node} selected={node.decisionId === selectedId && !node.replaced} onSelect={onSelect} />
      ))}

      {layout.chips.map((chip) => {
        const [number, more] = chip.label.split(' ');
        return (
          <button
            key={chip.key}
            className={`dmap-chip t-${chip.status}${chip.role === 'asked' ? ' is-asked' : ''}`}
            style={{ left: chip.x, top: chip.y, width: chip.w, height: chip.h }}
            title={`${chip.role === 'asked' ? 'Asked from' : 'Built on it'}:\n${chip.title}`}
            onClick={() => go.task(board.id, chip.taskIds[0])}
          >
            <b>{number}</b>
            {more && <span>{more}</span>}
          </button>
        );
      })}

      {layout.commits && (
        <div className="dmap-commits" style={{ top: layout.commits.y, width }}>
          <span className="dmap-row-label">
            Commits
            <span>
              {layout.commits.count} approval{layout.commits.count === 1 ? '' : 's'}
            </span>
          </span>
          {layout.commits.items.map((commit) => (
            <button
              key={commit.decisionId}
              className={`dmap-commit c-${commit.status}${commit.up ? ' is-up' : ''}${commit.decisionId === selectedId ? ' is-selected' : ''}`}
              style={{ left: commit.x }}
              title={`#${commit.number} ${commit.title}`}
              onClick={() => onSelect(commit.decisionId)}
            >
              <i>{commit.status === 'decided' || commit.status === 'provisional' ? <Icon name="check" /> : null}</i>
              <span>#{commit.number}</span>
            </button>
          ))}
        </div>
      )}

      {/* The time axis stays in view while the rows scroll under it. */}
      <div className="dmap-axis" style={{ width }}>
        <div className="dmap-axis-strip" style={{ top: axisY - 4 }} />
        {layout.ticks.map((tick) => (
          <span key={`tick-${tick.t}`} className="dmap-tick" style={{ left: tick.x, top: axisY }}>
            {tick.day && <strong>{tick.day}</strong>} {tick.time}
          </span>
        ))}
        {layout.gaps.map((gap) => (
          <span key={`quiet-${gap.x}`} className="dmap-quiet" style={{ left: gap.x + gap.w / 2, top: axisY + 20 }}>
            {gap.label}
          </span>
        ))}
        <span className="dmap-now-label" style={{ left: nowX, top: axisY - 1 }}>
          now
        </span>
      </div>
    </div>
  );
}

function Node({ node, selected, onSelect }: { node: MapNode; selected: boolean; onSelect: (id: string) => void }) {
  const classes = [
    'dmap-node',
    `s-${node.status}`,
    node.pending && 'is-pending',
    node.call && 'is-call',
    node.replaced && 'is-replaced',
    selected && 'is-selected',
  ].filter(Boolean);
  return (
    <button
      className={classes.join(' ')}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      onClick={() => onSelect(node.decisionId)}
      aria-pressed={selected}
      title={node.pending ? node.title : `${node.title}${node.sub ? `\n${node.sub}` : ''}`}
    >
      <span className="dmap-node-top">
        <span className="num">#{node.number}</span>
        <span className="dmap-node-title">{node.pending ? node.meta : node.title}</span>
        {node.pinned && (
          <span className="dmap-node-pinned" title="Pinned in the Board Context">
            <Glyph name="layers" />
          </span>
        )}
      </span>
      {(node.pending ? node.title : node.sub) && <span className="dmap-node-sub">{node.pending ? node.title : node.sub}</span>}
    </button>
  );
}

function Legend({ layout }: { layout: DecisionMapLayout }) {
  const has = (kind: string) => layout.edges.some((e) => e.kind === kind);
  const statuses = new Set(layout.nodes.map((n) => n.status));
  return (
    <div className="dmap-legend" aria-label="Legend">
      <span>
        <i className="lg-sq" style={{ '--m': 'var(--decided)' } as CSSProperties} />
        decided
      </span>
      <span>
        <i className="lg-sq" style={{ '--m': 'var(--open)' } as CSSProperties} />
        open
      </span>
      <span>
        <i className="lg-sq" style={{ '--m': 'var(--exploring)' } as CSSProperties} />
        exploring
      </span>
      {statuses.has('provisional') && (
        <span>
          <i className="lg-sq" style={{ '--m': 'var(--provisional)' } as CSSProperties} />
          provisional
        </span>
      )}
      {layout.chips.length > 0 && (
        <span>
          <i className="lg-dot" />
          task
        </span>
      )}
      {has('built') && (
        <span>
          <i className="lg-line" />
          built on it
        </span>
      )}
      {has('asked') && (
        <span>
          <i className="lg-line dash" />
          asked from
        </span>
      )}
      {has('depends') && (
        <span>
          <i className="lg-line strong" />
          depends on
        </span>
      )}
      {has('replaced') && (
        <span>
          <i className="lg-line dot" />
          replaced
        </span>
      )}
    </div>
  );
}

// ---- the panel --------------------------------------------------------------

// How long it has waited, and on whom; or who settled it, when.
function waitingLine(decision: Decision, name: string, now: number): string {
  const asks = pendingAsks(decision);
  const mine = asks.find((a) => samePerson(a.name, name));
  const others = asks.filter((a) => !samePerson(a.name, name)).map((a) => a.name);
  const since = (iso: string | undefined) => duration(now - Date.parse(iso ?? decision.createdAt));
  switch (decision.status) {
    case 'open':
      if (mine) return `Waiting on you for ${since(mine.at)}`;
      if (others.length) return `Waiting for ${listNames(others)} for ${since(asks[0].at)}`;
      return `Open for ${since(decision.createdAt)}`;
    case 'exploring':
      return `Being explored for ${since(decision.exploreRequest?.at)}${mine ? ', and asked of you' : ''}`;
    case 'provisional': {
      const by = decision.resolution?.by;
      return by?.kind === 'agent'
        ? `${by.name}'s call for ${since(decision.resolution?.at)}, waiting for a person to confirm`
        : `Decided for now by ${by?.name ?? 'someone'} ${timeAgo(decision.resolution?.at ?? decision.updatedAt)}`;
    }
    case 'deferred':
      return `Deferred by ${decision.deferral?.by.name ?? 'someone'} ${timeAgo(decision.deferral?.at ?? decision.updatedAt)}`;
    default: {
      const closure = decisionClosure(decision);
      const verb = decision.status === 'retired' ? 'Retired' : 'Decided';
      return closure?.by ? `${verb} by ${closure.by.name} ${timeAgo(closure.at)}` : verb;
    }
  }
}

function Summary({ board, decision, name, onOpen }: { board: Board; decision: Decision; name: string; onOpen: () => void }) {
  const links = decisionLinks(board, decision);
  const now = Date.now();
  const askedOfMe = pendingAsks(decision).some((a) => samePerson(a.name, name));
  const agentCall = decision.status === 'provisional' && decision.resolution?.by.kind === 'agent';
  const unsettled = decision.status === 'open' || decision.status === 'exploring' || decision.status === 'provisional';
  const waiting = waitingLine(decision, name, now);
  const latest = decision.comments.at(-1);
  const marked = decision.marks.length;
  const cells = decision.criteria.length * decision.options.filter((o) => !o.outdated).length;
  const chosen = decision.status === 'decided' || decision.status === 'provisional' ? decision.resolution : undefined;
  const readOnly = useReadOnly();

  const chain: { label: string; content: ReactNode }[] = [];
  for (const task of links.askedFrom) {
    chain.push({ label: 'Asked from', content: <TaskLine task={task} /> });
  }
  for (const dep of links.dependsOn) {
    chain.push({ label: 'Depends on', content: <DecisionLine decision={dep} /> });
  }
  for (const dependent of links.neededBy) {
    chain.push({ label: unsettled ? 'Holds' : 'Needed by', content: <DecisionLine decision={dependent} /> });
  }
  links.builtBy.slice(0, 4).forEach((task, i) => {
    chain.push({ label: i === 0 ? 'Built by' : '', content: <TaskLine task={task} /> });
  });
  if (links.builtBy.length > 4) chain.push({ label: '', content: <span className="t">and {links.builtBy.length - 4} more</span> });
  for (const past of links.replaced) {
    const option = decision.options.find((o) => o.id === past.optionId);
    chain.push({
      label: 'Replaced',
      content: (
        <span className="t">
          {past.label ?? option?.label ?? past.answer} <span className="faint">· by {past.endedBy.name}</span>
        </span>
      ),
    });
  }
  for (const title of links.pinnedIn) {
    chain.push({
      label: 'Pinned in',
      content: (
        <span className="dmap-ctx">
          <Glyph name="layers" /> Board Context: {title}
        </span>
      ),
    });
  }

  return (
    <>
      <div className="card-meta">
        <span className="card-number">#{decision.number}</span>
        <span className={`status status-${decision.status}`}>{STATUS_META[decision.status].label}</span>
        {askedOfMe && unsettled && <span className="tag tag-asked">asked of you</span>}
        {agentCall && <span className="tag tag-agent">agent's call</span>}
        <span className="card-spacer" />
        <ActorBadge actor={decision.createdBy} />
      </div>
      <h2 className="dmap-panel-q">{decision.question}</h2>
      <AreaField board={board} decision={decision} name={name} readOnly={readOnly} />
      <p className={`dmap-waiting${askedOfMe && unsettled ? ' is-mine' : ''}`}>
        <Glyph name="clock" /> {waiting}
      </p>

      {chain.length > 0 && (
        <section className="dmap-sec">
          <h3>On the map</h3>
          <div className="dmap-chain">
            {chain.map((row, i) => (
              <div key={i} className="dmap-chain-row">
                <span className="dmap-chain-label">{row.label}</span>
                {row.content}
              </div>
            ))}
          </div>
        </section>
      )}

      {decision.options.length > 0 && (
        <section className="dmap-sec">
          <h3>Options</h3>
          <ul className="card-options dmap-options">
            {decision.options.map((option) => {
              const recommended = decision.recommendation?.optionId === option.id;
              return (
                <li key={option.id} className={option.outdated ? 'is-outdated' : recommended || chosen?.optionId === option.id ? 'is-recommended' : ''}>
                  <span className="option-letter">{option.id}</span> <span className="card-option-label">{option.label}</span>
                  {recommended && (
                    <span className="star" title="Recommended" role="img" aria-label="Recommended">
                      <Icon name="star" />
                    </span>
                  )}
                  {chosen?.optionId === option.id && <span className="tag tag-chosen">chosen</span>}
                </li>
              );
            })}
          </ul>
          {chosen?.answer && <p className="dmap-why">Answered: “{clip(chosen.answer, 240)}”</p>}
          {chosen?.rationale ? (
            <p className="dmap-why">
              “{clip(chosen.rationale, 240)}” <span className="faint">· {chosen.by.name}</span>
            </p>
          ) : (
            unsettled && decision.recommendation?.reason && <p className="dmap-why">{clip(decision.recommendation.reason, 240)}</p>
          )}
        </section>
      )}

      {decision.criteria.length > 0 && (
        <section className="dmap-sec">
          <h3>Criteria</h3>
          <p>
            {decision.criteria.map((c) => c.label).join(' · ')}.{' '}
            {marked === 0 ? 'None marked yet.' : `${marked} of ${cells} marked.`}
          </p>
        </section>
      )}

      {latest && (
        <section className="dmap-sec">
          <h3>Latest comment</h3>
          <div className="dmap-quote">
            <ActorBadge actor={latest.author} />
            <p>
              “<RefText text={clip(latest.body, 280)} />”
            </p>
          </div>
        </section>
      )}

      <div className="dmap-actions">
        {unsettled && !readOnly && (
          <button className="btn btn-primary btn-small" onClick={onOpen}>
            {decision.status === 'provisional' ? 'Confirm or change' : 'Decide'}
          </button>
        )}
        <button className="btn btn-small" onClick={onOpen}>
          Open the card
        </button>
      </div>
    </>
  );
}

function TaskLine({ task }: { task: Board['tasks'][number] }) {
  return (
    <>
      <RefChip kind="task" number={task.number} />
      <span className="t" title={task.title}>
        {task.title}
      </span>
    </>
  );
}

function DecisionLine({ decision }: { decision: Decision }) {
  return (
    <>
      <RefChip kind="decision" number={decision.number} />
      <span className="t" title={decision.question}>
        {decision.question}
      </span>
    </>
  );
}

// The decision's area, which a person can set or change here. Theirs once set:
// agents leave it.
function AreaField({ board, decision, name, readOnly }: { board: Board; decision: Decision; name: string; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(decision.area ?? '');
  const [error, setError] = useState<string | null>(null);
  const listId = `dmap-areas-${decision.id}`;
  const areas = boardAreas(board);

  if (!editing) {
    return (
      <div className="dmap-area">
        <span className="dmap-chain-label">Area</span>
        {readOnly ? (
          <span>{decision.area ?? 'None'}</span>
        ) : (
          <button
            className="dmap-area-button"
            onClick={() => {
              setValue(decision.area ?? '');
              setError(null);
              setEditing(true);
            }}
            title={decision.areaPerson ? `Set by ${decision.areaPerson.name}` : 'Set the area this decision belongs to'}
          >
            {decision.area ?? <span className="faint">Add an area</span>}
            <Icon name="edit" />
          </button>
        )}
      </div>
    );
  }

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (value.trim() === (decision.area ?? '')) return setEditing(false);
    try {
      await api.setArea(decision.id, name, value);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form className="dmap-area" onSubmit={save}>
      <span className="dmap-chain-label">Area</span>
      <input
        autoFocus
        list={listId}
        value={value}
        maxLength={60}
        placeholder="e.g. Connectors"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
      />
      <datalist id={listId}>
        {areas.map((a) => (
          <option key={a.name} value={a.name} />
        ))}
      </datalist>
      <button className="btn btn-small" type="submit">
        Save
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
