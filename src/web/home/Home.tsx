import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { waitingSentence } from '../../core/approvals';
import type { BusyState } from '../../core/delivery';
import { firstRunShows } from '../../core/firstRun';
import { samePerson } from '../../core/format';
import { SQUARE_WORDS, type AgentAround, type AgentHere, type BoardWork, type NeedsReport, type Project, type Square } from '../../core/needs';
import type { BoardSummary } from '../../core/types';
import { api } from '../shared/api';
import { useApprovals } from '../access';
import { archiveBoard, useBoards } from '../live';
import { agentDoing, busyOfPhase, ConnectAgent, latestSteps, phaseOf, rowStep, StepsByBoardProvider, StepText, stepWords, useBoardSteps, usePhaseClock, useStepsEverywhere, whoIsOn, type BoardStep, type StepPhase } from '../agents';
import { Icon, Popover, seenAgo, timeAgo } from '../shared/components';
import { TopBar } from '../shell';
import { ConnectorsLine } from '../connectors';
import { DeleteBoardDialog, Search } from '../board';
import { FirstRun } from './firstRun';
import { useRowFocus, useStoredFlag, useTick } from '../shared/hooks';
import { dropFlag, flagged, flags, go, linkTo } from '../shared/pages';
import { NeedsBell, NeedsList, useNeeds } from '../inbox';
import { BoardEditor, handOffFocus, ProjectMenu, useArchiveUndo, type EditField } from './projectActions';
import { Stitch } from '../shared/stitch';
import { UpdateNotice } from '../update';

// Home is where you come back to: what needs you across every project, most
// urgent first, then the projects themselves, one row each, with their work
// at a glance as status squares, and who is on them. Until there is a
// project, it asks what you're working on instead (firstRun.tsx).
export function Home({ name }: { name: string }) {
  const { boards, refresh } = useBoards();
  const [sending, setSending] = useState(false); // the first run's send, until its board opens
  const { report, error } = useNeeds(name);
  const [showArchived, setShowArchived] = useStoredFlag('tricot:show-archived', () => false);
  const { archive, held, toast } = useArchiveUndo(name, report?.projects);
  const [focusRow, setFocusRow] = useState<string | null>(null); // the row to take the focus back after an edit, by board id
  useTick(30_000);
  const archived = boards?.filter((b) => b.archived) ?? [];
  const projects = report?.projects.filter((p) => !held.has(p.id)) ?? [];
  const rowFocus = (id: string) => ({ focus: focusRow === id, onFocus: setFocusRow, onFocused: () => setFocusRow(null) });
  // What agents are doing on each project now, for its row (steps.tsx).
  const steps = useStepsEverywhere();
  const firstRun = boards !== null && firstRunShows(boards, sending);

  return (
    <div className="page">
      <TopBar
        home
        right={
          <>
            <Search />
            <NeedsBell report={report} name={name} />
            <span className="topbar-sep" aria-hidden />
          </>
        }
      />

      <main className={firstRun ? 'home is-first-run' : 'home'}>
        {/* A newer Tricot, quietly, until it's updated or skipped (update.tsx). */}
        <UpdateNotice />
        {boards === null || report === null ? (
          error ? (
            <p className="error" role="alert">
              Couldn't load your projects: {error}
            </p>
          ) : (
            <p className="home-loading" role="status">
              Loading your projects…
            </p>
          )
        ) : firstRun ? (
          <FirstRun name={name} agents={report.agents} onSending={setSending} onEveryWay={openConnectPanel} />
        ) : (
          <>
            <Headline report={report} />
            {report.rows.length > 0 && <NeedsList rows={report.rows} name={name} />}
            <section className="projects" aria-labelledby="projects-title">
              <div className="projects-head">
                <h2 id="projects-title">Projects</h2>
                <span className="projects-count">{projects.length} active</span>
                <NewProject name={name} />
              </div>
              {projects.length === 0 ? (
                <p className="sheet projects-none">No projects in use. Create one, or unarchive one to pick it up again.</p>
              ) : (
                <StepsByBoardProvider value={steps}>
                  <ul className="sheet projects-list">
                    {projects.map((project) => (
                      <ProjectRow key={project.id} project={project} name={name} onArchive={archive} {...rowFocus(project.id)} />
                    ))}
                  </ul>
                </StepsByBoardProvider>
              )}
            </section>
          </>
        )}

        <footer className="home-foot">
          <div className="home-foot-group">
            <span className="home-foot-label">Agents</span>
            {report?.agents.map((agent) => (
              <span key={agent.name} className={`home-agent is-${agent.state}`} title={agentTitle(agent, aroundDoing(agent))}>
                <AgentMark name={agent.name} />
                {agent.name} {aroundDoing(agent)}
              </span>
            ))}
            {report && report.agents.length === 0 && <span className="home-foot-none">No agent connected</span>}
            <Popover className="home-connect">
              <summary className="home-link">{report?.agents.length ? 'Connect another' : 'Connect an agent'}</summary>
              <div className="popover-body">
                <ConnectAgent />
              </div>
            </Popover>
          </div>
          <div className="home-foot-group">
            <span className="home-foot-label">Connectors</span>
            <ConnectorsLine />
          </div>
          {archived.length > 0 && (
            <button className="home-link home-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
              Archived ({archived.length})
            </button>
          )}
          <About />
        </footer>

        {showArchived && archived.length > 0 && (
          <ul className="sheet projects-list projects-archived" aria-label="Archived projects">
            {archived.map((board) => (
              <ArchivedRow key={board.id} board={board} name={name} onDeleted={refresh} {...rowFocus(board.id)} />
            ))}
          </ul>
        )}
        {toast}
      </main>
    </div>
  );
}

