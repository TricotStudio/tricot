import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { samePerson } from '../../core/format';
import type { AgentSkills, AgentTask, SkillEntry } from '../../core/skills';
import { TASK_STATUS_WORDS } from '../../core/pins';
import type { BoardEvent } from '../../core/types';
import { api } from '../shared/api';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { linkTo } from '../shared/pages';
import { AgentLiveSteps, useLiveSteps } from './liveSteps';
import { AgentUsageSection } from './usage';
import './agents.css';

// The agents Tricot knows, in the user menu, and an agent's own panel: its
// live steps switch (liveSteps.tsx), its usage (usage.tsx), its skills (those
// it reported and the Tricot skills that work with every agent, which people
// add and edit here), what it is working on, and its activity.

// The agents and what each can be asked to run, as the server has them.
function useAgents(): { agents: AgentSkills[] | null; reload: () => void } {
  const [agents, setAgents] = useState<AgentSkills[] | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    api.agents().then(
      (list) => live && setAgents(list),
      () => live && setAgents((current) => current ?? []),
    );
    return () => {
      live = false;
    };
  }, [count]);
  return { agents, reload: useCallback(() => setCount((n) => n + 1), []) };
}

// Where an agent is, in a few words, and with `board` the board it is most on.
function agentStatus(agent: AgentSkills, withBoard = false): string {
  if (agent.state === 'absent') return 'not connected';
  const on = withBoard && agent.board ? ` on ${agent.board.title}` : '';
  if (agent.state === 'idle') return `idle, last seen ${timeAgo(agent.lastSeen!)}${on}`;
  return `${agent.state}${on}`;
}

const skillCount = (agent: AgentSkills) => `${agent.skills.length} skill${agent.skills.length === 1 ? '' : 's'}`;

// ---- the user menu's list -------------------------------------------------------

// Each agent, how it is, and how many skills it can be asked to run; a click opens its panel.
export function AgentsMenu({ onOpen }: { onOpen: (agent: string) => void }) {
  const { agents } = useAgents();
  if (agents === null) return null;
  return (
    <div className="user-agents">
      <div className="user-agents-head">Agents</div>
      {agents.length === 0 ? (
        <p className="user-agents-empty">No agent has connected yet. Once one has, its skills are here, and type / in a comment or a thread to call them.</p>
      ) : (
        agents.map((agent) => (
          <button key={agent.name} type="button" className="user-agent" onClick={() => onOpen(agent.name)} aria-haspopup="dialog">
            <ActorBadge actor={{ kind: 'agent', name: agent.name }} showName={false} />
            <span className="user-agent-text">
              <span className="user-agent-name">{agent.name}</span>
              <span className="user-agent-state">
                <span className={`user-agent-dot is-${agent.state}`} aria-hidden />
                {agentStatus(agent)}
              </span>
            </span>
            <span className="user-agent-count">{skillCount(agent)} ›</span>
          </button>
        ))
      )}
    </div>
  );
}

// ---- an agent's panel -----------------------------------------------------------

type Tab = 'skills' | 'work' | 'activity';

