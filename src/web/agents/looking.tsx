import { createContext, useContext } from 'react';
import { showsLooking } from '../../core/assignee';
import { firstLookCue, openedCue } from '../../core/firstLook';
import { listNames, samePerson } from '../../core/format';
import type { Board, Task } from '../../core/types';
import type { AgentPresence } from '../shared/api';
import { busyOfPhase, StepText, stepWords, useCardStep } from './steps';
import { Stitch } from '../shared/stitch';
import './steps.css';

// The agents on the board on screen, so any card can say which are looking at it.
const AgentsContext = createContext<AgentPresence[]>([]);
export const AgentsProvider = AgentsContext.Provider;
export const useAgents = () => useContext(AgentsContext);

// "Claude is taking a look": a card's cue while an agent's calls are about it,
// gone a minute after its last one. When the agent's harness sends its steps
// (steps.tsx), the cue says what it is doing instead, "Claude · Running npm
// test", for as long as the steps come, and dims when they stop. The
// "working on it" stitch (stitch.tsx) casts on as the agent comes to the
// card, knits while it works, and rests once its step dims.
// A pill on lane cards; a slim band at the head of the card's panel. Spans
// throughout, as decision cards are buttons. On a task assigned to an agent,
// only that agent shows, and one a comment there asks (core/assignee.ts).
// An agent whose last call was about the card and that waits for updates now
// (a reply here with then_wait) is listening, not looking: "Claude is
// listening", its stitch at rest. Its step about the reply ended as the reply
// landed (server/steps.ts).
export function TakingALook({ kind, id, task, band = false }: { kind: 'task' | 'decision'; id: string; task?: Task; band?: boolean }) {
  const shows = (agent: string) => !task || showsLooking(task, agent);
  const looking = useContext(AgentsContext).filter((a) => a.focus?.kind === kind && a.focus.id === id && shows(a.name));
  const current = useCardStep(kind, id, shows);
  const names = looking.map((a) => a.name);
  if (current && !names.some((n) => samePerson(n, current.step.agent))) names.unshift(current.step.agent);
  if (names.length === 0) return null;
  const dim = current?.phase === 'dim';
  const listening = !current && looking.every((a) => a.state === 'listening');
  // The whole step goes in the tooltip; on a lane card's narrow pill, a long
  // path gives way in its middle, so the file's name shows (StepText).
  const words = current && stepWords(current.step);
  const title = current
    ? `${current.step.agent}${current.step.role ? ` (${current.step.role} subagent)` : ''}: ${words}, at ${new Date(current.step.at).toLocaleTimeString()}`
    : listening
      ? `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} waiting for updates on the board, after a call about this card in the last minute`
      : `${listNames(names)} read or changed this card in the last minute`;
  return (
    <span
      className={`${band ? 'looking looking-band' : 'looking'}${current ? ' has-step' : ''}${dim ? ' is-dim' : ''}`}
      role={band ? 'status' : undefined}
      title={title}
    >
      <span className="looking-marks" aria-hidden>
        {names.map((name) => (
          <span key={name} className="looking-mark">
            {name.charAt(0).toUpperCase()}
          </span>
        ))}
      </span>
      {/* The stitch holds on to the last word, so a wrapped line ends with
          it, and is in the same place with or without a step: the first
          step changes the words, and the stitch knits on. */}
      <span className="looking-text">
        {current ? (
          <>
            {current.step.agent}
            <span className="looking-sep" aria-hidden>
              {' · '}
            </span>
          </>
        ) : (
          `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} ${listening ? '' : 'taking a '}`
        )}
        <span className="looking-end">
          {current ? (
            // A new step fades in; a steady stream of them isn't read out.
            <span key={current.step.at} className="looking-step" aria-live="off">
              <StepText text={words!} />
            </span>
          ) : listening ? (
            'listening'
          ) : (
            'look'
          )}
          <Stitch state={current ? busyOfPhase(current.phase) : listening ? 'resting' : 'casting'} />
        </span>
      </span>
    </span>
  );
}

// A backlog card's first look while it's to come, in a quiet line: "Assign or
// @-mention an agent for a first look" until a person assigns one or someone
// mentions one, then "Waiting for Codex's first look", or "Claude is taking
// the first look". While the
// taker's calls are about the card, its "taking a look" pill says so already.
// A card an agent opened needs none, and says who opened it: "Opened by Claude".
export function FirstLookCue({ board, task }: { board: Board; task: Task }) {
  const agents = useContext(AgentsContext);
  const cue = firstLookCue(board, task);
  if (!cue) {
    const opened = openedCue(task);
    if (!opened) return null;
    return (
      <p className="first-look is-opened" title={`${opened.by} opened this card with what it found, so it needs no first look. Mark it ready when it's worth doing.`}>
        {opened.text}
      </p>
    );
  }
  const looking = cue.by && agents.some((a) => a.focus?.kind === 'task' && a.focus.id === task.id && samePerson(a.name, cue.by!));
  if (looking) return null;
  return (
    <p className={`first-look${cue.by ? ' is-taken' : ''}`} title="One agent comments on a new backlog card with how feasible it is and how it would go">
      {cue.text}
    </p>
  );
}
