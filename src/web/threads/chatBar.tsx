import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { LISTEN_PHRASE, notListeningHere, sayTo } from '../../core/delivery';
import { ApprovalChip } from '../access';
import { listNames, samePerson } from '../../core/format';
import { reachedByAny } from '../../core/liveAgents';
import { splitLensCommand } from '../../core/lensCommand';
import { THREAD_TEXT_LIMIT } from '../../core/threads';
import { listeningLabel } from './chatDoor';
import { Icon, timeAgo, type IconName } from '../shared/components';
import { openConnect, toolOf, useConnectedAgents, useInstalledAgents } from '../conversation';
import { useAgents } from '../agents';
import { DrawOptions, DrawToolbar, useDrawTools } from '../canvas';
import { useCardKinds } from '../shared/cardKindsContext';
import { MentionInput, type LensChoice } from '../shared/mentions';
import './chatBar.css';

// The chat bar: the one input people talk to agents through. It floats at
// the bottom centre of every tab of a board, its words following the tab,
// and becomes the reply box at the foot of the conversation docked on the
// right while that is open (threads.tsx owns which, and what sending does),
// so there is only ever one on screen. At its left end, floating, the
// threads button; at its right, who's listening and Send. Enter sends; @
// mentions an agent or a person, / calls an agent's skill, and ^ asks for a
// lens on that one message (^Design), which is left out of what is sent.
// Floating, a canvas's drawing tools sit beside it on its left (ToolsCapsule),
// whichever view draws it: the dock's bar, or a view's own (Home's). The
// threads button is the dock's bar's alone (Home has its own ball of yarn),
// and comes and goes in motion with the view too (ThreadsButton).

interface ThreadsOpener {
  count: number;
  open: boolean;
  onOpen: () => void;
  button?: RefObject<HTMLButtonElement | null>;
}

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
  lenses?: readonly LensChoice[]; // what ^ offers; none where a message has no lens to ask for
  // The threads button, floating only: how many threads wait on you, and the list it opens.
  threads?: ThreadsOpener;
  // What goes with what's sent, as a chip before the field: blocks selected
  // on a Sketchbook page ("2 blocks"), its ✕ letting go of them; or, on a
  // board's Home, the thread the bar is aimed at (timeline.tsx), its ✕
  // putting the thread down.
  context?: { label: string; title: string; onRemove: () => void; icon?: IconName; remove?: { label: string; title: string } };
  replying?: boolean; // answers in a thread that exists, not a new message: it reaches every agent on the board, not only the coordinator
  to?: string; // answers one agent (a pairing's, on Home): it reaches that agent alone
  error?: string | null;
}

export function ChatBar(props: Props) {
  const { docked, value, onValue, onSend, placeholder, label, sendLabel, busy, field, lenses, threads, context, replying = false, to, error } = props;
  // A ^Lens alone says nothing to send.
  const said = lenses ? splitLensCommand(value, lenses.map((l) => l.name)).body : value.trim();
  const ready = Boolean(said) && !busy;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onSend();
  };
  // Floating, Esc lets go of the bar, keeping what's typed; docked, it
  // closes the conversation (threads.tsx).
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && !docked) field.current?.blur();
  };
  const bar = (
    <form className={`chat-bar${docked ? ' is-docked' : ''}`} onSubmit={submit} aria-label="Talk to agents">
      {!docked && <ThreadsButton threads={threads} />}
      {context && (
        <span className="chat-context" title={context.title}>
          <Icon name={context.icon ?? 'group'} />
          <span className="chat-context-label">{context.label}</span>
          <button type="button" className="chat-context-remove" onClick={context.onRemove} aria-label={context.remove?.label ?? `Leave out ${context.label}`} title={context.remove?.title ?? 'Leave them out (deselects them)'}>
            <Icon name="x" />
          </button>
        </span>
      )}
      <MentionInput
        skills
        lenses={lenses}
        ref={field}
        className="chat-input"
        value={value}
        onValue={onValue}
        onKeyDown={onKeyDown}
        maxLength={THREAD_TEXT_LIMIT}
        placeholder={placeholder}
        aria-label={label}
      />
      <ApprovalChip />
      <Listening quiet={docked} replying={replying} to={to} />
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
  return (
    <>
      {!docked && <ToolsCapsule />}
      {bar}
    </>
  );
}

