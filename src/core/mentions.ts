// @-mentions: a person (or an agent) pointing a comment or a request at one of
// the board's agents or people by name, e.g. "@Codex can you review the diff?".
// The board's agents are derived, never stored: the names seen in presence
// (agents connected now, from ?agent= on their MCP URL) and the agents who
// wrote its events. Its people are those who acted on it (peopleOn). Names
// match case-insensitively; a mention is kept by the name as the board spells
// it, and an @word that names nobody known stays plain text (an npm scope,
// an email). A mentioned agent reads the item as asked of it; other agents
// read it as for that agent, and leave it. An agent's mention of another
// agent reads the same, within the loop guard (agentTalk.ts). A mentioned
// person is told: on a decision it is also an ask (asks on decisions);
// elsewhere it is news in their Needs you until they've seen it
// (attention.ts, needs.ts).

import type { Element, ElementContent, Root, RootContent } from 'hast';
import { heldWords } from './agentTalk';
import { answerContext, decisionDiscussion, pinDiscussion, quote, taskDiscussion, type Discussion, type Shown } from './answering';
import { askingWords } from './connectors';
import { clip, listNames, peopleOn, samePerson } from './format';
import { answeredBy } from './reactions';
import type { Actor, Board, BoardEvent, Comment, Decision, Pin, Reaction, SkillRequest, Task } from './types';

export interface Mention {
  name: string; // as the board spells it
  start: number; // where the @ is
  end: number; // just after the name
}

// The board's agents, by name: those present now first, in the order given,
// then the others who wrote its events, most recent first. Spelled as presence
// has them, else as their latest event does.
export function boardAgents(board: Pick<Board, 'activity'>, present: string[] = []): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !names.some((n) => samePerson(n, trimmed))) names.push(trimmed);
  };
  present.forEach(add);
  for (const { actor } of board.activity.actors) if (actor.kind === 'agent') add(actor.name);
  return names;
}

// The board's people, by name, most recently active first.
export function boardPeople(board: Pick<Board, 'activity'>): string[] {
  return peopleOn(board).map((p) => p.name);
}

// A mention starts a word: not mid-word or mid-address (me@example.com), and
// the name ends one (@Claude isn't in @Claudette).
const BEFORE = /[\p{L}\p{N}_.@/-]/u;
const AFTER = /[\p{L}\p{N}_]/u;

// The @mentions in a text of the names given, in order. A longer name wins
// where two fit ("@Claude Code" over "@Claude"); case doesn't matter.
export function findMentions(text: string, names: string[]): Mention[] {
  const known = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (known.length === 0) return [];
  const found: Mention[] = [];
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (at > 0 && BEFORE.test(text[at - 1])) continue;
    const rest = text.slice(at + 1).toLowerCase();
    const name = known.find((n) => rest.startsWith(n.toLowerCase()) && !AFTER.test(text[at + 1 + n.length] ?? ''));
    if (!name) continue;
    found.push({ name, start: at, end: at + 1 + name.length });
    at += name.length;
  }
  return found;
}

// Who a text mentions, once each, in the order they first appear.
export function resolveMentions(text: string, names: string[]): string[] {
  const mentioned: string[] = [];
  for (const { name } of findMentions(text, names)) if (!mentioned.some((n) => samePerson(n, name))) mentioned.push(name);
  return mentioned;
}

// A text without the mentions it opens with, which only say who it's for:
// "@Codex can you review it?" reads "can you review it?". Unknown names, and
// mentions later on, stay. Text that is all mentions stays as it is.
export function withoutLeadingMentions(text: string, names: string[]): string {
  let rest = text.trimStart();
  for (;;) {
    const [first] = findMentions(rest, names);
    if (!first || first.start !== 0) break;
    rest = rest.slice(first.end).replace(/^[\s,:;-]+/, '');
  }
  return rest.trim() ? rest : text;
}

