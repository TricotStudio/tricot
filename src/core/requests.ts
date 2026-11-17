// People asking agents on the board context: "Get me an architecture view of
// the project". Like a sync, it is a light request, not a task. A person asks;
// an agent takes it, which makes a group on the board context titled from the
// request; the agent builds its answer there as blocks and finishes it with a
// note. A person can cancel it until it's done. These are the rules for that,
// and how agents and people read it.
//
// On a Sketchbook page a person asks about blocks they selected there:
// the blocks are the context of what they type in the page's chat bar,
// and the agent makes what fits: a decision, tasks, blocks or an
// answer, and says why in its note. Its group is made beside the blocks as it
// is asked, so the answer lands by what it is about. A decision or tasks made
// for it (post_decision or plan_tasks with request_id) are pinned to its
// blocks and show in its group. Requests asked before the page chat bar did may name what they
// want (`kind`: a decision, or tasks), and the card they ask for finishes them.
//
// A message sent with blocks selected starts a thread about
// them instead (core/threadSelection.ts): agents talk it through there and
// make a decision, tasks or blocks only once the person asks or agrees. What
// is below is how a request already asked on a page is still answered.

import { askedKind, requestCardIds } from './askedCards';
import { boardCardKinds, cardOf } from './cards';
import { blockName, GROUP_HEADER, GROUP_PADDING } from './canvas';
import { clip, listNames, samePerson } from './format';
import type { AgentBrowserHalf } from './agents/agent';
import { asHeard, withoutLeadingMentions } from './mentions';
import { pageName } from './scratchPad';
import { LIMITS } from './schemas/limits';
import type { Actor, Block, Board, Canvas, ContextRequest, Group, ScratchPage } from './types';
import type { Told } from './words';

export const REQUEST_TEXT_LIMIT = LIMITS.request;
// The open and working ones are always kept; the rest only the latest few, so
// a finished one's group still says who asked for it.
export const KEPT_REQUESTS = 20;
const TITLE_LENGTH = 48;

// What people can start from: each fills the input with its text, which an
// agent's group is then titled after (its label).
export const STARTERS: { label: string; text: string }[] = [
  { label: 'Architecture view', text: 'Get me an architecture view of the project' },
  { label: "What's left to build", text: "What's left to build?" },
  { label: 'Risks and open questions', text: 'List the risks and open questions' },
  { label: 'Timeline so far', text: 'Draw a timeline of the project so far' },
];

// Openers that ask rather than say what's wanted: "hey, can you please",
// then one verb ("get me", "draw") and one article.
const POLITE = [
  /^(?:please|pls|hey|hi|ok|okay|so|now|and)\b[\s,:]*/i,
  /^(?:can|could|would|will) (?:you|we|someone|an agent)\b\s*/i,
  /^(?:i'd|i would|we'd|we would) (?:like|love)\b(?: to (?:see|have|get)\b)?\s*/i,
  /^(?:i|we) (?:want|need)\b(?: to (?:see|have|get)\b)?\s*/i,
  /^let'?s\b\s*/i,
  /^help (?:me|us)\b(?: to\b)?\s*/i,
];
const VERB =
  /^(?:get|give|show|make|find|bring|fetch|draw|build|create|generate|write|produce|prepare|sketch|draft|compile|summari[sz]e|outline|describe|list|explain|map(?: out)?|put together|lay out|pull together|add|do)\b\s*(?:(?:me|us)\b\s*)?/i;
const ARTICLE = /^(?:a|an|the|some)\b\s+/i;
// What every request is about anyway: "of the project", "for this board".
const ABOUT_THE_PROJECT = /\s+(?:of|for|on|about|in) (?:the|this|our) (?:project|board|app|codebase|repo|work)(?=$|[\s,.;:!?])/gi;
const TRAILING = /(?:[\s,.;:!?]+|\s+(?:please|for (?:me|us)|thanks|thank you))+$/i;

