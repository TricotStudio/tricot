// GitHub's web half: its panel on the Connectors page (signing in by code or
// token, the repositories it can see), and the live details on the link cards
// of pull requests, issues and files. What it is and may read is
// core/connectors/github/.

import { github as githubSource } from '../../canvas/sources/github';
import type { WebConnector } from '../connector';
import { GithubCardDetails } from './card';
import { loadCard } from './cards';
import './github.css';
import { GithubPanel } from './panel';
import { GithubSignIn } from './signIn';

// A dark tile with a branching line: GitHub's colours, a plain sign rather
// than its logo. Links to GitHub's other pages show it too.
function GithubMark() {
  const { tile, glyph } = githubSource.marks.github;
  return (
    <span className="connector-mark" aria-hidden>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <rect width="32" height="32" rx="6" fill={tile} />
        {glyph}
      </svg>
    </span>
  );
}

export const github: WebConnector = {
  id: 'github',
  Mark: GithubMark,
  serves: 'Pull requests, issues and files',
  setup: { intro: 'GitHub needs nothing set up: Tricot signs in with its own GitHub App.', files: [] },
  signOutHint: 'remove Tricot at github.com/settings/apps/authorizations, or delete the personal token at github.com/settings/tokens.',
  removedNote:
    'Disconnected here. GitHub keeps the grant until you remove it at github.com/settings/apps/authorizations; a personal token works until you delete it at github.com/settings/tokens.',
  accessNote: () =>
    "Read-only on the repositories Tricot is installed on (or a token covers): it can't change anything on GitHub. It never reads your other repositories.",
  SignIn: GithubSignIn,
  Panel: GithubPanel,
  LinkCard: GithubCardDetails,
  // A pull request's or issue's real title and last update, from its live card.
  fileInfo: async (key) => {
    const answer = await loadCard(key);
    return answer?.card ? { name: answer.card.title, modifiedTime: answer.card.updatedAt } : null;
  },
};
