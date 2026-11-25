// One full-screen frame for a piece people work on with an agent: a website,
// a Google Doc, and in later steps code, notes, diagrams, images, tables,
// charts and scenes (core/pairing.ts). The same top bar on each: the piece's
// mark, its title and where it is from, the mode switch (Browse, or Read,
// and "Pair with <agent> ▾", where the agent is picked), the piece's own view
// controls, and Close. While pairing, a band says how to point at a part, on
// one line (all of it in its tooltip), and the session's requests are listed
// beside the piece once it has one: before, the band says it all, and the
// piece keeps the room. A piece people can
// edit by hand has Edit between the two (piece.tsx, edit.tsx).
//
// The piece is the body. It knows how to point at one of its parts, show the
// pins on its parts and come back after a change (the site reloads in place,
// the doc follows its draft), and says what opening one of its pins does
// (onOpenRequest), for the session's list. A piece whose parts take no
// requests (a diff's lines, a shape, a comparison) has the frame without
// Pair (`pairs={false}`), and its whole block's pins under it (blockPins.tsx).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Pin } from '../../../core/types';
import { ActorBadge, Icon, timeAgo } from '../../shared/components';
import { otherPanelOpen, typing, useDismiss } from '../../shared/hooks';
import { insideOf } from '../../shared/onTop';
import { PairingList } from './requests';
import { NEW_SESSION, type AgentChoice, type Pairing } from './session';
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

// Escape in a full view closes one thing a press, once a panel of the shell
// is closed: `inner` closes what the view has open inside it (its editor, a
// prompt, a thread) and says whether it did, and with nothing open the view
// closes. A thread or the canvas's prompt drawn over the piece closes itself
// on Escape (pins.tsx) before this hears it, and so does a panel (the agent
// picker, the lists of the row under the piece), so whether one was open is
// taken as the key goes down: that Escape closes it alone.
export function useEscapeSteps(open: boolean, inner: (event: KeyboardEvent) => boolean, onClose: () => void): void {
  const now = useRef({ open, inner, onClose });
  now.current = { open, inner, onClose };
  useEffect(() => {
    let wasOpen = false;
    let wasPanel = false;
    const begin = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      wasOpen = now.current.open;
      wasPanel = panelOpen();
    };
    const step = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || wasPanel || panelOpen()) return;
      if (!now.current.inner(e) && !wasOpen) now.current.onClose();
    };
    window.addEventListener('keydown', begin, true);
    window.addEventListener('keydown', step);
    return () => {
      window.removeEventListener('keydown', begin, true);
      window.removeEventListener('keydown', step);
    };
  }, []);
}

const STATE_WORDS: Record<AgentChoice['state'], string> = {
  listening: 'listening',
  asleep: 'asleep',
  working: 'working',
  away: 'not checking',
  unseen: 'not on the board now',
};

// What pairing means now, in a sentence: with a session of its own, whether the person's first request starts it,
// it is starting, or it is up; with an agent of the board's, where it is (reachWords).
export function pairingReach(pairing: Pairing): string {
  const { agent, who, ownState } = pairing;
  if (ownState === 'first') return `Your first request starts ${agent ?? who} in Tricot's terminal, for every piece on this page.`;
  if (ownState === 'starting') return `Starting ${agent} in Tricot's terminal: your request waits for it, and it picks it up as it comes up.`;
  if (ownState === 'busy') return `${agent} waits to start: Tricot's terminal is running as many pairing sessions as it runs at once, and starts it as one is done.`;
  if (ownState === 'full') return `${agent} waits to start: Tricot's terminal has no free tab, and starts it as one closes.`;
  if (ownState === 'up') return `${agent} pairs on this page alone, and picks up each request at once.`;
  return agent ? reachWords(pairing.agents.find((a) => a.name === agent), agent) : '';
}

// What pairing with an agent means while it is where it is, in a sentence.
export function reachWords(choice: AgentChoice | undefined, agent: string): string {
  switch (choice?.state) {
    case 'listening':
      return `${agent} is listening, so it picks up each request at once.`;
    case 'asleep':
      return `${agent} is asleep: Tricot wakes it for each request, and it picks it up within a few seconds.`;
    case 'working':
      return `${agent} is busy; it picks up your requests as soon as it next checks the board.`;
    default:
      return `${agent} isn't checking the board now: your requests wait for it. Say “Start listening on Tricot” in its session.`;
  }
}

