import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { deliveryBusy, deliveryOf, deliveryTitle, deliveryWords, inWindow, leavesWithReply, toWake, wakeLead, wakeWords, type BusyState, type Delivery, type Said, type Where } from '../core/delivery';
import type { Actor, Board } from '../core/types';
import { useReadOnly } from './hooks';
import { useAgents } from './looking';
import { Stitch, STITCH_EXIT_MS } from './stitch';
import { outbox, type Outgoing } from './outbox';
import { phaseOf, StepText, useSteps } from './steps';
import { SayToListen, toolOf, useConnectedAgents, useInstalledAgents } from './wake';
import './delivery.css';

// One quiet row under a person's latest message to agents, so they never
// stare at a silent card (core/delivery.ts): "Sending…", then "Delivered ·
// Claude is listening" or "Waiting for Claude · last seen 4 min ago", "Seen by
// Claude", "Claude · Running npm test", with the "working on it" stitch
// (stitch.tsx): none while it is only delivered; cast on as the agent sees
// it, then knitting on through its steps; resting once it sets the message
// down or goes quiet. How long ago it was asked is in the tooltip. The reply
// takes its place: the stitch unravels and the line goes. While no agent on
// the board will see it, the line names the agent to tell and what to say:
// "Claude isn't listening yet. In Claude Code, say: “Start listening on
// Tricot”", with Copy (wake.tsx). A message the server refused says so, with Retry. It shares its row with the message's
// reactions, so an agent's 👀 arriving doesn't move anything, and its words
// change in place.

interface Props {
  board: Board;
  where: Where;
  said: Said;
  after: { author: Actor }[]; // what came after it in the same discussion
  onItsWay?: 'sending' | 'failed';
  outgoing?: Outgoing;
  onEdit?: (body: string) => void; // a message not sent goes back to the reply box
  onConnect?: () => void; // before the connect panel opens: e.g. the threads panel closes
  children?: ReactNode; // the message's reactions
}

// Nothing on the line counts seconds: it is redrawn now and then for a step
// going quiet or an agent last seen longer ago, and when the pointer comes,
// so its tooltip says how long ago it was asked as of then.
const TICK_MS = 5_000;

export function MessageFoot({ board, where, said, after, onItsWay, outgoing, onEdit, onConnect, children }: Props) {
  const readOnly = useReadOnly();
  const agents = useAgents();
  const steps = useSteps();
  const [now, setNow] = useState(() => Date.now());
  const at = Math.max(now, Date.now());
  // The steps that show, and a turn's end for as long as the board holds it
  // (it says an agent set the message down, though its line has gone).
  const showing = steps.filter((s) => phaseOf(s, at) || s.done);
  const delivery = onItsWay || readOnly || !inWindow(said, at) ? undefined : deliveryOf({ board, where, said, after, agents, steps: showing });
  const words = delivery && deliveryWords(delivery, at);
  const ticking = Boolean(words);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  const shown: Shown | undefined =
    delivery && words ? { delivery, words, title: deliveryTitle(words, said, at), busy: deliveryBusy(delivery, (step) => phaseOf(step, at) === 'live') } : undefined;

  // When the reply lands, the line as it was stays a moment, for its stitch's
  // exit: the line last drawn is kept for it after each render. Before the
  // page paints, so the line never blinks out first.
  const last = useRef<Shown | undefined>(undefined);
  const [leaving, setLeaving] = useState<Shown | undefined>(undefined);
  const replied = delivery?.state === 'replied';
  useLayoutEffect(() => {
    const before = last.current;
    if (!replied || !before || !leavesWithReply(before.busy, delivery)) return;
    setLeaving(before);
    const timer = setTimeout(() => setLeaving(undefined), STITCH_EXIT_MS);
    return () => {
      clearTimeout(timer);
      setLeaving(undefined);
    };
  }, [replied]); // only as the reply lands
  useLayoutEffect(() => {
    last.current = shown;
  });

  let line: ReactNode = null;
  if (onItsWay === 'failed' && outgoing) {
    line = (
      <p className="delivery is-failed" role="alert" title={outgoing.error}>
        <span className="delivery-text">Not sent{outgoing.error ? `: ${outgoing.error}` : ''}</span>
        <button type="button" className="delivery-action" onClick={() => outbox.retry(outgoing.key)}>
          Retry
        </button>
        {onEdit && (
          <button
            type="button"
            className="delivery-action"
            onClick={() => {
              outbox.remove(outgoing.key);
              onEdit(outgoing.body);
            }}
          >
            Edit
          </button>
        )}
      </p>
    );
  } else if (onItsWay === 'sending') {
    line = (
      <p className="delivery is-sending">
        <span className="delivery-text">Sending…</span>
        <span className="delivery-sr" role="status">
          Sending
        </span>
      </p>
    );
  } else if (shown) {
    const hover = () => setNow(Date.now());
    line =
      shown.delivery.state === 'nobody' || shown.delivery.state === 'waiting' ? (
        <Unheard shown={shown} said={said} at={at} onHover={hover} onConnect={onConnect} />
      ) : (
        <Line shown={shown} onHover={hover} onConnect={onConnect} />
      );
  } else if (leaving && replied) {
    line = <Line shown={leaving} leaving />;
  }
  if (!line) return <>{children}</>;
  return (
    <div className="said-foot">
      {children}
      {line}
    </div>
  );
}

