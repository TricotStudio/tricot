import type { Task } from '../../core/types';
import { Icon, timeAgo } from '../shared/components';

// The commit a person approved with the work ("Looks good, commit it"): a
// quiet line on a done task, waiting for the agent until it reports the hash.
// On a narrow card the wait wraps whole, under the words rather than the mark.
export function CommitLine({ task }: { task: Task }) {
  const commit = task.commit;
  if (!commit && task.noCommit && task.status === 'done') return <NoCommitLine task={task} />;
  if (!commit || task.status !== 'done') return null;
  const approved = `${commit.approvedBy.name} approved the commit ${timeAgo(commit.approvedAt)}`;
  if (commit.hash) {
    return (
      <p className="commit-line is-committed" title={`${approved}; committed ${timeAgo(commit.committedAt ?? commit.approvedAt)}`}>
        <Icon name="check" />
        <span>
          Commit approved ·{' '}
          <code className="commit-hash" title={commit.hash}>
            {commit.hash.slice(0, 7)}
          </code>
        </span>
      </p>
    );
  }
  return (
    <p className="commit-line" title={approved}>
      <span className="commit-waiting" aria-hidden />
      <span>
        Commit approved · <span className="commit-nowrap">waiting for the agent</span>
      </span>
    </p>
  );
}

// The agent's word that the work isn't in the repository, and why: on a review,
// where only "Looks good" is offered, and on the done task, where a hash would be.
export function NoCommitLine({ task }: { task: Task }) {
  const none = task.noCommit;
  if (!none) return null;
  return (
    <p className="commit-line is-committed" title={`${none.by.name} said so ${timeAgo(none.at)}`}>
      <Icon name="check" />
      <span>Nothing to commit: {none.reason}</span>
    </p>
  );
}
