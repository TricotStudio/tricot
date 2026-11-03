import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { OMP_FILE, OMP_WHY, OPENCODE_FILE, panelTexts, type PanelTool } from '../core/connect';
import type { Actor, Status, Task } from '../core/types';
import { api, type AgentPresence } from './api';
import { AgentPanel, AgentsMenu } from './agents';
import { useDismiss } from './hooks';
import { LiveStepsHint } from './liveSteps';
import { RefChip } from './refs';
import { setTheme, useTheme } from './theme';
import { themes } from './themes/registry';

export const STATUS_META: Record<Status, { label: string; hint: string }> = {
  open: { label: 'Open', hint: 'Waiting on you' },
  exploring: { label: 'Exploring', hint: 'Agents gathering evidence' },
  provisional: { label: 'Provisional', hint: 'Agents proceed; easy to change' },
  decided: { label: 'Decided', hint: 'Binding' },
  deferred: { label: 'Deferred', hint: 'Not now' },
  retired: { label: 'Retired', hint: 'No longer relevant' },
};

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// One stroke family for every icon in the UI: 16px grid, 1.5 stroke, round joins.
const ICONS = {
  'arrow-right': <path d="M3 8h10M9 4l4 4-4 4" />,
  'arrow-left': <path d="M13 8H3M7 4 3 8l4 4" />,
  'arrow-up': <path d="M8 13V3M4 7l4-4 4 4" />,
  'arrow-up-left': <path d="M11.5 11.5 4.5 4.5M4.5 10V4.5H10" />,
  'chevron-down': <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />,
  external: <path d="M7 4.5H4.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V9M9.5 3.5h3v3M12.5 3.5l-5 5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  x: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  edit: <path d="M3 13l.6-2.7 7-7a1.45 1.45 0 0 1 2.1 2.1l-7 7ZM9.4 4.6l2 2" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  sync: <path d="M2.75 7.25A5.3 5.3 0 0 1 12.4 5M12.75 2.25V5H10M13.25 8.75A5.3 5.3 0 0 1 3.6 11M3.25 13.75V11H6" />,
  bell: <path d="M4 11.5h8l-1-1.5V7a3 3 0 0 0-6 0v3l-1 1.5ZM6.8 13.5a1.3 1.3 0 0 0 2.4 0" />,
  search: <path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.25 10.25 13.5 13.5" />,
  canvas: <path d="M3.75 2.75h8.5a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1ZM5.5 5.5h2.25v2.25H5.5ZM8.5 9h2v1.5h-2Z" />,
  comment: <path d="M3 4.25c0-.7.55-1.25 1.25-1.25h7.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H7.5L4.75 13.25V11h-.5C3.55 11 3 10.45 3 9.75Z" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />,
  details: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  archive: <path d="M2.5 3.5h11v3h-11ZM3.5 6.5v6h9v-6M6.5 9h3" />,
  link: (
    <path d="M6.7 9.3a2.9 2.9 0 0 0 4.1 0l2.2-2.2a2.9 2.9 0 0 0-4.1-4.1l-.9.9M9.3 6.7a2.9 2.9 0 0 0-4.1 0L3 8.9A2.9 2.9 0 0 0 7.1 13l.9-.9" />
  ),
  partly: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 3a5 5 0 0 1 0 10Z" fill="currentColor" stroke="none" />
    </>
  ),
  star: (
    <path
      d="m8 2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4-2.9-2.8 4-.6Z"
      fill="currentColor"
      strokeWidth="1"
    />
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
    </>
  ),
  moon: <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" />,
  // The plug, its cord a thread with a loop in it: connecting an agent. The
  // break is where the thread passes under itself.
  'knitted-plug': (
    <path d="M6.25 1.5v2.25M9.75 1.5v2.25M4.75 3.75h6.5v1.5a3.25 3.25 0 0 1-6.5 0ZM8 8.5v1.75c0 3.35 3.4 3.75 3.6 1.35.09-.9-.39-1.44-1.09-1.57M6.16 12.85c-1.05.84-2.36 1.43-3.91 1.4" />
  ),
  // A spool of thread, for the board's threads.
  thread: (
    <path d="M4.5 1.75h7a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2ZM4.5 12.25h7a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2ZM5.25 3.75v8.5M10.75 3.75v8.5M5.25 6.25l5.5-1.25M5.25 8.75l5.5-1.25M5.25 11.25l5.5-1.25M10.75 8.5c.9 0 1.2.8 2 .8.55 0 .9-.35 1.1-.7" />
  ),
  // A smiley with a small plus, for adding a reaction to a comment.
  react: (
    <>
      <path d="M10.9 5.6A5 5 0 1 0 12 9" />
      <path d="M5 10.6a2.6 2.6 0 0 0 4 0" />
      <path d="M5.3 7.6h.01M8.7 7.6h.01" strokeWidth="2" />
      <path d="M13 1.75v3.5M11.25 3.5h3.5" />
    </>
  ),
  // A bin, for deleting a thread.
  trash: <path d="M3 4.5h10M6.25 4.5V3.25h3.5V4.5M4.5 4.5l.55 8.1a1 1 0 0 0 1 .9h3.9a1 1 0 0 0 1-.9l.55-8.1M6.75 7v4M9.25 7v4" />,
} satisfies Record<string, ReactNode>;

