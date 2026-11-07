// Live steps from the terminal: the question the first `tricot` asks, and
// `tricot steps [status|on|off]`. Both go through the same plans as each
// agent's "Live steps" switch in Tricot (server/hooks/liveSteps.ts): what
// would be written is shown, and nothing is written without a yes (or --yes).
// `--project` is the other scope: Claude Code's hook in this project's own
// .claude/settings.json, instead of every project's (user scope).
//
// The first question is asked once per data folder, in a terminal only,
// never in CI or with --no-ask, and only when an agent Tricot shows steps
// for is on this machine without them. Its answer, yes or no, is kept in the
// data folder (live-steps.json) so it isn't asked again.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exportToken } from '../core/connect';
import { listNames } from '../core/format';
import { liveStepsLabel, type LiveStepsAction, type LiveStepsAgent } from '../core/liveSteps';
import { home } from '../platform/paths';
import {
  applyLiveSteps,
  compactFiles,
  liveStepsAgents,
  LiveStepsError,
  liveStepsInstaller,
  planLiveSteps,
  UnreadableSettings,
  type HookSetup,
  type HookTarget,
  type LiveStepsContext,
  type LiveStepsPlan,
} from '../server/hooks';
import type { CliContext, CliResult } from './main';
import { shellOf } from './shell';

export interface HooksEnv {
  ctx: CliContext;
  dataDir: string;
  url: string; // Tricot's address, which the steps go to
  values: { agent?: string; name?: string; yes?: boolean; verbose?: boolean; 'no-ask'?: boolean; project?: boolean; narration?: boolean };
  // Set when the board listens beyond this machine: what a project's hook needs to reach it.
  token?: string;
}

export const ANSWER_FILE = 'live-steps.json';

