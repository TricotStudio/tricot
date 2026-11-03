// GitHub's MCP tool: read a pull request, issue or file by its link. Read-only.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { checksText, STATE_WORDS } from '../../../core/connectors/github/card';
import { githubTarget } from '../../../core/connectors/github/link';
import { clip } from '../../../core/format';
import type { ConnectorTool } from '../connector';
import { GithubError } from './connector';
import type { Detail, GithubReader } from './reader';

const BODY_MAX = 3000; // characters of a description
const DIFF_MAX = 60_000; // bytes of a diff
const FILE_MAX = 60_000; // characters of a file
const FILE_LINES_MAX = 400; // lines of a range

const text = (body: string): CallToolResult => ({ content: [{ type: 'text' as const, text: body }] });
const refusal = (body: string): CallToolResult => ({ isError: true, content: [{ type: 'text' as const, text: body }] });

// Why GitHub can't be read, said for an agent: what a person has to do.
function failure(error: GithubError): string {
  switch (error.code) {
    case 'not_connected':
      return "GitHub isn't connected, so agents can't read it. A person connects it on the Connectors page.";
    case 'needs_sign_in':
      return 'GitHub needs a person to sign in again (on the Connectors page) before agents can read it.';
    case 'not_installed':
      return `${error.message}${error.installUrl ? ` (${error.installUrl})` : ''} Ask a person (comment or ask_people) if you need it; don't retry until they have.`;
    default:
      return error.message;
  }
}

function describe({ card, body, labels, comments, files }: Detail): string[] {
  const kind = card.kind === 'pull' ? 'Pull request' : 'Issue';
  const lines = [`${kind} ${card.repo} #${card.number}: "${card.title}" [${STATE_WORDS[card.state].toLowerCase()}] by ${card.author}`, card.url];
  if (card.branch) lines.push(`Branch: ${card.branch.head} into ${card.branch.base}`);
  if (card.changes) lines.push(`Changes: ${card.changes.files} file${card.changes.files === 1 ? '' : 's'}, +${card.changes.additions} -${card.changes.deletions}`);
  if (card.checks) lines.push(`Checks on the latest commit: ${checksText(card.checks)}`);
  if (labels.length) lines.push(`Labels: ${labels.join(', ')}`);
  if (comments !== undefined) lines.push(`Comments: ${comments}`);
  lines.push('', body.trim() ? `Description:\n${body.trim().length > BODY_MAX ? `${body.trim().slice(0, BODY_MAX)}…\n(cut: the full description is on GitHub)` : body.trim()}` : 'No description.');
  if (files) {
    lines.push('', `Changed files (${files.total}${files.total > files.list.length ? `, first ${files.list.length} listed` : ''}):`);
    lines.push(...files.list.map((f) => `- ${f.path} (${f.status}, +${f.additions} -${f.deletions})`));
  }
  return lines;
}

export function githubTools(reader: GithubReader): ConnectorTool[] {
  return [
    {
      name: 'read_github',
      config: {
        title: 'Read GitHub link',
        description:
          "Read a GitHub pull request, issue or file by its link, through the people's GitHub connector: title, state, description; for a pull request its checks and changed files (diff: true adds the diff); for a file its text at that commit. Read-only.",
        inputSchema: {
          url: z.string().describe('A github.com link to a pull request, an issue, or a file (blob link, #L10-L20 for lines)'),
          diff: z.boolean().optional().describe('Pull requests: include the diff text, cut at 60 KB'),
        },
        annotations: { readOnlyHint: true },
      },
      async run(args) {
        const target = githubTarget(String(args.url ?? ''));
        if (!target) return refusal('That is not a link to a GitHub pull request, issue or file (github.com/<owner>/<repo>/pull/<n>, /issues/<n> or /blob/<ref>/<path>).');
        try {
          if (target.kind === 'file') {
            const file = await reader.file(target);
            const all = file.text.split('\n');
            const head = `File ${file.repo}:${file.path} at ${file.ref} (commit ${file.commit.slice(0, 10)}), ${all.length} line${all.length === 1 ? '' : 's'}`;
            if (file.lines) {
              const [from, to] = [file.lines[0], Math.min(file.lines[1], file.lines[0] + FILE_LINES_MAX - 1, all.length)];
              if (from > all.length) return refusal(`${file.path} has ${all.length} lines; the link points at line ${from}.`);
              const shown = all.slice(from - 1, to).map((line, i) => `${from + i}: ${line}`);
              return text([`${head}. Lines ${from}-${to}:`, ...shown].join('\n'));
            }
            const body = file.text.length > FILE_MAX ? `${file.text.slice(0, FILE_MAX)}\n…(cut at ${FILE_MAX} characters: link to lines with #L10-L20 to read the rest)` : file.text;
            return text(`${head}:\n${body}`);
          }
          const detail = await reader.detail(target, target.kind === 'pull');
          const lines = describe(detail);
          if (args.diff === true && target.kind === 'pull') {
            const { text: patch, truncated } = await reader.diff(target, DIFF_MAX);
            lines.push('', truncated ? `Diff (cut at ${DIFF_MAX / 1000} KB or GitHub's own limit; the changed files above are complete):` : 'Diff:', patch);
          }
          return text(lines.join('\n'));
        } catch (error) {
          if (error instanceof GithubError) return refusal(clip(failure(error), 600));
          throw error;
        }
      },
    },
  ];
}
