import { useCallback, useRef, useState } from 'react';
import { SeatsPanel } from '../access';
import { AgentPanel, AgentsMenu } from '../agents';
import { ActorBadge, Icon } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { setTheme, themes, useTheme } from '../themes';
import { CheckForUpdates } from '../update';

// You, at the end of the top bar: the chip opens your menu, with your name,
// the theme, your browsers and terminals (seats.tsx), the version running
// with Check for updates (update.tsx), and the agents.
export function UserMenu({ name, onRename }: { name: string; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<string | null>(null); // whose panel is open
  const [seats, setSeats] = useState(false); // your browsers and terminals, open
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
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              setSeats(true);
            }}
          >
            <strong>Your browsers and terminals</strong>
            <span>The ones you let act for you, and removing one.</span>
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
          <CheckForUpdates onShow={close} />
          <AgentsMenu
            onOpen={(agentName) => {
              setOpen(false);
              setAgent(agentName);
            }}
          />
        </div>
      )}
      {agent && <AgentPanel name={agent} person={name} onClose={() => setAgent(null)} />}
      {seats && <SeatsPanel name={name} onClose={() => setSeats(false)} />}
    </div>
  );
}
