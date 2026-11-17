import type { SlackProblem, SlackThreadCard } from '../../../core/connectors/slack/thread';
import { slackRoutes } from '../../../core/connectors/slack/routes';
import { get } from '../../shared/api';

// Slack's calls to the server: its routes (core/connectors/slack/routes.ts), served
// by server/connectors/slack/routes.ts.

export type ThreadAnswer = { thread: SlackThreadCard; problem?: undefined } | { thread?: undefined; problem: SlackProblem };

export const slackApi = {
  // A linked thread's card, by its key (<channel>/<ts>).
  thread: (key: string, fresh = false) => {
    const [channel, ts] = key.split('/');
    return get(slackRoutes.thread)<ThreadAnswer>({ channel, ts }, fresh ? { fresh: '1' } : undefined);
  },
};