// The names a text opens with, and the text after them (a suffix of it):
// "@Codex @Sam /review the diff" opens with Codex and Sam.
export function leadingMentions(text: string, names: string[]): { names: string[]; rest: string } {
  const opening: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    const [first] = findMentions(rest, names);
    if (!first || first.start !== 0) break;
    opening.push(first.name);
    rest = rest.slice(first.end).replace(/^[\s,:;-]+/, '');
  }
  return { names: opening, rest };
}

// A question typed with who it's for, as the Decisions tab's chat bar posts it
// while no agent listens (web/threads.tsx):
// "Should the export include closed cards? @Claude explore it". The question
// is what comes before the first mention, or when the text opens with one, the
// text without its mentions. From that mention on is a comment for the new
// decision, which points it at whoever it names, as any comment does. Text
// that mentions no one known is all question.
export function splitQuestion(text: string, names: string[]): { question: string; comment?: string } {
  const mentions = findMentions(text, names);
  if (mentions.length === 0) return { question: text.trim() };
  const before = text.slice(0, mentions[0].start).replace(/[\s,;:–—-]+$/, '');
  let question = before.trim();
  if (!question) {
    let rest = '';
    let at = 0;
    for (const { start, end } of mentions) {
      rest += text.slice(at, start);
      at = end;
    }
    rest += text.slice(at);
    // Tidy the gaps the mentions leave: "@Codex, @Claude: retry, @Sam?" reads "retry?".
    question = rest
      .replace(/\s+/g, ' ')
      .replace(/[\s,;:–—-]+([.?!]|$)/g, '$1')
      .replace(/ ([,;:])/g, '$1')
      .replace(/^[\s,.;:–—-]+/, '');
  }
  return { question, comment: text.slice(mentions[0].start).trim() };
}

// The agents among a list of mentions: the names that aren't the board's
// people. (A mention only resolves to a known agent or person, so the rest
// are agents.)
export function agentsIn(board: Pick<Board, 'activity'>, mentions: string[] | undefined): string[] {
  if (!mentions?.length) return [];
  const people = boardPeople(board);
  return mentions.filter((m) => !people.some((p) => samePerson(p, m)));
}

export function peopleIn(board: Pick<Board, 'activity'>, mentions: string[] | undefined): string[] {
  if (!mentions?.length) return [];
  const people = boardPeople(board);
  return mentions.filter((m) => people.some((p) => samePerson(p, m)));
}

// How an item reads to an agent: asked of it, for other agents, or for
// whoever takes it (no agent mentioned), which is how unmentioned items read.
export type Addressed = { to: 'you' } | { to: 'others'; agents: string[] } | { to: 'anyone' };

export function addressedTo(agents: string[], viewer: string | undefined): Addressed {
  if (agents.length === 0) return { to: 'anyone' };
  if (viewer && agents.some((a) => samePerson(a, viewer))) return { to: 'you' };
  return { to: 'others', agents };
}

// The comment (or thread message) that @-mentions this agent and waits on
// it: the latest one by someone else, with nothing from it since, and no 👍
// or 👎 of its on it (core/reactions.ts), which answers it. An agent's
// mention the loop guard holds (agentTalk.ts) asks nothing of it.
export function waitingMention<T extends { author: Actor; mentions?: string[]; reactions?: Reaction[]; held?: number }>(comments: T[] | undefined, me: string): T | undefined {
  let waiting: T | undefined;
  for (const comment of comments ?? []) {
    if (samePerson(comment.author.name, me)) waiting = undefined;
    else if (!comment.held && comment.mentions?.some((m) => samePerson(m, me))) waiting = comment;
  }
  return waiting && !answeredBy(waiting, me) ? waiting : undefined;
}

// Whether a comment asks this person something they haven't answered: it is
// someone else's and @-mentions them, and they haven't commented after it in
// the same thread, nor answered it with a 👍 or 👎. The "asks you" tag.
export function asksYou(comment: Comment, thread: Comment[], me: string): boolean {
  const mine = (c: Comment) => c.author.kind === 'human' && samePerson(c.author.name, me);
  if (!me || mine(comment) || !comment.mentions?.some((m) => samePerson(m, me))) return false;
  if (answeredBy(comment, me)) return false;
  return !thread.slice(thread.indexOf(comment) + 1).some(mine);
}

