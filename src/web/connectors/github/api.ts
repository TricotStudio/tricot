import type { ConnectorStatus } from '../../../core/connectors';
import type { GithubCard, GithubProblem } from '../../../core/connectors/github/card';
import type { DeviceView, PollOutcome, RepoList } from '../../../core/connectors/github/wire';
import type { Block } from '../../../core/types';
import { routes } from '../../../core/routes';
import { get, post } from '../../shared/api';

// GitHub's calls to the server (server/connectors/github/routes.ts).

export type CardAnswer = { card: GithubCard; problem?: undefined } | { card?: undefined; problem: GithubProblem };

export const githubApi = {
  // Signing in with a code: the one waiting (a reloaded page picks it up), a new one, a check, giving up.
  device: () => get(routes.githubDevice)<{ device: DeviceView | null }>(),
  startDevice: () => post(routes.githubStartDevice)<{ device: DeviceView }>({}),
  pollDevice: () => post(routes.githubPollDevice)<PollOutcome>({}),
  cancelDevice: () => post(routes.githubCancelDevice)<{ ok: true }>({}),
  // A personal token, checked once.
  useToken: (token: string) => post(routes.githubToken)<{ connector: ConnectorStatus }>({ token }),

  repos: (fresh = false) => get(routes.githubRepos)<RepoList>(undefined, fresh ? { fresh: '1' } : undefined),

  // A pull request's or issue's live card, by its key (owner/repo/pull/12).
  card: (key: string, fresh = false) => {
    const [owner, repo, kind, number] = key.split('/');
    return get(routes.githubCard)<CardAnswer>({ owner, repo, kind, number }, fresh ? { fresh: '1' } : undefined);
  },

  // A pull request's diff, or a file, added beside its link block.
  showChanges: (blockId: string, actor: string) => post(routes.githubShowChanges)<{ block: Block }>({ actor }, { blockId }),
  bringInFile: (blockId: string, actor: string) => post(routes.githubBringInFile)<{ block: Block }>({ actor }, { blockId }),
};
