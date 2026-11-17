// Slack's web half: its mark and panel words on the Connectors page and the live
// card of a linked thread on a canvas.
// What it is and may do is core/connectors/slack/.

import { LOGOS } from '../../canvas/sources/sites';
import type { WebConnector } from '../connector';
import { SlackThreadCard } from './card';
import { loadThread } from './threads';
import './slack.css';

// Slack's sign, on its aubergine: the connector's mark, and the mark of every Slack link.
function SlackMark() {
  const { tile, glyph } = LOGOS.slack;
  return (
    <span className="connector-mark" aria-hidden>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <rect width="32" height="32" rx="6" fill={tile} />
        {glyph}
      </svg>
    </span>
  );
}

export const slack: WebConnector = {
  id: 'slack',
  Mark: SlackMark,
  serves: 'Threads you link',
  setup: {
    intro: "Tricot Studio's Slack app isn't built into this copy of Tricot yet. To use Slack now, make an app of your own, once:",
    files: ['slack-client.json'],
  },
  signOutHint: "remove Tricot from your workspace's apps in Slack.",
  accessNote: () =>
    "It signs in as you and reads the threads you link. It posts only when you choose to share something, never for an agent: agents can read a linked thread; they can't post to Slack.",
  LinkCard: SlackThreadCard,
  marks: { slack: LOGOS.slack },
  // Who started the thread names the link until a person titles it; what they said is on the card under it.
  fileInfo: async (key) => {
    const answer = await loadThread(key);
    return answer?.thread ? { name: `Thread by ${answer.thread.author}` } : null;
  },
};
