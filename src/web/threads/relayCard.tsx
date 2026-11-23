import { useState, type CSSProperties, type ReactNode } from 'react';
import { answeredWords, firstLine, relayStack, relayWords, verdictWords } from '../../core/homeConversation';
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
// one. Answered, a question folds to a line of who answered and what they
// said, and a review to the verdict.
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

// Where a relay stands, as it is drawn: a question asking or answered, a review waiting or answered, or its kind.
type State = 'asking' | 'answered' | 'reviewing' | 'blocked' | 'done';
function stateOf(relay: Relay): State {
  if (relay.kind === 'question') return relay.needsYou ? 'asking' : 'answered';
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

// Its thread's name, which opens it, where it stands and when it was said.
function Head({ relay, clock }: { relay: Relay; clock: (iso: string) => string }) {
  return (
    <div className="relay-head">
      <Icon name="thread" />
      <button type="button" className="relay-thread" onClick={relay.open} title={relay.thread ? `Open “${relay.title}” here` : `Open ${relay.label ?? relay.title}`}>
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
  const stitched = relay.thread && relay.kind !== 'done' ? { 'data-yarn-relay': relay.thread.id } : {};
  const light = relay.thread ? { onPointerEnter: () => onLight(relay.thread!.id), onPointerLeave: () => onLight(null) } : {};
  return (
    <li className="relay" data-at={relay.at}>
      <div className={`relay-card is-${state}${aimed ? ' is-aimed' : ''}`} style={toneOf(relay.tone)} {...stitched} {...light}>
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
              {aimed && (
                <span className="relay-hint">
                  Your answer goes to this thread · <kbd>Esc</kbd> lets go
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="relay-line">
            {state === 'answered' ? <Answered relay={relay} name={name} /> : <span className="relay-text">{firstLine(relay.body)}</span>}
            <button type="button" className="relay-btn is-quiet" onClick={relay.open}>
              {state === 'answered' ? 'Open thread' : 'See it'} <Icon name="arrow-right" />
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

const noop = () => {};

function ReplyButton({ relay, aimed, onReply }: { relay: Relay; aimed: boolean; onReply: (relay: Relay) => void }) {
  return (
    <button
      type="button"
      className="relay-btn"
      aria-pressed={aimed}
      onClick={() => onReply(relay)}
      title={aimed ? 'Let go: the bar asks the coordinator again (Esc)' : `Answer in “${relay.title}” from the bar, for one message`}
    >
      <Icon name="reply" /> {aimed ? 'Replying below' : 'Reply'}
    </button>
  );
}

// Several that came in while the viewer was away, as one card: what needs them
// first (the latest first), then what was answered, then what was done.
export function RelayStack({ board, relays, name, clock, aimed, onReply, onLight }: Omit<Props, 'relay' | 'aimed'> & { relays: Relay[]; aimed: string | null }) {
  const { head, needs, answered, done } = relayStack(relays);
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
  const stitched = relay.thread && relay.kind !== 'done' ? { 'data-yarn-relay': relay.thread.id } : {};
  const light = relay.thread ? { onPointerEnter: () => onLight(relay.thread!.id), onPointerLeave: () => onLight(null) } : {};
  const lead = state === 'asking' ? 'Asks:' : state === 'reviewing' ? 'For your review:' : state === 'blocked' ? 'Blocked:' : undefined;
  return (
    <div className={`relay-row is-${state}${aimed ? ' is-aimed' : ''}`} style={toneOf(relay.tone)} {...stitched} {...light}>
      <span className="work-square" aria-hidden />
      <div className="relay-row-main">
        <div className="relay-row-line">
          <button type="button" className="relay-thread" onClick={relay.open} title={relay.thread ? `Open “${relay.title}” here` : `Open ${relay.label ?? relay.title}`}>
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
            <CommentText comment={{ body: relay.body, mentions: relay.thread?.messages.find((m) => m.id === relay.key)?.mentions }} />
          </div>
        )}
      </div>
      <time className="relay-time" dateTime={relay.at}>
        {clock(relay.at)}
      </time>
      {state === 'asking' ? (
        <ReplyButton relay={relay} aimed={aimed} onReply={onReply} />
      ) : state === 'reviewing' ? (
        <button type="button" className="relay-btn" onClick={() => setReviewing(true)} title={`See what “${relay.title}” changed, and answer it here`}>
          Review
        </button>
      ) : (
        <button type="button" className="relay-btn is-quiet" onClick={relay.open}>
          {state === 'answered' ? 'Open thread' : 'See it'} <Icon name="arrow-right" />
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
