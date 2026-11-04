import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { APPROVAL_REASON_LIMIT, approvalAction, approvalText, needsYouTitle, notificationText, waitingWords, type Approval, type ApprovalReply } from '../core/approvals';
import { api } from './api';
import { approvalsStore } from './approvalsStore';
import { Icon } from './components';
import { admissionsStore, letThisBrowserIn, TicketedSource } from './seat';
import type { AdmissionView } from '../core/seats';
import { cardHash } from './hooks';
import { notificationsOn, notificationsSupported, ring, turnOnNotifications } from './notify';
import './approvals.css';

// An agent waiting for a person's OK (core/approvals.ts): its permission
// prompt, brought to the board by the hook in its harness. It shows on the
// card the agent is working on (its panel in full, a lane card as a pill),
// as a toast anywhere in Tricot, and on the chat bar's chip; while the tab
// is in the background its title says so ("⏸ Claude needs you"), and a
// system notification comes when the person turned them on. Once answered,
// here or in the terminal, it is gone from all of them.
//
// What the agent sent is shown as it sent it, as plain text: never Markdown,
// never a link. Only a person answers, from a browser they let in
// (seat.ts, server/approvalsRoutes.ts); a browser that isn't one is told
// that an agent waits, and where, and offered to be let in (sealed).

// ---- the requests waiting -----------------------------------------------------

export function useApprovals(): Approval[] {
  return useSyncExternalStore(approvalsStore.subscribe, approvalsStore.get);
}

// For a page that listens to no other stream (the connectors page).
export function useApprovalsStream(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const source = new TicketedSource('/api/approvals/stream');
    source.addEventListener('approvals', (event) => approvalsStore.set(JSON.parse(event.data) as Approval[]));
    source.addEventListener('admissions', (event) => admissionsStore.set(JSON.parse(event.data) as AdmissionView[]));
    return () => source.close();
  }, [open]);
}

// ---- which are shown in full on the page now ------------------------------------
// A card's panel shows its requests in full; the toast leaves those out, so
// the same buttons aren't on screen twice.

const inFull = new Map<string, number>();
const inFullListeners = new Set<() => void>();
let inFullVersion = 0;
const subscribeInFull = (listener: () => void) => {
  inFullListeners.add(listener);
  return () => inFullListeners.delete(listener);
};
function setInFull(id: string, by: number): void {
  inFull.set(id, (inFull.get(id) ?? 0) + by);
  if (!inFull.get(id)) inFull.delete(id);
  inFullVersion += 1;
  for (const listener of inFullListeners) listener();
}
function useShownInFull(id: string): void {
  useEffect(() => {
    setInFull(id, 1);
    return () => setInFull(id, -1);
  }, [id]);
}
function useInFull(): Set<string> {
  useSyncExternalStore(subscribeInFull, () => inFullVersion);
  return new Set(inFull.keys());
}

// ---- one request ----------------------------------------------------------------

