import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  liveStepsAgentFor,
  liveStepsCommand,
  liveStepsLabel,
  type LiveStepsAgent,
  type LiveStepsFile,
  type LiveStepsPreview,
  type LiveStepsReport,
  type LiveStepsResult,
} from '../core/liveSteps';
import { api, type LiveStepsChange, type RequestError } from './api';
import './liveSteps.css';

// Live steps in Tricot: the "Live steps" switch in an agent's panel, which
// shows the exact files and lines before anything is written and writes them
// only once the person confirms, and the Connect panel's one-line hint for an
// agent without them. The server does the work (server/liveStepsRoutes.ts);
// `tricot hooks` does the same from a terminal.

// Each agent's live steps on this machine: null while loading, undefined when
// this server has none to offer.
function useLiveSteps(): { report: LiveStepsReport | null | undefined; reload: () => void } {
  const [report, setReport] = useState<LiveStepsReport | null | undefined>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    api.liveSteps().then(
      (next) => live && setReport(next),
      () => live && setReport(undefined),
    );
    return () => {
      live = false;
    };
  }, [round]);
  return { report, reload: useCallback(() => setRound((n) => n + 1), []) };
}

// Words with `code` in backticks, as the server writes a command.
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

// ---- an agent's panel ---------------------------------------------------------------

export function AgentLiveSteps({ name, person }: { name: string; person: string }) {
  const { report, reload } = useLiveSteps();
  const [asking, setAsking] = useState<LiveStepsChange | null>(null);
  const [done, setDone] = useState<LiveStepsResult | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const stateId = useId();
  if (!report) return null;
  const agent = liveStepsAgentFor(name, report.agents);

  if (!agent) {
    return (
      <section className="live-steps" aria-labelledby={titleId}>
        <div className="live-steps-text">
          <span className="live-steps-title" id={titleId}>
            Live steps
          </span>
          <span className="live-steps-state">Tricot can't tell which tool {name} runs in, so there is no switch here.</span>
        </div>
        <p className="live-steps-line">
          From a terminal: <code>tricot hooks on --agent claude --name "{name}"</code> (or codex, pi, omp, gemini, opencode).
        </p>
      </section>
    );
  }

  const on = agent.state === 'on';
  const absent = !agent.found && agent.state === 'off';
  const disabled = !report.canChange || absent || Boolean(agent.problem);
  const ask = (action: 'on' | 'off') => {
    setDone(null);
    setAsking({ action, name: action === 'on' ? name : undefined });
  };
  // The project's own hook from earlier, taken out on its own: as
  // `tricot connect claude --remove-hooks` would, in that project.
  const tidy = () => {
    setDone(null);
    setAsking({ action: 'off', scope: 'project' });
  };
  const close = () => {
    setAsking(null);
    toggle.current?.focus();
  };
  const finished = (result: LiveStepsResult) => {
    setAsking(null);
    setDone(result);
    reload();
    toggle.current?.focus();
  };

  return (
    <section className="live-steps" aria-labelledby={titleId}>
      <div className="live-steps-row">
        <div className="live-steps-text">
          <span className="live-steps-title" id={titleId}>
            Live steps
          </span>
          <span className={`live-steps-state${on ? ' is-on' : ''}`} id={stateId}>
            {liveStepsLabel(agent)}
          </span>
        </div>
        <button
          ref={toggle}
          type="button"
          role="switch"
          className="live-switch"
          aria-checked={on}
          aria-labelledby={titleId}
          aria-describedby={stateId}
          disabled={disabled}
          onClick={() => ask(on ? 'off' : 'on')}
        >
          <span className="live-switch-thumb" aria-hidden />
        </button>
      </div>
      {!report.canChange && report.why && <p className="live-steps-line">{report.why}</p>}
      {agent.problem && <p className="live-steps-line">{agent.problem}</p>}
      {agent.state === 'partly' && agent.missing && (
        <p className="live-steps-line">Missing {agent.missing.join(', ')}. Turning it on mends it.</p>
      )}
      {agent.trust && agent.state !== 'off' && (
        <p className="live-steps-line is-needs-you">
          <strong>{agent.trust}.</strong> Open /hooks in {agent.name} and trust Tricot's hook; Tricot can't see whether you have.
        </p>
      )}
      {agent.alsoInProject && (
        <p className="live-steps-line">
          {agent.state === 'off' ? (
            <span>
              Also set up in <code>{agent.alsoInProject}</code> from earlier, so steps show from that project.
            </span>
          ) : (
            <span>
              Also set up in <code>{agent.alsoInProject}</code> from earlier; steps still show once.{' '}
              {!disabled && (
                <button type="button" className="live-steps-link" onClick={tidy}>
                  Tidy up
                </button>
              )}
            </span>
          )}
        </p>
      )}
      {/* What was written was in the sheet; its notes too (the /hooks note stays above while it holds). */}
      {done && (
        <p className="live-steps-done" role="status">
          {done.summary}
        </p>
      )}
      {asking && <LiveStepsSheet agent={agent} person={person} change={asking} onCancel={close} onDone={finished} />}
    </section>
  );
}

// ---- the confirm sheet ------------------------------------------------------------------

