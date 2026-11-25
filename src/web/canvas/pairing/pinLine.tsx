// The live line under a request on its pin, in a piece's full view: what the
// agent it is for is doing about it, from what the page already holds
// (core/delivery.ts). While the agent's steps are on this card (or, on the
// board context or a Sketchbook page, on no card) since the request, its
// latest one: "Claude is on it · Editing index.html", with the "working on
// it" stitch. Without steps, where the request stands: "Seen by Claude",
// "Delivered · Claude is listening", or, to a pairing session of its own not
// up yet, "Starting Claude · Pair app.css in Tricot's terminal", or what holds
// it back there. It gives way
// once the agent replies, as the change lands.

import { useEffect, useState, type ReactNode } from 'react';
import { deliveryBusy, deliveryOf, deliveryTitle, inWindow, type BusyState, type Delivery, type Where } from '../../../core/delivery';
import { samePerson } from '../../../core/format';
import { pairedPlace } from '../../../core/homePairing';
import { pinLineWords } from '../../../core/pairing';
import { pinComments } from '../../../core/pins';
import { pairingThread } from '../../../core/roles';
import type { Comment, Pin } from '../../../core/types';
import { phaseOf, StepText, useAgents, useSteps } from '../../agents';
import { Stitch } from '../../shared/stitch';
import { ownedBy, useCanvas } from '../context';

const TICK_MS = 5_000; // a step going quiet, redrawn now and then

export interface PinDelivery {
  delivery: Delivery;
  words: string;
  busy?: BusyState;
  said: Comment;
}

// Where the latest person's message on a pin stands with the agents it is
// for, in words; nothing once it is answered, or long past.
export function usePinDelivery(pin: Pin): PinDelivery | undefined {
  const canvas = useCanvas();
  const agents = useAgents();
  const steps = useSteps();
  const [now, setNow] = useState(() => Date.now());
  const comments = pinComments(pin, ownedBy(canvas));
  const at = Math.max(now, Date.now());
  const index = comments.findLastIndex((c) => c.author.kind === 'human');
  const said = index >= 0 ? comments[index] : undefined;
  // A page's pin is on no card, as the board context's is. A pairing session of its own on the page has its steps, its
  // background agents' too, on its thread (server/steps.ts): they show here as its steps on the page.
  const where = (canvas.owner ? { [canvas.owner.kind]: canvas.owner.card } : { boardContext: true }) as Where;
  const page = canvas.owner ? undefined : pairedPlace(canvas.board, pin.blockId);
  const sessions = new Set(page ? (canvas.board.threads ?? []).filter((t) => pairingThread(t) && t.pageId === page.pageId).map((t) => t.id) : []);
  const showing = steps.filter((s) => phaseOf(s, at) || s.done).map((s) => (s.thread && sessions.has(s.thread) ? { ...s, thread: undefined } : s));
  const delivery =
    said && !canvas.readOnly && inWindow({ at: said.createdAt }, at)
      ? deliveryOf({
          board: canvas.board,
          where,
          said: { id: said.id, author: said.author, at: said.createdAt, mentions: said.mentions, reactions: said.reactions, held: said.held, paired: said.paired },
          after: comments.slice(index + 1),
          agents,
          steps: showing,
        })
      : undefined;
  // A request to a pairing session of its own whose agent Tricot's terminal is starting (core/roles.ts) waits for it.
  const place = said && delivery?.state === 'waiting' ? pairedPlace(canvas.board, pin.blockId) : undefined;
  const session = place ? canvas.board.threads?.find((t) => t.status === 'working' && pairingThread(t) && t.pageId === place.pageId && said!.mentions?.some((m) => samePerson(m, t.owner!))) : undefined;
  // One the terminal holds back says why (core/roles.ts HeldLaunch).
  const held = session && agents.flatMap((a) => a.holds ?? []).find((h) => h.thread === session.id);
  const words = session
    ? held
      ? `${session.owner} waits for ${held.why === 'full' ? 'a free tab' : 'a pairing session to finish'} in Tricot's terminal`
      : `Starting ${session.owner} in Tricot's terminal`
    : delivery && pinLineWords(delivery, at);
  useEffect(() => {
    if (!words) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [Boolean(words)]);
  if (!delivery || !words || !said) return undefined;
  return { delivery, words, said, busy: deliveryBusy(delivery, (step) => phaseOf(step, at) === 'live') };
}

// The line itself, or `fallback` while it has nothing to say. Under a note,
// which asks no agent anything (no request, no @-mention), nothing: a note
// just stays on its part.
export function PinLine({ pin, fallback = null }: { pin: Pin; fallback?: ReactNode }) {
  const canvas = useCanvas();
  const live = usePinDelivery(pin);
  const latest = pinComments(pin, ownedBy(canvas)).findLast((c) => c.author.kind === 'human');
  if (latest && !latest.ask && !latest.mentions?.length) return null;
  if (!live) return <>{fallback}</>;
  const { delivery, words, busy, said } = live;
  const working = delivery.state === 'working';
  return (
    <p className={`delivery pin-live is-${delivery.state}`} title={deliveryTitle(words, { at: said.createdAt }, Date.now())}>
      <span key={words} className="delivery-text" aria-hidden>
        <StepText text={words} />
      </span>
      <Stitch state={busy} />
      <span className="delivery-sr" role="status">
        {working ? `${delivery.agent} is working on it` : words}
      </span>
    </p>
  );
}
