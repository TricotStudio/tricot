// Live steps, as people see them: for each agent Tricot shows steps for
// (Claude Code, Codex, Pi, OMP, Gemini CLI, OpenCode), whether it is on this machine and whether
// its steps hook is set up, in words, and what turning it on or off would
// write. The server works it out from the hook installers (server/hooks); the
// `tricot hooks` command, an agent's panel and the Connect panel show it.
// Types and words only: the browser imports this.

import { samePerson } from './format';

export type LiveStepsAction = 'on' | 'off';

// user: for every project. project: the hook the folder Tricot was started
// in has from earlier (Claude Code), which is only ever taken out (tidied up).
export type LiveStepsScope = 'user' | 'project';

// One agent, as the switch shows it.
export interface LiveStepsAgent {
  id: string; // the installer's: "claude"
  name: string; // the agent as people know it: "Claude Code"
  agentName: string; // its name on the board unless told otherwise: "Claude"
  found: boolean; // its folder or its command is on this machine
  state: 'on' | 'off' | 'partly';
  where: string; // its settings or extension, from ~: "~/.claude/settings.json"
  scope: string; // which of its settings, in words: "user settings"
  missing?: string[]; // when partly: what isn't there
  problem?: string; // its settings can't be read, so Tricot won't change them
  trust?: string; // it runs a new hook only once you trust it (Codex), which Tricot can't see
  sendsAs?: string; // the name the hook there sends steps as
  // Its plan usage, for Claude Code and Codex (core/usage.ts): set up with its
  // steps, not yet (an install from before), or, for Claude Code, its status
  // line replaced by one the person set since, so the numbers stopped.
  usage?: 'on' | 'off' | 'replaced';
  // Claude Code and Codex: with live steps on, their permission prompts come
  // to the board too, for a person to answer there (core/approvals.ts).
  approvals?: true;
  // Claude Code: the project Tricot was started in (from ~) has its own
  // steps hook from earlier (`tricot connect claude --hooks`). With both,
  // each step still shows once: the server keeps one of the two copies.
  alsoInProject?: string;
}

// The whole list, and whether this request may change it: only from the
// computer Tricot runs on.
export interface LiveStepsReport {
  agents: LiveStepsAgent[];
  canChange: boolean;
  why?: string; // when it can't: why, in a sentence
}

// One file turning it on or off would touch, and the lines, as a person reads them.
export interface LiveStepsFile {
  path: string; // from ~ when it is under it
  does: 'write' | 'add' | 'replace' | 'remove' | 'delete';
  what: string;
  lines?: string;
  same: boolean; // already like this: nothing is written
}

// What turning one agent's steps on or off would do, before anything is
// written. Applying it needs its fingerprint, so what is applied is what the
// person saw.
export interface LiveStepsPreview {
  agent: string; // the installer's id
  name: string;
  action: LiveStepsAction;
  scope: LiveStepsScope;
  sendsAs?: string; // on: the name it sends steps as
  files: LiveStepsFile[];
  notes: string[]; // what to know before saying yes
  project?: string; // with the project scope: the project tidied up, from ~
  unchanged: boolean; // nothing would be written
  text: string; // all of it, as the terminal shows it
  fingerprint: string;
}

export interface LiveStepsResult {
  changed: boolean;
  message: string; // what was written, file by file
  summary: string; // the same in a sentence or two: "Turned on. Pi loads it in its next session."
  notes: string[];
  agent: LiveStepsAgent; // as it is now
}

// Its state in a few words, as the switch says it: "On · Claude Code, user
// settings", "Off", "Not installed on this machine".
export function liveStepsLabel(agent: LiveStepsAgent): string {
  if (agent.problem) return `Can't read ${agent.where}`;
  if (agent.state === 'on') return `On · ${agent.name}, ${agent.scope}`;
  if (agent.state === 'partly') return `Partly set up · ${agent.name}, ${agent.scope}`;
  if (!agent.found) return 'Not installed on this machine';
  return 'Off';
}

// The command that turns one agent's steps on, for a hint.
export const liveStepsCommand = (agent: Pick<LiveStepsAgent, 'id'>) => `tricot hooks on --agent ${agent.id}`;

// Which agent an agent on the board runs in: the one whose hook sends steps
// under its name, else the one whose usual name it has ("Claude", or
// "Claude (reviewer)" for a second Claude), else none.
export function liveStepsAgentFor(name: string, agents: LiveStepsAgent[]): LiveStepsAgent | undefined {
  const lower = name.trim().toLowerCase();
  const startsWith = (prefix: string) => lower === prefix || (lower.startsWith(prefix) && !/[a-z0-9]/.test(lower[prefix.length]));
  return (
    agents.find((a) => a.sendsAs && samePerson(a.sendsAs, name)) ??
    agents.find((a) => samePerson(a.agentName, name) || samePerson(a.name, name) || samePerson(a.id, name)) ??
    agents.find((a) => startsWith(a.agentName.toLowerCase()) || startsWith(a.name.toLowerCase()))
  );
}
