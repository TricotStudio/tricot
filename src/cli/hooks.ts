// Live steps from the terminal: the question the first `tricot` asks, and
// `tricot hooks [status|on|off]`. Both go through the same plans as each
// agent's "Live steps" switch in Tricot (server/hooks/liveSteps.ts): what
// would be written is shown, and nothing is written without a yes (or --yes).
//
// The first question is asked once per data folder, in a terminal only,
// never in CI or with --no-hooks, and only when an agent Tricot shows steps
// for is on this machine without them. Its answer, yes or no, is kept in the
// data folder (live-steps.json) so it isn't asked again.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listNames } from '../core/format';
import { liveStepsLabel, type LiveStepsAction, type LiveStepsAgent } from '../core/liveSteps';
import {
  applyLiveSteps,
  compactFiles,
  liveStepsAgents,
  LiveStepsError,
  liveStepsInstaller,
  planLiveSteps,
  UnreadableSettings,
  type LiveStepsContext,
  type LiveStepsPlan,
} from '../server/hooks';
import type { CliContext, CliResult } from './main';

export interface HooksEnv {
  ctx: CliContext;
  dataDir: string;
  url: string; // Tricot's address, which the steps go to
  values: { agent?: string; name?: string; yes?: boolean; verbose?: boolean; 'no-hooks'?: boolean };
}

export const ANSWER_FILE = 'live-steps.json';

interface Answer {
  answer: 'yes' | 'no';
  at: string;
  how: 'asked' | 'hooks on' | 'hooks off';
}

export function rememberedAnswer(dataDir: string): Answer | undefined {
  try {
    const kept = JSON.parse(readFileSync(path.join(dataDir, ANSWER_FILE), 'utf8')) as Partial<Answer>;
    return kept.answer === 'yes' || kept.answer === 'no' ? (kept as Answer) : undefined;
  } catch {
    return undefined;
  }
}

function remember(dataDir: string, answer: Answer['answer'], how: Answer['how']): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, ANSWER_FILE), `${JSON.stringify({ answer, at: new Date().toISOString(), how })}\n`, { mode: 0o600 });
  } catch {
    // Not remembered: the question comes again next time, which is all it costs.
  }
}

// CI sets CI; "false" or "0" says it isn't.
const inCi = (env: NodeJS.ProcessEnv) => Boolean(env.CI) && !/^(0|false)$/i.test(env.CI ?? '');

export function liveStepsContext(h: HooksEnv): LiveStepsContext {
  const { ctx } = h;
  return {
    target: { home: ctx.env.HOME ?? os.homedir(), project: path.resolve(ctx.cwd ?? process.cwd()), env: ctx.env },
    source: path.join(ctx.root, 'hooks'),
    url: h.url,
  };
}

const WHAT_IT_SENDS =
  "Each hook sends Tricot one line per step, never file contents, command output or your prompts, and does nothing while Tricot is closed. Claude Code's status line and Codex's hook also pass on plan usage, numbers only.";

// The agents whose permission prompts come to the board as well, said apart:
// those carry the command or change the agent asks about.
const approvalsSaid = (names: string[]) =>
  `${listNames(names)} also ${names.length === 1 ? 'brings' : 'bring'} each permission prompt to the board, with the command or change it asks about, for you to answer there; while Tricot is closed, the terminal asks as usual.`;

// ---- the first `tricot` ----------------------------------------------------------

export async function askOnFirstRun(h: HooksEnv): Promise<void> {
  const { ctx, values } = h;
  // Nothing is looked at, not even which agents are here, unless the question can be asked.
  if (!ctx.ask || values['no-hooks'] || inCi(ctx.env) || rememberedAnswer(h.dataDir)) return;
  const context = liveStepsContext(h);
  const plans: LiveStepsPlan[] = [];
  for (const agent of liveStepsAgents(context)) {
    if (!agent.found || agent.state === 'on' || agent.problem) continue;
    try {
      const plan = planLiveSteps(context, agent.id, 'on');
      if (!plan.unchanged) plans.push(plan);
    } catch (error) {
      if (!(error instanceof UnreadableSettings || error instanceof LiveStepsError)) throw error;
    }
  }
  if (!plans.length) return;

  const { out } = ctx;
  const width = Math.max(...plans.map((p) => p.name.length));
  out('');
  out('Tricot can show what your agents are doing, live on the card each one works on ("Reading src/app.ts", "Running npm test").');
  out(`It found ${listNames(plans.map((p) => p.name))} on this machine. Yes adds a small hook to each, for every project:`);
  for (const plan of plans) {
    out(`  ${plan.name.padEnd(width)}  ${compactFiles(plan.files.filter((f) => !f.same))}`);
  }
  if (values.verbose) {
    for (const plan of plans) {
      out('');
      out(`${plan.name} would:`);
      out(plan.text);
    }
  } else {
    out('  Every file and line: tricot --verbose');
  }
  out(WHAT_IT_SENDS);
  const asking = plans.filter((plan) => liveStepsInstaller(plan.agent).approvals).map((plan) => plan.name);
  if (asking.length) out(approvalsSaid(asking));
  out("Turn them off any time with `tricot hooks off`, or with the Live steps switch in an agent's panel.");
  const yes = await ctx.ask("Show your agents' steps live on your boards? [Y/n] ", true);
  remember(h.dataDir, yes ? 'yes' : 'no', 'asked');
  if (!yes) {
    out('Nothing was changed. Turn them on later with: tricot hooks on');
    out('');
    return;
  }
  applyAll(h, context, plans);
  out('');
}

