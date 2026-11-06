import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectorStatus } from '../../../core/connectors';
import { api } from '../../shared/api';
import { Icon } from '../../shared/components';
import { onConnectorMessage } from '../live';
import { linearApi } from './api';
import { forgetCards } from './cards';

const KEY_PAGE = 'https://linear.app/settings/account/security';

// Pasting a personal API key, which Tricot checks with Linear and keeps on this computer.
function KeyForm({ onChange, lead }: { onChange(next: ConnectorStatus): void; lead: string }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const { connector } = await linearApi.useKey(key);
      setKey('');
      forgetCards();
      onChange(connector);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="lin-key" onSubmit={(e) => void submit(e)}>
      <p className="muted small">
        {lead}{' '}
        <a href={KEY_PAGE} target="_blank" rel="noreferrer">
          Make a key
        </a>
      </p>
      <div className="lin-key-row">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="lin_api_…"
          aria-label="Linear API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy || !key.trim()}>
          {busy ? 'Checking…' : 'Use this key'}
        </button>
      </div>
      <p className="faint small">The key stays on this computer and is sent only to Linear.</p>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

// Connecting Linear: Tricot Studio's Linear app, which signs in on Linear's
// own page in a new tab (once its client ID is filled in: the status then
// says it is built in), or a personal API key pasted here. Until the app is
// there, the key is the way.
export function LinearSignIn({ status, onChange }: { status: ConnectorStatus; onChange(next: ConnectorStatus): void }) {
  const offered = status.clientSource === 'built-in';
  const [waiting, setWaiting] = useState<{ url?: string; blocked?: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // While the person signs in in the other tab: it tells this one how it went (the page's list of connectors refreshes by itself).
  useEffect(() => {
    if (!waiting) return;
    return onConnectorMessage((message) => {
      if (message.id !== 'linear') return;
      if (!message.ok) setProblem(message.message ?? 'The sign-in failed.');
      setWaiting(null);
    });
  }, [waiting]);

  const connect = async () => {
    // Opened now, while the click still counts, then sent to Linear.
    const tab = window.open('', '_blank');
    setProblem(null);
    setWaiting({});
    try {
      const { url } = await api.startConnector('linear');
      if (tab) tab.location.href = url;
      setWaiting({ url, blocked: !tab });
    } catch (e) {
      tab?.close();
      setWaiting(null);
      setProblem((e as Error).message);
    }
  };

  const again = status.state === 'needs_sign_in';
  return (
    <section className="connector-section lin-signin">
      {offered && (
        <div className="lin-connect">
          {waiting ? (
            <>
              <span className="connector-waiting" role="status">
                <span className="connector-spinner" aria-hidden />
                {waiting.blocked ? "The browser didn't open a new tab. Open Linear to sign in, then come back here." : 'Finish signing in on the Linear tab…'}
              </span>
              {waiting.url && (
                <a className={`btn btn-small${waiting.blocked ? ' btn-primary' : ''}`} href={waiting.url} target="_blank" rel="noreferrer">
                  {waiting.blocked ? 'Open Linear' : 'Open it again'}
                  <Icon name="external" />
                </a>
              )}
              <button className="btn btn-small btn-quiet" onClick={() => setWaiting(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => void connect()}>
                {again ? 'Connect again' : 'Connect Linear'}
              </button>
              <span className="faint small">Opens Linear in a new tab. Nothing is saved until you allow it there.</span>
            </>
          )}
        </div>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {offered ? (
        <details className="lin-details-key">
          <summary>Use a personal API key instead</summary>
          <KeyForm onChange={onChange} lead="Make a key in Linear, under Settings → Security & access → Personal API keys, with read-only access, and paste it here." />
        </details>
      ) : (
        <>
          <h3>{again ? 'Paste a new Linear API key' : 'Paste your Linear API key'}</h3>
          <KeyForm onChange={onChange} lead="In Linear, open Settings → Security & access → Personal API keys and make a key with read-only access." />
        </>
      )}
    </section>
  );
}
