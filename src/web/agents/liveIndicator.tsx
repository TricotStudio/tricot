import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { planProgress } from "../../core/agentWork";
import { presenceRank } from "../../core/delivery";
import { samePerson } from "../../core/format";
import type { AgentPresence } from "../shared/api";
import { ActorBadge, timeAgo } from "../shared/components";
import { useDismiss } from "../shared/hooks";
import { Peek } from "./peek";
import { useWork } from "./steps";

// What each agent state means for the person waiting on it, most reachable first.
const AGENT_STATES: Record<
  AgentPresence["state"],
  { label: string; meaning: (lastSeen: string) => string }
> = {
  listening: {
    label: "listening",
    meaning: () => "Waiting on the board, so it sees what you do right away.",
  },
  asleep: {
    label: "asleep",
    meaning: () =>
      "Its turn is over, so it spends nothing while it waits. Tricot wakes it in its terminal as soon as something on the board needs it.",
  },
  working: {
    label: "working",
    meaning: (seen) =>
      `Busy with a step; it sees what you do when it next checks the board (last checked ${timeAgo(seen)}).`,
  },
  away: {
    label: "not checking",
    meaning: (seen) =>
      `Last checked the board ${timeAgo(seen)}; nudge it in its session if you're waiting on it.`,
  },
};

// An agent asleep whose wake, typed into its terminal, started no turn.
const STUCK_MEANING =
  "Tricot typed a wake into its terminal, but its turn didn't start: look at its terminal. Tricot tries again when something new needs it.";

// How long the pointer can be off the live label and its card before the card
// opens or closes, so passing over the label doesn't flash it.
const LIVE_CARD_DELAY_MS = 150;

// Whether the board is live, and which agents are on it, in a few words: an
// agent by name and state, or how many. The dot follows the most reachable
// agent. Hovering or focusing the label opens a card with each agent's state,
// what that means for you, and the tasks it's on. The card stays open while
// the pointer or focus is on it, so its links can be used; a click outside it
// or Escape closes it. What an agent is working on, if the page says (`work`:
// the tasks it has in progress, a part's, shared/boardViews.ts), is a line under its state. An agent whose
// work the board has heard (its plan, its steps: core/agentWork.ts) has "See what it's doing", which opens the peek
// (peek.tsx) under the label, for work an agent does from its own terminal, with no message on the board to open it from.
export function LiveIndicator({
  live,
  agents = [],
  work,
}: {
  live: boolean;
  agents?: AgentPresence[];
  work?: (agent: AgentPresence) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [peeking, setPeeking] = useState<string | null>(null);
  const heard = useWork();
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = useCallback((escape: boolean) => {
    // Focus goes back to the label before the card closes, so it isn't lost with the card's links.
    if (escape && root.current?.contains(document.activeElement))
      label.current?.focus();
    setOpen(false);
  }, []);
  useDismiss(open, close, root);
  const workOf = (name: string) => heard.find((w) => samePerson(w.agent, name));
  if (!live) {
    return (
      <div className="live" title="Reconnecting…">
        <span className="live-label">
          <span className="live-dot" /> Offline
        </span>
      </div>
    );
  }
  const later = (next: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), LIVE_CARD_DELAY_MS);
  };
  const focusedWithin = () =>
    root.current?.contains(document.activeElement) ?? false;
  // Most reachable first, so the card's first row is the one the dot follows.
  const byReach = [...agents].sort(
    (a, b) => presenceRank(a.state) - presenceRank(b.state),
  );
  const reachable = byReach[0]?.state ?? "listening";
  const words =
    agents.length === 0
      ? "No agents"
      : agents.length === 1
        ? `${agents[0].name} · ${AGENT_STATES[agents[0].state].label}`
        : `${agents.length} agents`;
  return (
    <div
      className="live"
      ref={root}
      onMouseEnter={() => {
        hovered.current = true;
        later(true);
      }}
      onMouseLeave={() => {
        hovered.current = false;
        if (focusedWithin()) clearTimeout(timer.current);
        else later(false);
      }}
      onFocus={() => {
        clearTimeout(timer.current);
        setOpen(true);
      }}
      onBlur={(e) => {
        if (!hovered.current && !root.current?.contains(e.relatedTarget))
          setOpen(false);
      }}
    >
      <button
        ref={label}
        type="button"
        className={`live-label live-on live-${reachable}`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="live-dot" />
        <span className="live-words">{words}</span>
      </button>
      {open && (
        <div
          className="live-card"
          role="group"
          aria-label="Agents on this board"
        >
          {agents.length === 0 ? (
            <p className="live-card-empty">
              No agent has used this board in the last 5 minutes.
            </p>
          ) : (
            <ul className="live-agents">
              {byReach.map((a) => (
                <li key={a.name} className="live-agent">
                  <div className="live-agent-head">
                    <ActorBadge actor={{ kind: "agent", name: a.name }} />
                    <span className={`live-state live-${a.state}`}>
                      <span className="live-dot" />
                      {AGENT_STATES[a.state].label}
                    </span>
                  </div>
                  <p className="live-agent-meaning">
                    {a.stuck
                      ? STUCK_MEANING
                      : AGENT_STATES[a.state].meaning(a.lastSeen)}
                  </p>
                  {work?.(a)}
                  {workOf(a.name) && (
                    <PeekButton
                      name={a.name}
                      work={workOf(a.name)!}
                      onPeek={() => {
                        setOpen(false);
                        setPeeking(a.name);
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {peeking && (
        <Peek agent={peeking} anchor={label} onClose={() => setPeeking(null)} />
      )}
    </div>
  );
}

function PeekButton({
  name,
  work,
  onPeek,
}: {
  name: string;
  work: ReturnType<typeof useWork>[number];
  onPeek: () => void;
}) {
  const progress = planProgress(work.plan);
  return (
    <button
      type="button"
      className="live-agent-peek"
      onClick={onPeek}
      title={`What ${name} is working on: its plan, what it is doing now, the files it changed`}
    >
      See what it's doing
      {progress ? ` · ${progress.done} of ${progress.total}` : ""}
    </button>
  );
}
