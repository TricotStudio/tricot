import { useEffect, useState } from 'react';
import type { ConnectorStatus } from '../../core/connectors';
import { api } from '../api';
import { onConnectorMessage } from './live';
import { webConnectors } from './registry';

// The ids of the connectors that are signed in, read when asked and again after a sign-in.
function useConnected(): Set<string> {
  const [connected, setConnected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const load = () =>
      api.connectors().then(
        (list: ConnectorStatus[]) => setConnected(new Set(list.filter((c) => c.state === 'connected').map((c) => c.id))),
        () => {},
      );
    void load();
    return onConnectorMessage(() => void load());
  }, []);
  return connected;
}

// For adding a link: a button for each connected service that lets a person
// choose a file rather than paste its address ("Choose a Google Doc"). `onBusy`
// says while the service's chooser is open, so the form around it stays put.
export function ConnectorChoosers({ onPick, onBusy }: { onPick(url: string): void; onBusy(busy: boolean): void }) {
  const connected = useConnected();
  const [problem, setProblem] = useState<string | null>(null);
  const choosers = webConnectors().flatMap((c) => (c.chooser && connected.has(c.id) ? [c.chooser] : []));
  if (choosers.length === 0) return null;
  const choose = async (chooser: (typeof choosers)[number]) => {
    setProblem(null);
    onBusy(true);
    try {
      const picked = await chooser.choose();
      if (picked) onPick(picked.url);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      onBusy(false);
    }
  };
  return (
    <div className="add-link-choose">
      {choosers.map((chooser) => (
        <button key={chooser.label} type="button" className="btn btn-small" onClick={() => void choose(chooser)}>
          {chooser.label}
        </button>
      ))}
      <span className="faint small">or paste an address</span>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