// A short title for a request's group, from its text: its first sentence,
// without the asking, e.g. "Get me an architecture view of the project" reads
// "Architecture view". Text that is all asking keeps its own words. The
// agents it opens by mentioning ("@Codex get me…", "@Claude:opus get me…")
// only say who it's for.
export function requestTitle(text: string, mentions: string[] = []): string {
  const flat = withoutLeadingMentions(text, mentions, mentions).replace(/\s+/g, ' ').trim();
  const first = flat.split(/(?<=[.?!])\s/)[0];
  let title = first;
  for (let before = ''; before !== title; ) {
    before = title;
    for (const opener of POLITE) title = title.replace(opener, '');
  }
  title = title.replace(VERB, '').replace(ARTICLE, '').replace(ABOUT_THE_PROJECT, '').replace(TRAILING, '').trim();
  if (!title) title = first.replace(/[\s.?!]+$/, '') || flat;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (title.length <= TITLE_LENGTH) return title;
  const cut = title.slice(0, TITLE_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`;
}

// Whether the person left the question, or what to plan, to agents: said
// nothing, or only who it's for, so the words that stand for theirs (what its
// kind of card says, core/askedCards.ts) are all it holds.
export function leftToAgents(request: Pick<ContextRequest, 'kind' | 'text' | 'mentions'>): boolean {
  const agents = request.mentions ?? [];
  const asked = askedKind(request.kind)?.asked;
  return Boolean(asked && withoutLeadingMentions(request.text, agents, agents) === asked.asked);
}

// Where a request's group is: the page it was asked on, or the board context.
// None for a page that has been deleted since.
export function requestCanvas(board: Pick<Board, 'canvas' | 'pages'>, request: Pick<ContextRequest, 'pageId'>): { canvas: Canvas; page?: ScratchPage } | undefined {
  if (!request.pageId) return { canvas: board.canvas };
  const page = board.pages?.find((p) => p.id === request.pageId);
  return page && { canvas: page.canvas, page };
}

export function requestGroup(board: Pick<Board, 'canvas' | 'pages'>, request: Pick<ContextRequest, 'pageId' | 'groupId'>): Group | undefined {
  return requestCanvas(board, request)?.canvas.groups.find((g) => g.id === request.groupId);
}

// The blocks a request is about that are still on its page, in canvas order.
export function requestBlocks(board: Pick<Board, 'canvas' | 'pages'>, request: Pick<ContextRequest, 'pageId' | 'blockIds'>): Block[] {
  const ids = new Set(request.blockIds ?? []);
  return ids.size ? (requestCanvas(board, request)?.canvas.blocks.filter((b) => ids.has(b.id)) ?? []) : [];
}

// Where a request was asked, in words: on the board context, or on its page.
export function requestPlace(board: Pick<Board, 'canvas' | 'pages'>, request: Pick<ContextRequest, 'pageId'>): string {
  const page = requestCanvas(board, request)?.page;
  return page ? `on ${pageName(page)} [page id: ${page.id}]` : request.pageId ? 'on a Sketchbook page deleted since' : 'on the board context';
}

// The blocks a request is about, as agents read them: note "Pricing" [id: b1], image [id: b2].
function aboutBlocks(blocks: Block[]): string {
  if (blocks.length === 0) return 'the blocks it was about have been removed since';
  const named = blocks.slice(0, 8).map((b) => `${blockName(b, 40)} [id: ${b.id}]`);
  return blocks.length > named.length ? `${named.join(', ')} and ${blocks.length - named.length} more` : listNames(named);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// What a request asks, as its event and agents say it: "for a decision about 2
// blocks on Sketchbook page "Pricing"". Empty for one on the board context.
export function askedAbout(board: Pick<Board, 'canvas' | 'pages'>, request: ContextRequest): string {
  if (!request.pageId) return '';
  const blocks = count(request.blockIds?.length ?? 0, 'block');
  const page = requestCanvas(board, request)?.page;
  const on = page ? ` on ${pageName(page)}` : '';
  return askedKind(request.kind)?.asked.about(blocks, on) ?? ` about ${blocks}${on}`;
}

// The cards a request names that the board still has, of each kind registered in turn: its decisions, then its tasks.
// `request` is whatever names cards by `<kind>Ids` (core/askedCards.ts): a request, or a thread's cards.
function cardsNamed(board: Board, request: object) {
  return boardCardKinds().map((kind) => {
    const ids = requestCardIds(request, kind.kind);
    return { kind, named: ids.length, found: ids.flatMap((id) => cardOf(board, kind.kind, id) ?? []) };
  });
}

// The cards made for a request, as text: #12, T41 and T42.
export function requestCards(board: Board, request: object): string[] {
  return cardsNamed(board, request).flatMap(({ found }) => found.map((card) => card.label));
}

// The space between the blocks a request's group shows its cards in.
const CARD_GAP = 10;

// How tall a request's group must be for the cards made for it (how each kind of card shows, `BoardCardKind.heights`).
export function requestCardsHeight(board: Board, request: object): number {
  const heights = cardsNamed(board, request).flatMap(({ kind, named, found }) => kind.heights?.(found.map((card) => card.card), named) ?? []);
  if (heights.length === 0) return 0;
  return GROUP_HEADER + heights.reduce((a, b) => a + b, 0) + CARD_GAP * (heights.length - 1) + GROUP_PADDING;
}

export function isActive(request: ContextRequest): boolean {
  return request.status === 'open' || request.status === 'working';
}

const sameAgent = (a: Actor | undefined, b: Actor) => a?.kind === b.kind && a.name === b.name;

// How a request is named in messages: its group's title once it has one.
function named(board: Board, request: ContextRequest): string {
  const group = requestGroup(board, request);
  return `"${clip(group?.title ?? requestTitle(request.text, request.mentions), 60)}"`;
}

// Whether a request @-mentions this agent, or no agent: one that mentions
// agents is theirs alone.
export function requestFor(request: ContextRequest, agent: string): boolean {
  return !request.mentions?.length || request.mentions.some((m) => samePerson(m, agent));
}

// Why an agent can't take a request, or nothing if it can. Taking one it
// already took is fine: it gets the same group back.
export function takeRefusal(board: Board, request: ContextRequest, actor: Actor): string | undefined {
  const name = named(board, request);
  if (actor.kind !== 'agent') return 'Only agents take a request on the board context; people ask, and can cancel one.';
  switch (request.status) {
    case 'open':
      if (requestFor(request, actor.name)) return undefined;
      return `${request.by.name} asked ${listNames(request.mentions!)} for ${name}, so only ${listNames(request.mentions!)} can take it. Take a request addressed to you or to no agent.`;
    case 'working':
      return sameAgent(request.takenBy, actor) ? undefined : `${request.takenBy!.name} already took ${name}: it's theirs to finish.`;
    case 'done':
      return `${name} is done: ${request.takenBy?.name ?? 'an agent'} finished it.`;
    case 'cancelled':
      return `${request.by.name}'s request ${name} was cancelled, so there's nothing to take.`;
  }
}

