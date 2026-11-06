import { useEffect, useId, useState } from 'react';
import { agentOfSource, findAgent } from '../../core/agents/registry';
import { liveStepsAgentFor, type LiveStepsAgent, type LiveStepsReport } from '../../core/liveSteps';
import {
  asOf,
  costText,
  dayStarts,
  liveWindows,
  notSharedLine,
  percentText,
  planText,
  sharesOf,
  tokenCount,
  tokensLine,
  toolOfSource,
  usageLevel,
  windowLine,
  windowName,
  workingText,
  type ActivityCounts,
  type AgentBoardActivity,
  type AgentUsage,
  type AgentUsageReport,
} from '../../core/usage';
import { api } from '../shared/api';
import './usage.css';

// The Usage section of an agent's panel: how much of its plan's windows the
// tool it runs in has used and when each resets, its tokens and cost where
// the tool says, and what it did on its board today and this week. The
// numbers come from its harness, through live steps (core/usage.ts); for a
// tool that keeps them to itself, a quiet line says so.

const REFRESH_MS = 30_000; // the numbers, read again while the panel is open
const TICK_MS = 15_000; // the countdowns, worked out again in the browser

function useUsage(name: string, board: string | undefined): AgentUsageReport | null {
  const [report, setReport] = useState<{ key: string; value: AgentUsageReport } | null>(null);
  const key = `${name}:${board ?? ''}`;
  useEffect(() => {
    let live = true;
    const load = () => {
      const { day, week } = dayStarts(Date.now());
      api.agentUsage(name, { board, day, week }).then(
        (value) => live && setReport({ key, value }),
        () => live && setReport((current) => current ?? { key, value: {} }),
      );
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [name, board, key]);
  return report?.key === key ? report.value : null;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// What to say when there are no plan numbers to show, or beside the ones
// there are: why, and what would bring them.
function quietLine(name: string, tool: LiveStepsAgent | undefined, usage: AgentUsage | undefined, toolId: string | undefined): string | undefined {
  const shares = sharesOf(toolId);
  const toolName = tool?.name ?? name;
  if (toolId === undefined) return usage ? undefined : `Tricot can't tell which tool ${name} runs in, so it has no usage to show.`;
  if (shares === 'none' || shares === 'tokens') {
    const line = notSharedLine(toolId, toolName)!;
    if (shares === 'none' || usage) return line;
    return tool && tool.state === 'on' ? `${line} They show here after its next turn.` : `${line} Turn on live steps to see them here.`;
  }
  if (tool?.usage === 'replaced') {
    return `Your status line changed since Tricot set it up, so ${tool.agentName}'s plan usage stopped coming. To have both, turn live steps off and on again: Tricot's status line then shows your new one.`;
  }
  if (tool && tool.state !== 'on') {
    return tool.state === 'partly'
      ? `Turn live steps on again to see ${tool.agentName}'s plan usage here.`
      : `Turn on live steps to see ${tool.agentName}'s plan usage here.`;
  }
  if (usage?.windows?.length) return undefined;
  return findAgent(toolId)?.usage.quiet?.(toolName, Boolean(usage));
}

export function AgentUsageSection({ name, board, liveSteps }: { name: string; board?: { id: string; title: string }; liveSteps: LiveStepsReport | null | undefined }) {
  const report = useUsage(name, board?.id);
  const now = useNow();
  const titleId = useId();
  if (report === null || liveSteps === null) return null;
  const usage = report.usage;
  const tool = liveSteps ? liveStepsAgentFor(name, liveSteps.agents) : undefined;
  const toolId = usage ? toolOfSource(usage.source) : tool?.id;
  const windows = liveWindows(usage?.windows, now);
  const stale = usage && asOf(windows.length ? (usage.windowsAt ?? usage.at) : usage.at, now);
  const meta = [usage?.plan && planText(usage.plan), stale].filter(Boolean).join(' · ');
  const quiet = quietLine(name, tool, usage, toolId);
  const extras = usage ? usageExtras(usage) : [];

  return (
    <section className="agent-usage" aria-labelledby={titleId}>
      <div className="agent-usage-head">
        <span className="agent-usage-title" id={titleId}>
          Usage
        </span>
        {meta && <span className="agent-usage-meta">{meta}</span>}
      </div>
      {windows.length > 0 && (
        <ul className="usage-windows">
          {windows.map((window) => {
            const label = windowName(window);
            const level = usageLevel(window.usedPercent);
            return (
              <li key={window.id} className={`usage-window is-${level}`}>
                <div className="usage-window-line">
                  <span className="usage-window-name">{label}</span>
                  <span className="usage-window-text">{windowLine(window, now)}</span>
                </div>
                <div
                  className="usage-bar"
                  role="meter"
                  aria-label={`${label} window used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, Math.round(window.usedPercent))}
                  aria-valuetext={windowLine(window, now)}
                >
                  <span className="usage-bar-fill" style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {extras.length > 0 && (
        <ul className="usage-extras">
          {extras.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {quiet && <p className="usage-quiet">{quiet}</p>}
      {report.activity && <BoardActivity activity={report.activity} />}
    </section>
  );
}

// Tokens, cost and context, where the tool says them, a line each.
function usageExtras(usage: AgentUsage): string[] {
  const lines: string[] = [];
  if (usage.tokens) lines.push(`${tokensLine(usage.tokens)}, this session`);
  if (usage.costUsd !== undefined) {
    lines.push(agentOfSource(usage.source)?.usage.listPrices ? `${costText(usage.costUsd)} this session, at list prices` : `${costText(usage.costUsd)} this session`);
  }
  if (usage.context) lines.push(`Context ${percentText(usage.context.usedPercent)} full, of ${tokenCount(usage.context.window)} tokens`);
  return lines;
}

const ROWS: [keyof ActivityCounts, string][] = [
  ['tasksFinished', 'Tasks finished'],
  ['decisionsPosted', 'Decisions posted'],
  ['comments', 'Comments and replies'],
  ['workingMs', 'Time working'],
];

function BoardActivity({ activity }: { activity: AgentBoardActivity }) {
  const value = (counts: ActivityCounts, key: keyof ActivityCounts) => (key === 'workingMs' ? workingText(counts.workingMs) : String(counts[key]));
  return (
    <table className="usage-board">
      <caption>On {activity.board.title}</caption>
      <thead>
        <tr>
          <td />
          <th scope="col">Today</th>
          <th scope="col">This week</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(([key, label]) => (
          <tr key={key}>
            <th scope="row">{label}</th>
            <td>{value(activity.today, key)}</td>
            <td>{value(activity.week, key)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
