import { useEffect, useState, useSyncExternalStore } from 'react';
import { LISTEN_PHRASE, sayTo } from '../../core/delivery';
import { liveStepsAgentFor, type LiveStepsAgent } from '../../core/liveSteps';
import { api } from '../shared/api';
import './delivery.css';

// Telling an agent to look (core/delivery.ts, LISTEN_PHRASE): an agent that
// isn't listening on a board sees nothing there until it is told to, so where
// a person waits on one (Home's first run, the line under a message nobody on
// the board has seen) Tricot gives the words, with Copy: "In Claude Code,
// say: “Start listening on Tricot”".

// The agent tools on this computer, as live steps find them, asked once a
// page: which tool an agent runs in ("Claude" in Claude Code). Null when this
// server can't tell.
let installed: Promise<LiveStepsAgent[] | null> | undefined;
let installedNow: LiveStepsAgent[] | null | undefined;
export function installedAgents(): Promise<LiveStepsAgent[] | null> {
  installed ??= api.liveSteps().then(
    (report) => (installedNow = report.agents),
    () => (installedNow = null),
  );
  return installed;
}

// The same, as a component reads it: undefined until it is known.
export function useInstalledAgents(): LiveStepsAgent[] | null | undefined {
  const [agents, setAgents] = useState(installedNow);
  useEffect(() => {
    let live = true;
    void installedAgents().then((next) => live && setAgents(next));
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

// The agents connected to Tricot, on any board or none, the busiest first:
// read now and then, while a line needs them.
const listeners = new Set<() => void>();
let connected: string[] | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const CONNECTED_EVERY_MS = 10_000;

function loadConnected(): void {
  api.agents().then(
    (agents) => {
      const names = agents.filter((a) => a.state !== 'absent').map((a) => a.name);
      if (connected && names.join('\n') === connected.join('\n')) return;
      connected = names;
      for (const listener of listeners) listener();
    },
    () => {},
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    loadConnected();
    timer = setInterval(loadConnected, CONNECTED_EVERY_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearInterval(timer);
  };
}

export function useConnectedAgents(): string[] | undefined {
  return useSyncExternalStore(subscribe, () => connected);
}

// The tool an agent runs in, by name, once Tricot knows the tools here.
export function toolOf(agent: string, agents: LiveStepsAgent[] | null): string | undefined {
  return agents ? liveStepsAgentFor(agent, agents)?.name : undefined;
}

// "In Claude Code, say: “Start listening on Tricot”", and Copy, which copies
// the words alone. `quiet`: a status line around it reads the words out
// (delivery.tsx), so they aren't read twice.
export function SayToListen({ agent, tool, quiet = false }: { agent: string; tool: string | undefined; quiet?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const reset = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(reset);
  }, [copied]);
  const copy = () =>
    navigator.clipboard.writeText(LISTEN_PHRASE).then(
      () => setCopied(true),
      () => {}, // clipboard blocked: the words stay there to select
    );
  return (
    <>
      <span aria-hidden={quiet || undefined}>
        {sayTo(agent, tool)} <q className="say-phrase">{LISTEN_PHRASE}</q>
      </span>{' '}
      <button type="button" className="delivery-action say-copy" onClick={() => void copy()} title={`Copy “${LISTEN_PHRASE}”`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </>
  );
}
