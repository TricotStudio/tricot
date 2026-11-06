import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { channelFrom } from '../../../core/connectors/slack/link';
import { decisionMessage } from '../../../core/connectors/slack/share';
import type { Board, Decision } from '../../../core/types';
import { api } from '../../shared/api';
import { slackApi } from './api';
import '../../shared/dialog.css';
import { linkTo } from '../../shared/pages';

const REMEMBERED = 'tricot:slack-channel';

const remembered = (): string => {
  try {
    return localStorage.getItem(REMEMBERED) ?? '';
  } catch {
    return '';
  }
};

const SLACK_MARKUP = /\*([^*\n]+)\*|_([^_\n]+)_|<([^|>\n]+)\|([^>\n]+)>/g;
const unescaped = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The message as Slack will show it: its *bold*, _italic_ and <link|label> drawn, its escapes undone.
function SlackText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, at) => {
        const parts: ReactNode[] = [];
        let last = 0;
        for (const match of line.matchAll(SLACK_MARKUP)) {
          parts.push(unescaped(line.slice(last, match.index)));
          if (match[1] !== undefined) parts.push(<strong key={parts.length}>{unescaped(match[1])}</strong>);
          else if (match[2] !== undefined) parts.push(<em key={parts.length}>{unescaped(match[2])}</em>);
          else parts.push(<span key={parts.length} className="slack-share-link">{unescaped(match[4])}</span>);
          last = match.index + match[0].length;
        }
        parts.push(unescaped(line.slice(last)));
        return (
          <p key={at} className="slack-share-line">
            {parts}
          </p>
        );
      })}
    </>
  );
}

// "Share to Slack" on a decision's ⋯: shows what will be posted (the
// question, the options and a link back), asks which channel, and posts it
// as the person, who is the one pressing the button. Nothing is sent before.
export function ShareDecisionDialog({ board, decision, onClose }: { board: Board; decision: Decision; onClose: () => void }) {
  const [channel, setChannel] = useState(remembered);
  const [as, setAs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const link = `${location.origin}/${linkTo.decision(board.id, decision.id)}`;
  const valid = channelFrom(channel) !== null;

  useEffect(() => {
    api.connectors().then(
      (list) => setAs(list.find((c) => c.id === 'slack')?.account?.email ?? null),
      () => {},
    );
  }, []);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose, busy]);

  const share = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await slackApi.shareDecision(decision.id, channel.trim());
      try {
        localStorage.setItem(REMEMBERED, channel.trim());
      } catch {
        // Not kept: the person types it next time.
      }
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="delete-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="delete-dialog slack-share" role="dialog" aria-modal="true" aria-labelledby="slack-share-title" onSubmit={share}>
        <h2 id="slack-share-title">Share to Slack</h2>
        {done ? (
          <>
            <p role="status">Shared to Slack{as ? `, as ${as}` : ''}.</p>
            <div className="delete-actions">
              <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Posts this decision to a channel{as ? <>, as <strong>{as}</strong></> : ''}. It comes from your own Slack account, only when you press the button.
            </p>
            <label className="delete-label" htmlFor="slack-share-channel">
              Channel
            </label>
            <input
              id="slack-share-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="A link to the channel, or to a message in it"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <p className="faint small">In Slack, right-click the channel or a message in it, then Copy link. A channel ID (C…) works too.</p>
            <label className="delete-label" htmlFor="slack-share-preview">
              What will be posted
            </label>
            <div id="slack-share-preview" className="slack-share-preview" role="group" aria-label="What will be posted">
              <SlackText text={decisionMessage(decision, link)} />
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="delete-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
                {busy ? 'Sharing…' : 'Share to Slack'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body,
  );
}
