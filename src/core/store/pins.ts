import type { Decisions } from './decisions';
import { BoardError } from './errors';
import type { Located, PinPart, PinTarget } from './inputs';
import { where } from './labels';
import type { People } from './people';
import { pinAnchor, pinIn, pinRef, samePart } from './pinParts';
import { type BoardRepository, refOf } from './repository';
import type { Tasks } from './tasks';
import { LIMITS, commentText, guardArchived, limited, randomId, required } from './validate';
import { blockLabel } from '../canvas';
import { askingWords, connectorPinning } from '../connectors';
import { clip } from '../format';
import { agentsIn, peopleIn, withoutLeadingMentions } from '../mentions';
import { canvasName, cleanQuote, partQuote, pinPart } from '../pins';
import type { Actor, Block, Comment, Decision, Pin, PinAnchor, PinDiscussion, Task } from '../types';

// Pins: parts of a block that link to work, or carry a comment.
export class Pins {
  constructor(
    private readonly repo: BoardRepository,
    private readonly tasks: Tasks,
    private readonly decisions: Decisions,
    private readonly people: People,
  ) {}

  // A person pins part of a block and turns it into a task there and then.
  // The prompt's first line titles it and its detail quotes the part and the
  // block it's on. It waits in the backlog unless they say it's ready; on a
  // settled decision's canvas, it implements that decision.
  pinTask(blockId: string, part: PinPart, input: { text: string; ready?: boolean }, actor: Actor): { pin: Pin; task: Task } {
    const { located, block, anchor, quote } = this.preparePin(blockId, part);
    // An agent mentioned in the prompt ("@Codex tighten this") is the task's
    // assignee; the mentions that open it only say so, and don't title it.
    const [assignee] = agentsIn(located.board, this.people.mentionsIn(located.board, input.text, actor));
    const { first, rest } = promptLines(assignee ? withoutLeadingMentions(input.text, [assignee]) : input.text);
    const decision = located.decision;
    const decisionIds = decision && (decision.status === 'decided' || decision.status === 'provisional') ? [decision.id] : [];
    const detail = [rest, pinnedFrom(located, block, anchor.kind === 'line' ? partQuote({ anchor, quote }) : quote)].filter(Boolean).join('\n\n');
    const [task] = this.tasks.planTasks(located.board.id, [{ title: first, detail, decisionIds, assignee }], actor, { ready: input.ready });
    return { pin: this.commitPin(located, block, anchor, quote, { taskId: task.id }, actor), task };
  }

  // A person pins part of a block and asks the board a question about it: a
  // decision with no options yet, for agents to propose some. The prompt's
  // first line is the question and its context quotes the part, as a pinned
  // task's detail does. The mentions that open it only say who it's for:
  // people mentioned are asked, and an agent mentioned finds the prompt as the
  // card's first comment, which asks it (mentions.ts).
  pinQuestion(blockId: string, part: PinPart, input: { text: string }, actor: Actor): { pin: Pin; decision: Decision } {
    const { located, block, anchor, quote } = this.preparePin(blockId, part);
    const { board } = located;
    const mentions = this.people.mentionsIn(board, input.text, actor);
    const { first, rest } = promptLines(withoutLeadingMentions(input.text, mentions));
    const context = [rest, pinnedFrom(located, block, anchor.kind === 'line' ? partQuote({ anchor, quote }) : quote)].filter(Boolean).join('\n\n');
    const people = peopleIn(board, mentions);
    const decision = this.decisions.postDecision(board.id, { question: first, context, ask: people }, actor);
    const pin = this.commitPin(located, block, anchor, quote, { decisionId: decision.id }, actor);
    if (agentsIn(board, mentions).length) this.decisions.addComment(decision.id, input.text, actor);
    return { pin, decision };
  }

  // A person pins part of a block and comments on it. On a task's or
  // decision's canvas the comment goes in that card's discussion, quoting the
  // part, so the conversation stays in one place; the board context has no
  // discussion, so there it starts a thread on the pin. Commenting on a part
  // that already has comments adds to them.
  // `ask` makes the comment a request for agents to act on the part: to edit
  // a Google Doc's paragraph in its draft (a part its connector offers).
  pinComment(blockId: string, part: PinPart, body: string, actor: Actor, options: { ask?: boolean } = {}): { pin: Pin; comment: Comment } {
    const { located, block, anchor, quote } = this.preparePin(blockId, part);
    const text = commentText(body);
    if (options.ask && !connectorPinning(anchor.kind)?.pins?.ask) throw new BoardError(askingWords()?.refusal ?? 'No part of a connector can be asked of agents; comment on it.');
    const same = located.canvas.pins.find((p) => p.blockId === block.id && p.discussion && samePart(p.anchor, anchor));
    const discussion: PinDiscussion = located.task || located.decision ? {} : { thread: [] };
    // Pinned quietly: the comment is what's worth telling, and it says where.
    const pin = same ?? this.commitPin(located, block, anchor, quote, { discussion }, actor, true);
    return { pin, comment: this.commentAt(located, block, pin, text, actor, options.ask) };
  }

