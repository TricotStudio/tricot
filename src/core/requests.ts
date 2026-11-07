// People asking agents on the board context: "Get me an architecture view of
// the project". Like a sync, it is a light request, not a task. A person asks;
// an agent takes it, which makes a group on the board context titled from the
// request; the agent builds its answer there as blocks and finishes it with a
// note. A person can cancel it until it's done. These are the rules for that,
// and how agents and people read it.

import { clip, listNames, samePerson } from './format';
import type { AgentBrowserHalf } from './agents/agent';
import { asHeard, withoutLeadingMentions } from './mentions';
import { LIMITS } from './schemas/limits';
import type { Actor, Board, ContextRequest } from './types';

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

export function isActive(request: ContextRequest): boolean {
  return request.status === 'open' || request.status === 'working';
}

const sameAgent = (a: Actor | undefined, b: Actor) => a?.kind === b.kind && a.name === b.name;

// How a request is named in messages: its group's title once it has one.
function named(board: Board, request: ContextRequest): string {
  const group = board.canvas.groups.find((g) => g.id === request.groupId);
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
// and the latest others, up to KEPT_REQUESTS in all.
export function keptRequests(requests: ContextRequest[], keep = KEPT_REQUESTS): ContextRequest[] {
  let over = requests.length - keep;
  if (over <= 0) return requests;
  return requests.filter((r) => isActive(r) || over-- <= 0);
}

// The request a group on the board context answers, if any: the latest one
// made it, should there be more than one.
export function requestOfGroup(board: Board, groupId: string): ContextRequest | undefined {
  return board.requests?.findLast((r) => r.groupId === groupId);
}

// People's open requests, and the ones agents are answering, for agents.
// Named when an agent reads the board, catches up or waits. One that
// mentions agents reads as asked of the agent reading it, or as theirs, with
// what a tag asks of it (`kind`: which agent it is, mentions.ts taggedAsk).
export function requestsDigest(board: Board, viewer?: string, kind?: AgentBrowserHalf): string | undefined {
  const lines = (board.requests ?? []).filter(isActive).map((r) => {
    if (r.status === 'open') {
      const take = 'Take it with take_request, build the answer as blocks in its group, then finish_request with a one-line note.';
      const agents = r.mentions ?? [];
      if (agents.length === 0) return `${r.by.name} asked agents on the board context [request id: ${r.id}]: "${clip(r.text, 300)}". ${take}`;
      const text = `"${clip(withoutLeadingMentions(r.text, agents, agents), 300)}"`;
      if (viewer && requestFor(r, viewer)) {
        const read = asHeard(board, { author: r.by, text: r.text, mentions: agents }, viewer, kind);
        return `${r.by.name} asked you on the board context [request id: ${r.id}]: "${clip(read.text, 300)}".${read.ask} ${take}`;
      }
      const only = `only ${listNames(agents)} can take it`;
      return `${r.by.name} asked ${listNames(agents)} on the board context [request id: ${r.id}]: ${text}. For ${listNames(agents)}: ${viewer ? `${only}; not for you, carry on.` : `${only}.`}`;
    }
    const group = board.canvas.groups.find((g) => g.id === r.groupId);
    const where = group ? `in group "${clip(group.title, 60)}" [group id: ${group.id}]` : 'though its group is gone';
    return `${r.takenBy!.name} is answering ${r.by.name}'s request [request id: ${r.id}] "${clip(r.text, 120)}" ${where}: finish_request with a one-line note once the answer is in.`;
  });
  return lines.length ? lines.join('\n') : undefined;
}

// What get_canvas says on the heading of a group that answers a request.
export function requestHeading(board: Board, groupId: string): string {
  const request = requestOfGroup(board, groupId);
  if (!request) return '';
  const asked = `${request.by.name}'s request [request id: ${request.id}] "${clip(request.text, 120)}"`;
  if (request.status === 'working') return ` · answers ${asked}, taken by ${request.takenBy!.name}`;
  if (request.status === 'done') return ` · answered ${asked}, finished by ${request.takenBy!.name}`;
  return request.status === 'cancelled' ? ` · ${asked} was cancelled` : ` · for ${asked}`;
}