function who(actor: Actor): string {
  return `${actor.name} (${actor.kind})`;
}

// A comment asking an agent, after the words naming it: whole, or for one its
// session has read, that it has (answering.ts).
function heard(comment: Comment, shown: Shown | undefined): string {
  return quote(withoutLeadingMentions(comment.body, comment.mentions ?? []), comment.id, shown);
}

// A skill request, as the agent it asks reads it: "asks you to run
// /avoid-ai-writing", its arguments, and how its reply is marked (skills.ts).
export function asksYouToRun(skill: SkillRequest | undefined, viewer: string | undefined): skill is SkillRequest {
  return Boolean(skill && viewer && skill.agents.some((a) => samePerson(a, viewer)));
}

export function skillArgs(skill: SkillRequest): string {
  return skill.args ? `: "${clip(skill.args, 300)}"` : '';
}

// A Tricot skill carries its instructions to the agents that have no skill of
// that name of their own (core/skills.ts), who follow them from the request.
function carriesFor(skill: SkillRequest, viewer: string | undefined): string | undefined {
  return viewer && skill.tricot?.agents.some((a) => samePerson(a, viewer)) ? skill.tricot.instructions : undefined;
}

// "/review", or for an agent that gets the instructions, "the Tricot skill /release-notes".
export function skillCalled(skill: SkillRequest, viewer: string | undefined): string {
  return carriesFor(skill, viewer) === undefined ? `/${skill.name}` : `the Tricot skill /${skill.name}`;
}

export const INSTRUCTIONS_CLIP = 600;

// A request's instructions in an update line, on one line and cut short when
// long, with where the whole text is (none where there is no other place to
// read it: it is then given whole).
function instructionsIn(skill: SkillRequest, viewer: string | undefined, whole: string | undefined): string {
  const instructions = carriesFor(skill, viewer);
  if (instructions === undefined) return '';
  const flat = instructions.replace(/\s+/g, ' ').trim();
  if (!whole || flat.length <= INSTRUCTIONS_CLIP) return ` Its instructions: ${/[.!?:…]$/.test(flat) ? flat : `${flat}.`}`;
  return ` Its instructions (cut short; the whole text is in ${whole}): ${clip(flat, INSTRUCTIONS_CLIP)}`;
}

// "asks you to run /review on T98 [task id: …]: "args". Run it, then reply with
// comment(…); your reply shows "via /review"." A Tricot skill's goes: "asks you
// to run the Tricot skill /release-notes on T98 […]: "args". Its instructions: …
// Follow them, then reply with …". `place` is "on T98 [task id: …]" or "in
// thread …"; `whole` the tool that gives the instructions in full.
export function asksToRun(skill: SkillRequest, viewer: string | undefined, place: string, reply: string, whole: string | undefined): string {
  const follow = carriesFor(skill, viewer) === undefined ? 'Run it' : 'Follow them';
  return `asks you to run ${skillCalled(skill, viewer)} ${place}${skillArgs(skill)}.${instructionsIn(skill, viewer, whole)} ${follow}, then reply with ${reply}; your reply shows "via /${skill.name}".`;
}

// A request's instructions in full, as get_task, get_decision and get_thread
// show them under its comment: indented lines, none for another agent's
// request or for an agent that has the skill itself.
export function skillInstructionLines(skill: SkillRequest | undefined, viewer: string | undefined): string[] {
  const instructions = skill && viewer ? carriesFor(skill, viewer) : undefined;
  if (!skill || instructions === undefined) return [];
  return [`  Instructions of the Tricot skill /${skill.name}:`, ...instructions.split('\n').map((line) => `    ${line}`)];
}

// Where a comment is, for an agent: the card and how to answer there.
export interface Where {
  on: string; // T57, #12, the board context about "…"
  id: string; // [task id: …]
  reply: string; // comment(task_id: …)
  read?: string; // where a request's whole text is read: get_task
  discussion: Discussion; // the comments around it (answering.ts)
}

