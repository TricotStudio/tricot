import { useCallback, useEffect, useState } from 'react';
import type { ConnectorStatus } from '../../../core/connectors';
import type { RepoList } from '../../../core/connectors/github/wire';
import { Icon } from '../../shared/components';
import { githubApi } from './api';

const SHOWN = 30;

// On GitHub's card once connected: which repositories Tricot can see, and
// where to give it more. It looks again when the person comes back from GitHub.
export function GithubPanel(_props: { status: ConnectorStatus }) {
  const [list, setList] = useState<RepoList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback((fresh: boolean) => {
    setBusy(true);
    githubApi
      .repos(fresh)
      .then(
        (found) => {
          setList(found);
          setProblem(null);
        },
        (e: Error) => setProblem(e.message),
      )
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    load(false);
    const again = () => load(true);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [load]);

  const app = list?.via !== 'token';
  return (
    <section className="connector-section">
      <h3>{app ? 'Repositories Tricot is installed on' : 'Repositories this token covers'}</h3>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {list && list.repos.length === 0 && !problem && (
        <p className="muted small">
          {app ? "Tricot isn't installed on any repository yet, so it can only read public ones. Install it on the repositories you want it to read." : 'This token covers no repositories.'}
        </p>
      )}
      {list && list.repos.length > 0 && (
        <ul className="gh-repos">
          {list.repos.slice(0, SHOWN).map((repo) => (
            <li key={repo.fullName} title={repo.private ? 'Private' : 'Public'}>
              {repo.fullName}
              {repo.private && <span className="gh-private"> · private</span>}
            </li>
          ))}
          {list.repos.length > SHOWN && <li className="faint">and {list.repos.length - SHOWN} more</li>}
          {list.truncated && <li className="faint">and more not listed</li>}
        </ul>
      )}
      <div className="row">
        {app &&
          (list?.installUrl ? (
            <a className="btn btn-small" href={list.installUrl} target="_blank" rel="noreferrer">
              Install on your repos
              <Icon name="external" />
            </a>
          ) : (
            <a className="btn btn-small" href={list?.manageUrl ?? 'https://github.com/settings/installations'} target="_blank" rel="noreferrer">
              Manage installations on GitHub
              <Icon name="external" />
            </a>
          ))}
        <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => load(true)}>
          Refresh the list
        </button>
      </div>
    </section>
  );
}
