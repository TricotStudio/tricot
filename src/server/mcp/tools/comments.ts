import { peopleTextAdvice, withAdvice } from '../../../core/advice';
import { blockLabel } from '../../../core/canvas';
import { cardOwning } from '../../../core/cards';
import { pinPart } from '../../../core/pins';
import { partOf } from '../../../core/parts';
import { pageName } from '../../../core/scratchPad';
import { tools } from '../../../core/schemas';
import { clip } from '../../../core/format';
import { BoardError, type ReactionPlace } from '../../../core/store';
import { AGENT_TALK, THEN_WAIT, inThread, toAgentsNote } from '../wording';
import type { Piece } from '../words';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';

// What a comment can be on is a pinned part; a group adds the cards (a part's cards), and says so here.
const COMMENT_ON: Piece[] = [
  ['pass', 'Pass '],
  ['pin', 'pin_id (exactly one).'],
];

// Where a reaction's comment can be: a thread or a pinned part, and the cards a group adds.
const REACT_PLACE: Piece[] = [
  ['pass', 'Pass one of '],
  ['where', 'thread_id or pin_id: where the comment is.'],
];

export function commentTools({ store, getActor, words, session: { told } }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'comment',
      title: 'Comment',
      description: [
        ['reply', 'Reply in '],
        ['reply-pin', "the comment thread on a pinned part (pin_id): a line of a diff or code block, a person's request to edit a Google Doc's paragraph, or a person's request to change an element of a website (edit its file first)."],
        ['mention', ' @-mention a person to tell them, or another agent to hand it a question or work.'],
        ['then-wait', ' then_wait posts, then listens in the same call.'],
      ],
      guide: {
        topic: 'conversation',
        text: [
          ['use', "Use it to answer a person's question on a card or report on work they sent back."],
          ['pinned', ' A comment people make on a pinned part'],
          ['board', ' starts a thread on the pin, which get_canvas lists: reply with pin_id'],
          ['board-end', '.'],
          ['tell', ' To tell a person something on a card, mention them (@Sam): it shows as new for them until they have seen it, and nothing waits on them.'],
          [
            'hand',
            ` To hand another agent a question or a piece of work, mention it (@Codex): it reads as asked of it, and its reply comes through your updates. Answer another agent's mention as you would a person's. ${AGENT_TALK}`,
          ],
          ['then', ` ${THEN_WAIT}`],
        ],
      },
      schema: tools.comment,
      handler: async ({ body, thread_id, ...args }) => {
        // What the comment is on is the one id given besides thread_id: a pin, or a card named by its kind (`<kind>_id`).
        const named = Object.entries(args).filter(([key, id]) => id && key.endsWith('_id')) as [string, string][];
        if (named.length !== 1) throw new BoardError(words.say('comment.on', COMMENT_ON));
        const [[idName, id]] = named;
        const pin_id = idName === 'pin_id' ? id : undefined;
        const kind = idName.slice(0, -'_id'.length);
        if (thread_id && pin_id) throw new BoardError('Pass thread_id with decision_id or task_id: a comment on a pin stays on its pin.');
        const card = pin_id ? undefined : store.getCard(kind, id).board;
        const thread = thread_id && card ? store.threadOn(thread_id, card) : undefined;
        const shown = thread ? ` It shows in ${inThread(thread)}.` : '';
        const advise = (reply: string) => withAdvice(reply, peopleTextAdvice(body, 'comment', words));
        if (pin_id) {
          const { pin, comment } = store.commentOnPin(pin_id, body, getActor());
          told.read(comment.id); // it wrote it
          const located = store.canvasOf(pin.id);
          const { board, canvas, page } = located;
          const block = canvas.blocks.find((b) => b.id === pin.blockId)!;
          const card = cardOwning(located)?.label;
          const owner = partOf(block, pin.anchor.kind);
          const part = `${pinPart(pin, block)} in ${owner?.label?.(block, pin) ?? blockLabel(block)}`;
          const asks = toAgentsNote(board, comment);
          if (card) return text(advise(`Commented on ${card} about ${part}, in its discussion.${asks}`));
          const count = pin.discussion?.thread?.length ?? 0;
          const seen = owner?.seen ?? 'People see it on the pin';
          // On the board context only where a group says so: a pin kept from before has no page, and a server without one names none.
          const on = page ? `, on ${pageName(page)}` : (words.line('comment.context', {}) ?? '');
          return text(advise(`Replied in the comment thread on ${part}${on} (${count} comments). ${seen}.${asks}`));
        }
        const { comment, label, then } = store.commentOnKind(kind, id, body, getActor());
        told.read(comment.id);
        const asks = toAgentsNote(store.getCard(kind, id).board, comment);
        if (thread) store.addThreadWork(thread.id, { kind: 'comment', id: comment.id, on: id }, getActor());
        return text(advise(`Commented on ${label}${then ?? '.'}${shown}${asks}`));
      },
    }),

    defineTool({
      name: 'react',
      title: 'React',
      description: [
        ['react', 'React to a comment or a thread message with 👍 (yes, OK), 👎 (no) or 👀 (seen), instead of a reply that would only say that. Pass where it is ('],
        ['where', 'thread_id or pin_id): it reacts to the latest comment there by someone else, or to comment_id. remove takes yours back; then_wait as on comment.'],
      ],
      guide: {
        topic: 'conversation',
        text: [
          [
            'use',
            [
              'When a reply would only say "yes", "no" or "seen", react instead: people see it under what they wrote.',
              "👍 means yes or OK, 👎 means no; either answers a comment that asks you, so it no longer waits on you. Your 👀 shows up on its own when a person's comment or message, or another agent's that asks you, reaches you in get_board or your updates.",
              'One of each per comment; remove takes yours back.',
            ].join(' ') + ' ',
          ],
          ['reactions', 'People\'s reactions to your own comments reach your updates ("Sam reacted 👎 to your comment on '],
          ['example', 'Checkout flow'],
          ['end', '"): read 👍 as a yes or OK, 👎 as a no.'],
        ],
      },
      schema: tools.react,
      handler: async ({ task_id, decision_id, thread_id, pin_id, comment_id, emoji, remove }) => {
        // A card's discussion is named by its kind and `Id`; a Store with no such kind refuses it as a card that is not there.
        const onCard = (kind: string, id: string) => ({ [`${kind}Id`]: id }) as ReactionPlace;
        const places: ReactionPlace[] = [
          ...(task_id ? [onCard('task', task_id)] : []),
          ...(decision_id ? [onCard('decision', decision_id)] : []),
          ...(thread_id ? [{ threadId: thread_id }] : []),
          ...(pin_id ? [{ pinId: pin_id }] : []),
        ];
        if (places.length !== 1) throw new BoardError(words.say('react.place', REACT_PLACE));
        const { item, on, changed, answered } = store.react(places[0], { commentId: comment_id, emoji, remove }, getActor());
        const whose = `${item.author.name}'s ${thread_id ? 'message' : 'comment'} ${on}`;
        if (remove) return text(changed ? `Took back your ${emoji} on ${whose}.` : `You hadn't reacted ${emoji} to ${whose}; nothing changed.`);
        if (!changed) return text(`You had already reacted ${emoji} to ${whose}.`);
        const reply = answered ? ' It counts as your reply, so it no longer waits on you.' : '';
        return text(`Reacted ${emoji} to ${whose}: "${clip(item.body, 80)}".${reply} ${item.author.name} sees it under it.`);
      },
    }),
  ];
}
