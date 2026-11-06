import type { SlackProblem, SlackShared, SlackThreadCard } from '../../../core/connectors/slack/thread';
import { routes } from '../../../core/routes';
import { get, post } from '../../shared/api';

// Slack's calls to the server (server/connectors/slack/routes.ts).

export type ThreadAnswer = { thread: SlackThreadCard; problem?: undefined } | { thread?: undefined; problem: SlackProblem };

export const slackApi = {
  // A linked thread's card, by its key (<channel>/<ts>).
  thread: (key: string, fresh = false) => {
    const [channel, ts] = key.split('/');
    return get(routes.slackThread)<ThreadAnswer>({ channel, ts }, fresh ? { fresh: '1' } : undefined);
  },

  // A person's own action: posts the decision to a channel as them. Signed by their seat.
  shareDecision: (decisionId: string, channel: string) => post(routes.slackShareDecision)<{ shared: SlackShared }>({ channel }, { decisionId }),
};
