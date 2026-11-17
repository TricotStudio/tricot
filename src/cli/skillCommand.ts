// `tricot skill [status|on|off]`: the Tricot skill `tricot connect` adds
// to an agent (connectSkill.ts), looked at, added later, or taken out, as
// `tricot steps [status|on|off]` does for its live steps (hooks.ts): what would
// be written or removed is shown, nothing is done without a yes (or --yes), and
// the answer is kept per agent, so that `tricot connect` doesn't offer again
// what was turned off, and offers what was turned on. `--agent <id>` is the one
// agent. Which agents have a skill is read from the registry.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { listNames } from '../core/format';
import { skillAgents } from '../core/agents/registry';
import type { AgentKind, SkillForm } from '../core/agents/agent';
import { which } from '../platform/which';
import { displayPath, findHookInstaller } from '../server/hooks';
import { applySkill, backupBase, planRemoval, planSkill, rememberSkillAnswers, removeSkill, skillShown, type SkillPlan, type YesNo } from './connectSkill';
import { targetOf } from './connectFile';
import type { HooksEnv } from './hooks';
import type { CliResult } from './main';
import { SKILL_NAME } from './showSkill';

type Skilled = AgentKind & { skill: SkillForm };

// Whether the agent is on this computer: its hook installer's own search (its folder and its command)
// when it has one, else its program on the PATH.
function here(kind: Skilled, h: HooksEnv): boolean {
  const target = targetOf(h.ctx);
  const installer = findHookInstaller(kind.id);
  if (installer) return installer.detect(target).found;
  return Boolean(which(kind.command, h.ctx.env)) || existsSync(kind.skill.folder(target));
}

const stateOf = (plan: SkillPlan) => {
  switch (plan.does) {
    case 'same':
      return 'on';
    case 'update':
      return 'older';
    case 'make':
      return 'off';
    default:
      return plan.does === 'kept' ? 'edited' : "can't tell";
  }
};

export async function skillCommand(h: HooksEnv, sub = 'status'): Promise<CliResult> {
  const { ctx, values } = h;
  const kinds = skillAgents();
  let chosen: Skilled[];
  if (values.agent) {
    const kind = kinds.find((each) => each.id === values.agent);
    if (!kind) {
      ctx.err(`Tricot adds no skill to ${values.agent}${kinds.length ? `: it adds one to ${listNames(kinds.map((each) => each.id))}` : ''}. Nothing was changed.`);
      return { exitCode: 1 };
    }
    chosen = [kind];
  } else {
    chosen = kinds.filter((kind) => here(kind, h) || sub === 'status');
  }
  switch (sub) {
    case 'status':
      return status(h, chosen);
    case 'on':
      if (values.name) {
        ctx.err('--name belongs to tricot connect and tricot steps: the skill has no name of its own to give.');
        return { exitCode: 1 };
      }
      return add(h, chosen);
    case 'off':
      return take(h, chosen);
    default:
      ctx.err(`Unknown "tricot skill ${sub}". Try: tricot skill status, tricot skill on, tricot skill off (with --agent <id> for one agent).`);
      return { exitCode: 1 };
  }
}

function status(h: HooksEnv, chosen: Skilled[]): CliResult {
  const { out } = h.ctx;
  const target = targetOf(h.ctx);
  const width = Math.max(...chosen.map((kind) => kind.name.length));
  out(`The Tricot skill (${SKILL_NAME}), for every project on this machine:`);
  for (const kind of chosen) {
    const plan = planSkill(kind, target);
    const state = stateOf(plan);
    const where = here(kind, h) ? plan.shown : 'not on this machine';
    out(`  ${kind.name.padEnd(width)}  ${state.padEnd(10)}  ${where}`);
    if (plan.does === 'update') out(`  ${' '.repeat(width)}  an older Tricot wrote it; \`tricot skill on --agent ${kind.id}\` brings it up to date`);
    if (plan.does === 'kept' || plan.does === 'refuse') out(`  ${' '.repeat(width)}  ${plan.why}`);
  }
  const off = chosen.filter((kind) => here(kind, h) && planSkill(kind, target).does === 'make');
  if (off.length) out(`\nAdd it with: tricot skill on${off.length === 1 && chosen.length > 1 ? ` --agent ${off[0].id}` : ''}`);
  return { exitCode: 0 };
}