export function Icon({ name, className }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

function hue(name: string): number {
  let h = 0;
  for (const char of name) h = (h * 31 + char.charCodeAt(0)) % 360;
  return h;
}

// Humans get a tinted circle, agents a neutral square; both show an initial.
export function ActorBadge({ actor, showName = true, title }: { actor: Actor; showName?: boolean; title?: string }) {
  const style = actor.kind === 'human' ? ({ '--hue': hue(actor.name) } as CSSProperties) : undefined;
  return (
    <span className={`actor actor-${actor.kind}`} title={title ?? `${actor.name} (${actor.kind})`}>
      <span className="actor-mark" style={style} aria-hidden>
        {actor.name.charAt(0).toUpperCase()}
      </span>
      {showName && <span className="actor-name">{actor.name}</span>}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{STATUS_META[status].label}</span>;
}

// The board's one Markdown engine (markdown.tsx), from here as it always was.
export { InlineMd, Md } from './markdown';

// What each agent state means for the person waiting on it, most reachable first.
const AGENT_STATES: Record<AgentPresence['state'], { label: string; meaning: (lastSeen: string) => string }> = {
  listening: { label: 'listening', meaning: () => 'Waiting on the board, so it sees what you do right away.' },
  working: {
    label: 'working',
    meaning: (seen) => `Busy with a step; it sees what you do when it next checks the board (last checked ${timeAgo(seen)}).`,
  },
  away: {
    label: 'not checking',
    meaning: (seen) => `Last checked the board ${timeAgo(seen)}; nudge it in its session if you're waiting on it.`,
  },
};

// The tasks an agent has in progress.
function workingOn(tasks: Task[], agent: string): Task[] {
  return tasks.filter((t) => t.status === 'in_progress' && t.claimedBy?.kind === 'agent' && t.claimedBy.name === agent);
}

// How long the pointer can be off the live label and its card before the card
// opens or closes, so passing over the label doesn't flash it.
const LIVE_CARD_DELAY_MS = 150;

// Whether the board is live, and which agents are on it, in a few words: an
// agent by name and state, or how many. The dot follows the most reachable
// agent. Hovering or focusing the label opens a card with each agent's state,
// what that means for you, and the tasks it's on. The card stays open while
// the pointer or focus is on it, so its links can be used; a click outside it
// or Escape closes it.
export function LiveIndicator({ live, agents = [], tasks = [] }: { live: boolean; agents?: AgentPresence[]; tasks?: Task[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = useCallback((escape: boolean) => {
    // Focus goes back to the label before the card closes, so it isn't lost with the card's links.
    if (escape && root.current?.contains(document.activeElement)) label.current?.focus();
    setOpen(false);
  }, []);
  useDismiss(open, close, root);
  if (!live) {
    return (
      <div className="live" title="Reconnecting…">
        <span className="live-label">
          <span className="live-dot" /> Offline
        </span>
      </div>
    );
  }
  const later = (next: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), LIVE_CARD_DELAY_MS);
  };
  const focusedWithin = () => root.current?.contains(document.activeElement) ?? false;
  // Most reachable first, so the card's first row is the one the dot follows.
  const states = Object.keys(AGENT_STATES) as AgentPresence['state'][];
  const byReach = [...agents].sort((a, b) => states.indexOf(a.state) - states.indexOf(b.state));
  const reachable = byReach[0]?.state ?? 'listening';
  const words =
    agents.length === 0
      ? 'No agents'
      : agents.length === 1
        ? `${agents[0].name} · ${AGENT_STATES[agents[0].state].label}`
        : `${agents.length} agents`;
  return (
    <div
      className="live"
      ref={root}
      onMouseEnter={() => {
        hovered.current = true;
        later(true);
      }}
      onMouseLeave={() => {
        hovered.current = false;
        if (focusedWithin()) clearTimeout(timer.current);
        else later(false);
      }}
      onFocus={() => {
        clearTimeout(timer.current);
        setOpen(true);
      }}
      onBlur={(e) => {
        if (!hovered.current && !root.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button ref={label} type="button" className={`live-label live-on live-${reachable}`} aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="live-dot" />
        <span className="live-words">{words}</span>
      </button>
      {open && (
        <div className="live-card" role="group" aria-label="Agents on this board">
          {agents.length === 0 ? (
            <p className="live-card-empty">No agent has used this board in the last 5 minutes.</p>
          ) : (
            <ul className="live-agents">
              {byReach.map((a) => {
                const own = workingOn(tasks, a.name);
                return (
                  <li key={a.name} className="live-agent">
                    <div className="live-agent-head">
                      <ActorBadge actor={{ kind: 'agent', name: a.name }} />
                      <span className={`live-state live-${a.state}`}>
                        <span className="live-dot" />
                        {AGENT_STATES[a.state].label}
                      </span>
                    </div>
                    <p className="live-agent-meaning">{AGENT_STATES[a.state].meaning(a.lastSeen)}</p>
                    {own.length > 0 && (
                      <p className="live-agent-tasks">
                        Working on
                        {own.map((t) => (
                          <RefChip key={t.id} kind="task" number={t.number} />
                        ))}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// You, at the end of the top bar: the chip opens your menu, with your name and the theme.
export function UserChip({ name, onRename }: { name: string; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<string | null>(null); // whose panel is open
  const root = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  return (
    <div className="user-menu" ref={root}>
      <button className="user-chip" onClick={() => setOpen(!open)} aria-expanded={open} title="You">
        <ActorBadge actor={{ kind: 'human', name }} />
        <Icon name="chevron-down" className="user-chev" />
      </button>
      {open && (
        <div className="menu-panel user-panel">
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            <strong>Change your name</strong>
            <span>How people and agents see you on every board.</span>
          </button>
          <div className="user-theme">
            <span>Theme</span>
            <div className="connect-tabs" role="group" aria-label="Theme">
              {themes.map((t) => (
                <button key={t.id} type="button" className={theme === t ? 'is-active' : ''} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                  <Icon name={t.base === 'light' ? 'sun' : 'moon'} /> {t.label}
                </button>
              ))}
            </div>
          </div>
          <AgentsMenu
            onOpen={(agentName) => {
              setOpen(false);
              setAgent(agentName);
            }}
          />
        </div>
      )}
      {agent && <AgentPanel name={agent} person={name} onClose={() => setAgent(null)} />}
    </div>
  );
}

// A command or a config entry, with Copy: the Connect panel's, and Home's first run's (firstRun.tsx).
export function CopyLine({ text, block }: { text: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; the text stays selectable.
    }
  };
  return (
    <div className={block ? 'copyline is-block' : 'copyline'}>
      <code>{text}</code>
      <button className="btn btn-quiet btn-small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// How each agent tool joins: one command, run once, names the agent on the
// board. The commands are built and quoted as `tricot connect` prints them
// (core/connect.ts). The tab last used is remembered on this browser.
const AGENT_TOOLS: { key: PanelTool; label: string }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'pi', label: 'Pi' },
  { key: 'omp', label: 'OMP' },
  { key: 'gemini', label: 'Gemini CLI' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'other', label: 'Other' },
];
const TOOL_KEY = 'tricot:connect-tool';

// On a board, a second step: the board's id, to hand the agent. Home has none.
export function ConnectAgent({ boardId }: { boardId?: string }) {
  const [url, setUrl] = useState<string>();
  const [tool, setTool] = useState<PanelTool>(() => {
    try {
      const saved = localStorage.getItem(TOOL_KEY);
      return AGENT_TOOLS.some((t) => t.key === saved) ? (saved as PanelTool) : 'claude';
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
  const texts = panelTexts(url);
  return (
    <div className="connect">
      <div className="connect-tabs" role="group" aria-label="Agent tool">
        {AGENT_TOOLS.map((t) => (
          <button key={t.key} type="button" className={tool === t.key ? 'is-active' : ''} aria-pressed={tool === t.key} onClick={() => pick(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tool === 'claude' && (
        <>
          <p>Run once in a terminal; Claude Code then has the board in every session.</p>
          <CopyLine text={texts.claude} />
        </>
      )}
      {tool === 'codex' && (
        <>
          <p>Run once in a terminal; Codex then has the board in every session.</p>
          <CopyLine text={texts.codex} />
          <p className="muted small">
            Codex asks before each board tool unless you approve them for this server in its settings. It shows on the board
            as “Codex”.
          </p>
        </>
      )}
      {tool === 'pi' && (
        <>
          <p>Run once in a terminal; Pi then has the board in every session.</p>
          <CopyLine text={texts.pi} />
          <p className="muted small">
            Pi reaches the board's tools through its codemode tool. Add <code>--exposure direct</code> to list them to the
            model instead. It shows on the board as “Pi”.
          </p>
        </>
      )}
      {tool === 'omp' && (
        <>
          <p>
            OMP has no command for this. Add the entry to <code>{OMP_FILE}</code> (merge it into <code>mcpServers</code> if
            the file exists), or to <code>.omp/mcp.json</code> for one project.
          </p>
          <CopyLine block text={texts.omp} />
          <p className="muted small">{OMP_WHY}</p>
        </>
      )}
      {tool === 'gemini' && (
        <>
          <p>Run once in a terminal; Gemini CLI then has the board in every session.</p>
          <CopyLine text={texts.gemini} />
          <p className="muted small">
            Without <code>--scope user</code> it would be for one project. Gemini CLI asks before each board tool unless you add{' '}
            <code>--trust</code>. It shows on the board as “Gemini”.
          </p>
        </>
      )}
      {tool === 'opencode' && (
        <>
          <p>
            Add the entry to <code>{OPENCODE_FILE}</code> (merge it into <code>mcp</code> if the file exists), or to{' '}
            <code>opencode.json</code> in a project. OpenCode 1 and 2 both read it.
          </p>
          <CopyLine block text={texts.opencode} />
          <p className="muted small">
            OpenCode 1 adds a server only by asking questions; <code>tricot connect opencode</code> also prints OpenCode 2's
            one-line command. It shows on the board as “OpenCode”.
          </p>
        </>
      )}
      {tool === 'other' && (
        <>
          <p>Any MCP client (Streamable HTTP): point it at this address.</p>
          <CopyLine text={texts.other} />
          <p className="muted small">
            Add <code>?agent=Name</code> to label the agent on the board.
          </p>
        </>
      )}
      {tool !== 'other' && <LiveStepsHint tool={tool} />}
      {boardId && (
        <>
          <p>Then tell your agent which board to work on:</p>
          <CopyLine text={boardId} />
        </>
      )}
    </div>
  );
}

// A <details> popover: its <summary>, then a .popover-body. A browser leaves
// one open until its summary is clicked again; this one also closes on a
// click outside it or on Escape, as the other panels do (useDismiss).
export function Popover({ className, children }: { className?: string; children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    const details = root.current;
    if (!details) return;
    details.open = false;
    if (details.contains(document.activeElement)) details.querySelector('summary')?.focus();
  }, []);
  useDismiss(open, close, root);
  return (
    <details ref={root} className={className ? `popover ${className}` : 'popover'} onToggle={(e) => setOpen(e.currentTarget.open)}>
      {children}
    </details>
  );
}

export function NameGate({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Wordmark />
        <h1>What should agents call you?</h1>
        <p className="muted">Your name is attached to every decision you make, so everyone can see who decided what.</p>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Your name" maxLength={60} />
        <button className="btn btn-primary" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}

// The board mark: a lattice of two threads each way, woven over and under
// where they cross and turned onto the diagonal, with a small square (a
// diamond, once turned) at its heart. One colour, the text colour, in both
// themes. Drawn on a 16px grid, like the favicon in index.html.
export function BoardMark({ size }: { size: number }) {
  return (
    <svg className="board-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <g transform="rotate(45 8 8)">
        <path
          d="M1.5 5H9.25M12.75 5H14.5M1.5 11H3.25M6.75 11H14.5M5 1.5V3.25M5 6.75V14.5M11 1.5V9.25M11 12.75V14.5"
          fill="none"
          stroke="var(--text)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <rect x="6.75" y="6.75" width="2.5" height="2.5" rx="0.5" fill="var(--text)" />
      </g>
    </svg>
  );
}

// The mark, then the name in Cal Sans (bundled in fonts/).
export function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-lockup${small ? ' brand-lockup-small' : ''}`}>
      <BoardMark size={small ? 22 : 30} />
      <span className="brand-text">
        <span className="wordmark">Tricot</span>
      </span>
    </span>
  );
}
