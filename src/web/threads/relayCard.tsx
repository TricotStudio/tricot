import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { answeredWords, earlierWords, firstLine, ownName, relayStack, relayWords, verdictWords } from '../../core/homeConversation';
import type { Board } from '../../core/types';
import { Icon } from '../shared/components';
import { useReadOnly } from '../shared/hooks';
import { CommentText } from '../shared/mentions';
import type { Relay } from './relays';
import { ReviewAnswer, reviewedWork, useReview, type Review } from './review';
import { WorkCards } from './threadWork';

// A relay in Home's conversation (relays.ts, timeline.tsx): a card from a
// thread, never the coordinator speaking, so it has no author's badge and is
// led by its thread's name, which opens the thread. Its edge is in the colour
// of where its thread stands now (styles/base.css `--status-*`), and the
// thread's strand stitches into it on the yarn (`data-yarn-relay`, yarn.tsx).
// Its size follows how much it needs the viewer: a question in full, with
// Reply, which aims the conversation's bar at its thread for one message; work
// waiting for their review in full too, its owner's summary with the previews
// of what it made and the review's answer (review.tsx), whose note rings the
// card while it is written; a card blocked in two lines; something done in
// one. A thread's latest word (a reply) in up to three lines, fading where
// the thread holds more, with Reply too, though it needs nothing of the viewer;
// and so is an agent's latest word in a pairing, led by the piece it was on
// and where that is, whose Reply answers on its pin and whose Open opens the
// piece's full view there. A pairing with a session of its own is stitched
// to that session's strand; one with an agent of the board's has none.
// Answered, a question or a reply folds to a line of who answered and what
// they said, and a review to the verdict.
// What came in while the viewer was away comes as one card (`RelayStack`),
// what needs them first, each row as a relay is. What each says, and how
// the stack groups them, are Home's conversation's (core/homeConversation.ts),
// which the terminal's chat says too.

const TONES: Record<Relay['tone'], [string, string]> = {
  working: ['var(--status-in-progress)', 'var(--status-in-progress-ink)'],
  waiting: ['var(--status-in-review)', 'var(--status-in-review-ink)'],
  review: ['var(--status-in-review)', 'var(--status-in-review-ink)'],
  todo: ['var(--status-to-do)', 'var(--status-to-do-ink)'],
  done: ['var(--status-done)', 'var(--status-done-ink)'],
  blocked: ['var(--status-blocked)', 'var(--status-blocked-ink)'],
};
export const toneOf = (tone: Relay['tone']): CSSProperties => ({ '--tone': TONES[tone][0], '--ink': TONES[tone][1] }) as CSSProperties;

// What it says of where it stands, after its name.
function Kind({ relay }: { relay: Relay }) {
  if (relay.kind === 'blocked')
    return (
      <span className="relay-kind is-blocked">
        <Icon name="blocked" />
        Blocked
      </span>
    );
  return (
    <span className="relay-kind">
      <span className="work-square" aria-hidden />
      {relayWords(relay)}
    </span>
  );
}

// "You answered: …", or who did; for a review, "You approved it" or "You sent it back: “…”".
function Answered({ relay, name }: { relay: Relay; name: string }) {
  const sentBack = relay.verdict?.kind === 'changes';
  return (
    <span className={`relay-answer${sentBack ? ' is-sent-back' : ''}`}>
      <Icon name={sentBack ? 'reply' : 'check'} />
      <span>{(relay.kind === 'review' && verdictWords(relay, name)) || answeredWords(relay, name)}</span>
    </span>
  );
}

// Where a relay stands, as it is drawn: a question asking or answered, a review waiting or answered, a reply or a reply
// answered, or its kind.
type State = 'asking' | 'answered' | 'reviewing' | 'replied' | 'blocked' | 'done';
function stateOf(relay: Relay): State {
  if (relay.kind === 'question') return relay.needsYou ? 'asking' : 'answered';
  if (relay.kind === 'reply') return relay.answer ? 'answered' : 'replied';
  if (relay.kind === 'review') return relay.verdict ? 'answered' : 'reviewing';
  return relay.kind;
}

interface Props {
  board: Board;
  relay: Relay;
  name: string;
  clock: (iso: string) => string;
  aimed: boolean; // the bar answers into its thread
  onReply: (relay: Relay) => void; // aims the bar at its thread, or lets go when it is aimed
  onLight: (thread: string | null) => void;
}