// The line as drawn: its words, its tooltip, and its stitch, if any.
interface Shown {
  delivery: Delivery;
  words: string;
  title: string;
  busy?: BusyState;
}

function Line({ shown: { delivery, words, title, busy }, leaving = false, onHover, onConnect }: { shown: Shown; leaving?: boolean; onHover?: () => void; onConnect?: () => void }) {
  const working = delivery.state === 'working';
  return (
    <p className={`delivery is-${delivery.state}${leaving ? ' is-leaving' : ''}`} title={title} onPointerEnter={onHover}>
      {/* A new state, or a new step, fades in where the last one was. */}
      <span key={words} className="delivery-text" aria-hidden>
        <StepText text={words} />
      </span>
      {/* Not keyed by the words, and here in every state: it casts on as
          the agent sees the message and knits on through each new step. */}
      <Stitch state={busy} leaving={leaving} />
      {delivery.state === 'nobody' && (
        <button
          type="button"
          className="delivery-action"
          onClick={() => {
            onConnect?.();
            openConnect();
          }}
        >
          Connect one
        </button>
      )}
      {/* Read out once per state, not with each step. */}
      <span className="delivery-sr" role="status">
        {working ? `${delivery.agent} is working on it` : words}
      </span>
    </p>
  );
}

// Nobody on the board has it: the agent to tell, and what to say so it
// listens, with Copy (wake.tsx), until an agent on the board picks it up.
// With no agent to name, the line as it was ("Connect one"). Nothing for the
// moment it takes to read which agents are connected, so the words don't
// change under the person.
function Unheard({ shown, said, at, onHover, onConnect }: { shown: Shown; said: Said; at: number; onHover: () => void; onConnect?: () => void }) {
  const connected = useConnectedAgents();
  const installed = useInstalledAgents();
  if (connected === undefined || installed === undefined) return null;
  const agent = toWake(shown.delivery, connected);
  if (!agent) return <Line shown={shown} onHover={onHover} onConnect={onConnect} />;
  const tool = toolOf(agent, installed);
  const words = wakeWords(agent, tool, shown.delivery);
  return (
    <p className="delivery is-unheard" title={deliveryTitle(words, said, at)} onPointerEnter={onHover}>
      <span aria-hidden>{wakeLead(agent, shown.delivery)}</span> <SayToListen agent={agent} tool={tool} quiet />
      <span className="delivery-sr" role="status">
        {words}
      </span>
    </p>
  );
}

// The board's Connect an agent panel, in its header (BoardView.tsx).
export function openConnect(): void {
  const details = document.querySelector<HTMLDetailsElement>('details.connect-popover');
  if (!details) return;
  details.open = true;
  details.querySelector<HTMLElement>('summary')?.focus();
}