interface Answer {
  answer: 'yes' | 'no';
  at: string;
  how: 'asked' | 'steps on' | 'steps off';
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
    target: { home: home(ctx.env, ctx.platform), project: path.resolve(ctx.cwd ?? process.cwd()), env: ctx.env },
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
  if (!ctx.ask || values['no-ask'] || inCi(ctx.env) || rememberedAnswer(h.dataDir)) return;
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
  out("Turn them off any time with `tricot steps off`, or with the Live steps switch in an agent's panel.");
  const yes = await ctx.ask("Show your agents' steps live on your boards?", true);
  remember(h.dataDir, yes ? 'yes' : 'no', 'asked');
  if (!yes) {
    out('Nothing was changed. Turn them on later with: tricot steps on');
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

// ---- tricot steps ------------------------------------------------------------------

export async function stepsCommand(h: HooksEnv, sub = 'status'): Promise<CliResult> {
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
      if (values.project || values.narration) {
        ctx.err('--project and --narration go with on or off: tricot steps on --agent claude --project');
        return { exitCode: 1 };
      }
      return status(h);
    case 'on':
    case 'off':
      if (values.project) return changeProject(h, sub);
      if (values.narration) {
        ctx.err('--narration goes with --project: tricot steps on --agent claude --project --narration');
        return { exitCode: 1 };
      }
      if (values.name && !values.agent) {
        ctx.err('--name is for one agent: tricot steps on --agent claude --name "Claude (reviewer)"');
        return { exitCode: 1 };
      }
      return change(h, sub);
    default:
      ctx.err(`Unknown "tricot steps ${sub}". Try: tricot steps status, tricot steps on, tricot steps off (with --agent <id> for one agent).`);
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
  if (agent.state === 'partly' && agent.missing) lines.push(`${indent}missing ${listNames(agent.missing)}; \`tricot steps on --agent ${agent.id}\` mends it`);
  if (agent.trust) lines.push(`${indent}${agent.trust} (Tricot can't see whether you've given it)`);
  if (agent.alsoInProject) {
    lines.push(
      agent.state === 'off'
        ? `${indent}${agent.alsoInProject} has its own hook from earlier, so steps show from that project`
        : `${indent}Also set up in ${agent.alsoInProject} from earlier; steps still show once`,
    );
    if (agent.state !== 'off') lines.push(`${indent}To tidy up: tricot steps off --agent claude --project, run in ${agent.alsoInProject}`);
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
  if (off.length) out(`\nTurn them on with: tricot steps on${off.length === 1 && agents.length > 1 ? ` --agent ${off[0].id}` : ''}`);
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
    if (!(await ctx.ask(`Turn ${action} live steps for ${names}?`, false))) {
      out('Nothing was changed.');
      return { exitCode: 0 };
    }
  }
  if (!applyAll(h, context, plans)) failed = true;
  remember(h.dataDir, action === 'on' ? 'yes' : 'no', action === 'on' ? 'steps on' : 'steps off');
  return { exitCode: failed ? 1 : 0 };
}

// ---- tricot steps on|off --project ---------------------------------------------------

// This project's .claude, through the same installer that sets up every
// agent's steps for the person (server/hooks); nothing in the home folder.
function projectTarget(h: HooksEnv): HookTarget {
  return { home: home(h.ctx.env, h.ctx.platform), project: path.resolve(h.ctx.cwd ?? process.cwd()) };
}

// Settings it can't read are left as they are, and it says so.
function refused(h: HooksEnv, error: unknown): CliResult {
  if (!(error instanceof UnreadableSettings)) throw error;
  h.ctx.err(error.message);
  return { exitCode: 1 };
}

// Claude Code's steps hook in this project's own .claude/settings.json (the
// scope 'project'), for those who want it in one project only: what `tricot
// steps on` does for every project, in one. Only Claude Code has one.
async function changeProject(h: HooksEnv, action: LiveStepsAction): Promise<CliResult> {
  const { ctx, values } = h;
  const installer = values.agent ? liveStepsInstaller(values.agent) : undefined;
  if (!installer?.scopes.includes('project')) {
    ctx.err('--project is for Claude Code: tricot steps on --agent claude --project');
    return { exitCode: 1 };
  }
  if (action === 'off' && values.narration) {
    ctx.err('--narration goes with steps on: tricot steps on --agent claude --project --narration');
    return { exitCode: 1 };
  }
  const target = projectTarget(h);
  if (action === 'off') {
    try {
      ctx.out(installer.uninstall(target, 'project').message);
      return { exitCode: 0 };
    } catch (error) {
      return refused(h, error);
    }
  }
  const { out } = ctx;
  const name = values.name ?? installer.agentName;
  const narration = Boolean(values.narration);
  const setup: HookSetup = { url: h.url, name, narration, source: path.join(ctx.root, 'hooks') };
  let preview;
  try {
    preview = installer.preview(target, setup, 'project');
  } catch (error) {
    return refused(h, error);
  }
  if (preview.unchanged) {
    out(`Claude's steps are already set up like this in ${target.project}; nothing to change.`);
    out(`Take them out with: tricot steps off --agent ${installer.id} --project`);
    return { exitCode: 0 };
  }
  out(`This shows what Claude is doing ("Reading src/web/Home.tsx", "Running npm test") on the Tricot card it works on, as ${name}.`);
  out('A small script sends Tricot one line per step: never file contents, command output or your prompts.');
  if (narration) {
    out("With --narration it also sends the first line of each message Claude writes in the terminal, which everyone on the board sees. Never Claude's thinking.");
  }
  out('It runs in the background, so Claude never waits for it, and does nothing when Tricot is not running.\n');
  out(`In ${target.project} it would:`);
  out(preview.text);
  if (h.token) out(`\nThis board needs its token: ${exportToken(h.token, shellOf(ctx.platform))}`);
  if (!values.yes) {
    if (!ctx.ask) {
      ctx.err('\nRun this in a terminal to answer yes or no, or add --yes; nothing was changed.');
      return { exitCode: 1 };
    }
    if (!(await ctx.ask('Add it?'))) {
      out('Nothing was changed.');
      return { exitCode: 0 };
    }
  }
  try {
    out(installer.install(target, setup, 'project').message);
  } catch (error) {
    return refused(h, error);
  }
  out(`Take it out again with: tricot steps off --agent ${installer.id} --project`);
  return { exitCode: 0 };
}
