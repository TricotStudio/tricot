import type { FormEvent, KeyboardEvent, RefObject } from 'react';
import { LISTEN_PHRASE, notListeningHere, sayTo } from '../core/delivery';
import { listNames } from '../core/format';
import { THREAD_TEXT_LIMIT } from '../core/threads';
import { listeningLabel } from './chatDoor';
import { Icon, timeAgo } from './components';
import { openConnect } from './delivery';
import { useAgents } from './looking';
import { MentionInput } from './mentions';
import { toolOf, useConnectedAgents, useInstalledAgents } from './wake';
import './chatBar.css';

// The chat bar: the one input people talk to agents through. It floats at
// the bottom centre of every tab of a board, its words following the tab,
// and becomes the reply box at the foot of the conversation docked on the
// right while that is open (threads.tsx owns which, and what sending does),
// so there is only ever one on screen. At its left end, floating, the
// threads button; at its right, who's listening and Send. Enter sends; @
// mentions an agent or a person, and / calls an agent's skill.

interface Props {
  docked: boolean; // at the foot of the docked conversation, rather than floating
  value: string;
  onValue: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  label: string; // the field's name, for screen readers
  sendLabel: string; // what Send does: "Send", "Start a thread", "Post as a question"
  busy?: boolean;
  field: RefObject<HTMLInputElement | null>;
  // The threads button, floating only: how many threads wait on you, and the list it opens.
  threads?: { count: number; open: boolean; onOpen: () => void; button?: RefObject<HTMLButtonElement | null> };
  error?: string | null;
}

export function ChatBar(props: Props) {
  const { docked, value, onValue, onSend, placeholder, label, sendLabel, busy, field, threads, error } = props;
  const ready = Boolean(value.trim()) && !busy;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onSend();
  };
  // Floating, Esc lets go of the bar, keeping what's typed; docked, it
  // closes the conversation (threads.tsx).
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && !docked) field.current?.blur();
  };
  return (
    <form className={`chat-bar${docked ? ' is-docked' : ''}`} onSubmit={submit} aria-label="Talk to agents">
      {threads && (
        <>
          <button
            type="button"
            ref={threads.button}
            className="chat-threads"
            onClick={threads.onOpen}
            aria-expanded={threads.open}
            aria-haspopup="dialog"
            aria-label={threads.count ? `Threads: ${threads.count} waiting on you` : 'Threads'}
            title={threads.count ? `${threads.count} thread${threads.count === 1 ? '' : 's'} waiting on you` : 'Threads'}
          >
            <Icon name="thread" />
            {threads.count > 0 && (
              <span className="chat-count" aria-hidden>
                {threads.count}
              </span>
            )}
          </button>
          <span className="chat-sep" aria-hidden />
        </>
      )}
      <MentionInput
        skills
        ref={field}
        className="chat-input"
        value={value}
        onValue={onValue}
        onKeyDown={onKeyDown}
        maxLength={THREAD_TEXT_LIMIT}
        placeholder={placeholder}
        aria-label={label}
      />
      <Listening quiet={docked} />
      <button type="submit" className={`chat-send${ready ? ' is-ready' : ''}`} disabled={!ready} aria-label={sendLabel} title={`${sendLabel} (Enter)`}>
        <Icon name="arrow-up" />
      </button>
      {error && (
        <p className="error chat-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// Who will hear what's sent: the agents on the board now, listening or
// between steps. With none, the bar says so plainly: an agent connected to
// Tricot isn't listening here (the line under a message says what to tell
// it, wake.tsx); with none connected at all, the way to connect one.
// Docked, the conversation says who answers, so only none is said.
function Listening({ quiet }: { quiet: boolean }) {
  const agents = useAgents();
  const here = agents.filter((a) => a.state !== 'away');
  const names = here.map((a) => a.name);
  if (names.length === 0) return <NotHere onBoard={agents.map((a) => a.name)} />;
  if (quiet) return null;
  const title = here
    .map((a) =>
      a.state === 'listening' ? `${a.name} is listening: it sees what you send right away` : `${a.name} is between steps: it sees what you send when it next checks the board`,
    )
    .join('\n');
  return (
    <span className="chat-who" title={title}>
      <span className="chat-who-dot" aria-hidden />
      <span className="chat-who-text">{listeningLabel(names)}</span>
    </span>
  );
}

// No agent on the board will hear it. Nothing for the moment it takes to
// read which agents are connected, so the words don't change under the person.
function NotHere({ onBoard }: { onBoard: string[] }) {
  const agents = useAgents();
  const connected = useConnectedAgents();
  const installed = useInstalledAgents();
  if (connected === undefined || installed === undefined) return null;
  const label = notListeningHere(onBoard, connected);
  if (label) {
    const agent = onBoard[0] ?? connected[0];
    const say = `${sayTo(agent, toolOf(agent, installed))} “${LISTEN_PHRASE}”.`;
    return (
      <span className="chat-who is-none" title={`${agent} isn't listening on this board, so what you send waits until it is. ${say}`}>
        <span className="chat-who-text">{label}</span>
      </span>
    );
  }
  const last = agents.length ? `${listNames(agents.map((a) => a.name))} last checked the board ${timeAgo(agents[0].lastSeen)}. ` : 'No agent is on this board right now. ';
  return (
    <span className="chat-who is-none" title={`${last}What you send waits in a thread until one connects; on Decisions it's posted as a question card.`}>
      <span className="chat-who-text">No agent listening</span>
      <button type="button" className="chat-connect" onClick={openConnect}>
        Connect one
      </button>
    </span>
  );
}
