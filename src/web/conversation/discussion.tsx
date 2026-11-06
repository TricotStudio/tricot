import { useEffect, useRef, useState } from 'react';
import type { Where } from '../../core/delivery';
import { samePerson } from '../../core/format';
import { resolveMentions } from '../../core/mentions';
import type { ReactionPlace } from '../../core/store/reactions';
import type { Board, Comment, Pin } from '../../core/types';
import { agentLineAt, LoopLine, SaidTo } from './agentTalk';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { MessageFoot } from './delivery';
import { useReadOnly } from '../shared/hooks';
import { AsksYou, CommentText, MentionTextarea, useRoster, ViaSkill } from '../shared/mentions';
import { newestMine, onItsWay, outbox, settledKeys, useOutgoing, withOutgoing, type Outgoing } from './outbox';
import { Reactions } from './reactions';

export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

interface Props {
  board: Board;
  where: Where; // the card, for who its comments are for (core/delivery.ts)
  comments: Comment[];
  pins: Pin[]; // the card's canvas pins, which comments made on its parts quote
  place: ReactionPlace; // the card, for reactions to its comments
  name: string;
  unreadSince: string | null; // comments by others after this are unread
  onSend: (body: string) => Promise<{ comments: Comment[] }>; // the card, as the server has it after
  placeholder?: string; // e.g. on a closed card, that a note leaves it closed
}

// The names a message being sent may @-mention, for it to read as it will
// once the board has it.
export function useMentionable(name: string): string[] {
  const roster = useRoster();
  return [...roster.agents.map((a) => a.name), ...roster.people, name];
}

// A comment being sent, drawn until the board has it.
function draftComment(o: Outgoing, name: string, names: string[]): Comment {
  const mentions = resolveMentions(o.body, names);
  return { id: o.key, author: { kind: 'human', name }, body: o.body, createdAt: o.at, ...(mentions.length && { mentions }) };
}

// ---- between comments and the parts they're about ----------------------------

// Asks the canvas to show a pin, from the quote of a comment about it: it
// brings the pin's block into view and highlights the part for a moment.
export const FOCUS_PIN = 'tricot:focus-pin';

export function focusPin(pinId: string): void {
  window.dispatchEvent(new CustomEvent<string>(FOCUS_PIN, { detail: pinId }));
}

const anchor = (commentId: string) => `comment-${commentId}`;

// Scrolls the discussion to comments, from the chip of the part they're
// about, and flashes them. A comment just sent shows once the board catches
// up, so it is looked for a little while.
export function showComments(ids: string[], tries = 12): void {
  const found = ids.flatMap((id) => document.getElementById(anchor(id)) ?? []);
  if (found.length === 0) {
    if (tries > 0) setTimeout(() => showComments(ids, tries - 1), 120);
    return;
  }
  found[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const element of found) {
    element.classList.remove('is-flash');
    void element.offsetWidth; // restarts the animation
    element.classList.add('is-flash');
  }
}