// How long it has waited: "0:42", "12:05", "1:02:09".
function waited(since: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function Waited({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="approval-time" title={`Asked at ${new Date(since).toLocaleTimeString()}`}>
      {waited(since, now)}
    </span>
  );
}

// The request in full, with its answers. `toast`: in the toast, with where it is.
export function ApprovalRequest({ approval, name, toast = false }: { approval: Approval; name: string; toast?: boolean }) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const { text, more } = approvalText(approval);
  const sessionOffered = Boolean(approval.forSession?.length);

  useEffect(() => {
    if (denying) field.current?.focus();
  }, [denying]);

  const answer = async (reply: ApprovalReply) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerApproval(approval.id, name, reply);
      approvalsStore.drop(approval.id);
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      setError((failure as Error).message);
      setBusy(false);
      // No longer waiting (answered in the terminal): it leaves in a moment.
      if (status === 404) setTimeout(() => approvalsStore.drop(approval.id), 2500);
    }
  };
  const deny = (event: FormEvent) => {
    event.preventDefault();
    void answer({ behavior: 'deny', ...(reason.trim() && { reason: reason.trim() }) });
  };
  const where = approval.on;
  const cardLink = where?.card && approval.card ? cardHash[approval.card.kind](where.board, approval.card.id) : undefined;

  if (approval.sealed) return <SealedRequest approval={approval} toast={toast} cardLink={cardLink} />;

  return (
    <section className={`approval${toast ? ' is-toast' : ''}`} data-approval={approval.id} aria-label={waitingWords(approval)}>
      <header className="approval-head">
        <Icon name="pause" className="approval-mark" />
        <span className="approval-who">{waitingWords(approval)}</span>
        <Waited since={approval.at} />
      </header>
      <p className="approval-what">{approvalAction(approval)}</p>
      {/* As the agent sent it: plain text, never Markdown, never a link. */}
      <pre className="approval-input" tabIndex={0} aria-label="What it asks to run, as sent">
        {text}
      </pre>
      {more.length > 0 && (
        <ul className="approval-more" aria-label="Sent with it">
          {more.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {approval.description && <p className="approval-why">“{approval.description}”</p>}
      {toast && where && (
        <p className="approval-where">
          {cardLink ? (
            <a href={cardLink} title={where.cardTitle}>
              {where.card} on {where.title}
            </a>
          ) : (
            <>On {where.title}</>
          )}
        </p>
      )}
      {denying ? (
        <form className="approval-deny" onSubmit={deny}>
          <label className="approval-deny-label" htmlFor={`deny-${approval.id}`}>
            Tell {approval.agent} why <span className="faint">(optional; it reads this)</span>
          </label>
          <div className="approval-deny-row">
            <input
              id={`deny-${approval.id}`}
              ref={field}
              className="input approval-reason"
              value={reason}
              maxLength={APPROVAL_REASON_LIMIT}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                setDenying(false);
              }}
              placeholder="Use npm run build instead"
              disabled={busy}
            />
            <button type="submit" className="btn btn-small approval-deny-button" disabled={busy}>
              Deny
            </button>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => setDenying(false)} disabled={busy}>
              Back
            </button>
          </div>
        </form>
      ) : (
        <div className="approval-actions">
          <button type="button" className="btn btn-primary btn-small" onClick={() => void answer({ behavior: 'allow' })} disabled={busy}>
            Allow
          </button>
          {sessionOffered && (
            <button type="button" className="btn btn-small" onClick={() => void answer({ behavior: 'allow', session: true })} disabled={busy}>
              Allow for this session
            </button>
          )}
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setDenying(true)} disabled={busy}>
            Deny…
          </button>
        </div>
      )}
      {sessionOffered && !denying && (
        <p className="approval-session">
          For this session also allows <span className="approval-rules">{approval.forSession!.join(', ')}</span>, until {approval.agent} ends it.
        </p>
      )}
      {error && (
        <p className="error approval-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// What a browser that isn't one of the person's seats is told: that an agent
// waits, and where, but not what it asks, and how to let this browser in.
function SealedRequest({ approval, toast, cardLink }: { approval: Approval; toast: boolean; cardLink?: string }) {
  const [busy, setBusy] = useState(false);
  const where = approval.on;
  return (
    <section className={`approval is-sealed${toast ? ' is-toast' : ''}`} data-approval={approval.id} aria-label={waitingWords(approval)}>
      <header className="approval-head">
        <Icon name="pause" className="approval-mark" />
        <span className="approval-who">{waitingWords(approval)}</span>
        <Waited since={approval.at} />
      </header>
      <p className="approval-what">This browser can’t see what it asks until you let it act for you. It takes one keypress in Tricot’s terminal, or one click in a browser you’ve let in, once.</p>
      {toast && where && (
        <p className="approval-where">
          {cardLink ? (
            <a href={cardLink} title={where.cardTitle}>
              {where.card} on {where.title}
            </a>
          ) : (
            <>On {where.title}</>
          )}
        </p>
      )}
      <div className="approval-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void letThisBrowserIn().finally(() => setBusy(false));
          }}
        >
          Let this browser in
        </button>
      </div>
    </section>
  );
}

// ---- on a card ------------------------------------------------------------------

const onCard = (approval: Approval, kind: 'task' | 'decision', id: string) => approval.card?.kind === kind && approval.card.id === id;

function InFull({ approval, name }: { approval: Approval; name: string }) {
  useShownInFull(approval.id);
  return <ApprovalRequest approval={approval} name={name} />;
}