// Applies each plan, saying what it did; a file that can't be read is said
// and the others go on. Whether every one went through.
function applyAll(h: HooksEnv, context: LiveStepsContext, plans: LiveStepsPlan[]): boolean {
  let ok = true;
  for (const plan of plans) {
    try {
      const done = applyLiveSteps(context, plan);
      h.ctx.out(done.message);
      for (const note of done.notes) h.ctx.out(`  ${note}`);
    } catch (error) {
      if (!(error instanceof UnreadableSettings)) throw error;
      h.ctx.err(error.message);
      ok = false;
    }
  }
  return ok;
}

// ---- tricot hooks ------------------------------------------------------------------

export async function hooksCommand(h: HooksEnv, sub = 'status'): Promise<CliResult> {
  const { ctx, values } = h;
  if (values.agent) {
    try {
      liveStepsInstaller(values.agent);
    } catch (error) {
      if (!(error instanceof LiveStepsError)) throw error;
      ctx.err(error.message);
      return { exitCode: 1 };
    }
  }
  switch (sub) {
    case 'status':
      return status(h);
    case 'on':
    case 'off':
      if (values.name && !values.agent) {
        ctx.err('--name is for one agent: tricot hooks on --agent claude --name "Claude (reviewer)"');
        return { exitCode: 1 };
      }
      return change(h, sub);
    default:
      ctx.err(`Unknown "tricot hooks ${sub}". Try: tricot hooks status, tricot hooks on, tricot hooks off (with --agent <id> for one agent).`);
      return { exitCode: 1 };
  }
}

// One agent's line: its state, and where or what is the matter.
function statusLine(agent: LiveStepsAgent, width: number): string[] {
  const head = `  ${agent.name.padEnd(width)}  `;
  const indent = ' '.repeat(head.length);
  if (agent.problem) return [`${head}can't tell: ${agent.problem}`];
  if (!agent.found && agent.state === 'off') return [`${head}not on this machine`];
  const lines = [`${head}${agent.state.padEnd(6)}  ${agent.where}${agent.sendsAs && agent.state !== 'off' ? `, sends as ${agent.sendsAs}` : ''}`];
  if (agent.state === 'partly' && agent.missing) lines.push(`${indent}missing ${listNames(agent.missing)}; \`tricot hooks on --agent ${agent.id}\` mends it`);
  if (agent.trust) lines.push(`${indent}${agent.trust} (Tricot can't see whether you've given it)`);
  if (agent.alsoInProject) {
    lines.push(
      agent.state === 'off'
        ? `${indent}${agent.alsoInProject} has its own hook from earlier, so steps show from that project`
        : `${indent}Also set up in ${agent.alsoInProject} from earlier; steps still show once`,
    );
    if (agent.state !== 'off') lines.push(`${indent}To tidy up: tricot connect claude --remove-hooks, run in ${agent.alsoInProject}`);
  }
  return lines;
}

function status(h: HooksEnv): CliResult {
  const all = liveStepsAgents(liveStepsContext(h));
  const agents = h.values.agent ? all.filter((a) => a.id === h.values.agent) : all;
  const width = Math.max(...agents.map((a) => a.name.length));
  const { out } = h.ctx;
  out('Live steps, for every project on this machine:');
  for (const agent of agents) for (const line of statusLine(agent, width)) out(line);
  const off = agents.filter((a) => a.found && a.state !== 'on' && !a.problem);
  if (off.length) out(`\nTurn them on with: tricot hooks on${off.length === 1 && agents.length > 1 ? ` --agent ${off[0].id}` : ''}`);
  return { exitCode: 0 };
}

async function change(h: HooksEnv, action: LiveStepsAction): Promise<CliResult> {
  const { ctx, values } = h;
  const { out, err } = ctx;
  const context = liveStepsContext(h);
  const all = liveStepsAgents(context);
  let chosen: LiveStepsAgent[];
  if (values.agent) {
    chosen = all.filter((a) => a.id === values.agent);
  } else if (action === 'on') {
    chosen = all.filter((a) => a.found);
    if (!chosen.length) {
      err(`Tricot found none of ${listNames(all.map((a) => a.name))} on this machine (it looks for each one's folder and its command), so there is nothing to set up.`);
      return { exitCode: 1 };
    }
  } else {
    chosen = all.filter((a) => a.state !== 'off');
  }

  let failed = false;
  const plans: LiveStepsPlan[] = [];
  for (const agent of chosen) {
    try {
      const plan = planLiveSteps(context, agent.id, action, { name: values.name });
      if (plan.unchanged) out(`${agent.name}: ${action === 'on' ? `live steps are already on (${liveStepsLabel(agent)})` : 'live steps are already off'}; nothing to change.`);
      else plans.push(plan);
    } catch (error) {
      if (!(error instanceof UnreadableSettings || error instanceof LiveStepsError)) throw error;
      err(`${agent.name}: ${error.message}`);
      failed = true;
    }
  }
  if (!plans.length) {
    if (!chosen.length) out("Live steps aren't on for any agent; nothing to take out.");
    return { exitCode: failed ? 1 : 0 };
  }

  for (const plan of plans) {
    out(`${plan.name}, for every project, would:`);
    out(plan.text);
    out('');
  }
  if (action === 'on') out(WHAT_IT_SENDS);
  const names = listNames(plans.map((p) => p.name));
  if (!values.yes) {
    if (!ctx.ask) {
      err('Run this in a terminal to answer yes or no, or add --yes; nothing was changed.');
      return { exitCode: 1 };
    }
    if (!(await ctx.ask(`Turn ${action} live steps for ${names}? [y/N] `, false))) {
      out('Nothing was changed.');
      return { exitCode: 0 };
    }
  }
  if (!applyAll(h, context, plans)) failed = true;
  remember(h.dataDir, action === 'on' ? 'yes' : 'no', action === 'on' ? 'hooks on' : 'hooks off');
  return { exitCode: failed ? 1 : 0 };
}