// What happens to each file, in a word, with the same quiet tag either way.
const DOES: Record<LiveStepsFile['does'], string> = { write: 'Adds', add: 'Adds', replace: 'Adds', remove: 'Removes', delete: 'Removes' };

function FileChange({ file }: { file: LiveStepsFile }) {
  return (
    <li className="live-file">
      <div className="live-file-head">
        <span className="live-file-does">{DOES[file.does]}</span>
        <code className="live-file-path">{file.path}</code>
      </div>
      <p className="live-file-what">
        {file.what}
        {file.same && <span className="live-file-same"> · there already, not written again</span>}
      </p>
    </li>
  );
}

// The exact lines each settings file gets or loses, for whoever wants them:
// closed until asked for.
function ExactLines({ files }: { files: LiveStepsFile[] }) {
  const shown = files.filter((file) => file.lines && !file.same);
  if (!shown.length) return null;
  return (
    <details className="live-lines">
      <summary>Show the exact lines</summary>
      {shown.map((file) => (
        <div key={`${file.does}:${file.path}`} className="live-lines-file">
          <p>
            {file.does === 'remove' || file.does === 'delete' ? 'Out of' : 'In'} <code>{file.path}</code>
          </p>
          <pre className="live-file-lines" tabIndex={0} aria-label={`The lines for ${file.path}`}>
            {file.lines}
          </pre>
        </div>
      ))}
    </details>
  );
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

function LiveStepsSheet({
  agent,
  person,
  change,
  onCancel,
  onDone,
}: {
  agent: LiveStepsAgent;
  person: string;
  change: LiveStepsChange;
  onCancel: () => void;
  onDone: (result: LiveStepsResult) => void;
}) {
  const [preview, setPreview] = useState<LiveStepsPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const sheet = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const turningOn = change.action === 'on';
  // The project's own hook from earlier, tidied up on its own.
  const tidying = change.scope === 'project';
  const project = agent.alsoInProject ?? 'the project';

  // What it would write, read again after a refusal (the files changed).
  useEffect(() => {
    let live = true;
    setPreview(null);
    api.previewLiveSteps(agent.id, person, change).then(
      (next) => live && setPreview(next),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [agent.id, person, change, round]);

  useEffect(() => {
    sheet.current?.focus();
  }, []);

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.applyLiveSteps(agent.id, person, { ...change, fingerprint: preview.fingerprint }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      // What it would write changed since the person saw it: show them the new one.
      if ((e as RequestError).status === 409) setRound((n) => n + 1);
    }
  };

  // Escape closes the sheet, not the panel under it; Tab stays in the sheet.
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== 'Tab' || !sheet.current) return;
    const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const nothing = preview?.unchanged;
  const title = tidying ? `Tidy up ${project}?` : `Turn ${change.action} live steps for ${agent.name}?`;
  const lede = tidying
    ? `${agent.name}'s steps are on for every project, so the hook ${project} got earlier isn't needed. Tricot takes out only its own lines there; every other setting stays as it is.`
    : turningOn
      ? `${agent.name} then shows what it is doing, one line per step, on the card it works on, in every project. Tricot adds a small hook to ${agent.name}'s own settings and changes nothing else. It sends no file contents, command output or prompts.`
      : `${agent.name} stops sending its steps. Tricot takes out only what it added; every other setting stays as it is.`;
  return (
    <div className="live-sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="live-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheet} tabIndex={-1} onKeyDown={keys}>
        <div className="live-sheet-body">
          <h3 id={titleId}>{title}</h3>
          <p className="live-sheet-lede">{lede}</p>
          {preview ? (
            <>
              <p className="live-sheet-meta">
                {preview.sendsAs && (
                  <>
                    Its steps show as <strong>{preview.sendsAs}</strong>.{' '}
                  </>
                )}
                {nothing ? (turningOn ? 'It is set up like this already.' : "There is nothing of Tricot's to take out.") : null}
              </p>
              <ul className="live-files">
                {preview.files.map((file) => (
                  <FileChange key={`${file.does}:${file.path}`} file={file} />
                ))}
              </ul>
              <ExactLines files={preview.files} />
              {preview.notes.map((note) => (
                <p key={note} className="live-sheet-note">
                  {withCode(note)}
                </p>
              ))}
            </>
          ) : (
            !error && <p className="live-sheet-meta">Reading what is there now…</p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="live-sheet-actions">
          <button type="button" className="btn btn-small" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-small btn-primary" disabled={!preview || busy} onClick={() => void confirm()}>
            {busy ? 'Writing…' : tidying ? 'Tidy up' : turningOn ? 'Turn on' : 'Turn off'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- the Connect panel --------------------------------------------------------------------

// One line for an agent on this machine without live steps, with the fix.
export function LiveStepsHint({ tool }: { tool: string }) {
  const { report } = useLiveSteps();
  const agent = report?.agents.find((a) => a.id === tool);
  if (!agent || !agent.found || agent.state === 'on' || agent.problem) return null;
  return (
    <p className="connect-hint">
      <span className="connect-hint-mark" aria-hidden />
      <span>
        {agent.state === 'partly' ? `${agent.name}'s live steps are partly set up` : `No live steps for ${agent.name} yet`}: run <code>{liveStepsCommand(agent)}</code>, or use the switch in its panel.
      </span>
    </p>
  );
}
