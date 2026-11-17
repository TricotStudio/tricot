import { useState, type FormEvent } from 'react';
import type { ConnectorStatus } from '../../../core/connectors';
import { figmaApi, forgetFigma } from './api';

// Connecting Figma: a token pasted once, which Tricot checks with Figma and keeps on this computer.
export function FigmaSignIn({ status, onChange }: { status: ConnectorStatus; onChange(next: ConnectorStatus): void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const { connector } = await figmaApi.connect(token);
      setToken('');
      onChange(connector);
      forgetFigma();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="connector-section">
      <h3>{status.state === 'needs_sign_in' ? 'Paste a new Figma token' : 'Paste your Figma token'}</h3>
      <p className="muted small">
        In Figma, open Settings → Security → Personal access tokens and make a token with read-only access (Current user, File content, Comments).
      </p>
      <form className="figma-token" onSubmit={(e) => void submit(e)}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="figd_…"
          aria-label="Figma token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy || !token.trim()}>
          {busy ? 'Checking…' : 'Connect Figma'}
        </button>
      </form>
      <p className="faint small">The token stays on this computer and is sent only to Figma.</p>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
