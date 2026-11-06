// What Slack's Web API errors mean, in words for a person, with the code the
// page and the tool act on (SLACK_CODES). A token no good any more is the
// connector's (connector.ts call): it never gets here.

import { ConnectorError } from '../oauth';
import { SLACK_CODES } from './connector';

export function slackRefusal(error: string, doing: 'read' | 'post'): ConnectorError {
  const code = error.slice(0, 60);
  switch (code) {
    case 'channel_not_found':
    case 'thread_not_found':
    case 'message_not_found':
      return new ConnectorError(
        doing === 'post'
          ? "Slack can't find that channel, or this sign-in can't see it."
          : "Slack has nothing at that link, or this sign-in can't see it: a channel you aren't in, or another workspace.",
        404,
        SLACK_CODES.notFound,
      );
    case 'missing_scope':
      return new ConnectorError(
        doing === 'post'
          ? "This Slack sign-in wasn't allowed to post. Connect Slack again from Connectors."
          : "This Slack sign-in isn't allowed to read that: Tricot reads public and private channels, not direct messages. If it should, connect Slack again from Connectors.",
        403,
        SLACK_CODES.missingScope,
      );
    case 'not_in_channel':
      return new ConnectorError("You aren't in that channel, so Slack won't let you post there. Join it in Slack first.", 403, 'not_in_channel');
    case 'is_archived':
      return new ConnectorError('That channel is archived, so nothing can be posted in it.', 400, 'is_archived');
    case 'restricted_action':
    case 'restricted_action_read_only_channel':
    case 'restricted_action_thread_locked':
    case 'restricted_action_thread_only_channel':
      return new ConnectorError("Your Slack workspace doesn't let you post in that channel.", 403, 'restricted_action');
    case 'msg_too_long':
    case 'msg_blocks_too_long':
      return new ConnectorError('That decision is too long for one Slack message.', 400, 'msg_too_long');
    case 'ratelimited':
      return new ConnectorError("Slack's rate limit is used up for now. Try again in a minute.", 429, SLACK_CODES.rateLimited);
    default:
      return new ConnectorError(`Slack said no (${code}).`, 502, SLACK_CODES.refused);
  }
}
