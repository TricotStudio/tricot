// Linear's MCP tools: read an issue by its link or identifier, and search issues
// by words. Read-only: there is no tool that writes to Linear. To plan work from
// issues, agents use plan_tasks, with the issues' links in the tasks' detail.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { linearIssueRef, type LinearCard } from '../../../core/connectors/linear/issue';
import { clip } from '../../../core/format';
import type { ConnectorTool } from '../connector';
import { LinearError } from './connector';
import type { LinearDetail, LinearReader } from './reader';

const BODY_MAX = 3000; // characters of a description
const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 25;

const text = (body: string): CallToolResult => ({ content: [{ type: 'text' as const, text: body }] });
const refusal = (body: string): CallToolResult => ({ isError: true, content: [{ type: 'text' as const, text: body }] });

// Why Linear can't be read, said for an agent: what a person has to do.
export function failure(error: LinearError): string {
  switch (error.code) {
    case 'not_connected':
      return "Linear isn't connected, so agents can't read it. A person connects it on the Connectors page. Ask them (comment or ask_people) if you need it; don't retry until they have.";
    case 'needs_sign_in':
      return 'Linear no longer accepts the saved sign-in. A person signs in to Linear again on the Connectors page. Ask them (comment or ask_people) if you need it; don\'t retry until they have.';
    default:
      return error.message;
  }
}

const day = (iso?: string) => (iso ? iso.slice(0, 10) : 'unknown date');

// One issue in a line: "ENG-12 [In Progress] "Fix the login" (Ada, High) https://…"
export function issueLine(card: LinearCard): string {
  return `${card.identifier} [${card.status.name}] "${clip(card.title, 160)}" (${card.assignee ?? 'unassigned'}, ${card.priority.toLowerCase()}) ${card.url}`;
}

export function issueText(issue: LinearDetail): string {
  const facts = [
    `Team: ${issue.team || 'unknown'}`,
    issue.project && `Project: ${issue.project}`,
    issue.labels.length > 0 && `Labels: ${issue.labels.join(', ')}`,
    issue.dueDate && `Due: ${issue.dueDate}`,
    issue.estimate !== undefined && `Estimate: ${issue.estimate}`,
    issue.creator && `Created by ${issue.creator}${issue.createdAt ? ` on ${day(issue.createdAt)}` : ''}`,
    `Updated: ${day(issue.updatedAt)}`,
  ].filter(Boolean);
  const description = issue.description.trim();
  return [
    `Linear issue ${issue.identifier}: "${clip(issue.title, 200)}" [${issue.status.name}]`,
    `Assigned to: ${issue.assignee ?? 'nobody'} · Priority: ${issue.priority}`,
    issue.url,
    facts.join(' · '),
    ...(issue.parent ? [`Sub-issue of ${issue.parent.identifier}: "${clip(issue.parent.title, 160)}"`] : []),
    '',
    description ? `Description:\n${description.length > BODY_MAX ? `${description.slice(0, BODY_MAX)}…\n(cut: the full description is in Linear)` : description}` : 'No description.',
  ].join('\n');
}

export function linearTools(reader: LinearReader): ConnectorTool[] {
  return [
    {
      name: 'read_linear_issue',
      config: {
        title: 'Read Linear issue',
        description:
          "Read a Linear issue through the people's Linear connector: its identifier, title, status, assignee, priority, team, project, labels, due date and description. Pass the issue's linear.app link or its identifier (ENG-123). Read-only: nothing is written back to Linear. To plan work from issues, call plan_tasks and put each issue's link in the task's detail. Refused until a person connects Linear.",
        inputSchema: { issue: z.string().describe('A linear.app issue link, or an identifier such as ENG-123') },
        annotations: { readOnlyHint: true },
      },
      async run(args) {
        const identifier = linearIssueRef(String(args.issue ?? ''));
        if (!identifier) return refusal('That is not a Linear issue: pass a linear.app/<workspace>/issue/ENG-123 link or an identifier such as ENG-123.');
        try {
          return text(issueText(await reader.detail(identifier)));
        } catch (error) {
          if (error instanceof LinearError) return refusal(clip(failure(error), 600));
          throw error;
        }
      },
    },
    {
      name: 'search_linear_issues',
      config: {
        title: 'Search Linear issues',
        description: `Search Linear issues by words in the people's Linear connector, best match first: each with its identifier, status, assignee, priority and link. Read one in full with read_linear_issue. Read-only. At most ${SEARCH_MAX} results. Refused until a person connects Linear.`,
        inputSchema: {
          query: z.string().min(1).max(200).describe('Words to look for in issues'),
          limit: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`How many to list (default ${SEARCH_DEFAULT})`),
        },
        annotations: { readOnlyHint: true },
      },
      async run(args) {
        const query = String(args.query ?? '').trim();
        if (!query) return refusal('Say what to search for.');
        const limit = Math.min(SEARCH_MAX, Math.max(1, Number(args.limit) || SEARCH_DEFAULT));
        try {
          const { total, issues } = await reader.search(query, limit);
          if (issues.length === 0) return text(`No Linear issues match "${clip(query, 80)}".`);
          const more = total > issues.length ? ` (${total} match; the first ${issues.length} are listed)` : '';
          return text([`Linear issues matching "${clip(query, 80)}"${more}:`, ...issues.map((card) => `- ${issueLine(card)}`)].join('\n'));
        } catch (error) {
          if (error instanceof LinearError) return refusal(clip(failure(error), 600));
          throw error;
        }
      },
    },
  ];
}