// The floating bar on screen as it was last drawn: how many are (one, or two
// for the moment a view switch has made a bar while the one going is still
// there), whether its drawing tools and its threads button were shown, and
// how many threads that button said wait on you. A bar a view switch makes
// takes over from the bar going, as that one had them, so moving between
// views leaves the bar where it is and what changes on it moves.
const onScreen = { bars: 0, tools: 0, threads: 0, waiting: 0 };

// Whether the floating bar on screen, as last drawn, shows its threads
// button. Read as a view is drawn, before the page changes: Home, made as a
// view switch takes that bar away, has its ball of yarn settle in at the top
// of its yarn as the button folds into Home's own bar (timeline.tsx), a quiet
// handoff, nothing crossing the screen.
export function threadsButtonOnScreen(): boolean {
  return onScreen.bars > 0 && onScreen.threads > 0;
}

// The threads button at the floating bar's left end, a small ball of yarn
// with how many threads wait on you, and the rule after it. The dock's bar
// has it on every view; a view that draws a bar of its own has none (Home,
// whose ball of yarn tops its yarn). Every floating bar keeps its place, shut
// where it has no button, so it comes and goes in motion with the view
// (chatBar.css), as the drawing tools do: the bar a view switch makes is
// drawn first as the bar going was, then as it is. Going, the button shows
// what the bar going's said, inert, and is gone once its going has played.
// A bar made with no floating bar on screen (the page opening, the bar coming
// back from the docked conversation, whose move carries it) is drawn as it
// is at once.
function ThreadsButton({ threads }: { threads?: ThreadsOpener }) {
  // How the floating bar going had it, when a view switch made this one.
  const [before, setBefore] = useState(() => (onScreen.bars > 0 ? { shown: onScreen.threads > 0, waiting: onScreen.waiting } : undefined));
  const shown = before ? before.shown : Boolean(threads);
  const [seen, setSeen] = useState(shown);
  const [said] = useState(() => before?.waiting ?? 0); // what a button going says as it goes
  const waiting = threads ? threads.count : said;
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    onScreen.bars++;
    return () => {
      onScreen.bars--;
    };
  }, []);
  useLayoutEffect(() => {
    if (!shown) return;
    onScreen.threads++;
    onScreen.waiting = waiting;
    return () => {
      onScreen.threads--;
    };
  }, [shown, waiting]);
  // Styled once as the bar going was, then as this one is: what changes moves.
  useLayoutEffect(() => {
    if (!before) return;
    slot.current?.getBoundingClientRect();
    setBefore(undefined);
  }, []);
  useEffect(() => {
    if (shown) setSeen(true);
  }, [shown]);
  // Gone, once its going has played (at once with reduced motion), or was cut
  // short, so a bar with no button of its own keeps none.
  useLayoutEffect(() => {
    if (threads || shown || !seen || !slot.current) return;
    let here = true;
    const gone = () => here && setSeen(false);
    Promise.all(slot.current.getAnimations({ subtree: true }).map((a) => a.finished)).then(gone, gone);
    return () => {
      here = false;
    };
  }, [threads, shown, seen]);
  return (
    <span ref={slot} className={`chat-ball${shown ? ' is-shown' : seen ? ' was-shown' : ''}`} inert={!threads}>
      {(threads || seen) && (
        <span className="chat-ball-in">
          <button
            type="button"
            ref={threads?.button}
            className="chat-threads"
            onClick={threads?.onOpen}
            aria-expanded={threads?.open}
            aria-haspopup="dialog"
            aria-label={waiting ? `Threads: ${waiting} waiting on you` : 'Threads'}
            title={waiting ? `${waiting} thread${waiting === 1 ? '' : 's'} waiting on you` : 'Threads'}
          >
            <Icon name="thread" />
            {waiting > 0 && (
              <span className="chat-count" aria-hidden>
                {waiting}
              </span>
            )}
          </button>
          <span className="chat-sep" aria-hidden />
        </span>
      )}
    </span>
  );
}