export function AgentPanel({ name, person, onClose }: { name: string; person: string; onClose: () => void }) {
  const { agents, reload } = useAgents();
  const agent = agents?.find((a) => samePerson(a.name, name));
  const [tab, setTab] = useState<Tab>('skills');
  const panel = useRef<HTMLElement>(null);
  const liveSteps = useLiveSteps();

  useEffect(() => {
    panel.current?.focus();
    // A sheet open over the panel (live steps) takes its own Escape.
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const reported = agent?.reportedAt ? `skills reported ${timeAgo(agent.reportedAt)}` : "hasn't reported its skills";
  return createPortal(
    <div className="agent-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="agent-panel" ref={panel} role="dialog" aria-modal="true" aria-label={`${name}, an agent`} tabIndex={-1}>
        <header className="agent-head">
          <ActorBadge actor={{ kind: 'agent', name }} showName={false} />
          <div className="agent-head-text">
            <h2>{agent?.name ?? name}</h2>
            <p>
              {agent && <span className={`user-agent-dot is-${agent.state}`} aria-hidden />}
              {agent ? agentStatus(agent, true) : 'Loading…'} · {reported}
            </p>
          </div>
          <button type="button" className="btn btn-quiet btn-small agent-close" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <AgentLiveSteps name={agent?.name ?? name} person={person} steps={liveSteps} />
        {agents !== null && <AgentUsageSection name={agent?.name ?? name} board={agent?.board} liveSteps={liveSteps.report} />}
        <div className="agent-tabs" role="tablist" aria-label={`${name}`}>
          {(['skills', 'work', 'activity'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
              {t === 'skills' ? `Skills${agent ? ` ${agent.skills.length}` : ''}` : t === 'work' ? 'Working on' : 'Activity'}
            </button>
          ))}
        </div>
        <div className="agent-body">
          {!agent ? (
            <p className="agent-empty">{agents === null ? 'Loading…' : `${name} isn't known to Tricot.`}</p>
          ) : tab === 'skills' ? (
            <SkillsTab agent={agent} person={person} onChange={reload} />
          ) : tab === 'work' ? (
            <WorkTab agent={agent} onOpen={onClose} />
          ) : (
            <ActivityTab agent={agent} onOpen={onClose} />
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

// ---- skills ---------------------------------------------------------------------

// Whose a skill is, as a tag: the agent's own, or one Tricot keeps.
function skillTag(skill: SkillEntry, agent: string): string {
  if (!skill.tricot) return 'its own';
  return skill.tricot.agent ? `Tricot skill · just for ${agent}` : 'Tricot skill · works with every agent';
}

function SkillsTab({ agent, person, onChange }: { agent: AgentSkills; person: string; onChange: () => void }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const q = query.trim().toLowerCase();
  const shown = agent.skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  const done = () => {
    setEditing(null);
    onChange();
  };
  return (
    <>
      <input
        className="agent-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search skills…"
        aria-label={`Search ${agent.name}'s skills`}
        spellCheck={false}
      />
      {agent.skills.length === 0 ? (
        <p className="agent-empty">{agent.name} has not reported any skills. A Tricot skill you add below works with it all the same.</p>
      ) : shown.length === 0 ? (
        <p className="agent-empty">No skill matches “{query.trim()}”.</p>
      ) : (
        <ul className="agent-skills">
          {shown.map((skill) =>
            skill.tricot && editing === skill.tricot.id ? (
              <li key={`tricot:${skill.tricot.id}`} className="agent-skill is-editing">
                <SkillForm agent={agent.name} person={person} skill={skill} onDone={done} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={`${skill.tricot ? 'tricot' : 'own'}:${skill.name}`} className="agent-skill">
                <div className="agent-skill-line">
                  <code>
                    /{skill.name}
                    {skill.call && ' (Tricot)'}
                  </code>
                  <span className={`agent-skill-tag${skill.tricot ? ' is-tricot' : ''}`}>{skillTag(skill, agent.name)}</span>
                  {skill.tricot && (
                    <button type="button" className="btn btn-quiet btn-small agent-skill-edit" onClick={() => setEditing(skill.tricot!.id)} aria-label={`Edit /${skill.name}`}>
                      Edit
                    </button>
                  )}
                </div>
                <p className="agent-skill-desc" title={skill.description}>
                  {skill.description}
                </p>
                {skill.call && <p className="agent-skill-note">{agent.name} has its own /{skill.name}, which is what that calls. Call this one as /{skill.call}.</p>}
              </li>
            ),
          )}
        </ul>
      )}
      {editing === 'new' ? (
        <div className="agent-add is-open">
          <SkillForm agent={agent.name} person={person} onDone={done} onCancel={() => setEditing(null)} />
        </div>
      ) : (
        <button type="button" className="agent-add" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Add a skill
        </button>
      )}
    </>
  );
}

// A Tricot skill to add, or one to change or delete: kept in Tricot, sent with
// the request, never written into an agent's settings.
function SkillForm({ agent, person, skill, onDone, onCancel }: { agent: string; person: string; skill?: SkillEntry; onDone: () => void; onCancel: () => void }) {
  const kept = skill?.tricot;
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [instructions, setInstructions] = useState(kept?.instructions ?? '');
  const [justThis, setJustThis] = useState(Boolean(kept?.agent));
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim() !== '' && description.trim() !== '' && instructions.trim() !== '';

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    const body = { name: name.trim(), description: description.trim(), instructions, agent: justThis ? agent : '' };
    void run(() => (kept ? api.editSkill(kept.id, person, body) : api.addSkill(person, body)));
  };

  return (
    <form className="agent-form" onSubmit={save}>
      <div className="agent-form-head">{kept ? `Edit /${skill!.name}` : 'Add a skill'}</div>
      <label className="agent-field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="One word, e.g. weekly-summary" autoFocus spellCheck={false} />
      </label>
      <label className="agent-field">
        <span>What it does, in one line</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Write release notes from the last commits" />
      </label>
      <label className="agent-field">
        <span>Instructions the agent follows when you call it</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="Read the commits since the last tag, group them by area, and write the notes in plain language…" />
      </label>
      <div className="agent-field">
        <span>Who it is for</span>
        <div className="connect-tabs" role="group" aria-label="Who it is for">
          <button type="button" className={justThis ? '' : 'is-active'} aria-pressed={!justThis} onClick={() => setJustThis(false)}>
            Every agent
          </button>
          <button type="button" className={justThis ? 'is-active' : ''} aria-pressed={justThis} onClick={() => setJustThis(true)}>
            Just {agent}
          </button>
        </div>
      </div>
      <p className="agent-form-note">Saved in Tricot and sent with the request, so it works with any agent. Nothing is written into {agent}'s own settings.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {asking ? (
        <div className="agent-form-actions">
          <span className="small">Delete /{skill?.name} for {kept?.agent ? kept.agent : 'every agent'}?</span>
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAsking(false)}>
            Keep it
          </button>
          <button type="button" className="btn btn-small agent-delete" disabled={busy} onClick={() => void run(() => api.deleteSkill(kept!.id, person))}>
            Delete
          </button>
        </div>
      ) : (
        <div className="agent-form-actions">
          {kept && (
            <button type="button" className="btn btn-quiet btn-small agent-delete" onClick={() => setAsking(true)}>
              <Icon name="trash" /> Delete
            </button>
          )}
          <span className="row-spacer" />
          <button type="button" className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={`btn btn-small${ready ? ' btn-primary' : ''}`} disabled={!ready || busy}>
            {kept ? 'Save' : justThis ? `Add for ${agent}` : 'Add for every agent'}
          </button>
        </div>
      )}
    </form>
  );
}

// ---- working on -----------------------------------------------------------------

// Loads once for the agent: what it has claimed and not finished, on every board.
function useAsync<T>(load: () => Promise<T>, key: string): { value: T | null; error: string | null } {
  const [state, setState] = useState<{ key: string; value: T | null; error: string | null }>({ key, value: null, error: null });
  useEffect(() => {
    let live = true;
    load().then(
      (value) => live && setState({ key, value, error: null }),
      (e: Error) => live && setState({ key, value: null, error: e.message }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { value: null, error: null };
}

function WorkTab({ agent, onOpen }: { agent: AgentSkills; onOpen: () => void }) {
  const { value: tasks, error } = useAsync<AgentTask[]>(() => api.agentWork(agent.name), agent.name);
  if (error) return <p className="error agent-empty">{error}</p>;
  if (!tasks) return <p className="agent-empty">Loading…</p>;
  if (tasks.length === 0) return <p className="agent-empty">{agent.name} has no task claimed right now.</p>;
  return (
    <ul className="agent-rows">
      {tasks.map((task) => (
        <li key={task.id}>
          <a href={linkTo.task(task.boardId, task.id)} onClick={onOpen} className="agent-row">
            <span className="agent-row-title">
              <span className="agent-row-ref">T{task.number}</span> {task.title}
            </span>
            <span className="agent-row-meta">
              {TASK_STATUS_WORDS[task.status]} · {task.boardTitle}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// ---- activity -------------------------------------------------------------------

const ACTIVITY_PAGE = 30;

function ActivityTab({ agent, onOpen }: { agent: AgentSkills; onOpen: () => void }) {
  const board = agent.board;
  const { value: page, error } = useAsync(
    () => (board ? api.events(board.id, { actor: agent.name, limit: ACTIVITY_PAGE }) : Promise.resolve(null)),
    `${agent.name}:${board?.id ?? ''}`,
  );
  if (!board) return <p className="agent-empty">{agent.name} hasn't been on a board since Tricot started, so there is no activity to show yet.</p>;
  if (error) return <p className="error agent-empty">{error}</p>;
  if (!page) return <p className="agent-empty">Loading…</p>;
  if (page.events.length === 0) return <p className="agent-empty">{agent.name} hasn't done anything on {board.title} yet.</p>;
  const link = (event: BoardEvent) =>
    event.taskId ? linkTo.task(board.id, event.taskId) : event.decisionId ? linkTo.decision(board.id, event.decisionId) : linkTo.board(board.id);
  return (
    <>
      <p className="agent-activity-head">
        On {board.title}, newest first{page.total > page.events.length ? ` (${page.events.length} of ${page.total})` : ''}
      </p>
      <ul className="agent-rows">
        {page.events.map((event) => (
          <li key={event.seq}>
            <a href={link(event)} onClick={onOpen} className="agent-row">
              <span className="agent-row-title">{event.summary}</span>
              <span className="agent-row-meta">{timeAgo(event.at)}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