export const onTask = (task: Task): Where => ({
  on: `T${task.number}`,
  id: `[task id: ${task.id}]`,
  reply: `comment(task_id: ${task.id})`,
  read: 'get_task',
  discussion: taskDiscussion(task),
});
export const onDecision = (decision: Decision): Where => ({
  on: `#${decision.number}`,
  id: `[decision id: ${decision.id}]`,
  reply: `comment(decision_id: ${decision.id})`,
  read: 'get_decision',
  discussion: decisionDiscussion(decision),
});
export const onThread = (board: Board, pin: Pin): Where => ({
  on: `the board context, about "${clip(pin.quote, 60)}"`,
  id: `[pin id: ${pin.id}]`,
  reply: `comment(pin_id: ${pin.id})`,
  discussion: pinDiscussion(board, pin),
});

// Comments asking this agent something it hasn't answered yet, for get_board
// and its updates: "Sam asked you on T57: "…". Reply with comment(…)."
// Requests to edit a doc are named on their own (connectorAsks), as are
// requests on the board context (requestsDigest). With the agent's session
// (`shown`), one it has read says so instead of saying it again, and one an
// update above gave is left out.
export function mentionsDigest(board: Board, viewer: string | undefined, shown?: Shown): string | undefined {
  if (!viewer) return undefined;
  const lines = mentionsWaitingOn(board, viewer).flatMap(({ comment, where }) => {
    if (shown?.inThisResult(comment.id)) return [];
    const line = asksYouToRun(comment.skill, viewer)
      ? `${comment.author.name} ${asksToRun(comment.skill, viewer, `on ${where.on} ${where.id}`, where.reply, where.read)}`
      : `${comment.author.name} asked you on ${where.on} ${where.id}${heard(comment, shown)}. Reply with ${where.reply}.`;
    return [[line, ...answerContext(where.discussion, comment, viewer, shown)].join('\n')];
  });
  return lines.length ? lines.join('\n') : undefined;
}

// The comments mentionsDigest names: each card's that asks this agent
// something it hasn't answered, where it is, and its card's id (none on the
// board context).
export function mentionsWaitingOn(board: Board, viewer: string): { comment: Comment; where: Where; taskId?: string; decisionId?: string }[] {
  const found: ReturnType<typeof mentionsWaitingOn> = [];
  const add = (comments: Comment[] | undefined, where: () => Where, card: { taskId?: string; decisionId?: string } = {}) => {
    const comment = waitingMention(comments, viewer);
    if (!comment || comment.ask) return;
    if (!agentsIn(board, comment.mentions).some((a) => samePerson(a, viewer))) return;
    found.push({ comment, where: where(), ...card });
  };
  for (const task of board.tasks) add(task.comments, () => onTask(task), { taskId: task.id });
  for (const decision of board.decisions) add(decision.comments, () => onDecision(decision), { decisionId: decision.id });
  for (const pin of board.canvas.pins) if (pin.discussion?.thread && !pin.discussion.resolved) add(pin.discussion.thread, () => onThread(board, pin));
  return found;
}

// A comment or request event that @-mentions agents, as the agent reading its
// updates sees it: asked of it, or for another agent. None for one that
// mentions no agent, which reads as it always has. A comment asking it comes
// whole, with what its session (`shown`) needs to answer it (answering.ts).
export function mentionEventLine(event: BoardEvent, board: Board, viewer: string | undefined, shown?: Shown): string | undefined {
  if (event.type !== 'comment_added' && event.type !== 'request_asked') return undefined;
  const address = addressedTo(agentsIn(board, event.mentions), viewer);
  if (address.to === 'anyone') return undefined;
  const lead = `- (${event.seq}) ${who(event.actor)}`;
  if (event.type === 'request_asked') {
    const request = board.requests?.find((r) => r.id === event.itemId);
    const id = `[request id: ${event.itemId}]`;
    if (address.to === 'others') return `${lead} asked ${listNames(address.agents)} on the board context ${id}. Not for you; carry on.`;
    const text = request ? `: "${clip(withoutLeadingMentions(request.text, request.mentions ?? []), 300)}"` : '';
    return `${lead} asked you on the board context ${id}${text}. Take it with take_request.`;
  }
  const found = commentOf(event, board);
  if (!found) return undefined;
  const { comment, where } = found;
  if (address.to === 'others') return `${lead} asked ${listNames(address.agents)} on ${where.on} ${where.id}. Not for you; carry on.`;
  if (comment.held) return `${lead} mentioned you on ${where.on} ${where.id}: "${clip(withoutLeadingMentions(comment.body, comment.mentions ?? []), 200)}"; ${heldWords(comment.held)}.`;
  const doing = comment.ask ? (askingWords()?.doing ?? 'Reply') : 'Reply';
  const line = asksYouToRun(comment.skill, viewer)
    ? `${lead} ${asksToRun(comment.skill, viewer, `on ${where.on} ${where.id}`, where.reply, where.read)}`
    : `${lead} asked you on ${where.on} ${where.id}${heard(comment, shown)}. ${doing} with ${where.reply}.`;
  return [line, ...answerContext(where.discussion, comment, viewer, shown)].join('\n');
}

