// The live line under a request on its pin, in a piece's full view: what the
// agent it is for is doing about it, from what the page already holds
// (core/delivery.ts). While the agent's steps are on this card (or, on the
// board context, on no card) since the request, its latest one: "Claude is on
// it · Editing index.html", with the "working on it" stitch. Without steps,
// where the request stands: "Seen by Claude", "Delivered · Claude is
// listening". It gives way once the agent replies, as the change lands.

import { useEffect, useState, type ReactNode } from 'react';
import { deliveryBusy, deliveryOf, deliveryTitle, inWindow, type BusyState, type Delivery, type Where } from '../../../core/delivery';
import { pinLineWords } from '../../../core/pairing';
import { pinComments } from '../../../core/pins';
import type { Comment, Pin } from '../../../core/types';
import { phaseOf, StepText, useAgents, useSteps } from '../../agents';
import { Stitch } from '../../shared/stitch';
import { useCanvas } from '../context';

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
  const comments = pinComments(pin, { task: canvas.task, decision: canvas.decision });
  const at = Math.max(now, Date.now());
  const index = comments.findLastIndex((c) => c.author.kind === 'human');
  const said = index >= 0 ? comments[index] : undefined;
  const where: Where = canvas.task ? { task: canvas.task } : canvas.decision ? { decision: canvas.decision } : { boardContext: true };
  const showing = steps.filter((s) => phaseOf(s, at) || s.done);
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
  const words = delivery && pinLineWords(delivery, at);
  useEffect(() => {
    if (!words) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [Boolean(words)]);
  if (!delivery || !words || !said) return undefined;
  return { delivery, words, said, busy: deliveryBusy(delivery, (step) => phaseOf(step, at) === 'live') };
}

// The line itself, or `fallback` while it has nothing to say.
export function PinLine({ pin, fallback = null }: { pin: Pin; fallback?: ReactNode }) {
  const live = usePinDelivery(pin);
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