// Floating over a canvas that can be drawn on, its drawing tools float beside
// the bar in a capsule of their own on its left, the options of the tool that
// is on in a tray over it (canvas/tools: DrawToolbar, DrawOptions). Every
// floating bar has it, drawn while the bar is: shown while such a canvas is
// (drawTools.ts `present`), hidden and inert while none is, so it comes and
// goes in motion (chatBar.css).
//
// Moving between views leaves the bar where it is, though a view may draw a
// bar of its own (Home): the capsule of the bar a view switch makes takes
// over from the capsule of the bar going, shown if that one was, so it leaves
// from there as it would have, whatever view comes next. It leaves in motion
// (`was-shown`) only once it has been on screen shown: a bar that opens away
// from a canvas plays no leaving, the dock closing over Files included, and
// nor does one made as a canvas goes while the bar was docked in the
// conversation, as no capsule was shown then.
function ToolsCapsule() {
  const drawable = useDrawTools().present;
  // Made while a shown one is on screen, going: it takes over from it, shown.
  const [carried, setCarried] = useState(() => onScreen.tools > 0);
  const [seen, setSeen] = useState(carried);
  const shown = drawable || carried;
  const capsule = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!shown) return;
    onScreen.tools++;
    return () => {
      onScreen.tools--;
    };
  }, [shown]);
  // Styled once as it is made, before it changes: what it does next, coming
  // in or leaving, moves from how it is now rather than from nothing.
  useLayoutEffect(() => {
    capsule.current?.getBoundingClientRect();
    setCarried(false);
  }, []);
  // Seen once a frame is drawn with it shown. Made as a canvas goes, it is
  // drawn shown only until the change lets go of that canvas, before any
  // frame, so it has no leaving to play.
  useEffect(() => {
    if (!drawable) return;
    const frame = requestAnimationFrame(() => setSeen(true));
    return () => cancelAnimationFrame(frame);
  }, [drawable]);
  return (
    <div ref={capsule} className={`chat-tools${shown ? ' is-shown' : seen ? ' was-shown' : ''}`} inert={!drawable}>
      <div className="chat-tools-sheet">
        <DrawToolbar />
      </div>
      <DrawOptions />
    </div>
  );
}

// Who will hear what's sent: the agents on the board now that a message for
// any agent reaches when it starts a thread (core/liveAgents.ts reachedByAny:
// its coordinator, else every agent), listening or between steps, by name, or how many
// when there are more than two. A bar that answers in a thread (`replying`) names
// every agent on the board, as before; one that answers an agent (`to`, a pairing's) names
// that agent alone. With none, the bar says so plainly: an agent
// connected to Tricot isn't listening here (the line under a message says what
// to tell it, wake.tsx); with none connected at all, the way to connect one.
// Docked, the conversation says who answers, so only none is said.
function Listening({ quiet, replying, to }: { quiet: boolean; replying: boolean; to?: string }) {
  const agents = useAgents();
  const here = to ? agents.filter((a) => a.state !== 'away' && samePerson(a.name, to)) : replying ? agents.filter((a) => a.state !== 'away') : reachedByAny(agents);
  const names = here.map((a) => a.name);
  if (names.length === 0) return <NotHere onBoard={to ? [to] : agents.map((a) => a.name)} />;
  if (quiet) return null;
  const title = here
    .map((a) =>
      a.state === 'listening'
        ? `${a.name} is listening: it sees what you send right away`
        : a.state === 'asleep'
          ? `${a.name} is asleep: Tricot wakes it for what you send`
          : `${a.name} is between steps: it sees what you send when it next checks the board`,
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
  const note = useCardKinds().question()?.note;
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
    <span className="chat-who is-none" title={`${last}What you send waits in a thread until one connects${note ? `; ${note}` : ''}.`}>
      <span className="chat-who-text">No agent listening</span>
      <button type="button" className="chat-connect" onClick={openConnect}>
        Connect one
      </button>
    </span>
  );
}