// A thread on a decision or a task. Agents read these. What a person sends
// shows at once, and the line under their latest says what became of it
// (delivery.tsx) until an agent's reply takes its place. An agent's latest
// message to another agent has that line too, and its head says who it is
// for ("Claude → Codex"); once the loop guard holds one, a quiet line at the
// foot says the agents wait for a person (agentTalk.tsx).
export function Discussion({ board, where, comments, pins, place, name, unreadSince, onSend, placeholder }: Props) {
  const readOnly = useReadOnly();
  const [body, setBody] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const names = useMentionable(name);
  const placeKey = 'task' in where ? `task:${where.task.id}` : 'decision' in where ? `decision:${where.decision.id}` : 'thread' in where ? `thread:${where.thread.id}` : 'board-context';
  const drawn = withOutgoing(comments, useOutgoing(placeKey), name, (o) => draftComment(o, name, names));
  // What the board has now, the outbox lets go (under the same key).
  const settled = settledKeys(drawn).join();
  useEffect(() => {
    for (const key of settled ? settled.split(',') : []) outbox.remove(key);
  }, [settled]);
  // Agents' replies that come while the card is open fade in where the line was.
  const opened = useRef<Set<string> | null>(null);
  opened.current ??= new Set(comments.map((c) => c.id));
  const mine = (comment: Comment) => comment.author.kind === 'human' && samePerson(comment.author.name, name);
  const unread = (comment: Comment) => Boolean(unreadSince) && comment.createdAt > unreadSince! && !mine(comment);
  // The line goes under the latest message from a person, when it is this viewer's.
  const latest = drawn.findLastIndex((d) => d.item.author.kind === 'human');
  const lineAt = latest >= 0 && mine(drawn[latest].item) ? latest : -1;
  const agentAt = agentLineAt(board, comments);
  const agentLine = agentAt >= 0 ? comments[agentAt].id : undefined;

  const send = () => {
    const text = body;
    if (!text.trim()) return;
    const known = comments.map((c) => c.id);
    outbox.send(placeKey, text, known, async () => newestMine((await onSend(text)).comments, known, name, text));
    setBody('');
  };
  // A comment not sent goes back to the box, to change and send again.
  const edit = (text: string) => {
    setBody(text);
    requestAnimationFrame(() => field.current?.focus());
  };

  return (
    <section className="section">
      <h3>Discussion</h3>
      {drawn.length === 0 && <p className="faint small">{readOnly ? 'No comments.' : 'No comments yet. Agents read these.'}</p>}
      <ol className="comments">
        {drawn.map((d, i) => {
          const comment = d.item;
          const way = onItsWay(d);
          const draft = comment.id === d.outgoing?.key;
          const reactions = draft ? null : <Reactions item={comment} place={place} name={name} />;
          const arriving = comment.author.kind === 'agent' && !opened.current!.has(comment.id);
          const state = way === 'sending' ? ' is-sending' : way === 'failed' ? ' is-unsent' : '';
          return (
            <li
              key={d.key}
              id={draft ? undefined : anchor(comment.id)}
              className={`comment comment-${comment.author.kind}${unread(comment) ? ' is-unread' : ''}${arriving ? ' is-arriving' : ''}${state}`}
              onAnimationEnd={(e) => e.currentTarget.classList.remove('is-flash')}
            >
              <div className="comment-head">
                <ActorBadge actor={comment.author} />
                <SaidTo board={board} said={comment} /> <span className="faint small">{timeAgo(comment.createdAt)}</span>
                {unread(comment) && <span className="block-new">new</span>}
                <AsksYou comment={comment} thread={comments} />
                <ViaSkill via={comment.via} />
              </div>
              {comment.pin && <CommentQuote pin={comment.pin} pinned={pins.some((p) => p.id === comment.pin!.id)} />}
              <CommentText comment={comment} />
              {way || i === lineAt || comment.id === agentLine ? (
                <MessageFoot
                  board={board}
                  where={where}
                  said={{ id: comment.id, author: comment.author, at: comment.createdAt, mentions: comment.mentions, reactions: comment.reactions, held: comment.held, paired: comment.paired }}
                  after={drawn.slice(i + 1).map((x) => x.item)}
                  onItsWay={way}
                  outgoing={d.outgoing}
                  onEdit={edit}
                >
                  {reactions}
                </MessageFoot>
              ) : (
                reactions
              )}
            </li>
          );
        })}
      </ol>
      <LoopLine board={board} items={comments} />
      {!readOnly && (
        <div className="composer">
          <MentionTextarea
            skills
            ref={field}
            rows={2}
            value={body}
            onValue={setBody}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send()}
            placeholder={placeholder ?? 'Ask a question or add a thought; @ to mention, # to link a card, / for a skill'}
          />
          <button
            className={`btn btn-small composer-send${body.trim() ? ' btn-primary' : ''}`}
            disabled={!body.trim()}
            onClick={send}
            title={`Comment (${MOD}+Enter)`}
          >
            Comment <kbd>{MOD === '⌘' ? '⌘↵' : 'Ctrl ↵'}</kbd>
          </button>
        </div>
      )}
    </section>
  );
}

// The part of the canvas a comment is about, which shows it there. Once
// unpinned, the quote stays as it read.
function CommentQuote({ pin, pinned }: { pin: NonNullable<Comment['pin']>; pinned: boolean }) {
  if (!pinned) {
    return (
      <span className="comment-quote is-gone" title="Unpinned since">
        {pin.quote}
      </span>
    );
  }
  return (
    <button type="button" className="comment-quote" onClick={() => focusPin(pin.id)} title="Show it on the canvas">
      <Icon name="arrow-up-left" />
      <span>{pin.quote}</span>
    </button>
  );
}
