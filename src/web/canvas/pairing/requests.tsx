// The side list of a pairing session: what the person has asked the agent
// while pairing, in order, each with its state. Working: what the agent is
// doing about it (its step on the pin, or where the request stands); done:
// it replied; waiting on you: it replied with something for the person.
// Clicking one opens its pin, wherever it is in the piece.

import { clip } from '../../../core/format';
import { requestCount, requestWords, type PairingRequest } from '../../../core/pairing';
import type { Pin } from '../../../core/types';
import { Icon } from '../../shared/components';
import { StepText } from '../../agents';
import { Stitch } from '../../shared/stitch';
import { usePinDelivery } from './pinLine';
import type { Pairing } from './session';

export function PairingList({ pairing, open, onOpen }: { pairing: Pairing; open?: string | null; onOpen: (pin: Pin) => void }) {
  const { requests, agent, session } = pairing;
  const who = agent ?? 'an agent';
  return (
    <aside className="pair-list" aria-label="Asked while pairing">
      <div className="pair-list-head">
        <h3>This session</h3>
        {requests.length > 0 && <span className="faint small">{requestCount(requests)}</span>}
      </div>
      {requests.length === 0 ? (
        <p className="pair-list-empty">
          {session || !agent
            ? `Point at any part and ask ${who}. What you ask shows here, with what ${who} is doing about it.`
            : `Starting a session with ${who}…`}
        </p>
      ) : (
        <ol className="pair-requests">
          {requests.map((request, i) => (
            <li key={request.pin.id}>
              <button type="button" className={`pair-request is-${request.state}${request.pin.id === open ? ' is-open' : ''}`} onClick={() => onOpen(request.pin)}>
                <span className="pair-request-n">{i + 1}</span>
                <span className="pair-request-main">
                  <span className="pair-request-text">{requestWords(request)}</span>
                  <span className="pair-request-part">{clip(request.pin.quote, 60)}</span>
                  <RequestState request={request} agent={who} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function RequestState({ request, agent }: { request: PairingRequest; agent: string }) {
  if (request.state === 'done') {
    return (
      <>
        <span className="pair-request-state is-done">
          <Icon name="check" /> Done
        </span>
        {request.reply && <span className="pair-request-reply">{clip(request.reply.body, 90)}</span>}
      </>
    );
  }
  if (request.state === 'waiting') {
    return (
      <>
        <span className="pair-request-state is-waiting">
          <span className="tag tag-waiting">Waiting on you</span>
        </span>
        {request.reply && <span className="pair-request-reply">{clip(request.reply.body, 90)}</span>}
      </>
    );
  }
  return <Working request={request} agent={agent} />;
}

// What the agent is doing about it: its step on the pin, or where it stands.
function Working({ request, agent }: { request: PairingRequest; agent: string }) {
  const live = usePinDelivery(request.pin);
  return (
    <span className="pair-request-state is-working">
      <Stitch state={live?.busy} />
      <StepText text={live?.words ?? `Sent to ${agent}`} />
    </span>
  );
}