  // A reply about a part people commented on: in its card's discussion, or in
  // the pin's own thread on the board context, which a reply reopens.
  commentOnPin(pinId: string, body: string, actor: Actor): { pin: Pin; comment: Comment } {
    const { located, pin, block } = this.findPin(pinId);
    guardArchived(located.board);
    if (!pin.discussion) {
      const work = pin.taskId ? `task_id ${pin.taskId}` : `decision_id ${pin.decisionId}`;
      throw new BoardError(`That pin links ${pinPart(pin, block)} to ${pinRef(located.board, pin)}; comment on it with ${work}.`);
    }
    return { pin, comment: this.commentAt(located, block, pin, commentText(body), actor) };
  }

  // A person closes a board context thread, or opens it again. Comments on a
  // card's canvas are in its discussion, which has nothing to resolve.
  resolvePin(pinId: string, resolved: boolean, actor: Actor): Pin {
    const { located, pin, block } = this.findPin(pinId);
    guardArchived(located.board);
    if (actor.kind === 'agent') throw new BoardError('Only people resolve a comment thread. Reply with comment(pin_id) if there is more to say.');
    if (!pin.discussion?.thread) throw new BoardError(`${pinPart(pin, block)} has no comment thread to resolve.`);
    if (Boolean(pin.discussion.resolved) === resolved) return pin;
    if (resolved) pin.discussion.resolved = { by: actor, at: new Date().toISOString() };
    else delete pin.discussion.resolved;
    const what = resolved ? 'resolved' : 'reopened';
    this.repo.recordCanvas(located, actor, `${what} the comment thread on ${pinPart(pin, block)} in ${blockLabel(block)} (${canvasName(located)})`, pin.id);
    return pin;
  }