// The comment an event added, and where it is. The event names its comment;
// one logged before it did shares a timestamp with it, which two comments by
// the same person in the same millisecond do too.
function commentOf(event: BoardEvent, board: Board): { comment: Comment; where: Where } | undefined {
  const mine = (c: Comment) => (event.commentId ? c.id === event.commentId : c.createdAt === event.at && c.author.kind === event.actor.kind && c.author.name === event.actor.name);
  if (event.taskId) {
    const task = board.tasks.find((t) => t.id === event.taskId);
    const comment = task?.comments.find(mine);
    return task && comment ? { comment, where: onTask(task) } : undefined;
  }
  if (event.decisionId) {
    const decision = board.decisions.find((d) => d.id === event.decisionId);
    const comment = decision?.comments.find(mine);
    return decision && comment ? { comment, where: onDecision(decision) } : undefined;
  }
  const pin = board.canvas.pins.find((p) => p.id === event.itemId);
  const comment = pin?.discussion?.thread?.find(mine);
  return pin && comment ? { comment, where: onThread(board, pin) } : undefined;
}

// A comment's tag in get_task and get_decision, for the agent reading it.
export function mentionTag(board: Board, comment: Comment, viewer: string | undefined): string {
  const address = addressedTo(agentsIn(board, comment.mentions), viewer);
  if (address.to === 'you' && comment.held) return ` (mentions you; ${heldWords(comment.held)})`;
  if (address.to === 'you') return asksYouToRun(comment.skill, viewer) ? ` (asks you to run ${skillCalled(comment.skill, viewer)})` : ' (asks you)';
  return address.to === 'others' ? ` (for ${listNames(address.agents)}: not for you)` : '';
}

// Rendered Markdown that is never a mention: code is quoted as written, and a
// link already goes somewhere.
const SKIP = new Set(['code', 'pre', 'kbd', 'samp', 'a']);

// A rehype plugin that marks a comment's mentions in its rendered Markdown as
// <span class="mention" data-mention="Codex">@Codex</span>, for the UI to
// draw as chips. Only the names given are marked: the comment's mentions.
export function rehypeMentions({ names }: { names: string[] }) {
  return (tree: Root) => {
    if (names.length === 0) return;
    const walk = (parent: Root | Element) => {
      parent.children = (parent.children as RootContent[]).flatMap((child): RootContent[] => {
        if (child.type === 'element' && !SKIP.has(child.tagName)) walk(child);
        if (child.type !== 'text') return [child];
        const pieces: ElementContent[] = [];
        let at = 0;
        for (const mention of findMentions(child.value, names)) {
          if (mention.start > at) pieces.push({ type: 'text', value: child.value.slice(at, mention.start) });
          pieces.push({
            type: 'element',
            tagName: 'span',
            properties: { className: ['mention'], dataMention: mention.name },
            children: [{ type: 'text', value: child.value.slice(mention.start, mention.end) }],
          });
          at = mention.end;
        }
        if (pieces.length === 0) return [child];
        if (at < child.value.length) pieces.push({ type: 'text', value: child.value.slice(at) });
        return pieces;
      }) as never[];
    };
    walk(tree);
  };
}
