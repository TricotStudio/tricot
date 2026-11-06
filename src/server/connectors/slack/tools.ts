// Slack's MCP tool: read a message or thread by its link. Read-only, and the
// only one: agents have no tool that posts to Slack. Sharing a decision acts
// as the person, so it is theirs alone, from the page (routes.ts), and
// test/slack.test.ts fails if a tool here ever posts.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { slackTarget } from '../../../core/connectors/slack/link';
import { repliesText } from '../../../core/connectors/slack/thread';
import type { ConnectorTool } from '../connector';
import { ConnectorError } from '../oauth';
import { SLACK_CODES } from './connector';
import type { SlackReader, ThreadDetail } from './reader';

const MESSAGE_MAX = 1500; // characters of one message

const text = (body: string): CallToolResult => ({ content: [{ type: 'text' as const, text: body }] });
const refusal = (body: string): CallToolResult => ({ isError: true, content: [{ type: 'text' as const, text: body }] });

const ASK = "Ask a person (comment or ask_people) if you need it; don't retry until they have.";

// Why Slack can't be read, said for an agent: what a person has to do.
function failure(error: ConnectorError): string {
  switch (error.code) {
    case SLACK_CODES.notConnected:
      return `Slack isn't connected, so agents can't read Slack threads. A person connects it on the Connectors page. ${ASK}`;
    case SLACK_CODES.needsSignIn:
      return `Slack needs a person to sign in again (on the Connectors page) before agents can read threads. Slack's desktop sign-ins run out after 30 days. ${ASK}`;
    case SLACK_CODES.missingScope:
      return `${error.message} ${ASK}`;
    default:
      return error.message;
  }
}

const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function describe({ card, messages, more }: ThreadDetail, url: string): string {
  const lines = [`Slack thread in channel ${card.channel}, started ${when(card.postedAt)} by ${card.author}: ${repliesText(card.replies).toLowerCase()}.`, url, ''];
  messages.forEach((message, at) => {
    const body = message.text.length > MESSAGE_MAX ? `${message.text.slice(0, MESSAGE_MAX)}… (cut: the rest is in Slack)` : message.text;
    lines.push(`${at === 0 ? 'Thread starter' : `Reply ${at}`} · ${message.author}, ${when(message.at)}:`, body.trim() ? body.trim() : '(no text)', '');
  });
  if (more) lines.push(`(Only the first ${messages.length} messages are shown: the thread has more in Slack.)`);
  return lines.join('\n').trimEnd();
}

export function slackTools(reader: SlackReader): ConnectorTool[] {
  return [
    {
      name: 'read_slack',
      config: {
        title: 'Read Slack thread',
        description:
          "Read a Slack message or thread by its link, through the people's Slack connector (signed in as the person who connected it): who wrote the thread's first message and each reply, when, and what they said. Works for public and private channels that person is in, not direct messages. Read-only: agents cannot post to Slack. A person shares a decision to a channel themselves, from its card on the board.",
        inputSchema: { url: z.string().describe('A Slack link to a message or thread (Copy link in Slack): https://<workspace>.slack.com/archives/<channel>/p<id>') },
        annotations: { readOnlyHint: true },
      },
      async run(args) {
        const url = String(args.url ?? '');
        const target = slackTarget(url);
        if (!target) return refusal('That is not a link to a Slack message or thread (https://<workspace>.slack.com/archives/<channel>/p<id>, from Copy link in Slack).');
        try {
          return text(describe(await reader.detail(target.channel, target.threadTs ?? target.ts), url));
        } catch (error) {
          if (error instanceof ConnectorError) return refusal(failure(error));
          throw error;
        }
      },
    },
  ];
}