  // Adds a comment about a pin's part where its comments go, and says so.
  // `ask`: a person's request for agents to edit the doc's paragraph.
  private commentAt(located: Located, block: Block, pin: Pin, text: string, actor: Actor, ask = false): Comment {
    const quote = clip(partQuote(pin, block), 200);
    const asking = ask ? `edit ${pinIn(pin, block)}` : undefined;
    if (located.task) return this.tasks.addTaskComment(located.task.id, text, actor, { id: pin.id, quote }, asking).comments.at(-1)!;
    if (located.decision) return this.decisions.addComment(located.decision.id, text, actor, { id: pin.id, quote }, asking).comments.at(-1)!;
    const now = new Date().toISOString();
    const mentions = this.people.mentionsIn(located.board, text, actor);
    const held = this.people.heldIn(located.board, pin.discussion?.thread ?? [], actor, mentions);
    const comment: Comment = {
      id: randomId(8),
      author: actor,
      body: text,
      createdAt: now,
      ...(ask ? { ask: true as const } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(held ? { held } : {}),
    };
    const discussion = (pin.discussion ??= {});
    (discussion.thread ??= []).push(comment);
    delete discussion.resolved; // a reply reopens it
    const summary = asking
      ? `asked agents to ${asking} (board context): "${clip(text, 200)}"`
      : `commented on ${pinIn(pin, block)} (board context): "${clip(text, 200)}"`;
    // The thread is the pin's, so its events are about the pin.
    this.repo.record(located.board, actor, 'comment_added', summary, undefined, pin.id, undefined, now, mentions, comment.id, undefined, Boolean(held));
    return comment;
  }

  private findPin(pinId: string): { located: Located; pin: Pin; block: Block } {
    const located = this.repo.locateItem(pinId);
    const pin = located.canvas.pins.find((p) => p.id === pinId);
    if (!pin) throw new BoardError(`"${pinId}" is not a pin.`);
    return { located, pin, block: located.canvas.blocks.find((b) => b.id === pin.blockId)! };
  }

  // Links a task or decision that already exists to part of a block, e.g. an
  // agent connecting the board context's phrases to the work doing them.
  // Pinning the same part to the same work again changes nothing.
  pin(blockId: string, part: PinPart, target: PinTarget, actor: Actor): Pin {
    const { taskId, decisionId } = target;
    if (!taskId === !decisionId) throw new BoardError('Pin it to a task or a decision (exactly one).');
    const { located, block, anchor, quote } = this.preparePin(blockId, part);
    const { board } = located;
    if (taskId && !board.tasks.some((t) => t.id === taskId)) throw new BoardError(`No task "${taskId}" on this board.`);
    if (decisionId && !board.decisions.some((d) => d.id === decisionId)) throw new BoardError(`No decision "${decisionId}" on this board.`);
    const same = located.canvas.pins.find(
      (p) => p.blockId === block.id && p.taskId === taskId && p.decisionId === decisionId && samePart(p.anchor, anchor),
    );
    return same ?? this.commitPin(located, block, anchor, quote, { taskId, decisionId }, actor);
  }

  // Links work to the part another pin is on, e.g. a decision an agent posts
  // when a comment thread there needs a person's call. The part is taken as
  // pinned, so a box keeps its number.
  pinAlongside(pinId: string, target: PinTarget, actor: Actor): Pin {
    const { taskId, decisionId } = target;
    if (!taskId === !decisionId) throw new BoardError('Pin it to a task or a decision (exactly one).');
    const { located, pin: beside, block } = this.findPin(pinId);
    guardArchived(located.board);
    const { board } = located;
    if (taskId && !board.tasks.some((t) => t.id === taskId)) throw new BoardError(`No task "${taskId}" on this board.`);
    if (decisionId && !board.decisions.some((d) => d.id === decisionId)) throw new BoardError(`No decision "${decisionId}" on this board.`);
    if (located.canvas.pins.length >= LIMITS.pins) throw new BoardError(`A canvas can hold at most ${LIMITS.pins} pins.`);
    const same = located.canvas.pins.find(
      (p) => p.blockId === block.id && p.taskId === taskId && p.decisionId === decisionId && samePart(p.anchor, beside.anchor),
    );
    return same ?? this.commitPin(located, block, structuredClone(beside.anchor), beside.quote, { taskId, decisionId }, actor);
  }

  // Checks a pin before anything changes: the block, and the part of it.
  private preparePin(blockId: string, part: PinPart): { located: Located; block: Block; anchor: PinAnchor; quote: string } {
    const located = this.repo.locateItem(blockId);
    guardArchived(located.board);
    const block = located.canvas.blocks.find((b) => b.id === blockId);
    if (!block) throw new BoardError(`"${blockId}" is not a block.`);
    if (located.canvas.pins.length >= LIMITS.pins) throw new BoardError(`A canvas can hold at most ${LIMITS.pins} pins.`);
    return { located, block, ...pinAnchor(block, part, located.canvas.pins) };
  }

  // `quiet` leaves the logging to the caller.
  private commitPin(
    located: Located,
    block: Block,
    anchor: PinAnchor,
    quote: string,
    link: PinTarget & { discussion?: PinDiscussion },
    actor: Actor,
    quiet = false,
  ): Pin {
    const pin: Pin = {
      id: this.repo.newItemId(located.canvas),
      blockId: block.id,
      anchor,
      quote,
      taskId: link.taskId,
      decisionId: link.decisionId,
      ...(link.discussion ? { discussion: link.discussion } : {}),
      author: actor,
      createdAt: new Date().toISOString(),
    };
    located.canvas.pins.push(pin);
    this.repo.indexItem(pin.id, refOf(located));
    if (quiet) return pin;
    const summary = `pinned ${pinPart(pin, block)} in ${blockLabel(block)} (${canvasName(located)}) to ${pinRef(located.board, pin, true)}`;
    this.repo.recordCanvas(located, actor, summary, block.id, pin);
    return pin;
  }
}

// A pin's prompt: the first line titles the task, or is the question, and the
// rest adds detail. A first line too long for a title is kept whole in it.
function promptLines(text: string): { first: string; rest?: string } {
  const [line, ...more] = limited(required(text, 'prompt'), LIMITS.prompt, 'The prompt').split('\n');
  const first = clip(line, 200);
  const rest = [first === cleanQuote(line) ? '' : line.trim(), more.join('\n').trim()].filter(Boolean).join('\n\n');
  return { first, rest: rest || undefined };
}

// The quote a pinned task's detail, or a pinned question's context, carries.
function pinnedFrom(located: Located, block: Block, quote: string): string {
  return `Pinned from ${blockLabel(block)} ${where(located)}:\n> ${quote}`;
}
