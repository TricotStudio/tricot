import type { ConnectorStatus } from '../../../core/connectors';
import type { GithubCard, GithubProblem } from '../../../core/connectors/github/card';
import type { DeviceView, PollOutcome, RepoList } from '../../../core/connectors/github/wire';
import type { Block } from '../../../core/types';
import { request } from '../../api';

// GitHub's calls to the server (server/connectors/github/routes.ts).
const route = (path: string) => `/api/connectors/github${path}`;

export type CardAnswer = { card: GithubCard; problem?: undefined } | { card?: undefined; problem: GithubProblem };

export const githubApi = {
  // Signing in with a code: the one waiting (a reloaded page picks it up), a new one, a check, giving up.
  device: () => request<{ device: DeviceView | null }>('GET', route('/device')),
  startDevice: () => request<{ device: DeviceView }>('POST', route('/device/start'), {}),
  pollDevice: () => request<PollOutcome>('POST', route('/device/poll'), {}),
  cancelDevice: () => request<{ ok: true }>('POST', route('/device/cancel'), {}),
  // A personal token, checked once.
  useToken: (token: string) => request<{ connector: ConnectorStatus }>('POST', route('/token'), { token }),

  repos: (fresh = false) => request<RepoList>('GET', route(`/repos${fresh ? '?fresh=1' : ''}`)),

  // A pull request's or issue's live card, by its key (owner/repo/pull/12).
  card: (key: string, fresh = false) =>
    request<CardAnswer>('GET', `${route('/cards')}/${key.split('/').map(encodeURIComponent).join('/')}${fresh ? '?fresh=1' : ''}`),

  // A pull request's diff, or a file, added beside its link block.
  showChanges: (blockId: string, actor: string) => request<{ block: Block }>('POST', route(`/blocks/${encodeURIComponent(blockId)}/diff`), { actor }),
  bringInFile: (blockId: string, actor: string) => request<{ block: Block }>('POST', route(`/blocks/${encodeURIComponent(blockId)}/file`), { actor }),
};
