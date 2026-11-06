import { useEffect, useState } from 'react';
import type { Rich } from '../../core/agents/agent';
import { agentKinds, findAgent, PANEL_OTHER, panelTexts, type PanelTool } from '../../core/agents/registry';
import { shellFor } from '../../core/connect';
import { sessionCommand } from '../../core/sessions';
import { api } from '../shared/api';
import { CopyLine } from '../shared/components';
import { LiveStepsHint } from './liveSteps';

// The shell the commands the page shows are for: PowerShell where the page is
// open on Windows (the same computer as the agent, in nearly every case),
// else zsh or bash.
export const pageShell = shellFor(typeof navigator !== 'undefined' && /Win/.test(navigator.platform));

// How each agent tool joins: one command, run once, names the agent on the
// board. The commands are built and quoted as `tricot connect --print` prints them
// (core/connect.ts), and what each tab says is the agent's own (core/agents/<id>/index.ts,
// listed in core/agents/registry.ts). The tab last used is remembered on this browser.
const TOOL_KEY = 'tricot:connect-tool';

const isTool = (key: string | null): key is PanelTool => key === PANEL_OTHER || agentKinds().some((kind) => kind.id === key);

// Plain words with pieces of code in them.
function Words({ parts }: { parts: Rich }) {
  return <>{parts.map((part, at) => (typeof part === 'string' ? part : <code key={at}>{part.code}</code>))}</>;
}

// On a board, a second step: the board's id, to hand the agent. Home has none.
export function ConnectAgent({ boardId }: { boardId?: string }) {
  const [url, setUrl] = useState<string>();
  const [tool, setTool] = useState<PanelTool>(() => {
    try {
      const saved = localStorage.getItem(TOOL_KEY);
      return isTool(saved) ? saved : 'claude';
    } catch {
      return 'claude';
    }
  });
  useEffect(() => {
    api.info().then((info) => setUrl(info.mcpUrl), () => {});
  }, []);
  const pick = (next: PanelTool) => {
    setTool(next);
    try {
      localStorage.setItem(TOOL_KEY, next);
    } catch {
      // Not remembered; the choice still holds for now.
    }
  };
  if (!url) return null;
  const texts = panelTexts(url, pageShell);
  const tabs = [...agentKinds().map((kind) => ({ key: kind.id, label: kind.name })), { key: PANEL_OTHER, label: 'Other' }];
  const agent = findAgent(tool);
  return (
    <div className="connect">
      <div className="connect-tabs" role="group" aria-label="Agent tool">
        {tabs.map((t) => (
          <button key={t.key} type="button" className={tool === t.key ? 'is-active' : ''} aria-pressed={tool === t.key} onClick={() => pick(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {agent && (
        <>
          <p>
            <Words parts={agent.panel.intro} />
          </p>
          <CopyLine block={agent.connect.how === 'file'} text={texts[agent.id]} />
          {agent.panel.note && (
            <p className="muted small">
              <Words parts={agent.panel.note} />
            </p>
          )}
          {!agent.cantStart && <OneSession agent={agent.id} name={agent.name} boardId={boardId} />}
        </>
      )}
      {tool === PANEL_OTHER && (
        <>
          <p>Any MCP client (Streamable HTTP): point it at this address.</p>
          <CopyLine text={texts[PANEL_OTHER]} />
          <p className="muted small">
            Add <code>?agent=Name</code> to label the agent on the board.
          </p>
        </>
      )}
      {tool !== PANEL_OTHER && <LiveStepsHint tool={tool} />}
      {boardId && (
        <>
          <p>Then tell your agent which board to work on:</p>
          <CopyLine text={boardId} />
        </>
      )}
    </div>
  );
}

// The other way in: `tricot claude` starts the agent with the board for one
// session, its settings left alone (core/sessions.ts).
function OneSession({ agent, name, boardId }: { agent: string; name: string; boardId?: string }) {
  return (
    <p className="muted small connect-session">
      Or start {name} with the board for one session, its settings left alone: <code>{sessionCommand(agent, boardId)}</code>
    </p>
  );
}
