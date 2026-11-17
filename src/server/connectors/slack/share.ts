// Sharing a card to a Slack channel: the one thing here that writes to
// Slack, and it posts as the person who signed in (a user token), so it is
// only ever a person's own action in the page. Its route is gated by the
// person check (access.ts personOnly, tier B) in ./routes.ts, and no MCP tool
// reaches it: tools.ts holds read tools alone.

import { channelFrom } from '../../../core/connectors/slack/link';
import type { SharedDecision } from '../../../core/connectors/connector';
import { decisionMessage } from '../../../core/connectors/slack/share';
import type { SlackShared } from '../../../core/connectors/slack/thread';
import { linkTo } from '../../../core/pages';
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

  // Where the board is, as the person has it open: what the message links back to. The card's own page, which
  // its card kind gives (store/cardKinds.ts), or the board's address when no kind does.
  linkTo(origin: string, decisionId: string): string {
    const { board, card } = this.store.getCard('decision', decisionId);
    return `${origin}/${this.store.cardLink('decision', board.id, card.id) ?? linkTo.board(board.id)}`;
  }

  // Posts the card's question, options and a link back to `channel`, as the signed-in person.
  async shareDecision(decisionId: string, channelText: string, origin: string): Promise<SlackShared> {
    const channel = channelFrom(channelText);
    if (!channel) throw new ConnectorError(CHANNEL_HELP, 400, 'bad_channel');
    const { card } = this.store.getCard('decision', decisionId);
    const reply = await this.slack.call('chat.postMessage', {
      channel,
      text: decisionMessage(card as unknown as SharedDecision, this.linkTo(origin, decisionId)),
      unfurl_links: 'false',
      unfurl_media: 'false',
    });
    if (!reply.ok) throw slackRefusal(reply.error ?? 'unknown', 'post');
    return { channel: typeof reply.channel === 'string' ? reply.channel : channel, ts: typeof reply.ts === 'string' ? reply.ts : '' };
  }
}