// The strand a relay is stitched to: its thread's, or a pairing session's of its own (core/roles.ts).
const strandOf = (relay: Relay): string | undefined => relay.thread?.id ?? relay.pairing?.thread;

// What a relay's name opens, said in its tooltip.
const opensWords = (relay: Relay): string =>
  relay.pairing ? `Open ${relay.pairing.file ?? relay.title} at ${relay.pairing.part}, pairing with ${ownName(relay.by ?? 'its agent')} again` : relay.thread ? `Open “${relay.title}” here` : `Open ${relay.label ?? relay.title}`;

// The way to where a relay was said: its thread, or a pairing's piece.
const openLabel = (relay: Relay): string => (relay.pairing ? 'Open' : 'Open thread');

// Its thread's name (or its pairing's piece), which opens it, where it stands and when it was said.
function Head({ relay, clock }: { relay: Relay; clock: (iso: string) => string }) {
  return (
    <div className="relay-head">
      <Icon name={relay.pairing ? (relay.icon ?? 'canvas') : 'thread'} />
      <button type="button" className="relay-thread" onClick={relay.open} title={opensWords(relay)}>
        {relay.label && <span className="relay-label">{relay.label}</span>}
        {relay.title}
      </button>
      <Kind relay={relay} />
      <time className="relay-time" dateTime={relay.at}>
        {clock(relay.at)}
      </time>
    </div>
  );
}

