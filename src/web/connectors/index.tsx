import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectorStatus } from '../../core/connectors';
import { api } from '../api';
import { Icon, timeAgo, UserChip, Wordmark } from '../components';
import { onConnectorMessage } from './live';
import { webConnector } from './registry';
import './connectors.css';

// Connectors: services Tricot reads from, set up once on this computer
// for every board. Signing in happens in a new tab, on the service's own
// page; the tab it comes back to tells this one (same origin) how it went
// (live.ts). What is the service's own, such as its mark and what its
// permissions say, comes from its web half (registry.ts).

// ---- statuses ----------------------------------------------------------------

function useConnectors() {
  const [connectors, setConnectors] = useState<ConnectorStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.connectors().then(
      (list) => {
        setConnectors(list);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    const stop = onConnectorMessage(refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      stop();
    };
  }, [refresh]);
  return { connectors, error, refresh, setConnectors };
}

const STATE_LABEL: Record<ConnectorStatus['state'], { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'connected' },
  ready: { label: 'Not connected', tone: 'idle' },
  not_set_up: { label: 'Not set up', tone: 'idle' },
  needs_sign_in: { label: 'Sign in again', tone: 'attention' },
  error: { label: 'Not working', tone: 'error' },
};

function StateLabel({ state }: { state: ConnectorStatus['state'] }) {
  const { label, tone } = STATE_LABEL[state];
  return <span className={`status connector-state is-${tone}`}>{label}</span>;
}

// A connector's mark, or a plain tile when it has none.
function ConnectorMark({ id }: { id: string }) {
  const Mark = webConnector(id)?.Mark;
  return Mark ? <Mark /> : <span className="connector-mark" aria-hidden />;
}

// ---- the page --------------------------------------------------------------

