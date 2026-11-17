import { repliesText } from '../../../core/connectors/slack/thread';
import type { LinkSource } from '../../../core/sources';
import type { Block } from '../../../core/types';
import { useCanvas } from '../../canvas/context';
import { Icon, timeAgo } from '../../shared/components';
import { useSlackThread } from './threads';
import { linkTo } from '../../shared/pages';

type LinkBlock = Extract<Block, { type: 'link' }>;

// What the card says when there is no thread to show: short, with the full words in its tooltip.
const PROBLEM_WORDS: Record<string, string> = {
  not_connected: 'Connect Slack to see this thread here.',
  needs_sign_in: 'Slack needs you to sign in again.',
  not_found: "Slack can't show this thread to this sign-in.",
  missing_scope: "Slack didn't let Tricot read this.",
};

// Under a Slack link's title: who wrote the thread's first message, what they
// said, and how many replies it has, live once Slack is connected. Until then
// it says how to connect, and the card stays a plain link.
export function SlackThreadCard({ source }: { block: LinkBlock; source: LinkSource }) {
  const canvas = useCanvas();
  const { thread, problem, busy, refresh } = useSlackThread(source.fileId);
  if (!source.fileId) return null;
  if (!thread && !problem) return <p className="slack-card faint small">{busy ? 'Looking it up on Slack…' : ''}</p>;
  if (problem) {
    const connect = problem.code === 'not_connected' || problem.code === 'needs_sign_in';
    return (
      <p className="slack-card slack-problem nodrag" role="status" title={problem.message}>
        <span className="slack-problem-text">{PROBLEM_WORDS[problem.code] ?? problem.message}</span>
        {connect && (
          <a className="btn btn-small btn-primary" href={linkTo.connectors(canvas.board.id)}>
            {problem.code === 'not_connected' ? 'Connect Slack' : 'Sign in again'}
          </a>
        )}
      </p>
    );
  }
  if (!thread) return null;
  return (
    <div className="slack-card nodrag">
      <p className="slack-head">
        <strong className="slack-author" title={thread.author}>
          {thread.author}
        </strong>
        <span className="faint" title={new Date(thread.postedAt).toLocaleString()}>
          {timeAgo(thread.postedAt)}
        </span>
      </p>
      <p className="slack-text">{thread.text || 'A message with no text.'}</p>
      <p className="slack-foot">
        <span className={`slack-replies${thread.replies ? ' has-replies' : ''}`}>{repliesText(thread.replies)}</span>
        {thread.latestReplyAt && thread.replies > 0 && <span className="faint">last reply {timeAgo(thread.latestReplyAt)}</span>}
        <span className="slack-spacer" />
        <button className="btn btn-small btn-quiet slack-refresh" disabled={busy} onClick={() => void refresh()} title="Look it up on Slack again" aria-label="Refresh from Slack">
          <Icon name="sync" />
        </button>
      </p>
    </div>
  );
}
