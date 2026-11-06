// The Slack links Tricot recognises: a message or a thread in a workspace
// (https://<workspace>.slack.com/archives/<channel>/p<ts>). A link says which
// thread it is, so a card can show it once Slack is connected; other pages on
// slack.com stay plain links.

import type { LinkSourceKind } from '../../sources/types';
import { SLACK_HOSTS, slackTarget, threadKey } from './link';

// Room for the card under its title: who wrote it, a few lines of what they said, and the replies.
const CARD = { w: 400, h: 170 };

export const slackSources: LinkSourceKind = {
  id: 'slack',
  hosts: SLACK_HOSTS,
  read(url) {
    const target = slackTarget(url.href);
    if (!target) return null;
    return {
      kind: 'Slack',
      what: target.threadTs ? 'thread' : 'message',
      name: 'Slack thread',
      site: 'Slack',
      mark: 'slack',
      fileId: threadKey(target),
      card: CARD,
    };
  },
};
