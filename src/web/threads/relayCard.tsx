import type { CSSProperties, ReactNode } from 'react';
import { samePerson } from '../../core/format';
import { Icon } from '../shared/components';
import { CommentText } from '../shared/mentions';
import type { Relay } from './relays';

// A relay in Home's conversation (relays.ts, timeline.tsx): a card from a
// thread, never the coordinator speaking, so it has no author's badge and is
// led by its thread's name, which opens the thread. Its edge is in the colour
// of where its thread stands now (styles/base.css `--status-*`), and the
// thread's strand stitches into it on the yarn (`data-yarn-relay`, yarn.tsx).
// Its size follows how much it needs the viewer: a question in full, with
// Reply, which aims the conversation's bar at its thread for one message; a
// card blocked in two lines; something done in one. Answered, a question folds
// to a line of who answered and what they said.
// What came in while the viewer was away comes as one card (`RelayStack`),
// what needs them first, each row as a relay is.

const TONES: Record<Relay['tone'], [string, string]> = {
  working: ['var(--status-in-progress)', 'var(--status-in-progress-ink)'],
  waiting: ['var(--status-in-review)', 'var(--status-in-review-ink)'],
  todo: ['var(--status-to-do)', 'var(--status-to-do-ink)'],
  done: ['var(--status-done)', 'var(--status-done-ink)'],
  blocked: ['var(--status-blocked)', 'var(--status-blocked-ink)'],
};
export const toneOf = (tone: Relay['tone']): CSSProperties => ({ '--tone': TONES[tone][0], '--ink': TONES[tone][1] }) as CSSProperties;

const ownName = (agent: string): string => agent.split(' · ')[0];
const firstLine = (text: string): string => text.split('\n').find((line) => line.trim())?.replace(/^[#>*\-\s]+/, '') ?? '';

// What it says of where it stands, after its name.
function Kind({ relay }: { relay: Relay }) {
  if (relay.kind === 'blocked')
    return (
      <span className="relay-kind is-blocked">
        <Icon name="blocked" />
        Blocked
      </span>
    );
  const words =
    relay.kind === 'done'
      ? 'Done'
      : relay.needsYou
        ? `${ownName(relay.by ?? 'An agent')} asks you`
        : relay.tone === 'working'
          ? 'Back at work'
          : relay.tone === 'done'
            ? 'Done'
            : relay.tone === 'todo'
              ? 'Waiting for its agent'
              : 'Answered';
  return (
    <span className="relay-kind">
      <span className="work-square" aria-hidden />
      {words}
    </span>
  );
}

// "You answered: …", or who did.
function Answered({ relay, name }: { relay: Relay; name: string }) {
  const who = relay.answer && samePerson(relay.answer.by, name) ? 'You' : relay.answer?.by;
  return (
    <span className="relay-answer">
      <Icon name="check" />
      <span>
        {who} answered: “{firstLine(relay.answer?.body ?? '')}”
      </span>
    </span>
  );
}

interface Props {
  relay: Relay;
  name: string;
  clock: (iso: string) => string;
  aimed: boolean; // the bar answers into its thread
  onReply: (relay: Relay) => void; // aims the bar at its thread, or lets go when it is aimed
  onLight: (thread: string | null) => void;
}

export function RelayCard({ relay, name, clock, aimed, onReply, onLight }: Props) {
  const state = relay.kind === 'question' ? (relay.needsYou ? 'asking' : 'answered') : relay.kind;
  const stitched = relay.thread && relay.kind !== 'done' ? { 'data-yarn-relay': relay.thread.id } : {};
  const light = relay.thread ? { onPointerEnter: () => onLight(relay.thread!.id), onPointerLeave: () => onLight(null) } : {};
  return (
    <li className="relay" data-at={relay.at}>
      <div className={`relay-card is-${state}${aimed ? ' is-aimed' : ''}`} style={toneOf(relay.tone)} {...stitched} {...light}>
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
export function RelayStack({ relays, name, clock, aimed, onReply, onLight }: Omit<Props, 'relay' | 'aimed'> & { relays: Relay[]; aimed: string | null }) {
  const latest = (a: Relay, b: Relay) => b.at.localeCompare(a.at);
  const needs = relays.filter((r) => r.needsYou).sort(latest);
  const answered = relays.filter((r) => r.kind === 'question' && !r.needsYou).sort(latest);
  const done = relays.filter((r) => r.kind === 'done').sort(latest);
  const sources = new Set(relays.map((r) => r.thread?.id ?? r.key));
  const allThreads = relays.every((r) => r.thread);
  const first = relays[0].at;
  const last = relays.at(-1)!.at;
  const group = (label: string, rows: Relay[], needsYou = false): ReactNode =>
    rows.length > 0 && (
      <>
        <div className={`relay-group${needsYou ? ' is-needs-you' : ''}`}>
          {label} · {rows.length}
        </div>
        {rows.map((r) => (
          <StackRow key={r.key} relay={r} name={name} clock={clock} aimed={aimed === r.key} onReply={onReply} onLight={onLight} />
        ))}
      </>
    );
  return (
    <li className="relay" data-at={first}>
      <div className="relay-stack">
        <div className="relay-stack-head">
          <strong>
            {sources.size} {allThreads ? (sources.size === 1 ? 'thread' : 'threads') : sources.size === 1 ? 'piece of work' : 'pieces of work'} moved while you were away
          </strong>
          <span className="relay-time">{first === last ? clock(first) : `${clock(first)} – ${clock(last)}`}</span>
        </div>
        {group('Needs you', needs, true)}
        {group('Answered', answered)}
        {group('Done', done)}
      </div>
    </li>
  );
}

function StackRow({ relay, name, clock, aimed, onReply, onLight }: Props) {
  const state = relay.kind === 'question' ? (relay.needsYou ? 'asking' : 'answered') : relay.kind;
  const stitched = relay.thread && relay.kind !== 'done' ? { 'data-yarn-relay': relay.thread.id } : {};
  const light = relay.thread ? { onPointerEnter: () => onLight(relay.thread!.id), onPointerLeave: () => onLight(null) } : {};
  const lead = state === 'asking' ? 'Asks:' : state === 'blocked' ? 'Blocked:' : undefined;
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
      ) : (
        <button type="button" className="relay-btn is-quiet" onClick={relay.open}>
          {state === 'answered' ? 'Open thread' : 'See it'} <Icon name="arrow-right" />
        </button>
      )}
    </div>
  );
}
