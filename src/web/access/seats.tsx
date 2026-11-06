import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { AdmissionView, SeatView } from '../../core/seats';
import { api } from '../shared/api';
import { Icon, timeAgo } from '../shared/components';
import { admissionsStore, seatPrompt } from '../shared/seat';
import './seats.css';

// The person's seats on the page (seat.ts, core/seats.ts, T187):
// - while this browser asks to be let in, the code to look for, and "Press y
//   in Tricot's terminal" (SeatPromptDialog);
// - in a browser already let in, each browser or terminal asking to act for
//   the person, with Allow and Deny (AdmissionBanners);
// - "Your browsers and terminals", from the menu under your name: each one
//   that acts for you, who let it in and when, when it was last used, and
//   Remove (SeatsPanel).

// ---- this browser, asking ------------------------------------------------------------------

export function SeatPromptDialog() {
  const prompt = useSyncExternalStore(seatPrompt.subscribe, seatPrompt.get);
  useEffect(() => {
    if (!prompt) return;
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && seatPrompt.dismiss();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [prompt]);
  if (!prompt) return null;
  const close = (
    <button type="button" className="btn btn-small" onClick={() => seatPrompt.dismiss()} autoFocus>
      Close
    </button>
  );
  return createPortal(
    <div className="seat-scrim">
      <section className="seat-dialog seat-prompt" role="dialog" aria-modal="true" aria-labelledby="seat-title" aria-describedby="seat-lead">
        <h2 id="seat-title">Let this browser act for you</h2>
        {prompt.state === 'asking' && (
          <p id="seat-lead" className="seat-lead">
            Asking Tricot…
          </p>
        )}
        {prompt.state === 'waiting' && (
          <>
            <p id="seat-lead" className="seat-lead">
              Press <kbd>y</kbd> in the terminal where Tricot runs, or run <code>tricot access</code>. It shows this code:
            </p>
            <p className="seat-code" aria-label={`Code ${prompt.code.split('').join(' ')}`}>
              {prompt.code}
            </p>
            <p className="seat-note">
              {prompt.first
                ? 'This is the first browser, so any Tricot terminal can let it in. After this, only browsers and terminals you’ve let in can let others in.'
                : 'Or allow it from a browser you’ve already let in.'}
            </p>
            <p className="seat-note seat-faint">
              It’s once for this browser. Answering agents, approving commits, deciding and the like need it, so a program that pretends to be this page can’t do them as you.
            </p>
            <div className="seat-actions">
              <span className="seat-waiting" role="status">
                <span className="seat-dot" aria-hidden="true" /> Waiting for you there
              </span>
              <button type="button" className="btn btn-quiet btn-small" onClick={() => seatPrompt.dismiss()}>
                Not now
              </button>
            </div>
          </>
        )}
        {prompt.state === 'denied' && (
          <>
            <p id="seat-lead" className="seat-lead">
              It was denied{prompt.by ? ` ${prompt.by}` : ''}, so nothing was done.
            </p>
            <div className="seat-actions">{close}</div>
          </>
        )}
        {prompt.state === 'expired' && (
          <>
            <p id="seat-lead" className="seat-lead">
              Nobody allowed it in time, so nothing was done. Try again when you’re at Tricot’s terminal.
            </p>
            <div className="seat-actions">{close}</div>
          </>
        )}
        {prompt.state === 'failed' && (
          <>
            <p id="seat-lead" className="seat-lead error" role="alert">
              {prompt.error}
            </p>
            <div className="seat-actions">{close}</div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}

// ---- another browser or terminal, asking ----------------------------------------------------

export function useAdmissions(): AdmissionView[] {
  return useSyncExternalStore(admissionsStore.subscribe, admissionsStore.get);
}

// "A browser wants to act for you", or "Let this terminal answer for you?",
// with its code, as the one asking shows it.
function Admission({ admission, name }: { admission: AdmissionView; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminal = admission.kind === 'terminal';
  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerAdmission(admission.id, name, allow);
      admissionsStore.drop(admission.id);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <section className="admission" aria-label={terminal ? 'A terminal asks to answer for you' : 'A browser asks to act for you'}>
      <header className="admission-head">
        <Icon name="desktop" className="admission-mark" />
        <span>{terminal ? 'Let this terminal answer for you?' : 'A browser wants to act for you'}</span>
      </header>
      <p>
        {admission.label}, code <strong className="admission-code">{admission.code}</strong>. Allow it only if the {terminal ? 'terminal' : 'browser'} you’re using shows this code.
      </p>
      <div className="admission-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={() => void answer(true)} disabled={busy}>
          Allow
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => void answer(false)} disabled={busy}>
          Deny
        </button>
      </div>
      {error && (
        <p className="error admission-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function AdmissionBanners({ name }: { name: string }) {
  const admissions = useAdmissions();
  if (!admissions.length) return null;
  return (
    <div className="admission-banners" role="region" aria-label="Asking to act for you">
      {admissions.map((admission) => (
        <Admission key={admission.id} admission={admission} name={name} />
      ))}
    </div>
  );
}

// ---- the list ---------------------------------------------------------------------------------

// Your browsers and terminals: each one that acts for you, and Remove. Opened
// from a browser that isn't one, it asks to be let in first (api.ts).
export function SeatsPanel({ name, onClose }: { name: string; onClose: () => void }) {
  const [seats, setSeats] = useState<SeatView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.seats().then(
      (list) => live && setSeats(list),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);

  const remove = async (seat: SeatView) => {
    setBusy(seat.id);
    setError(null);
    try {
      setSeats(await api.removeSeat(seat.id, name));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Nothing shows until the list comes: a browser that isn't let in asks first (SeatPromptDialog).
  if (!seats && !error) return null;
  return createPortal(
    <div className="seat-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="seat-dialog seats-panel" role="dialog" aria-modal="true" aria-labelledby="seats-title">
        <h2 id="seats-title">Your browsers and terminals</h2>
        <p className="seat-note">
          These act for you: answering agents, approving commits, deciding and the like. Anything else that reaches Tricot can only comment and shape the board.
        </p>
        {seats && (
          <ul className="seats-list">
            {seats.map((seat) => (
              <li key={seat.id} className="seats-row">
                <Icon name={seat.kind === 'terminal' ? 'code' : 'desktop'} className="seats-mark" />
                <div className="seats-main">
                  <p className="seats-label">
                    {seat.label}
                    {seat.you && <span className="seats-you">This browser</span>}
                  </p>
                  <p className="seats-meta">
                    Let in {timeAgo(seat.admittedAt)} {seat.admittedBy}
                    {seat.lastUsedAt ? ` · last used ${timeAgo(seat.lastUsedAt)}` : ' · not used yet'}
                  </p>
                </div>
                <button type="button" className="btn btn-quiet btn-small seats-remove" onClick={() => void remove(seat)} disabled={busy !== null} aria-label={`Remove ${seat.label}`}>
                  {busy === seat.id ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="seat-actions">
          <button type="button" className="btn btn-small" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