// The requests of the agents working on this card: in full in its panel
// (`band`), as a pill on a lane card, which opens the card.
export function CardApprovals({ kind, id, name, band = false }: { kind: 'task' | 'decision'; id: string; name?: string; band?: boolean }) {
  const mine = useApprovals().filter((a) => onCard(a, kind, id));
  if (mine.length === 0) return null;
  if (band && name) {
    return (
      <div className="approval-band">
        {mine.map((approval) => (
          <InFull key={approval.id} approval={approval} name={name} />
        ))}
      </div>
    );
  }
  const agents = [...new Set(mine.map((a) => a.agent))];
  return (
    <span className="approval-pill" role="status" title={mine.map((a) => `${waitingWords(a)}: ${approvalAction(a)}`).join('\n')}>
      <Icon name="pause" />
      {agents.length === 1 ? `${agents[0]} needs your OK` : `${agents.length} agents need your OK`}
    </span>
  );
}

// ---- the toast ------------------------------------------------------------------

// Brings a request into view and to the keyboard: the chat bar's chip asks.
export function showApproval(id: string): void {
  const element = document.querySelector<HTMLElement>(`[data-approval="${CSS.escape(id)}"]`);
  if (!element) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  element.querySelector<HTMLButtonElement>('.approval-actions .btn')?.focus({ preventScroll: true });
}

// Every request not shown in full on the page now, at the foot of the window,
// wherever the person is in Tricot.
export function ApprovalToasts({ name }: { name: string }) {
  const approvals = useApprovals();
  const full = useInFull();
  const shown = approvals.filter((a) => !full.has(a.id));
  if (shown.length === 0) return null;
  return (
    <div className="approval-toasts" role="region" aria-label="Agents waiting for your OK">
      {shown.map((approval) => (
        <ApprovalRequest key={approval.id} approval={approval} name={name} toast />
      ))}
      <NotifyOffer />
    </div>
  );
}

// Notifications for the next one, offered where the request is; the
// browser asks only once the person clicks.
function NotifyOffer() {
  const [on, setOn] = useState(notificationsOn);
  if (on || !notificationsSupported || Notification.permission === 'denied') return null;
  return (
    <button
      type="button"
      className="link-button approval-notify"
      onClick={() => void turnOnNotifications().then(setOn)}
      title="A system notification when an agent waits for your OK while Tricot is in the background"
    >
      <Icon name="bell" /> Notify me when an agent needs me
    </button>
  );
}

// ---- the chat bar's chip ----------------------------------------------------------

// On the chat bar, beside who is listening: who is waiting for the person's OK.
export function ApprovalChip() {
  const approvals = useApprovals();
  if (approvals.length === 0) return null;
  const agents = [...new Set(approvals.map((a) => a.agent))];
  const words = agents.length === 1 ? `${agents[0]} needs your OK` : `${agents.length} agents need your OK`;
  return (
    <button type="button" className="chat-approval" onClick={() => showApproval(approvals[0].id)} title={approvals.map((a) => `${waitingWords(a)}: ${approvalAction(a)}`).join('\n')}>
      <Icon name="pause" />
      <span className="chat-approval-text">{words}</span>
    </button>
  );
}

// ---- when the tab is in the background --------------------------------------------

// The tab's title says an agent needs the person while the tab is hidden,
// and a system notification comes for each new request, when they turned
// them on. Nothing changes while they look at the tab.
export function useApprovalAttention(): void {
  const approvals = useApprovals();
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const base = useRef<string | undefined>(undefined);
  const heard = useRef<Set<string> | null>(null);

  useEffect(() => {
    const change = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);

  const title = hidden ? needsYouTitle(approvals.map((a) => a.agent)) : '';
  useEffect(() => {
    if (title) {
      if (base.current === undefined) base.current = document.title;
      document.title = title;
      return;
    }
    if (base.current === undefined) return;
    if (document.title.includes('needs you') || document.title.includes('need you')) document.title = base.current;
    base.current = undefined;
  }, [title]);

  useEffect(() => {
    const ids = new Set(approvals.map((a) => a.id));
    const before = heard.current;
    heard.current = ids;
    if (!before || !hidden || !notificationsOn()) return; // the first list is what was waiting already
    const fresh = approvals.filter((a) => !before.has(a.id));
    for (const approval of fresh.slice(-3)) {
      const words = notificationText(approval);
      const notification = new Notification(words.title, { body: words.body, tag: `approval-${approval.id}` });
      notification.onclick = () => {
        window.focus();
        if (approval.on && approval.card) location.hash = cardHash[approval.card.kind](approval.on.board, approval.card.id);
        notification.close();
      };
    }
    if (fresh.length) ring();
  }, [approvals, hidden]);
}