// Why an agent can't finish a request, or nothing if it can: only the agent
// who took it finishes it.
export function finishRefusal(board: Board, request: ContextRequest, actor: Actor): string | undefined {
  const name = named(board, request);
  if (actor.kind !== 'agent') return 'Only the agent who took a request finishes it; people can cancel it instead.';
  switch (request.status) {
    case 'open':
      return `Nobody has taken ${name} yet: take it with take_request, build the answer in its group, then finish_request.`;
    case 'working':
      return sameAgent(request.takenBy, actor) ? undefined : `${request.takenBy!.name} took ${name}, so only they finish it.`;
    case 'done':
      return `${name} is already done: ${request.takenBy?.name ?? 'an agent'} finished it.`;
    case 'cancelled':
      return `${request.by.name}'s request ${name} was cancelled, so there's nothing to finish. What you added stays in its group.`;
  }
}

// Why someone can't cancel a request, or nothing if they can: only people
// cancel. Only an open or working one changes (see isActive); cancelling one
// that's over is no error, it's over either way.
export function cancelRefusal(actor: Actor): string | undefined {
  return actor.kind === 'human' ? undefined : 'Only people cancel a request; finish it with finish_request instead.';
}

// The requests a board keeps after adding one: every open or working one,
// those `stays` says to keep (one whose group on a page still shows the cards
// it led to), and the latest others, up to KEPT_REQUESTS in all.
export function keptRequests(requests: ContextRequest[], keep = KEPT_REQUESTS, stays: (r: ContextRequest) => boolean = () => false): ContextRequest[] {
  let over = requests.length - keep;
  if (over <= 0) return requests;
  return requests.filter((r) => isActive(r) || stays(r) || over-- <= 0);
}

// The request a group on the board context or a Sketchbook page answers, if
// any: the latest one made it, should there be more than one.
export function requestOfGroup(board: Board, groupId: string): ContextRequest | undefined {
  return board.requests?.findLast((r) => r.groupId === groupId);
}

