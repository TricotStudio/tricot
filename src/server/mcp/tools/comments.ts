import { peopleTextAdvice, withAdvice } from '../../../core/advice';
import { blockLabel } from '../../../core/canvas';
import { pinPart } from '../../../core/pins';
import { partOf } from '../../../core/parts';
import { tools } from '../../../core/schemas';
import { clip } from '../../../core/format';
import { BoardError, type ReactionPlace } from '../../../core/store';
import { AGENT_TALK, THEN_WAIT, inThread, toAgentsNote } from '../wording';
import { defineTool, text, type Tool } from '../tool';
import type { ToolContext } from './context';

export function commentTools({ store, getActor, session: { told } }: ToolContext): Tool[] {
  return [
    defineTool({
      name: 'comment',
      title: 'Comment',
      description:
        [
          "Reply in a decision's or a task's discussion (decision_id or task_id), or in the comment thread on a pinned part (pin_id): a line of a diff or code block, a person's request to edit a Google Doc's paragraph, or a person's request to change an element of a website (edit its file first).",
          '@-mention a person to tell them, or another agent to hand it a question or work. Write #N for a decision and TN for a task.',
          'With decision_id or task_id, thread_id shows it in the thread you are answering.',
          'then_wait posts, then listens in the same call.',
        ].join(' '),
      guide: {
        topic: 'conversation',
        text: [
          "Use it to answer a person's question on a card or report on work they sent back.",
          "A comment people make on a pinned part of a task's or decision's canvas is in that card's discussion, quoting the part: reply there as usual. On the board context it starts a thread on the pin, which get_canvas lists: reply with pin_id, and if it needs a person's call, post a decision and pin it to the same part with pin(pin_id).",
          'To tell a person something on a card, mention them (@Sam): it shows as new for them until they have seen it, and nothing waits on them. To ask, use ask_people, which waits for an answer. Refer to cards as #N for a decision and TN for a task (e.g. "posted as #32", "done in T35"): the board turns them into links.',
          `To hand another agent a question or a piece of work, mention it (@Codex): it reads as asked of it, and its reply comes through your updates. Answer another agent's mention as you would a person's. ${AGENT_TALK}`,
          'When you comment on a decision or task answering a thread, pass thread_id: people see the comment in the thread, under your reply.',
          THEN_WAIT,
        ].join(' '),
      },
      schema: tools.comment,
      handler: async ({ decision_id, task_id, pin_id, body, thread_id }) => {
        if ([decision_id, task_id, pin_id].filter(Boolean).length !== 1) {
          throw new BoardError('Pass decision_id, task_id or pin_id (exactly one).');
        }
        if (thread_id && pin_id) throw new BoardError('Pass thread_id with decision_id or task_id: a comment on a pin stays on its pin.');
        const card = task_id ? store.getTask(task_id).board : decision_id ? store.getDecision(decision_id).board : undefined;
        const thread = thread_id && card ? store.threadOn(thread_id, card) : undefined;
        const shown = thread ? ` It shows in ${inThread(thread)}.` : '';
        const advise = (reply: string) => withAdvice(reply, peopleTextAdvice(body, 'comment'));
        if (pin_id) {
          const { pin, comment } = store.commentOnPin(pin_id, body, getActor());
          told.read(comment.id); // it wrote it
          const { board, canvas, task, decision } = store.canvasOf(pin.id);
          const block = canvas.blocks.find((b) => b.id === pin.blockId)!;
          const card = task ? `T${task.number}` : decision ? `#${decision.number}` : undefined;
          const owner = partOf(block, pin.anchor.kind);
          const part = `${pinPart(pin, block)} in ${owner?.label?.(block, pin) ?? blockLabel(block)}`;
          const asks = toAgentsNote(board, comment);
          if (card) return text(advise(`Commented on ${card} about ${part}, in its discussion.${asks}`));
          const count = pin.discussion?.thread?.length ?? 0;
          const seen = owner?.seen ?? 'People see it on the pin';
          return text(advise(`Replied in the comment thread on ${part}, on the board context (${count} comments). ${seen}.${asks}`));
        }
        if (task_id) {
          const task = store.addTaskComment(task_id, body, getActor());
          told.read(task.comments.at(-1)!.id);
          const asks = toAgentsNote(store.getTask(task.id).board, task.comments.at(-1)!);
          if (thread) store.addThreadWork(thread.id, { kind: 'comment', id: task.comments.at(-1)!.id, on: task.id }, getActor());
          const gave = task.firstLook?.status === 'done' && task.firstLook.commentId === task.comments.at(-1)?.id;
          if (gave) return text(advise(`Commented on T${task.number}: that gives it its first look, and ${task.createdBy.name} sees it. Leave the card in the backlog until a person marks it ready.${shown}${asks}`));
          return text(advise(`Commented on T${task.number}.${shown}${asks}`));
        }
        const decision = store.addComment(decision_id!, body, getActor());
        told.read(decision.comments.at(-1)!.id);
        if (thread) store.addThreadWork(thread.id, { kind: 'comment', id: decision.comments.at(-1)!.id, on: decision.id }, getActor());
        const asks = toAgentsNote(store.getDecision(decision.id).board, decision.comments.at(-1)!);
        return text(advise(`Commented on #${decision.number}.${shown}${asks}`));
      },
    }),

    defineTool({
      name: 'react',
      title: 'React',
      description:
        'React to a comment or a thread message with 👍 (yes, OK), 👎 (no) or 👀 (seen), instead of a reply that would only say that. Pass where it is (task_id, decision_id, thread_id or pin_id): it reacts to the latest comment there by someone else, or to comment_id. remove takes yours back; then_wait as on comment.',
      guide: {
        topic: 'conversation',
        text: [
          'When a reply would only say "yes", "no" or "seen", react instead: people see it under what they wrote.',
          "👍 means yes or OK, 👎 means no; either answers a comment that asks you, so it no longer waits on you. Your 👀 shows up on its own when a person's comment or message, or another agent's that asks you, reaches you in get_board or your updates.",
          'One of each per comment; remove takes yours back.',
          'People\'s reactions to your own comments reach your updates ("Sam reacted 👎 to your comment on T115"): read 👍 as a yes or OK, 👎 as a no.',
        ].join(' '),
      },
      schema: tools.react,
      handler: async ({ task_id, decision_id, thread_id, pin_id, comment_id, emoji, remove }) => {
        const places: ReactionPlace[] = [
          ...(task_id ? [{ taskId: task_id }] : []),
          ...(decision_id ? [{ decisionId: decision_id }] : []),
          ...(thread_id ? [{ threadId: thread_id }] : []),
          ...(pin_id ? [{ pinId: pin_id }] : []),
        ];
        if (places.length !== 1) throw new BoardError('Pass one of task_id, decision_id, thread_id or pin_id: where the comment is.');
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
