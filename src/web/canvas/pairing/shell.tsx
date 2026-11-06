// One full-screen frame for a piece people work on with an agent: a website,
// a Google Doc, and in later steps code, notes, diagrams, images, tables,
// charts and scenes (core/pairing.ts). The same top bar on each: the piece's
// mark, its title and where it is from, the mode switch (Browse, or Read,
// and "Pair with <agent> ▾", where the agent is picked), the piece's own view
// controls, and Close. While pairing, a band says how to point at a part,
// and the session's requests are listed beside the piece. A piece people can
// edit by hand has Edit between the two (piece.tsx, edit.tsx).
//
// The piece is the body. It knows how to point at one of its parts, show the
// pins on its parts and come back after a change (the site reloads in place,
// the doc follows its draft), and says what opening one of its pins does
// (onOpenRequest), for the session's list.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Pin } from '../../../core/types';
import { ActorBadge, Icon, timeAgo } from '../../shared/components';
import { otherPanelOpen, typing, useDismiss } from '../../shared/hooks';
import { PairingList } from './requests';
import type { AgentChoice, Pairing } from './session';
import './pairing.css';

const NO_PANEL = { current: null };

// Edit, for a piece people can edit by hand: `stop` saves and says whether it closed.
export interface ShellEdit {
  on: boolean;
  hint: string;
  start(): void;
  stop(): Promise<boolean>;
}

// Whether a panel of the shell (the agent picker) is open, so the piece's
// Escape leaves the view be while it closes that first.
export const panelOpen = () => otherPanelOpen(NO_PANEL);

const STATE_WORDS: Record<AgentChoice['state'], string> = {
  listening: 'listening',
  working: 'working',
  away: 'not checking',
  unseen: 'not on the board now',
};

// What pairing with an agent means while it is where it is, in a sentence.
export function reachWords(choice: AgentChoice | undefined, agent: string): string {
  switch (choice?.state) {
    case 'listening':
      return `${agent} is listening, so it picks up each request at once.`;
    case 'working':
      return `${agent} is busy; it picks up your requests as soon as it next checks the board.`;
    default:
      return `${agent} isn't checking the board now: your requests wait for it. Say “Start listening on Tricot” in its session.`;
  }
}

