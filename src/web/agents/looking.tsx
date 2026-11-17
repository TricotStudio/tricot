import { createContext, useContext } from 'react';
import { listNames, samePerson } from '../../core/format';
import type { CardKindName } from '../../core/pins';
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
// throughout, as decision cards are buttons. `shows` says which agents show on
// a card at all: a task assigned to an agent shows only that agent, and one a
// comment there asks (`showsLooking`, which a part's cards pass); none
// given, every agent whose call was about the card.
// An agent whose last call was about the card and that waits for updates now
// (a reply here with then_wait) is listening, not looking: "Claude is
// listening", its stitch at rest. Its step about the reply ended as the reply
// landed (server/steps.ts). One whose turn ended there, for Tricot's terminal
// to wake it, is at rest the same way: "Claude is asleep".
export function TakingALook({ kind, id, shows = () => true, band = false }: { kind: CardKindName; id: string; shows?: (agent: string) => boolean; band?: boolean }) {
  const looking = useContext(AgentsContext).filter((a) => a.focus?.kind === kind && a.focus.id === id && shows(a.name));
  const current = useCardStep(kind, id, shows);
  const names = looking.map((a) => a.name);
  if (current && !names.some((n) => samePerson(n, current.step.agent))) names.unshift(current.step.agent);
  if (names.length === 0) return null;
  const dim = current?.phase === 'dim';
  const listening = !current && looking.every((a) => a.state === 'listening' || a.state === 'asleep');
  const rest = looking.every((a) => a.state === 'asleep') ? 'asleep' : 'listening';
  // The whole step goes in the tooltip; on a lane card's narrow pill, a long
  // path gives way in its middle, so the file's name shows (StepText).
  const words = current && stepWords(current.step);
  const title = current
    ? `${current.step.agent}${current.step.role ? ` (${current.step.role} subagent)` : ''}: ${words}, at ${new Date(current.step.at).toLocaleTimeString()}`
    : listening
      ? rest === 'asleep'
        ? `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} asleep after a call about this card in the last minute: Tricot wakes ${names.length === 1 ? 'it' : 'them'} when something needs ${names.length === 1 ? 'it' : 'them'}`
        : `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} waiting for updates on the board, after a call about this card in the last minute`
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
            rest
          ) : (
            'look'
          )}
          <Stitch state={current ? busyOfPhase(current.phase) : listening ? 'resting' : 'casting'} />
        </span>
      </span>
    </span>
  );
}