// "5 things need you", and where: the projects, and what agents are doing
// now. An agent waiting for your OK (approvals.tsx) is one of them, and said first.
function Headline({ report }: { report: NeedsReport }) {
  const approvals = useApprovals();
  const total = report.total + approvals.length;
  const needing = report.projects.filter((p) => p.needs > 0);
  const busy = report.agents.filter((a) => a.state !== 'away').slice(0, 2);
  const waiting = waitingSentence(approvals);
  const where = needing.length === 0 ? null : needing.length === 1 ? `In ${needing[0].title}.` : `Across ${needing.length} projects.`;
  const lead = [waiting, where].filter(Boolean).join(' ') || null;
  return (
    <section className="home-head">
      <h1>{total === 0 ? 'Nothing needs you right now' : `${total} ${total === 1 ? 'thing needs' : 'things need'} you`}</h1>
      {(lead || busy.length > 0) && (
        <p className="home-sub">
          {lead}
          {busy.map((agent, i) => (
            <Fragment key={agent.name}>
              {i === 0 ? (lead ? ' ' : '') : ', and '}
              <strong>{agent.name}</strong> {agentWhere(agent)}
              {i === busy.length - 1 && '.'}
            </Fragment>
          ))}
        </p>
      )}
    </section>
  );
}

// The end of the footer: the Tricot that runs, and a link to its source (the
// repository in its package.json), so anyone using it, over a network too,
// can find the code. Quiet, and nothing until it's known.
function About() {
  const [info, setInfo] = useState<{ version?: string; source?: string }>();
  useEffect(() => {
    let live = true;
    api.info().then(
      (next) => live && setInfo(next),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (!info?.version && !info?.source) return null;
  return (
    <div className="home-foot-group home-foot-about">
      {info.version && <span>Tricot {info.version}</span>}
      {info.source && (
        <a className="home-link" href={info.source} target="_blank" rel="noreferrer">
          Source
        </a>
      )}
    </div>
  );
}

// The footer's Connect an agent panel, opened from elsewhere on Home (the
// first run's "Every way to connect").
function openConnectPanel(): void {
  const details = document.querySelector<HTMLDetailsElement>('details.home-connect');
  if (!details) return;
  details.open = true;
  details.querySelector<HTMLElement>('summary')?.focus();
}

// Title only: the board opens once it's made, to set its goal and ask agents in.
function NewProject({ name }: { name: string }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The board switcher's "New board" comes here with ?new: the field takes the
  // focus, and the address drops ?new so a reload doesn't.
  const [asked] = useState(() => flagged(flags.newBoard));
  useEffect(() => {
    if (asked) dropFlag(flags.newBoard);
  }, [asked]);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const board = await api.createBoard(name, title.trim(), '');
      go.board(board.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="new-project" onSubmit={create}>
      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setError(null);
        }}
        placeholder="New project title"
        aria-label="New project title"
        maxLength={200}
        autoFocus={asked}
      />
      <button className="btn btn-primary" disabled={!title.trim() || busy}>
        <Icon name="plus" />
        Create
      </button>
      {error && (
        <p className="error new-project-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// How a row takes the focus back after an edit: Home names the row by its
// board's id, which a new title changes, so the row with the new id takes it.
interface RowFocus {
  focus: boolean;
  onFocus: (id: string) => void;
  onFocused: () => void;
}

// One project: its name and goal, a square per item in play and what's
// settled, who is on it, and when it last changed. The whole row opens the
// board; its ⋯ renames it, changes its goal or archives it.
function ProjectRow({ project, name, onArchive, focus, onFocus, onFocused }: { project: Project; name: string; onArchive: (board: Project) => void } & RowFocus) {
  const { work } = project;
  const empty = work.decisions === 0 && work.tasks === 0;
  const settledLine = settled(work);
  const [editing, setEditing] = useState<EditField | null>(null);
  const [saved, setSaved] = useState<{ title: string; goal?: string } | null>(null); // shown until the list catches up
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => setSaved(null), [project.title, project.goal]);
  useRowFocus(row, focus, '.project-menu-button', onFocused);
  const { title, goal } = saved ?? project;

  return (
    <li className={`project${editing ? ' is-editing' : ''}`} ref={row}>
      <div className="project-name">
        {editing ? (
          <BoardEditor
            board={{ id: project.id, title, goal }}
            name={name}
            focus={editing}
            onDone={(board) => {
              if (board) setSaved({ title: board.title, goal: board.goal });
              setEditing(null);
              onFocus(board?.id ?? project.id);
            }}
          />
        ) : (
          <>
            <h3 className="project-title">
              <a className="project-link" href={linkTo.board(project.id)}>
                {title}
              </a>
              {project.needs > 0 && (
                <span className="project-needs">
                  {project.needs} {project.needs === 1 ? 'needs' : 'need'} you
                </span>
              )}
            </h3>
            {goal && (
              <p className="project-goal" title={goal}>
                {goal}
              </p>
            )}
          </>
        )}
      </div>
      <div className="project-work">
        {empty ? (
          <p className="project-empty">
            Nothing on it yet. <a href={linkTo.askAgents(project.id)}>Ask an agent for the first questions</a>
          </p>
        ) : (
          <>
            {work.squares.length > 0 && (
              // Above the row's link, so each square shows what it is; a click still opens the board.
              <span className="mosaic" role="img" aria-label={inPlay(work)} onClick={() => go.board(project.id)}>
                {work.squares.map((s, i) => (
                  <span key={i} className={`sq sq-${s.square}`} title={s.label} />
                ))}
              </span>
            )}
            {settledLine && <span className="project-settled">{settledLine}</span>}
          </>
        )}
      </div>
      <ProjectAgent project={project} />
      <time className="project-when" dateTime={project.updatedAt} title={`Last change ${new Date(project.updatedAt).toLocaleString()}`}>
        {timeAgo(project.updatedAt)}
      </time>
      {editing ? (
        <span aria-hidden />
      ) : (
        <ProjectMenu
          title={title}
          hasGoal={Boolean(goal)}
          onEdit={setEditing}
          onArchive={() => {
            handOffFocus(row.current);
            onArchive({ ...project, title });
          }}
        />
      )}
    </li>
  );
}

// An archived project: back on the list (Restore), renamed in place, or
// deleted for good once its name is typed (decision #69). Only an archived
// board can be deleted.
function ArchivedRow({ board, name, onDeleted, focus, onFocus, onFocused }: { board: BoardSummary; name: string; onDeleted: () => void } & RowFocus) {
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<{ title: string; goal?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => setSaved(null), [board.title, board.goal]);
  useRowFocus(row, focus, '.project-rename', onFocused);
  const { title, goal } = saved ?? board;

  const restore = () => {
    setBusy(true);
    setError(null);
    archiveBoard(board.id, name, false).then(
      () => handOffFocus(row.current),
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  };

  return (
    <li className={`project is-archived${editing ? ' is-editing' : ''}`} ref={row}>
      <div className="project-name">
        {editing ? (
          <BoardEditor
            board={{ id: board.id, title, goal }}
            name={name}
            focus="title"
            onDone={(next) => {
              if (next) setSaved({ title: next.title, goal: next.goal });
              setEditing(false);
              onFocus(next?.id ?? board.id);
            }}
          />
        ) : (
          <>
            <h3 className="project-title">
              <a className="project-link" href={linkTo.board(board.id)}>
                {title}
              </a>
            </h3>
            {goal && <p className="project-goal">{goal}</p>}
          </>
        )}
        {error && (
          <p className="error project-row-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="project-archived-side">
        <time className="project-when" dateTime={board.updatedAt}>
          archived {timeAgo(board.updatedAt)}
        </time>
        {!editing && (
          <>
            <button className="btn btn-small" disabled={busy} onClick={restore} aria-label={`Restore ${title}`}>
              Restore
            </button>
            <button className="btn btn-small project-rename" disabled={busy} onClick={() => setEditing(true)} aria-label={`Rename ${title}`}>
              Rename…
            </button>
            <button className="btn btn-small btn-delete" disabled={busy} onClick={() => setDeleting(true)} aria-label={`Delete ${title}`}>
              Delete…
            </button>
          </>
        )}
      </div>
      {deleting && (
        <DeleteBoardDialog
          board={{ ...board, title }}
          name={name}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            onDeleted();
          }}
        />
      )}
    </li>
  );
}

// The agent on it now, with the "working on it" stitch (stitch.tsx): cast
// on as it picks something up and knitting while it works, resting while it
// listens. While its harness's latest step shows, the row says that
// instead: the agent's mark, then its step, "Running npm test on T114", a
// long path giving way in its middle to fit the column, knitting while the
// step is live, and "+1" for each other agent on it. The column is narrow,
// so the agent is named by its mark there, and in full in the tooltip, with
// each agent and its latest step whole. Either way it is one row (AgentRow),
// so the stitch knits on as the first step comes.
function ProjectAgent({ project }: { project: Project }) {
  const who = whoIsOn(project);
  const step = useRowStep(project);
  const steps = latestSteps(useBoardSteps(project.id), Date.now());
  const others = who && 'now' in who ? who.others : 0;
  if (step) {
    const said = (s: BoardStep) => `${stepWords(s)}${s.on && !s.narration ? ` on ${s.on}` : ''}`;
    const lines = project.agents.map((agent) => {
      const own = steps.get(agent.name.toLowerCase());
      return own ? `${agent.name}: ${said(own)}` : agentTitle(agent);
    });
    if (!project.agents.some((a) => samePerson(a.name, step.step.agent))) lines.unshift(`${step.step.agent}: ${said(step.step)}`);
    return (
      <AgentRow
        className={`project-agent is-working has-step${step.phase === 'dim' ? ' is-dim' : ''}`}
        title={lines.join('\n')}
        name={step.step.agent}
        busy={busyOfPhase(step.phase)}
        after={others > 0 && <span className="project-agent-more">+{others}</span>}
      >
        <span className="step-sr">{step.step.agent}: </span>
        {/* A new step fades in; a steady stream of them isn't read out. */}
        <StepText key={step.step.at} text={said(step.step)} className="project-agent-step" />
      </AgentRow>
    );
  }
  if (who && 'now' in who) {
    return (
      <AgentRow className={`project-agent is-${who.now.state}`} title={project.agents.map((agent) => agentTitle(agent)).join('\n')} name={who.now.name} busy={who.now.state === 'working' ? 'casting' : 'resting'}>
        {who.now.name} {agentDoing(who.now)}
        {others > 0 && <span className="project-agent-more"> +{others}</span>}
      </AgentRow>
    );
  }
  if (!who) return <span className="project-agent is-none">No agent connected</span>;
  const { last } = who;
  return (
    <span className="project-agent" title={`${last.name} last worked on it ${new Date(last.at).toLocaleString()}`}>
      <AgentMark name={last.name} />
      <span className="project-agent-text">
        {last.name}, {seenAgo(last.at)}
      </span>
    </span>
  );
}

// What an agent on a project is doing now, from its harness's steps
// (steps.tsx), for the row's one line: the busiest agent's latest step while
// it shows, dimming as a card's does, and redrawn when it changes phase.
function useRowStep(project: Project): { step: BoardStep; phase: StepPhase } | undefined {
  const steps = useBoardSteps(project.id);
  const step = rowStep(project.agents.map((a) => a.name), steps, Date.now());
  const now = usePhaseClock(step);
  const phase = step && phaseOf(step, now);
  return step && phase ? { step, phase } : undefined;
}

// An agent on a project now: its mark, its words, its stitch, and what
// follows them.
function AgentRow({ className, title, name, busy, after, children }: { className: string; title: string; name: string; busy: BusyState; after?: ReactNode; children: ReactNode }) {
  return (
    <span className={className} title={title}>
      <AgentMark name={name} />
      <span className="project-agent-text">{children}</span>
      <Stitch state={busy} />
      {after}
    </span>
  );
}

// An agent's square mark with its initial, as agents are drawn everywhere.
function AgentMark({ name }: { name: string }) {
  return (
    <span className="actor actor-agent" aria-hidden>
      <span className="actor-mark">{name.charAt(0).toUpperCase()}</span>
    </span>
  );
}

// The same for an agent anywhere: one on no project yet, busy only
// connecting, is connected.
function aroundDoing(agent: AgentAround): string {
  return !agent.board && agent.state === 'working' ? 'connected' : agentDoing(agent);
}

function agentWhere(agent: AgentAround): string {
  if (!agent.board) return agent.state === 'listening' ? 'is listening' : 'is connected';
  if (agent.state === 'working') return agent.on ? `is working on ${agent.on} in ${agent.board}` : `is working in ${agent.board}`;
  return `is listening on ${agent.board}`;
}

// `doing` for an agent anywhere (the footer's) is aroundDoing's.
function agentTitle(agent: AgentHere, doing = agentDoing(agent)): string {
  const on = agent.on && agent.onTitle ? ` (${agent.on} ${agent.onTitle})` : '';
  return `${agent.name} ${doing}${on}, last checked ${timeAgo(agent.lastSeen)}`;
}

// "49 decided · 66 tasks done", in the board's order; the squares show the rest.
function settled(work: BoardWork): string {
  const parts: string[] = [];
  if (work.decided > 0) parts.push(`${work.decided} decided`);
  if (work.done > 0) parts.push(`${work.done} ${work.done === 1 ? 'task' : 'tasks'} done`);
  if (work.tasks === 0) parts.push('no tasks yet');
  return parts.join(' · ');
}

// What the squares say, for a screen reader: "1 blocking, 2 open, 1 in review".
function inPlay(work: BoardWork): string {
  const counts = new Map<Square, number>();
  for (const s of work.squares) counts.set(s.square, (counts.get(s.square) ?? 0) + 1);
  const word = (square: Square) => (square === 'blocking' ? 'blocking' : SQUARE_WORDS[square]);
  return `In play: ${[...counts].map(([square, n]) => `${n} ${word(square)}`).join(', ')}`;
}