// People's open requests, and the ones agents are answering, for agents.
// Named when an agent reads the board, catches up or waits. One that
// mentions agents reads as asked of the agent reading it, or as theirs, with
// what a tag asks of it (`kind`: which agent it is, mentions.ts taggedAsk).
// One about blocks on a Sketchbook page names them, and says how to answer
// what it asks for. A request whose page is gone asks for nothing. A request on the
// board context is named only where a tool group offers it, and one that asks for a card (a decision, tasks) only where
// a group offers cards (`told`, core/words.ts): without them it is no request an agent can answer.
export function requestsDigest(board: Board, viewer?: string, kind?: AgentBrowserHalf, told?: Told): string | undefined {
  const lines = (board.requests ?? []).filter((r) => isActive(r) && answerable(r, told) && requestCanvas(board, r)).map((r) => {
    const where = requestPlace(board, r);
    if (r.status === 'open') {
      const take = `Take it with take_request, ${answerHow(board, r, told)}`;
      const agents = r.mentions ?? [];
      const what = r.pageId ? `${askedAbout(board, r).trim()} [page id: ${r.pageId}; request id: ${r.id}]: ${aboutBlocks(requestBlocks(board, r))}` : '';
      if (agents.length === 0) {
        if (r.pageId) return `${r.by.name} asked agents ${what}. ${askedWords(r, r.text)} ${take}`;
        return `${r.by.name} asked agents ${where} [request id: ${r.id}]: "${clip(r.text, 300)}". ${take}`;
      }
      const text = `"${clip(withoutLeadingMentions(r.text, agents, agents), 300)}"`;
      if (viewer && requestFor(r, viewer)) {
        const read = asHeard(board, { author: r.by, text: r.text, mentions: agents }, viewer, kind);
        if (r.pageId) return `${r.by.name} asked you ${what}. ${askedWords(r, read.text)}${read.ask} ${take}`;
        return `${r.by.name} asked you ${where} [request id: ${r.id}]: "${clip(read.text, 300)}".${read.ask} ${take}`;
      }
      const only = `only ${listNames(agents)} can take it`;
      const asked = r.pageId ? `${askedAbout(board, r).trim()} [request id: ${r.id}]` : `${where} [request id: ${r.id}]: ${text}`;
      return `${r.by.name} asked ${listNames(agents)} ${asked}. For ${listNames(agents)}: ${viewer ? `${only}; not for you, carry on.` : `${only}.`}`;
    }
    const group = requestGroup(board, r);
    const into = group ? `in group "${clip(group.title, 60)}" [group id: ${group.id}]${r.pageId ? ` ${where}` : ''}` : 'though its group is gone';
    return `${r.takenBy!.name} is answering ${r.by.name}'s request [request id: ${r.id}] "${clip(r.text, 120)}" ${into}: ${r.kind || r.pageId ? answerHow(board, r, told) : 'finish_request with a one-line note once the answer is in.'}`;
  });
  return lines.length ? lines.join('\n') : undefined;
}

// Whether an agent can answer a request on a server that says what `told` does: one on a page, one on the board context
// where a group offers it, and not one that asks for a card (a decision or tasks) where none offers cards.
export function answerable(request: ContextRequest, told?: Told): boolean {
  if (request.kind && !told?.offers('cards')) return false;
  return Boolean(request.pageId) || (told?.offers('board-context') ?? false);
}

// What the person said, on a page: their words, or that they left it to agents.
function askedWords(request: ContextRequest, text: string): string {
  const asked = askedKind(request.kind)?.asked;
  if (asked && leftToAgents(request)) return asked.left;
  return asked ? asked.said(text) : `They asked: "${clip(text, 300)}".`;
}

// How to answer a request, after taking it: with the card it asks for, or as blocks in its group.
function answerHow(board: Board, request: ContextRequest, told?: Told): string {
  const asked = askedKind(request.kind)?.asked;
  if (asked) return asked.answerHow(board.id, request.id);
  if (request.pageId) return pageAnswerHow(board.id, request.id, request.pageId, undefined, told);
  return 'build the answer as blocks in its group, then finish_request with a one-line note.';
}

// How to answer what a person asked about blocks on a page, leaving what to
// make to the agent: what fits, pinned to the blocks, and why. A group that
// offers cards says the card it may make (`request.how.page`); the core's words are
// blocks in its group.
export function pageAnswerHow(boardId: string, requestId: string, pageId: string, groupId?: string, told?: Told): string {
  const group = groupId ? `group_id: ${groupId}` : 'its group_id';
  const made = told?.line('request.how.page', { board: boardId, request: requestId, page: pageId, group });
  if (made) return made;
  return [
    `read the blocks (get_canvas with page_id: ${pageId}) and answer what they asked with blocks in its group:`,
    `a view, a draft or a plain answer (add_block with page_id: ${pageId} and ${group}).`,
    "Then finish_request with a note saying what you made and why it fits what they asked: it's your reply to them.",
  ].join(' ');
}

// What get_canvas says on the heading of a group that answers a request: the
// request, the blocks it is about on a page, and the cards made for it.
export function requestHeading(board: Board, groupId: string, told?: Told): string {
  const request = requestOfGroup(board, groupId);
  if (!request || (request.kind && !told?.offers('cards'))) return '';
  const asked = `${request.by.name}'s request [request id: ${request.id}] "${clip(request.text, 120)}"`;
  const blocks = requestBlocks(board, request);
  const about = blocks.length ? ` about ${listNames(blocks.map((b) => blockName(b, 40)))}` : '';
  const cards = told?.offers('cards') ? requestCards(board, request) : [];
  const made = cards.length ? `, led to ${listNames(cards)}` : '';
  if (request.status === 'working') return ` · answers ${asked}${about}, taken by ${request.takenBy!.name}${made}`;
  if (request.status === 'done') return ` · answered ${asked}${about}, finished by ${request.takenBy!.name}${made}`;
  return request.status === 'cancelled' ? ` · ${asked}${about} was cancelled` : ` · for ${asked}${about}, waiting for an agent`;
}
