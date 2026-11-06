// Reading Linear as the connected account: an issue by its identifier, and a
// search by text. Read-only: nothing here writes to Linear. A card is kept for
// a minute, and a card asked for twice at once is looked up once, so a board
// full of Linear links stays within Linear's rate limit.

import type { LinearCard } from '../../../core/connectors/linear/issue';
import type { LinearConnector } from './connector';

// What a card shows, for an issue as GraphQL names it.
const CARD_FIELDS = 'identifier title url updatedAt priorityLabel state { name type } assignee { name displayName } team { name }';
const DETAIL_FIELDS = `${CARD_FIELDS} description createdAt dueDate estimate creator { name displayName } project { name } parent { identifier title } labels(first: 20) { nodes { name } }`;

const ISSUE = `query Issue($id: String!) { issue(id: $id) { ${DETAIL_FIELDS} } }`;
const SEARCH = `query Search($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) { totalCount nodes { ${CARD_FIELDS} } } }`;

const FRESH = 60_000;
const MAX_CARDS = 300;

interface Person {
  name?: string | null;
  displayName?: string | null;
}

interface RawIssue {
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  priorityLabel?: string | null;
  state?: { name?: string; type?: string } | null;
  assignee?: Person | null;
  team?: { name?: string } | null;
  description?: string | null;
  createdAt?: string;
  dueDate?: string | null;
  estimate?: number | null;
  creator?: Person | null;
  project?: { name?: string } | null;
  parent?: { identifier: string; title: string } | null;
  labels?: { nodes?: { name: string }[] } | null;
}

// An issue with what an agent reads of it besides what a card shows.
export interface LinearDetail extends LinearCard {
  description: string;
  createdAt?: string;
  dueDate?: string;
  estimate?: number;
  creator?: string;
  project?: string;
  parent?: { identifier: string; title: string };
  labels: string[];
}

export interface LinearSearch {
  total: number;
  issues: LinearCard[];
}

const person = (who?: Person | null): string | null => who?.displayName?.trim() || who?.name?.trim() || null;

function toCard(raw: RawIssue): LinearCard {
  return {
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    status: { name: raw.state?.name ?? 'Unknown', kind: raw.state?.type ?? '' },
    assignee: person(raw.assignee),
    priority: raw.priorityLabel || 'No priority',
    team: raw.team?.name ?? '',
    updatedAt: raw.updatedAt,
  };
}

function toDetail(raw: RawIssue): LinearDetail {
  return {
    ...toCard(raw),
    description: raw.description ?? '',
    ...(raw.createdAt ? { createdAt: raw.createdAt } : {}),
    ...(raw.dueDate ? { dueDate: raw.dueDate } : {}),
    ...(typeof raw.estimate === 'number' ? { estimate: raw.estimate } : {}),
    ...(person(raw.creator) ? { creator: person(raw.creator)! } : {}),
    ...(raw.project?.name ? { project: raw.project.name } : {}),
    ...(raw.parent ? { parent: raw.parent } : {}),
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
  };
}

export class LinearReader {
  private cards = new Map<string, { at: number; card: LinearCard }>();
  private looking = new Map<string, Promise<LinearCard>>();
  private session?: string;

  constructor(private readonly linear: LinearConnector) {}

  // An issue's card, by its identifier ("ENG-123"). Throws a LinearError saying why when it can't be had.
  async card(identifier: string, fresh = false): Promise<LinearCard> {
    this.forgetOnNewSignIn();
    const known = this.cards.get(identifier);
    if (!fresh && known && this.linear.now() - known.at < FRESH) return known.card;
    const running = this.looking.get(identifier);
    if (running) return running;
    const lookup = this.linear
      .graphql<{ issue: RawIssue }>(ISSUE, { id: identifier })
      .then(({ issue }) => {
        const card = toCard(issue);
        if (this.cards.size >= MAX_CARDS) this.cards.delete(this.cards.keys().next().value!);
        this.cards.set(identifier, { at: this.linear.now(), card });
        return card;
      })
      .finally(() => this.looking.delete(identifier));
    this.looking.set(identifier, lookup);
    return lookup;
  }

  // An issue in full, for an agent: always asked of Linear afresh.
  async detail(identifier: string): Promise<LinearDetail> {
    const { issue } = await this.linear.graphql<{ issue: RawIssue }>(ISSUE, { id: identifier });
    return toDetail(issue);
  }

  // Issues matching words, best first.
  async search(term: string, limit: number): Promise<LinearSearch> {
    const { searchIssues } = await this.linear.graphql<{ searchIssues: { totalCount?: number; nodes: RawIssue[] } }>(SEARCH, { term, first: limit });
    return { total: searchIssues.totalCount ?? searchIssues.nodes.length, issues: searchIssues.nodes.map(toCard) };
  }

  // What was read for another sign-in may not be what this one sees.
  private forgetOnNewSignIn(): void {
    const session = this.linear.session();
    if (session !== this.session) {
      this.session = session;
      this.cards.clear();
    }
  }
}
