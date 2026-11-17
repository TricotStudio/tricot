// Linear's web half: its panel on the Connectors page (signing in with
// Tricot Studio's app, or pasting a personal API key), and the live status and
// assignee on the link cards of issues. What it is and may read is
// core/connectors/linear/. Read-only.

import { LOGOS } from '../../canvas/sources/sites';
import type { WebConnector } from '../connector';
import { LinearCardDetails } from './card';
import { loadCard } from './cards';
import { LinearSignIn } from './signIn';
import './linear.css';

const MARK = LOGOS.linear;

// Linear's mark on its own tile, as on the cards of its links.
function LinearMark() {
  return (
    <span className="connector-mark" aria-hidden>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <rect width="32" height="32" rx="6" fill={MARK.tile} />
        {MARK.glyph}
      </svg>
    </span>
  );
}

export const linear: WebConnector = {
  id: 'linear',
  Mark: LinearMark,
  serves: 'Linear issues',
  setup: { intro: 'Linear needs nothing set up: sign in, or paste a personal API key.', files: [] },
  signOutHint: 'you can remove Tricot under Applications in your Linear account settings, or delete the personal API key under Security & access.',
  removedNote:
    'Disconnected here. A personal API key works until you delete it in Linear, under Security & access in your account settings.',
  accessNote: () => "Read-only: Tricot only reads issues, and never changes anything in Linear. A personal API key reaches what its owner can see; make it read-only in Linear to be sure.",
  SignIn: LinearSignIn,
  LinkCard: LinearCardDetails,
  marks: { linear: MARK },
  // An issue's real title and last update, from its live card.
  fileInfo: async (identifier) => {
    const answer = await loadCard(identifier);
    return answer?.card ? { name: answer.card.title, modifiedTime: answer.card.updatedAt } : null;
  },
};
