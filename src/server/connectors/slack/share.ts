// Sharing a decision to a Slack channel: the one thing here that writes to
// Slack, and it posts as the person who signed in (a user token), so it is
// only ever a person's own action in the page. Its route is gated by the
// person check (access.ts personOnly, tier B) in ./routes.ts, and no MCP tool
// reaches it: tools.ts holds read tools alone, and test/slack.test.ts keeps it so.

import { channelFrom } from '../../../core/connectors/slack/link';
import { decisionMessage } from '../../../core/connectors/slack/share';
import { linkTo } from '../../../core/pages';
import type { SlackShared } from '../../../core/connectors/slack/thread';
import type { Store } from '../../../core/store';
import { ConnectorError } from '../oauth';
import type { SlackConnector } from './connector';
import { slackRefusal } from './errors';

export const CHANNEL_HELP = 'Say which channel to share to: paste a link to the channel or to any message in it (Copy link in Slack), or its ID, which starts with C or G.';

export class SlackShares {
  constructor(
    private readonly slack: SlackConnector,
    private readonly store: Store,
  ) {}

  // Where the board is, as the person has it open: what the message links back to.
  linkTo(origin: string, decisionId: string): string {
    const { board, decision } = this.store.getDecision(decisionId);
    return `${origin}/${linkTo.decision(board.id, decision.id)}`;
  }

  // Posts the decision's question, options and a link back to `channel`, as the signed-in person.
  async shareDecision(decisionId: string, channelText: string, origin: string): Promise<SlackShared> {
    const channel = channelFrom(channelText);
    if (!channel) throw new ConnectorError(CHANNEL_HELP, 400, 'bad_channel');
    const { decision } = this.store.getDecision(decisionId);
    const reply = await this.slack.call('chat.postMessage', {
      channel,
      text: decisionMessage(decision, this.linkTo(origin, decisionId)),
      unfurl_links: 'false',
      unfurl_media: 'false',
    });
    if (!reply.ok) throw slackRefusal(reply.error ?? 'unknown', 'post');
    return { channel: typeof reply.channel === 'string' ? reply.channel : channel, ts: typeof reply.ts === 'string' ? reply.ts : '' };
  }
}