// Asks, unless --yes: false when there is nothing to ask in, or the answer is no.
async function agreed(h: HooksEnv, question: string): Promise<boolean | undefined> {
  const { ctx, values } = h;
  if (values.yes) return true;
  if (!ctx.ask) {
    ctx.err('Run this in a terminal to answer yes or no, or add --yes; nothing was changed.');
    return undefined;
  }
  if (!(await ctx.ask(question, false))) {
    ctx.out('Nothing was changed.');
    return false;
  }
  return true;
}

async function add(h: HooksEnv, chosen: Skilled[]): Promise<CliResult> {
  const { ctx, dataDir } = h;
  const { out, err } = ctx;
  if (!chosen.length) {
    err(`Tricot found none of ${listNames(skillAgents().map((kind) => kind.name))} on this machine (it looks for each one's folder and its command), so there is nothing to set up.`);
    return { exitCode: 1 };
  }
  const target = targetOf(ctx);
  let failed = false;
  const plans: { kind: Skilled; plan: Extract<SkillPlan, { text: string }> }[] = [];
  for (const kind of chosen) {
    const plan = planSkill(kind, target);
    if (plan.does === 'make' || plan.does === 'update') plans.push({ kind, plan });
    else if (plan.does === 'same') out(`${kind.name}: the skill is already there at ${plan.shown}; nothing to change.`);
    else {
      err(`${kind.name}: ${plan.why}${plan.does === 'kept' ? `. To have Tricot's skill there, move that file away, then run tricot skill on --agent ${kind.id}` : ''}.`);
      failed = failed || plan.does === 'refuse';
    }
  }
  if (!plans.length) return { exitCode: failed ? 1 : 0 };

  for (const { kind, plan } of plans) {
    for (const line of skillShown({ kind, plan })) out(line);
    out('');
  }
  const answer = await agreed(h, `Add the Tricot skill to ${listNames(plans.map(({ kind }) => kind.name))}?`);
  if (answer === undefined) return { exitCode: 1 };
  if (!answer) return { exitCode: 0 };
  const answers: Record<string, YesNo> = {};
  for (const { kind, plan } of plans) {
    const done = applySkill(h, { kind, plan });
    if (done.ok) answers[kind.id] = 'yes';
    else failed = true;
  }
  rememberSkillAnswers(dataDir, answers, 'skill on');
  if (Object.keys(answers).length) out('Start a new session of each agent for the skill to show up. Take it out again with `tricot skill off`.');
  return { exitCode: failed ? 1 : 0 };
}

async function take(h: HooksEnv, chosen: Skilled[]): Promise<CliResult> {
  const { ctx, dataDir } = h;
  const { out, err } = ctx;
  const target = targetOf(ctx);
  const removals: { kind: Skilled; file: string; copy?: string; shown: string }[] = [];
  let failed = false;
  for (const kind of chosen) {
    const plan = planRemoval(kind, target);
    if (plan.does === 'remove') removals.push({ kind, ...plan });
    else if (plan.does === 'none') out(`${kind.name}: the skill isn't there; nothing to take out.`);
    else if (plan.does === 'kept') out(`${kind.name}: ${plan.why}. Delete the file yourself if you want it gone.`);
    else {
      err(`${kind.name}: ${plan.why}.`);
      failed = true;
    }
  }
  if (!removals.length) return { exitCode: failed ? 1 : 0 };

  for (const removal of removals) {
    out(`${removal.kind.name}, for every project, would delete ${removal.shown}${removal.copy ? ` and the copy Tricot kept beside it, ${backupBase(removal)}` : ''}, and its folder ${displayPath(path.dirname(removal.file), target, 'user')} if that leaves it empty.`);
  }
  const answer = await agreed(h, `Take the Tricot skill out of ${listNames(removals.map(({ kind }) => kind.name))}?`);
  if (answer === undefined) return { exitCode: 1 };
  if (!answer) return { exitCode: 0 };
  const answers: Record<string, YesNo> = {};
  for (const removal of removals) {
    try {
      removeSkill({ does: 'remove', file: removal.file, shown: removal.shown, ...(removal.copy && { copy: removal.copy }) });
      out(`${removal.kind.name}: took out the skill at ${removal.shown}.`);
      answers[removal.kind.id] = 'no';
    } catch (error) {
      err(`${removal.kind.name}: ${error instanceof Error ? error.message : error}`);
      failed = true;
    }
  }
  rememberSkillAnswers(dataDir, answers, 'skill off');
  return { exitCode: failed ? 1 : 0 };
}
