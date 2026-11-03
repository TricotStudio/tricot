import { useMemo, useState } from 'react';
import { checksText, STATE_WORDS, type ChecksSummary, type GithubCard } from '../../../core/connectors/github/card';
import { cardKey, githubTarget, type FileTarget } from '../../../core/connectors/github/link';
import type { LinkSource } from '../../../core/sources';
import type { Block } from '../../../core/types';
import { Icon } from '../../components';
import { useCanvas } from '../../canvas/context';
import { githubApi } from './api';
import { useGithubCard } from './cards';

type LinkBlock = Extract<Block, { type: 'link' }>;

// What a GitHub link card says under its title, live: a pull request's or
// issue's state, author and checks with a button to show its changes; a file's
// button to bring it in. Quiet when GitHub isn't connected: the card stays a plain link.
export function GithubCardDetails({ block }: { block: LinkBlock; source: LinkSource }) {
  const target = useMemo(() => githubTarget(block.url), [block.url]);
  if (!target) return null;
  return target.kind === 'file' ? <FileDetails block={block} target={target} /> : <PullOrIssueDetails block={block} target={target} />;
}

function checksLabel({ passing, failing, pending }: ChecksSummary): string {
  const total = passing + failing + pending;
  if (total === 0) return 'No checks';
  if (failing) return `${failing} failing`;
  if (pending) return `${pending} pending`;
  return `${passing} passing`;
}

function ChecksChip({ checks }: { checks: ChecksSummary }) {
  const total = checks.passing + checks.failing + checks.pending;
  const tone = checks.failing ? 'failing' : checks.pending ? 'pending' : total ? 'passing' : 'none';
  return (
    <span className={`gh-checks is-${tone}`} title={`Checks on the latest commit: ${checksText(checks)}`}>
      <span className="gh-dot" aria-hidden />
      {checksLabel(checks)}
    </span>
  );
}

function Pill({ card }: { card: GithubCard }) {
  return <span className={`gh-state is-${card.state}`}>{STATE_WORDS[card.state]}</span>;
}

// Adds a block beside the card as the person, and says it did.
function useAdd(run: (actor: string) => Promise<unknown>) {
  const canvas = useCanvas();
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const start = () => {
    setState('working');
    canvas.perform(async (actor) => {
      try {
        await run(actor);
        setState('done');
      } catch (error) {
        setState('idle');
        throw error;
      }
    });
  };
  return { state, start, canAdd: !canvas.readOnly };
}

// What the card says in its one line; the full words are in its tooltip.
const PROBLEM_WORDS: Record<string, string> = {
  not_installed: "Tricot can't see it yet",
  needs_sign_in: 'GitHub needs you to sign in again',
  not_found: "GitHub can't find this",
};

function PullOrIssueDetails({ block, target }: { block: LinkBlock; target: Exclude<ReturnType<typeof githubTarget>, FileTarget | null> }) {
  const { card, problem, busy, refresh } = useGithubCard(cardKey(target));
  const changes = useAdd((actor) => githubApi.showChanges(block.id, actor));
  if (!card && !problem) return busy ? <p className="gh-details faint">Looking it up on GitHub…</p> : null;
  if (problem) {
    if (problem.code === 'not_connected') return null;
    const short = PROBLEM_WORDS[problem.code] ?? problem.message;
    return (
      <p className={`gh-details gh-problem is-${problem.code}`} role="status">
        <span className="gh-problem-text" title={problem.message}>
          {short}
        </span>
        {problem.code === 'not_installed' && problem.installUrl && (
          <a className="btn btn-small nodrag" href={problem.installUrl} target="_blank" rel="noreferrer" title={problem.message}>
            Install Tricot on {target.owner}/{target.repo}
            <Icon name="external" />
          </a>
        )}
        {problem.code === 'needs_sign_in' && (
          <a className="btn btn-small nodrag" href="#/connectors">
            Sign in again
          </a>
        )}
      </p>
    );
  }
  if (!card) return null;
  return (
    <div className="gh-details nodrag">
      <Pill card={card} />
      <span className="gh-by" title={`${card.repo} #${card.number}, by ${card.author}`}>
        {card.author}
      </span>
      {card.checks && <ChecksChip checks={card.checks} />}
      <span className="gh-spacer" />
      {card.kind === 'pull' && changes.canAdd && (
        <button className="btn btn-small" disabled={changes.state !== 'idle'} onClick={changes.start} title="Add this pull request's changes to the canvas, as a diff beside the card">
          {changes.state === 'done' ? 'Changes added' : changes.state === 'working' ? 'Adding…' : 'Show the changes'}
        </button>
      )}
      <button className="btn btn-small btn-quiet gh-refresh" disabled={busy} onClick={() => void refresh()} title="Look it up on GitHub again" aria-label="Refresh from GitHub">
        <Icon name="sync" />
      </button>
    </div>
  );
}

function FileDetails({ block, target }: { block: LinkBlock; target: FileTarget }) {
  const file = useAdd((actor) => githubApi.bringInFile(block.id, actor));
  const lines = target.lines && (target.lines[0] === target.lines[1] ? `line ${target.lines[0]}` : `lines ${target.lines[0]}–${target.lines[1]}`);
  if (!file.canAdd) return null;
  return (
    <div className="gh-details nodrag">
      <span className="gh-by">{lines ? `Highlights ${lines}` : 'A file on GitHub'}</span>
      <span className="gh-spacer" />
      <button className="btn btn-small" disabled={file.state !== 'idle'} onClick={file.start} title="Add this file to the canvas as code, at the commit the link names">
        {file.state === 'done' ? 'File brought in' : file.state === 'working' ? 'Bringing in…' : 'Bring in this file'}
      </button>
    </div>
  );
}
