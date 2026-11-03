import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { panelTexts } from '../core/connect';
import {
  agentLine,
  agentToConnect,
  connectWords,
  FIRST_DOOR,
  FIRST_RUN_LIMIT,
  folderLine,
  folderNote,
  FirstRunError,
  firstRunSender,
  helperLine,
  listenHintShows,
  WAITS_LINE,
  type StartFolder,
} from '../core/firstRun';
import type { AgentAround } from '../core/needs';
import { api } from './api';
import { ActorBadge, CopyLine, Icon } from './components';
import { NEW_BOARD } from './hooks';
import { openThread } from './threads';
import { SayToListen, toolOf, useInstalledAgents } from './wake';
import './firstRun.css';

// Home's first run (#79, "Just ask"; core/firstRun.ts): until there is a
// project, Home asks what you're working on. Sending makes the project and
// opens it on Decisions with the conversation docked, the sentence sent as its
// first message, so the agent's first question card lands beside it. Under
// the field, the command to connect the agent found on this computer, or once
// one has connected, a line saying what it does with what you send.

interface Props {
  name: string;
  agents: AgentAround[]; // Home's, the busiest first
  onSending: (sending: boolean) => void; // Home keeps this page while a send is under way, or its project is made but the question didn't go
  onEveryWay: () => void; // opens the Connect panel
}

export function FirstRun(props: Props) {
  // Where Tricot was started, and its MCP address: the page waits the moment
  // they take, so the words under the field don't change as it is read.
  const [info, setInfo] = useState<{ mcpUrl: string; folder?: StartFolder } | null>();
  useEffect(() => {
    let live = true;
    api.info().then(
      (next) => live && setInfo(next),
      () => live && setInfo(null),
    );
    return () => {
      live = false;
    };
  }, []);
  if (info === undefined) return null;
  return <Ask {...props} mcpUrl={info?.mcpUrl ?? null} folder={info?.folder} />;
}

function Ask({ name, agents, onSending, onEveryWay, mcpUrl, folder }: Props & { mcpUrl: string | null; folder: StartFolder | undefined }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const helpId = useId();
  const note = folderNote(folder);
  const send = useMemo(
    () =>
      firstRunSender({
        createBoard: (title, goal) => api.createBoard(name, title, goal),
        startThread: (boardId, body, door) => api.startThread(boardId, name, body, undefined, door),
        // Which folder it is about, on the board's context, for agents.
        ...(note && { noteFolder: (boardId: string) => api.addBlock({ boardId }, name, { title: note.title, content: { type: 'note', text: note.text } }) }),
      }),
    [name, note?.title, note?.text],
  );
  const help = helperLine(folder);
  // The board switcher's "New board" comes to Home with ?new: this field has
  // the focus anyway, and the address drops ?new so a reload doesn't.
  useEffect(() => {
    if (NEW_BOARD.test(location.hash)) history.replaceState(history.state, '', `${location.pathname}${location.search}${location.hash.replace(NEW_BOARD, '')}`);
  }, []);

  const start = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    onSending(true);
    try {
      const sent = await send(text);
      if (sent) openThread(sent.thread.id, sent.thread, { boardId: sent.board.id, view: FIRST_DOOR });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      onSending(e instanceof FirstRunError && e.board !== undefined); // its project made: this page stays, to send again
      field.current?.focus();
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void start();
  };
  // Enter sends; Shift+Enter is a new line. Not while an input method is composing.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void start();
  };

  const agent = agents.find((a) => a.state === 'listening') ?? agents.find((a) => a.state === 'working') ?? agents[0];
  return (
    <section className="first-run" aria-labelledby={titleId}>
      <div className="first-welcome">
        <p>Welcome to Tricot, {name}.</p>
        {folder && <FolderLine folder={folder} />}
      </div>
      <h1 id={titleId}>What are you working on?</h1>
      <form className="first-ask" onSubmit={submit} aria-busy={busy}>
        <textarea
          ref={field}
          className="first-ask-field"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="A pricing page for the Pro plan, retry logic for the API client, a launch plan…"
          aria-labelledby={titleId}
          aria-describedby={helpId}
          maxLength={FIRST_RUN_LIMIT}
          rows={3}
          readOnly={busy}
          autoFocus
        />
        <div className="first-ask-foot">
          <p className="first-ask-help" id={helpId}>
            {help.lead}
            {help.path && (
              <>
                {' '}
                <code className="first-path">{help.path}</code>
              </>
            )}
            {help.after}
          </p>
          <button className="btn btn-primary first-ask-send" disabled={!text.trim() || busy}>
            {busy ? 'Starting…' : 'Start and ask'}
            <Icon name="arrow-right" />
          </button>
        </div>
      </form>
      {error && (
        <p className="error first-run-error" role="alert">
          {error}
        </p>
      )}
      {agent ? (
        <AgentHere agent={agent} />
      ) : (
        <ConnectFirst url={mcpUrl} onEveryWay={onEveryWay} />
      )}
    </section>
  );
}

// Where Tricot was started, beside the welcome: the project's folder, or
// gently, that it wasn't started in one (core/firstRun.ts).
function FolderLine({ folder }: { folder: StartFolder }) {
  const { lead, path, after } = folderLine(folder);
  return (
    <p className={`first-folder is-${folder.kind}`}>
      {lead}
      {path && (
        <>
          {' '}
          <code className="first-path">{path}</code>
        </>
      )}
      {after}
    </p>
  );
}

// An agent has connected: what it does with the sentence, in one quiet line,
// and while it isn't listening, what to say so it does, with Copy (wake.tsx):
// until then it won't see the new project unless told to look.
function AgentHere({ agent }: { agent: AgentAround }) {
  const installed = useInstalledAgents();
  return (
    <div className={`first-agent is-${agent.state}`} role="status">
      <ActorBadge actor={{ kind: 'agent', name: agent.name }} showName={false} title={agent.name} />
      <p>
        {agentLine(agent)}
        {listenHintShows(agent) && installed !== undefined && (
          <span className="first-agent-say">
            <SayToListen agent={agent.name} tool={toolOf(agent.name, installed)} />
          </span>
        )}
      </p>
    </div>
  );
}

// No agent yet: the command for the one on this computer (as the Connect
// panel and `tricot connect` build it, core/connect.ts), with Copy, and the
// way to every other. Which agents are here comes from live steps
// (wake.tsx); without them, Claude Code's command, as the Connect panel opens on.
function ConnectFirst({ url, onEveryWay }: { url: string | null; onEveryWay: () => void }) {
  const found = useInstalledAgents();
  const titleId = useId();
  if (found === undefined) return null; // a moment, so the words don't change under the person
  const step = agentToConnect(found ?? undefined);
  return (
    <section className="first-connect" aria-labelledby={titleId}>
      <p className="first-connect-text">
        <strong id={titleId}>No agent connected yet.</strong> {connectWords(step)} {WAITS_LINE}
      </p>
      {url && <CopyLine text={panelTexts(url)[step.tool]} block={step.tool === 'omp'} />}
      <p className="first-connect-more">
        Another agent?{' '}
        <button type="button" className="home-link" onClick={onEveryWay}>
          Every way to connect
        </button>
      </p>
    </section>
  );
}
