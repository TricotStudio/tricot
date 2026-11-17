import type { ConnectorStatus } from '../../../core/connectors';
import type { GithubCard, GithubProblem } from '../../../core/connectors/github/card';
import type { DeviceView, PollOutcome, RepoList } from '../../../core/connectors/github/wire';
import type { Block } from '../../../core/types';
import { githubRoutes } from '../../../core/connectors/github/routes';
import { get, post } from '../../shared/api';

// GitHub's calls to the server: its routes (core/connectors/github/routes.ts), served
// by server/connectors/github/routes.ts.

export type CardAnswer = { card: GithubCard; problem?: undefined } | { card?: undefined; problem: GithubProblem };

export const githubApi = {
  // Signing in with a code: the one waiting (a reloaded page picks it up), a new one, a check, giving up.
  device: () => get(githubRoutes.device)<{ device: DeviceView | null }>(),
  startDevice: () => post(githubRoutes.startDevice)<{ device: DeviceView }>({}),
  pollDevice: () => post(githubRoutes.pollDevice)<PollOutcome>({}),
  cancelDevice: () => post(githubRoutes.cancelDevice)<{ ok: true }>({}),
  // A personal token, checked once.
  useToken: (token: string) => post(githubRoutes.token)<{ connector: ConnectorStatus }>({ token }),

  repos: (fresh = false) => get(githubRoutes.repos)<RepoList>(undefined, fresh ? { fresh: '1' } : undefined),

  // A pull request's or issue's live card, by its key (owner/repo/pull/12).
  card: (key: string, fresh = false) => {
    const [owner, repo, kind, number] = key.split('/');
    return get(githubRoutes.card)<CardAnswer>({ owner, repo, kind, number }, fresh ? { fresh: '1' } : undefined);
  },

  // A pull request's diff, or a file, added beside its link block.
  showChanges: (blockId: string, actor: string) => post(githubRoutes.showChanges)<{ block: Block }>({ actor }, { blockId }),
  bringInFile: (blockId: string, actor: string) => post(githubRoutes.bringInFile)<{ block: Block }>({ actor }, { blockId }),
};