export function ConnectorsPage({ name, onRename, from }: { name: string; onRename: () => void; from?: string }) {
  const { connectors, error, refresh, setConnectors } = useConnectors();
  const [boardTitle, setBoardTitle] = useState<string>();
  useEffect(() => {
    if (!from) return;
    api.boards().then((boards) => setBoardTitle(boards.find((b) => b.id === from)?.title), () => {});
  }, [from]);
  // A client file dropped into the folder shows up without a reload.
  const settingUp = connectors?.some((c) => c.state === 'not_set_up');
  useEffect(() => {
    if (!settingUp) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), 5000);
    return () => clearInterval(timer);
  }, [settingUp, refresh]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-left">
          <a className="brand" href="#/" title="All boards">
            <Wordmark />
          </a>
        </div>
        <div className="topbar-right">
          <UserChip name={name} onRename={onRename} />
        </div>
      </header>

      <main className="connectors">
        <a className="connectors-back" href={from ? `#/b/${encodeURIComponent(from)}` : '#/'}>
          <Icon name="arrow-left" /> {from ? (boardTitle ? `Back to ${boardTitle}` : 'Back to the board') : 'All boards'}
        </a>
        <section className="connectors-intro">
          <h1>Connectors</h1>
          <p className="lede">
            Let Tricot read from the services you already use. You set each one up once on this computer, and every
            board uses it. Sign-ins stay on this computer.
          </p>
        </section>

        {error && !connectors && <p className="error">{error}</p>}
        {connectors === null ? (
          !error && <p className="muted">Loading…</p>
        ) : (
          <div className="connector-list">
            {connectors.map((connector) => (
              <ConnectorCard
                key={connector.id}
                connector={connector}
                onChange={(next) => setConnectors((list) => list?.map((c) => (c.id === next.id ? next : c)) ?? null)}
                refresh={refresh}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

const WAIT_LIMIT = 10 * 60_000; // a sign-in is good for ten minutes

function ConnectorCard(props: { connector: ConnectorStatus; onChange: (next: ConnectorStatus) => void; refresh: () => void }) {
  const { connector, onChange, refresh } = props;
  // blocked: the browser kept the new tab from opening, so the person opens it from here.
  const [waiting, setWaiting] = useState<{ url?: string; since: number; blocked?: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const before = useRef(connector.account?.connectedAt);

  // While the person signs in in the other tab: listen for it, and look
  // every couple of seconds in case the message can't reach this tab.
  useEffect(() => {
    if (!waiting) return;
    const stop = onConnectorMessage((message) => {
      if (message.id !== connector.id) return;
      if (!message.ok) {
        setProblem(message.message ?? 'The sign-in failed.');
        setWaiting(null);
      }
    });
    const timer = setInterval(() => {
      if (Date.now() - waiting.since > WAIT_LIMIT) setWaiting(null);
      else refresh();
    }, 2000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [waiting, connector.id, refresh]);

  // Done once a new sign-in shows up.
  useEffect(() => {
    const at = connector.account?.connectedAt;
    if (waiting && connector.state === 'connected' && at !== before.current) {
      setWaiting(null);
      setProblem(null);
    }
    before.current = at;
  }, [connector, waiting]);

  const connect = async (permissions?: string[]) => {
    // Opened now, while the click still counts, then sent to the service.
    const tab = window.open('', '_blank');
    setProblem(null);
    setNote(null);
    setWaiting({ since: Date.now() });
    try {
      const { url } = await api.startConnector(connector.id, permissions);
      if (tab) tab.location.href = url;
      setWaiting({ url, since: Date.now(), blocked: !tab });
    } catch (e) {
      tab?.close();
      setWaiting(null);
      setProblem((e as Error).message);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const { connector: next, revoked } = await api.disconnectConnector(connector.id);
      onChange(next);
      setConfirming(false);
      setNote(
        revoked
          ? null
          : web?.removedNote ??
              `Signed out here. ${connector.name} couldn't be reached to remove Tricot's access too; ${web?.signOutHint ?? 'you can remove it where you manage its access.'}`,
      );
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const { state, account } = connector;
  const signedIn = state === 'connected' || state === 'needs_sign_in' || (state === 'error' && account);
  const web = webConnector(connector.id);
  const permission = web?.permission;
  const allowed = Boolean(permission && connector.access.find((a) => a.scope === permission.scope)?.granted);
  const failure = problem ?? (waiting ? null : connector.lastFailure);
  const brokenFile = state === 'not_set_up' && connector.clientFile;
  return (
    <article className={`connector-card is-${state}`} aria-labelledby={`connector-${connector.id}`}>
      <header className="connector-head">
        <ConnectorMark id={connector.id} />
        <div className="connector-name">
          <h2 id={`connector-${connector.id}`}>{connector.name}</h2>
          {web?.serves && <p className="muted small">{web.serves}</p>}
        </div>
        <StateLabel state={state} />
      </header>

      {account && state !== 'not_set_up' && (
        <p className="connector-account">
          {state === 'connected' ? 'Connected as' : 'Was connected as'} <strong>{account.email}</strong>
          <span className="faint connector-since"> · {timeAgo(account.connectedAt)}</span>
        </p>
      )}
      {state !== 'not_set_up' && connector.clientSource && (
        <p className="faint small connector-client">
          {connector.clientSource === 'built-in' ? (
            <>Signs in with Tricot's own {connector.name} client: nothing to set up.</>
          ) : (
            <>
              Signs in with your own client, from <code>{connector.clientFile}</code>. A client file in the data folder always comes first.
            </>
          )}
        </p>
      )}
      {(state === 'needs_sign_in' || state === 'error' || brokenFile) && connector.message && (
        <p className={`connector-note${state === 'needs_sign_in' ? ' is-attention' : ' is-error'}`} role="status">
          {connector.message}
        </p>
      )}

      <section className="connector-section">
        <h3>{state === 'connected' ? 'What Tricot can use' : 'What Tricot asks to use'}</h3>
        <ul className="connector-access">
          {connector.access.map((line) => (
            <li key={line.scope} className={line.granted === false ? 'is-denied' : undefined}>
              <Icon name={line.granted === false ? 'x' : 'check'} className="connector-access-icon" />
              <span>
                {line.label}
                {line.granted === false && <span className="faint"> · not allowed; connect again to allow it</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="faint small">
          {web?.accessNote(connector) ?? "Read-only: it can't open what's in your files, or change anything."}
        </p>
        {connector.notice && state === 'connected' && (
          <p className="connector-note is-attention" role="status">
            {connector.notice}
          </p>
        )}
      </section>

      {state === 'connected' && web?.Panel && <web.Panel status={connector} />}

      {web?.SignIn && (state === 'ready' || state === 'needs_sign_in') && <web.SignIn status={connector} onChange={onChange} />}

      {state === 'not_set_up' && connector.setup && (
        <section className="connector-section">
          <h3>Set up {connector.name} once</h3>
          <p className="muted small">{web?.setup.intro}</p>
          <ol className="connector-steps">
            {connector.setup.steps.map((step, i) => (
              <li key={i}>
                <SetupStep text={step} folder={connector.setup!.folder} files={web?.setup.files ?? []} />
              </li>
            ))}
          </ol>
          <p className="muted small">This page picks the file up on its own.</p>
        </section>
      )}

      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      {note && <p className="muted small">{note}</p>}

      <footer className="connector-actions">
        {waiting ? (
          <>
            <span className="connector-waiting" role="status">
              <span className="connector-spinner" aria-hidden />
              {waiting.blocked
                ? `The browser didn't open a new tab. Open ${connector.name} to sign in, then come back here.`
                : `Finish signing in on the ${connector.name} tab…`}
            </span>
            {waiting.url && (
              <a className={`btn btn-small${waiting.blocked ? ' btn-primary' : ''}`} href={waiting.url} target="_blank" rel="noreferrer">
                {waiting.blocked ? `Open ${connector.name}` : 'Open it again'}
                <Icon name="external" />
              </a>
            )}
            <button className="btn btn-small btn-quiet" onClick={() => setWaiting(null)}>
              Cancel
            </button>
          </>
        ) : confirming ? (
          <>
            <span className="connector-confirm">
              Disconnect {connector.name}? Link cards go back to plain names, for every board.
            </span>
            <button className="btn btn-small" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
            <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {state === 'ready' && !web?.SignIn && (
              <button className="btn btn-primary" onClick={() => connect()}>
                Connect {connector.name}
              </button>
            )}
            {state === 'needs_sign_in' && !web?.SignIn && (
              <button className="btn btn-primary" onClick={() => connect()}>
                Connect again
              </button>
            )}
            {state === 'connected' && connector.notice && (
              <button className="btn btn-small" onClick={() => connect()}>
                Connect again
              </button>
            )}
            {state === 'connected' && permission && !allowed && (
              <button className="btn btn-small" onClick={() => connect([permission.name])} title={permission.title}>
                {permission.button}
              </button>
            )}
            {(state === 'not_set_up' || (state === 'error' && !account)) && (
              <button className="btn btn-small" onClick={refresh}>
                Check again
              </button>
            )}
            {state === 'ready' && !web?.SignIn && <span className="faint small">Opens {connector.name} in a new tab.</span>}
            {signedIn && (
              <button className={`btn ${state === 'connected' ? '' : 'btn-quiet '}btn-small`} onClick={() => setConfirming(true)}>
                Disconnect
              </button>
            )}
          </>
        )}
      </footer>
    </article>
  );
}

// The folder and file names in a step read as paths someone could paste.
function SetupStep({ text, folder, files }: { text: string; folder: string; files: readonly string[] }) {
  const names = [folder, ...files];
  const pattern = new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  return (
    <>
      {text.split(pattern).map((part, i) => (names.includes(part) ? <code key={i}>{part}</code> : part))}
    </>
  );
}

// ---- on Home -------------------------------------------------------------

// Each connector's state in a few words, beside its status square.
const LINE: Record<ConnectorStatus['state'], { text: string; square: string }> = {
  connected: { text: 'connected', square: 'decided' },
  ready: { text: 'not connected', square: 'idle' },
  not_set_up: { text: 'not set up', square: 'idle' },
  needs_sign_in: { text: 'needs you to sign in again', square: 'open' },
  error: { text: 'not working', square: 'blocking' },
};

// Home's bottom line: "Google connected", each a way to the Connectors page.
export function ConnectorsLine() {
  const { connectors } = useConnectors();
  if (!connectors) return null;
  if (connectors.length === 0) {
    return (
      <a className="home-link" href="#/connectors">
        Set up
      </a>
    );
  }
  return (
    <>
      {connectors.map((c) => (
        <a
          key={c.id}
          className="home-link home-status"
          href="#/connectors"
          title={c.state === 'connected' && c.account ? `Connected as ${c.account.email}` : `${STATE_LABEL[c.state].label}: open Connectors`}
        >
          <span className={`sq sq-${LINE[c.state].square}`} aria-hidden />
          {c.name} {LINE[c.state].text}
        </a>
      ))}
    </>
  );
}