export function PairingShell(props: {
  pairing: Pairing;
  edit?: ShellEdit;
  label: string; // the dialog's name: "Website Tricot site"
  icon: ReactNode;
  title: string;
  from: ReactNode; // where it is from: "Home page · folder ~/site"
  fromTitle?: string;
  browse: { label: string; hint: string }; // Browse or Read
  pairHint: string; // what pairing does in this piece
  pairBand: ReactNode; // how to point at a part, while pairing
  band?: ReactNode; // a band of the piece's own
  controls?: ReactNode; // the piece's view controls
  open?: string | null; // the pin whose thread is open
  onOpenRequest(pin: Pin): void;
  onClose(): void;
  className?: string;
  foot?: ReactNode;
  children: ReactNode;
}) {
  const { pairing, edit, label, icon, title, from, fromTitle, browse, pairHint, pairBand, band, controls, open, onOpenRequest, onClose, className, foot, children } = props;
  const isPairing = pairing.mode === 'pair';
  // The block shown stays selected on the canvas underneath, where Delete and
  // Backspace would remove it, so they never reach the canvas while the view
  // is open. Typed in a field (a prompt, a reply, a doc's paragraph), they
  // still do what they do there.
  useEffect(() => {
    const keep = (e: KeyboardEvent) => {
      if ((e.key === 'Backspace' || e.key === 'Delete') && !typing(e.target)) e.stopPropagation();
    };
    window.addEventListener('keydown', keep, true);
    return () => window.removeEventListener('keydown', keep, true);
  }, []);
  return (
    <div className={`pair-shell nowheel nodrag nopan${isPairing ? ' is-pairing' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={label}>
      <header className="pair-bar">
        <span className="pair-icon" aria-hidden>
          {icon}
        </span>
        <div className="pair-title">
          <h2>{title}</h2>
          <p className="muted small" title={fromTitle}>
            {from}
          </p>
        </div>
        {!pairing.readOnly && <ModeSwitch pairing={pairing} edit={edit} browse={browse} pairHint={pairHint} />}
        {controls && <div className="pair-controls">{controls}</div>}
        <button className="btn btn-small btn-quiet pair-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </header>
      {isPairing && (
        <div className="pair-band" role="status">
          {pairBand}
        </div>
      )}
      {pairing.note && (
        <div className="pair-band is-note" role="status">
          <span>{pairing.note}</span>
          <button type="button" className="pair-band-close" onClick={pairing.dismissNote} aria-label="Dismiss">
            <Icon name="x" />
          </button>
        </div>
      )}
      {band}
      <div className="pair-main">
        <div className="pair-body">{children}</div>
        {isPairing && <PairingList pairing={pairing} open={open} onOpen={onOpenRequest} />}
      </div>
      {foot}
    </div>
  );
}

// Browse (or Read), Edit for a piece people can edit, and "Pair with Claude ▾":
// the last picks the agent. Leaving Edit saves what was typed; if it can't
// yet, Edit stays on and its band says why.
function ModeSwitch({ pairing, edit, browse, pairHint }: { pairing: Pairing; edit?: ShellEdit; browse: { label: string; hint: string }; pairHint: string }) {
  const [picking, setPicking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPicking(false), []);
  useDismiss(picking, close, root);
  const on = pairing.mode === 'pair';
  const editing = Boolean(edit?.on);
  const reading = !on && !editing;
  const { agent } = pairing;
  const choice = pairing.agents.find((a) => a.name === agent);
  const pair = (name?: string) => {
    if (!edit?.on) return pairing.pair(name);
    void edit.stop().then((closed) => closed && pairing.pair(name));
  };
  return (
    <div className="pair-modes" role="group" aria-label="Mode" ref={root}>
      <button
        type="button"
        className={`pair-mode${reading ? ' is-on' : ''}`}
        aria-pressed={reading}
        onClick={() => (edit?.on ? void edit.stop() : pairing.browse())}
        title={browse.hint}
      >
        {browse.label}
      </button>
      {edit && (
        <button type="button" className={`pair-mode${editing ? ' is-on' : ''}`} aria-pressed={editing} onClick={() => !editing && edit.start()} title={edit.hint}>
          Edit
        </button>
      )}
      <span className={`pair-mode pair-mode-pair${on ? ' is-on' : ''}`}>
        <button type="button" className="pair-mode-main" aria-pressed={on} disabled={pairing.busy} onClick={() => pair()} title={agent ? `${pairHint} ${reachWords(choice, agent)}` : pairHint}>
          {agent && <span className={`live-dot pair-dot live-${choice?.state ?? 'away'}`} aria-hidden />}
          {agent ? `Pair with ${agent}` : 'Pair'}
        </button>
        <button
          type="button"
          className="pair-mode-pick"
          aria-haspopup="menu"
          aria-expanded={picking}
          aria-label="Choose the agent to pair with"
          title="Choose the agent to pair with"
          disabled={pairing.busy}
          onClick={() => setPicking((was) => !was)}
        >
          <Icon name="chevron-down" />
        </button>
      </span>
      {picking && (
        <AgentPicker
          pairing={pairing}
          onPick={(name) => {
            setPicking(false);
            pair(name);
          }}
        />
      )}
    </div>
  );
}

// The board's agents, with where each is now: the one picked is paired with.
function AgentPicker({ pairing, onPick }: { pairing: Pairing; onPick: (name: string) => void }) {
  const { agents, agent } = pairing;
  return (
    <div className="pair-picker" role="menu" aria-label="Pair with">
      {agents.length === 0 ? (
        <p className="pair-picker-empty">No agent has been on this board yet. Connect one, and it shows here.</p>
      ) : (
        <ul>
          {agents.map((a) => (
            <li key={a.name}>
              <button type="button" role="menuitemradio" aria-checked={a.name === agent} className="pair-picker-agent" onClick={() => onPick(a.name)}>
                <ActorBadge actor={{ kind: 'agent', name: a.name }} />
                <span className={`live-state live-${a.state === 'unseen' ? 'away' : a.state}`}>
                  <span className="live-dot" />
                  {STATE_WORDS[a.state]}
                  {a.state === 'away' && a.lastSeen ? ` · ${timeAgo(a.lastSeen)}` : ''}
                </span>
                <span className="pair-picker-check" aria-hidden>
                  {a.name === agent && <Icon name="check" />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="pair-picker-foot">Your requests go straight to the agent you pick, and its steps show on each pin as it works.</p>
    </div>
  );
}