type Browse = { label: string; hint: string }; // Browse or Read

// What a piece pairs on. One whose parts take requests gives its session
// (session.ts), what pairing does in it and how to point at a part, and what
// opening a pin from the session's list does. One whose parts take none
// (`pairs={false}`: a diff's lines, a drawing, a comparison, core/parts.ts)
// has no Pair and no session: its bar has Read and Edit where people can
// edit it, and nothing else.
type ShellPairs =
  | {
      pairs?: true;
      pairing: Pairing;
      browse: Browse;
      pairHint: string; // what pairing does in this piece
      pairBand: ReactNode; // how to point at a part, while pairing
      open?: string | null; // the pin whose thread is open
      onOpenRequest(pin: Pin): void;
    }
  | { pairs: false; pairing?: never; browse?: Browse; pairHint?: never; pairBand?: never; open?: never; onOpenRequest?: never };

const READ: Browse = { label: 'Read', hint: 'Read it' };

export function PairingShell(
  props: ShellPairs & {
    edit?: ShellEdit;
    label: string; // the dialog's name: "Website Tricot site"
    icon: ReactNode;
    title: string;
    from: ReactNode; // where it is from: "Home page · folder ~/site"
    fromTitle?: string;
    band?: ReactNode; // a band of the piece's own
    controls?: ReactNode; // the piece's view controls
    onClose(): void;
    className?: string;
    foot?: ReactNode;
    children: ReactNode;
  },
) {
  const { edit, label, icon, title, from, fromTitle, browse = READ, pairHint = '', pairBand, band, controls, onClose, className, foot, children } = props;
  const paired = props.pairs === false ? undefined : props;
  const pairing = paired?.pairing;
  const isPairing = pairing?.mode === 'pair';
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
  // The keys come into the view as it opens, off the block it was opened
  // from, where the arrows would move it: to the view itself, unless the
  // piece has already taken them (a zoomed stage, a field). Closing it puts
  // them back on the block (CanvasView's refocus) or, for a view that doesn't
  // ask for that, back where they were before it opened, as long as nothing
  // outside the view took them meanwhile. What had them is read as the view
  // is first drawn, before any piece of it takes them. A popover the view
  // draws on top (a thread it opens at) is part of it.
  const root = useRef<HTMLDivElement>(null);
  const [before] = useState(() => document.activeElement);
  useEffect(() => {
    const element = root.current;
    if (element && !insideOf(document.activeElement, element)) element.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const element = root.current;
    return () => {
      const now = document.activeElement;
      const stranded = !now || now === document.body || insideOf(now, element);
      if (stranded && before instanceof HTMLElement && before !== document.body && before.isConnected) before.focus({ preventScroll: true });
    };
  }, [before]);
  return (
    <div
      ref={root}
      tabIndex={-1}
      className={`pair-shell nowheel nodrag nopan${isPairing ? ' is-pairing' : ''}${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
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
        {(pairing ? !pairing.readOnly : edit) && <ModeSwitch pairing={pairing} edit={edit} browse={browse} pairHint={pairHint} />}
        {controls && <div className="pair-controls">{controls}</div>}
        <button className="btn btn-small btn-quiet pair-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </header>
      {isPairing && (
        <div className="pair-band" role="status">
          <span className="pair-band-text" title={typeof pairBand === 'string' ? pairBand : undefined}>
            {pairBand}
          </span>
        </div>
      )}
      {pairing?.note && (
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
        {paired && isPairing && paired.pairing.requests.length > 0 && <PairingList pairing={paired.pairing} open={paired.open} onOpen={paired.onOpenRequest} />}
      </div>
      {foot}
    </div>
  );
}

// Browse (or Read), Edit for a piece people can edit, and "Pair with Claude ▾"
// for one that pairs: the last picks the agent. Leaving Edit saves what was
// typed; if it can't yet, Edit stays on and its band says why.
function ModeSwitch(props: { pairing?: Pairing; edit?: ShellEdit; browse: Browse; pairHint: string }) {
  const { pairing, edit, browse, pairHint } = props;
  const [picking, setPicking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setPicking(false), []);
  useDismiss(picking, close, root);
  const on = pairing?.mode === 'pair';
  const editing = Boolean(edit?.on);
  const reading = !on && !editing;
  const agent = pairing?.agent;
  const who = pairing?.who;
  const choice = pairing?.agents.find((a) => a.name === agent);
  const dot = pairing?.own ? (pairing.ownState === 'up' ? (choice?.state ?? 'listening') : 'asleep') : (choice?.state ?? 'away');
  const pair = (name?: string) => {
    if (!edit?.on) return pairing?.pair(name);
    void edit.stop().then((closed) => closed && pairing?.pair(name));
  };
  return (
    <div className="pair-modes" role="group" aria-label="Mode" ref={root}>
      <button
        type="button"
        className={`pair-mode${reading ? ' is-on' : ''}`}
        aria-pressed={reading}
        onClick={() => (edit?.on ? void edit.stop() : pairing?.browse())}
        title={browse.hint}
      >
        {browse.label}
      </button>
      {edit && (
        <button type="button" className={`pair-mode${editing ? ' is-on' : ''}`} aria-pressed={editing} onClick={() => !editing && edit.start()} title={edit.hint}>
          Edit
        </button>
      )}
      {pairing && (
        <span className={`pair-mode pair-mode-pair${on ? ' is-on' : ''}`}>
          <button type="button" className="pair-mode-main" aria-pressed={on} disabled={pairing.busy} onClick={() => pair()} title={who ? `${pairHint} ${pairingReach(pairing)}` : pairHint}>
            {who && <span className={`live-dot pair-dot live-${dot}`} aria-hidden />}
            {who ? `Pair with ${who}` : 'Pair'}
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
      )}
      {picking && pairing && (
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

// What to pair with: a session of its own first, where one can be had (theirs on this page again, else a new one
// Tricot's terminal starts); then the board's agents, with where each is now, the coordinator last, which stays free
// for the chat bar unless picked. The one picked is paired with.
function AgentPicker({ pairing, onPick }: { pairing: Pairing; onPick: (name: string) => void }) {
  const { agents, agent, fresh, own } = pairing;
  // Beside a session of its own, the agents on the board now: one that has gone isn't worth starting a pairing with.
  const here = fresh ? agents.filter((a) => a.state !== 'unseen' && a.name !== fresh.name) : agents;
  const listed = [...here.filter((a) => !a.coordinator), ...here.filter((a) => a.coordinator)];
  return (
    <div className="pair-picker" role="menu" aria-label="Pair with">
      {fresh && (
        <ul className="pair-picker-fresh">
          <li>
            <button type="button" role="menuitemradio" aria-checked={own} className="pair-picker-agent is-fresh" onClick={() => onPick(NEW_SESSION)}>
              <span className="pair-picker-new" aria-hidden>
                <Icon name="plus" />
              </span>
              <span className="pair-picker-what">
                <b>{fresh.name ?? `New ${fresh.by} session`}</b>
                <span className="muted small">{fresh.name ? 'Your session on this page, its thread kept' : 'Starts with your first request, for every piece on this page'}</span>
              </span>
              <span className="pair-picker-check" aria-hidden>
                {own && <Icon name="check" />}
              </span>
            </button>
          </li>
        </ul>
      )}
      {listed.length === 0 ? (
        !fresh && <p className="pair-picker-empty">No agent has been on this board yet. Connect one, and it shows here.</p>
      ) : (
        <ul>
          {listed.map((a) => (
            <li key={a.name}>
              <button type="button" role="menuitemradio" aria-checked={!own && a.name === agent} className="pair-picker-agent" onClick={() => onPick(a.name)}>
                <span className="pair-picker-name">
                  <ActorBadge actor={{ kind: 'agent', name: a.name }} />
                  {a.coordinator && <span className="pair-picker-role">coordinator</span>}
                </span>
                <span className={`live-state live-${a.state === 'unseen' ? 'away' : a.state}`}>
                  <span className="live-dot" />
                  {STATE_WORDS[a.state]}
                  {a.state === 'away' && a.lastSeen ? ` · ${timeAgo(a.lastSeen)}` : ''}
                </span>
                <span className="pair-picker-check" aria-hidden>
                  {!own && a.name === agent && <Icon name="check" />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="pair-picker-foot">
        {fresh ? 'A session of its own keeps the coordinator free, and works on this page alone. ' : ''}Your requests go straight to the agent you pick, and its steps show on each pin as it works.
      </p>
    </div>
  );
}