export function RelayCard(props: Props) {
  const { relay, name, clock, aimed, onReply, onLight } = props;
  const state = stateOf(relay);
  if (state === 'reviewing') return <ReviewCard {...props} />;
  if (state === 'replied') return <ReplyCard {...props} />;
  const strand = strandOf(relay);
  const stitched = strand && relay.kind !== 'done' ? { 'data-yarn-relay': strand } : {};
  const light = strand ? { onPointerEnter: () => onLight(strand), onPointerLeave: () => onLight(null) } : {};
  return (
    <li className="relay" data-at={relay.at}>
      <div className={`relay-card is-${state}${relay.pairing ? ' is-pairing' : ''}${aimed ? ' is-aimed' : ''}`} style={toneOf(relay.tone)} {...stitched} {...light}>
        <Head relay={relay} clock={clock} />
        {state === 'asking' ? (
          <>
            <div className="relay-body">
              <CommentText comment={{ body: relay.body, mentions: relay.thread?.messages.find((m) => m.id === relay.key)?.mentions }} />
            </div>
            <div className="relay-actions">
              <ReplyButton relay={relay} aimed={aimed} onReply={onReply} />
              <button type="button" className="relay-btn is-quiet" onClick={relay.open}>
                Open thread <Icon name="arrow-right" />
              </button>
              {aimed && <AimedHint relay={relay} />}
            </div>
          </>
        ) : (
          <div className="relay-line">
            {state === 'answered' ? <Answered relay={relay} name={name} /> : <span className="relay-text">{firstLine(relay.body)}</span>}
            <button type="button" className="relay-btn is-quiet" onClick={relay.open} title={opensWords(relay)}>
              {state === 'answered' ? openLabel(relay) : 'See it'} <Icon name="arrow-right" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

// Work waiting for the viewer's review, in full: its owner's summary, what it made (the previews a thread shows under
// its messages, threadWork.tsx) and the answer. Needs changes opens the note in the card, which rings it as a relay
// being answered is.
function ReviewCard({ board, relay, name, clock, onLight }: Props) {
  const review = useReview(relay.thread!, name);
  return (
    <li className="relay" data-at={relay.at}>
      <div
        className={`relay-card is-reviewing${review.noting ? ' is-noting' : ''}`}
        style={toneOf(relay.tone)}
        data-yarn-relay={relay.thread!.id}
        onPointerEnter={() => onLight(relay.thread!.id)}
        onPointerLeave={() => onLight(null)}
      >
        <Head relay={relay} clock={clock} />
        <ReviewBody board={board} relay={relay} review={review} />
      </div>
    </li>
  );
}

// The summary in full, what changed and the answer; read-only, the way to the thread alone.
function ReviewBody({ board, relay, review }: { board: Board; relay: Relay; review: Review }) {
  const readOnly = useReadOnly();
  const made = reviewedWork(relay.thread!, relay.key);
  const open = (
    <button type="button" className="relay-btn is-quiet" onClick={relay.open}>
      Open thread <Icon name="arrow-right" />
    </button>
  );
  return (
    <>
      <div className="relay-body">
        <CommentText comment={{ body: relay.body, mentions: relay.thread?.messages.find((m) => m.id === relay.key)?.mentions }} />
      </div>
      {made.length > 0 && (
        <div className="relay-made">
          <p className="relay-made-head">What changed</p>
          <WorkCards board={board} refs={made} onOpen={noop} />
        </div>
      )}
      {readOnly ? (
        <div className="relay-actions">{open}</div>
      ) : (
        <ReviewAnswer review={review} hint>
          {open}
        </ReviewAnswer>
      )}
    </>
  );
}

// A thread's latest word, which needs nothing of the viewer: up to three lines of it, the last fading where the thread
// holds more, with Reply, as a question has, the way to the thread, and how many of its owner's words before it stay
// there.
function ReplyCard({ relay, clock, aimed, onReply, onLight }: Props) {
  const thread = relay.thread;
  const strand = strandOf(relay);
  const body = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false); // longer than its three lines
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [relay.body]);
  const earlier = relay.earlier ?? 0;
  return (
    <li className="relay" data-at={relay.at}>
      <div
        className={`relay-card is-replied${relay.pairing ? ' is-pairing' : ''}${aimed ? ' is-aimed' : ''}`}
        style={toneOf(relay.tone)}
        {...(strand && { 'data-yarn-relay': strand, onPointerEnter: () => onLight(strand), onPointerLeave: () => onLight(null) })}
      >
        <Head relay={relay} clock={clock} />
        <div ref={body} className={`relay-body is-short${cut ? ' is-cut' : ''}`}>
          <CommentText comment={{ body: relay.body, mentions: relay.mentions ?? thread?.messages.find((m) => m.id === relay.key)?.mentions }} />
        </div>
        <div className="relay-actions">
          <ReplyButton relay={relay} aimed={aimed} onReply={onReply} />
          <button type="button" className="relay-btn is-quiet" onClick={relay.open} title={opensWords(relay)}>
            {openLabel(relay)} <Icon name="arrow-right" />
          </button>
          {aimed ? (
            <AimedHint relay={relay} />
          ) : (
            earlier > 0 && (
              <button type="button" className="relay-earlier" onClick={relay.open} title={`Read what ${ownName(relay.by ?? 'its agent')} said before this ${relay.pairing ? `on ${relay.pairing.part}` : `in “${relay.title}”`}`}>
                {earlierWords(relay)}
              </button>
            )
          )}
        </div>
      </div>
    </li>
  );
}

// Under a relay the bar answers: where what is typed goes, and how to let go. A pairing's goes to its agent, on its pin.
function AimedHint({ relay }: { relay: Relay }) {
  const where = relay.pairing ? `to ${ownName(relay.pairing.agent)}, on ${relay.pairing.part}` : 'to this thread';
  return (
    <span className="relay-hint">
      Your {relay.kind === 'reply' ? 'reply' : 'answer'} goes {where} · <kbd>Esc</kbd> lets go
    </span>
  );
}

const noop = () => {};

// Reply: bordered where the relay needs the viewer, a plain text button on a row of a thread's latest word, which doesn't.
function ReplyButton({ relay, aimed, onReply, quiet = false }: { relay: Relay; aimed: boolean; onReply: (relay: Relay) => void; quiet?: boolean }) {
  return (
    <button
      type="button"
      className={`relay-btn${quiet ? ' is-quiet' : ''}`}
      aria-pressed={aimed}
      onClick={() => onReply(relay)}
      title={
        aimed
          ? 'Let go: the bar asks the coordinator again (Esc)'
          : relay.pairing
            ? `Reply to ${ownName(relay.pairing.agent)} on ${relay.pairing.part} from the bar, for one message, as you would pairing`
            : `${relay.kind === 'reply' ? 'Reply' : 'Answer'} in “${relay.title}” from the bar, for one message`
      }
    >
      <Icon name="reply" /> {aimed ? 'Replying below' : 'Reply'}
    </button>
  );
}

// Several that came in while the viewer was away, as one card: what needs them
// first (the latest first), then the threads' latest words, then what was
// answered, then what was done.
export function RelayStack({ board, relays, name, clock, aimed, onReply, onLight }: Omit<Props, 'relay' | 'aimed'> & { relays: Relay[]; aimed: string | null }) {
  const { head, needs, replied, answered, done } = relayStack(relays);
  const first = relays[0].at;
  const last = relays.at(-1)!.at;
  const group = (label: string, rows: Relay[], needsYou = false): ReactNode =>
    rows.length > 0 && (
      <>
        <div className={`relay-group${needsYou ? ' is-needs-you' : ''}`}>
          {label} · {rows.length}
        </div>
        {rows.map((r) => (
          <StackRow key={r.key} board={board} relay={r} name={name} clock={clock} aimed={aimed === r.key} onReply={onReply} onLight={onLight} />
        ))}
      </>
    );
  return (
    <li className="relay" data-at={first}>
      <div className="relay-stack">
        <div className="relay-stack-head">
          <strong>{head}</strong>
          <span className="relay-time">{first === last ? clock(first) : `${clock(first)} – ${clock(last)}`}</span>
        </div>
        {group('Needs you', needs, true)}
        {group('Replied', replied)}
        {group('Answered', answered)}
        {group('Done', done)}
      </div>
    </li>
  );
}

// A row of the card of what came while the viewer was away. A review waiting opens in place, with Review, as its own
// card would show it.
function StackRow(props: Props) {
  const { relay, name, clock, aimed, onReply, onLight } = props;
  const state = stateOf(relay);
  const [reviewing, setReviewing] = useState(false);
  if (state === 'reviewing' && reviewing) return <StackReview {...props} onFold={() => setReviewing(false)} />;
  const strand = strandOf(relay);
  const stitched = strand && relay.kind !== 'done' ? { 'data-yarn-relay': strand } : {};
  const light = strand ? { onPointerEnter: () => onLight(strand), onPointerLeave: () => onLight(null) } : {};
  const lead = state === 'asking' ? 'Asks:' : state === 'reviewing' ? 'For your review:' : state === 'blocked' ? 'Blocked:' : undefined;
  return (
    <div className={`relay-row is-${state}${aimed ? ' is-aimed' : ''}`} style={toneOf(relay.tone)} {...stitched} {...light}>
      <span className="work-square" aria-hidden />
      <div className="relay-row-main">
        <div className="relay-row-line">
          <button type="button" className="relay-thread" onClick={relay.open} title={opensWords(relay)}>
            {relay.label && <span className="relay-label">{relay.label}</span>}
            {relay.title}
          </button>
          {state === 'answered' ? (
            <Answered relay={relay} name={name} />
          ) : (
            !aimed && (
              <span className="relay-text">
                {lead && <b className={state === 'blocked' ? 'is-blocked' : undefined}>{lead}</b>} {firstLine(relay.body)}
              </span>
            )
          )}
        </div>
        {aimed && (
          <div className="relay-body">
            <CommentText comment={{ body: relay.body, mentions: relay.mentions ?? relay.thread?.messages.find((m) => m.id === relay.key)?.mentions }} />
          </div>
        )}
      </div>
      <time className="relay-time" dateTime={relay.at}>
        {clock(relay.at)}
      </time>
      {state === 'asking' || state === 'replied' ? (
        <ReplyButton relay={relay} aimed={aimed} onReply={onReply} quiet={state === 'replied'} />
      ) : state === 'reviewing' ? (
        <button type="button" className="relay-btn" onClick={() => setReviewing(true)} title={`See what “${relay.title}” changed, and answer it here`}>
          Review
        </button>
      ) : (
        <button type="button" className="relay-btn is-quiet" onClick={relay.open} title={opensWords(relay)}>
          {state === 'answered' ? openLabel(relay) : 'See it'} <Icon name="arrow-right" />
        </button>
      )}
    </div>
  );
}

// A review's row, opened: what its own card shows, under its thread's name, until it is folded again or answered.
function StackReview({ board, relay, name, clock, onLight, onFold }: Props & { onFold: () => void }) {
  const review = useReview(relay.thread!, name);
  return (
    <div
      className={`relay-row is-reviewing is-open${review.noting ? ' is-noting' : ''}`}
      style={toneOf(relay.tone)}
      data-yarn-relay={relay.thread!.id}
      onPointerEnter={() => onLight(relay.thread!.id)}
      onPointerLeave={() => onLight(null)}
    >
      <span className="work-square" aria-hidden />
      <div className="relay-row-main">
        <div className="relay-row-line">
          <button type="button" className="relay-thread" onClick={relay.open} title={`Open “${relay.title}” here`}>
            {relay.title}
          </button>
        </div>
        <ReviewBody board={board} relay={relay} review={review} />
      </div>
      <time className="relay-time" dateTime={relay.at}>
        {clock(relay.at)}
      </time>
      <button type="button" className="relay-btn is-quiet" onClick={onFold} title="Fold it back into its row">
        Fold
      </button>
    </div>
  );
}
