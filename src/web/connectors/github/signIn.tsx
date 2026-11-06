import { useEffect, useRef, useState } from 'react';
import type { ConnectorStatus } from '../../../core/connectors';
import type { DeviceView } from '../../../core/connectors/github/wire';
import { Icon } from '../../shared/components';
import { githubApi } from './api';
import { forgetCards } from './cards';

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new';

// Connecting GitHub: Tricot shows a short code, the person types it on
// github.com/login/device, and this page waits (checking as often as GitHub
// allows) until they have. Or a fine-grained personal token with the same
// read-only access, checked once.
export function GithubSignIn({ onChange }: { status: ConnectorStatus; onChange(next: ConnectorStatus): void }) {
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const changed = useRef(onChange); // the page hands a new function each time it draws: the wait must not restart
  changed.current = onChange;

  // A reloaded page picks up a code that is still waiting.
  useEffect(() => {
    githubApi.device().then(({ device: waiting }) => setDevice(waiting), () => {});
  }, []);

  // While a code waits: check, no faster than GitHub's interval (it can ask for slower).
  useEffect(() => {
    if (!device) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = (seconds: number) => {
      timer = setTimeout(async () => {
        try {
          const outcome = await githubApi.pollDevice();
          if (stopped) return;
          if (outcome.state === 'pending') return next(outcome.interval);
          setDevice(null);
          if (outcome.state === 'connected') {
            forgetCards();
            changed.current(outcome.connector);
          } else setProblem(outcome.message);
        } catch (e) {
          if (stopped) return;
          setDevice(null);
          setProblem((e as Error).message);
        }
      }, seconds * 1000 + 250);
    };
    next(device.interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [device?.userCode]);

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setDevice((await githubApi.startDevice()).device);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setDevice(null);
    void githubApi.cancelDevice().catch(() => {});
  };

  const useToken = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { connector } = await githubApi.useToken(token);
      setToken('');
      forgetCards();
      onChange(connector);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="connector-section gh-signin">
      {device ? (
        <div className="gh-code" role="status">
          <p className="muted small">Type this code on GitHub to let Tricot in:</p>
          <p className="gh-code-digits" aria-label={`Your code is ${device.userCode.split('').join(' ')}`}>
            {device.userCode}
          </p>
          <div className="row">
            <a className="btn btn-primary btn-small" href={device.verificationUri} target="_blank" rel="noreferrer">
              Open {device.verificationUri.replace(/^https?:\/\//, '')}
              <Icon name="external" />
            </a>
            <button className="btn btn-small btn-quiet" onClick={cancel}>
              Cancel
            </button>
          </div>
          <span className="connector-waiting">
            <span className="connector-spinner" aria-hidden />
            Waiting for you to allow it on GitHub…
          </span>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            Connect GitHub
          </button>
          <span className="faint small">You get a code to type on github.com. Nothing is saved until you allow it there.</span>
        </div>
      )}

      {!device && (
        <details className="gh-token">
          <summary>Use a personal token instead</summary>
          <p className="muted small">
            Make a fine-grained token on GitHub with read-only access to Contents, Pull requests, Issues, Checks and Commit statuses, on the repositories you want
            Tricot to read, and paste it here.{' '}
            <a href={TOKEN_PAGE} target="_blank" rel="noreferrer">
              Make a token
            </a>
          </p>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="github_pat_…"
            aria-label="Personal access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <div className="row">
            <button className="btn btn-small" disabled={busy || !token.trim()} onClick={() => void useToken()}>
              Use this token
            </button>
          </div>
        </details>
      )}

      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
