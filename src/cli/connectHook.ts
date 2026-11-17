// The hook half of plain `tricot connect` (connectAll.ts): every agent that has
// a hook installer gets its hook with its connection, in the one question
// connect asks.
//
// "The hook" is what each agent's live steps are (server/hooks): the steps
// script, the permission prompts where an agent brings them to the board, and,
// in the agents that have one (`lenses` in their hook installer), the prompt
// hook that adds a short line for the agent when you ask to see something on
// Tricot, or open a message with a lens (^Design). It is set up all together,
// so it is the same plan `tricot steps on` makes, shown and applied through
// the same functions (server/hooks/liveSteps.ts), only offered here with the
// connection. Which agents have a hook, and which of them have the prompt
// hook, is read from the installers, never listed here. An agent with a
// hook but no prompt hook (Copilot CLI, Goose, Grok Build, OpenCode) gets live
// steps only, and the words say so; one with no installer (Cursor) gets none.
// The result says plainly which got what.
//
// Nothing is written without the yes the question asks (or --yes). Before a
// settings file is changed, a copy of it is kept beside it, as the connection's
// own settings files are (connectFile.ts). An agent already answered for, here
// or by the first `tricot` (hooks.ts), is not offered one again; its answer is
// kept per agent in the same file.

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '../core/agents/agent';
import { listNames } from '../core/format';
import { applyLiveSteps, compactFiles, displayPath, findHookInstaller, liveStepsAgents, liveStepsInstaller, planLiveSteps, UnreadableSettings, type LiveStepsPlan } from '../server/hooks';
import { BACKUP_SUFFIX, keepCopy } from './connectFile';
import { answerFor, approvalsSaid, lensesSaid, liveStepsContext, rememberAgents, rememberedAnswer, TURN_OFF, WHAT_IT_SENDS, type HooksEnv } from './hooks';

// Whether an agent has a hook at all (live steps), and whether that includes the prompt hook, as its installer says.
export const takesHook = (kind: AgentKind): boolean => findHookInstaller(kind.id) !== undefined;
export const takesPromptHook = (kind: AgentKind): boolean => Boolean(findHookInstaller(kind.id)?.lenses);

export interface HookOffer {
  kind: AgentKind;
  plan: LiveStepsPlan; // what turning its hook on would do, as `tricot steps on` shows it
}

// What the agents found here have, hook by hook.
export interface HookLook {
  offers: Map<string, HookOffer>; // by agent id: it has a hook, hasn't got it, and wasn't answered for
  there: AgentKind[]; // already set up
  earlier: { kind: AgentKind; answer: 'yes' | 'no'; partly: boolean }[]; // answered before, and not on: left as it is
  stuck: { kind: AgentKind; why: string }[]; // its settings can't be read (or the hook's own search doesn't find it): left as they are
}

export function lookAtHooks(h: HooksEnv, here: AgentKind[]): HookLook {
  const context = liveStepsContext(h);
  const kept = rememberedAnswer(h.dataDir);
  const states = new Map(liveStepsAgents(context).map((agent) => [agent.id, agent]));
  const look: HookLook = { offers: new Map(), there: [], earlier: [], stuck: [] };
  for (const kind of here) {
    const state = states.get(kind.id);
    if (!state) continue; // no hook installer: it has none to offer

    if (state.state === 'on') {
      look.there.push(kind);
      continue;
    }
    const answer = answerFor(kept, kind.id);
    if (answer) {
      look.earlier.push({ kind, answer, partly: state.state === 'partly' });
      continue;
    }
    if (state.problem) {
      look.stuck.push({ kind, why: state.problem });
      continue;
    }
    // Whatever stops the plan (settings Tricot won't change, or a hook script missing from the package)
    // leaves the hook out and says so: it never stops the connection.
    try {
      const plan = planLiveSteps(context, kind.id, 'on');
      if (plan.unchanged) look.there.push(kind);
      else look.offers.set(kind.id, { kind, plan });
    } catch (error) {
      look.stuck.push({ kind, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return look;
}

// What Tricot says of an agent with no prompt hook: what a request to see
// something on Tricot, or a lens, comes to.
export const noPromptHookSaid = (kinds: AgentKind[]): string => {
  const them = kinds.length === 1 ? 'it' : 'them';
  return `Tricot has no prompt hook for ${listNames(kinds.map((kind) => kind.name))}: a request to see something on Tricot, or a lens (^Design), reaches ${them} as you typed it, and ${kinds.length === 1 ? 'it goes' : 'they go'} by the wording of Tricot's tools to make a page.`;
};

// What the question is about, said before it: what the hook does and sends,
// in the first question's own words (hooks.ts), and the files it adds. An agent
// with the prompt hook gets it with its steps; one without gets its steps alone.
// `lines`: the exact lines are shown after it (--print, or no terminal to ask in).
export function hookExplained(offers: HookOffer[], lines = false): string[] {
  const prompting = offers.filter((offer) => takesPromptHook(offer.kind));
  const stepsOnly = offers.filter((offer) => !takesPromptHook(offer.kind));
  const names = (list: HookOffer[]) => list.map((offer) => offer.plan.name);
  const also = (list: HookOffer[]) => `${listNames(names(list))} also ${list.length === 1 ? 'gets' : 'get'} a small hook, for every project`;
  const width = Math.max(...offers.map((offer) => offer.plan.name.length));
  const approving = offers.filter((offer) => liveStepsInstaller(offer.kind.id).approvals).map((offer) => offer.plan.name);
  return [
    ...(prompting.length ? [`${also(prompting)}: it adds a short line for the agent when you ask to see something on Tricot, and it shows what the agent is doing live on its card.`] : []),
    ...(stepsOnly.length ? [`${also(stepsOnly)}, for live steps only: it shows what the agent is doing live on its card.`] : []),
    `The ${offers.length === 1 ? 'hook adds' : 'hooks add'}:`,
    ...offers.map((offer) => `  ${offer.plan.name.padEnd(width)}  ${compactFiles(offer.plan.files.filter((file) => !file.same))}`),
    `${lines ? '' : 'Every file and line: tricot connect --print. '}Before it changes a settings file, it keeps a copy beside it, ending in .tricot-backup.`,
    ...(prompting.length ? [lensesSaid(names(prompting))] : []),
    ...(stepsOnly.length ? [noPromptHookSaid(stepsOnly.map((offer) => offer.kind))] : []),
    WHAT_IT_SENDS,
    ...(approving.length ? [approvalsSaid(approving)] : []),
    TURN_OFF,
  ];
}

// What each hook's plan says to know about it, as the first question's preview does (what an agent waits for, what it
// asks you to trust, a link its settings file is): shown where the hook is explained in full.
export function hookNotes(offers: HookOffer[]): string[] {
  return offers.flatMap((offer) => offer.plan.notes.map((note) => `  ${offer.plan.name}: ${note}`));
}

// What --print and a run without a terminal show of the hook: its exact lines.
export function hookShown(offer: HookOffer): string[] {
  return [`${offer.plan.name}'s hook, for every project, would:`, offer.plan.text];
}

// A copy of each settings file the hook would change, beside it, as it is now.
// Done before the connection runs, so a file that command changes too (Gemini
// CLI's) is kept as it was. Throws when a copy can't be kept: nothing is
// written then. Gives each file as a person reads it (~/…) and its copy's name.
export function keepHookCopies(h: HooksEnv, offer: HookOffer): { file: string; copy: string }[] {
  const context = liveStepsContext(h);
  const installer = liveStepsInstaller(offer.kind.id);
  const kept: { file: string; copy: string }[] = [];
  for (const change of installer.preview(context.target, { url: context.url, source: context.source, name: offer.plan.sendsAs }).changes) {
    if ((change.does !== 'add' && change.does !== 'replace') || change.same || !existsSync(change.path)) continue;
    const file = displayPath(change.path, context.target, 'user');
    keepCopy(change.path, `${change.path}${BACKUP_SUFFIX}`, file);
    kept.push({ file, copy: path.basename(`${change.path}${BACKUP_SUFFIX}`) });
  }
  return kept;
}

// Sets the hook up, as `tricot steps on` does, in one line: that it is on, and
// when the agent picks it up, with the copies kept. The files and the notes are
// what the question said before (hookExplained, hookNotes), so they are not said
// again. A settings file that became unreadable since the plan is left alone, and said.
export function applyHook(h: HooksEnv, offer: HookOffer, kept: { file: string; copy: string }[]): { ok: true } | { ok: false; why: string } {
  const { out, err } = h.ctx;
  try {
    const done = applyLiveSteps(liveStepsContext(h), offer.plan);
    out(`${offer.kind.name}: live steps ${done.summary.charAt(0).toLowerCase()}${done.summary.slice(1)}`);
    for (const { file, copy } of kept) out(`  ${file} as it was is kept beside it, as ${copy}.`);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof UnreadableSettings)) throw error;
    err(`${offer.kind.name}: ${error.message}`);
    return { ok: false, why: error.message };
  }
}

// What the person answered by ticking or not: yes for each hook that was set
// up, no for each that was offered and not ticked. An agent whose hook
// failed, or whose connection did, is not kept as answered: it is offered
// again.
export function rememberHookAnswers(h: HooksEnv, answers: Record<string, 'yes' | 'no'>): void {
  if (Object.keys(answers).length) rememberAgents(h.dataDir, answers, 'connect');
}

export interface HookReport {
  added: AgentKind[];
  failed: { kind: AgentKind; why: string }[];
  left: AgentKind[]; // offered to one already connected, and not ticked: the others are left whole, and said of as unticked
}

// How to turn the hook on by hand: for one agent, or for every one found.
const stepsOn = (kinds: AgentKind[]) => (kinds.length === 1 ? `tricot steps on --agent ${kinds[0].id}` : 'tricot steps on (every agent it finds), or tricot steps on --agent <id> for one');

// The result's lines about the hook: which agents got it and with what, which
// already had it, which were left as they were and why, and which have no
// prompt hook, so nothing is half set up without being said. `without` is those
// with no prompt hook that are connected (or were): live steps only, or none.
// `brief`: leaves out what the hook added and what the agents with no prompt hook
// miss, which the caller's own short summary says (connectAll's ending); every
// problem, and every answer kept, is still said.
export function hookResult(look: HookLook, outcome: HookReport, without: AgentKind[], brief = false): string[] {
  const lines: string[] = [];
  const names = (kinds: AgentKind[]) => listNames(kinds.map((kind) => kind.name));
  const prompting = outcome.added.filter(takesPromptHook);
  const stepsOnly = outcome.added.filter((kind) => !takesPromptHook(kind));
  const doing = (kinds: AgentKind[]) => (kinds.length === 1 ? 'it is' : 'each is');
  if (prompting.length && !brief) {
    lines.push(`Hook added to ${names(prompting)}: it adds a short line for the agent when you ask to see something on Tricot, and shows what ${doing(prompting)} doing live on its card.`);
  }
  if (stepsOnly.length && !brief) {
    lines.push(`Live steps added to ${names(stepsOnly)}, which ${stepsOnly.length === 1 ? 'has' : 'have'} no prompt hook: the hook shows what ${doing(stepsOnly)} doing live on its card.`);
  }
  if (outcome.added.length && !brief) lines.push(`Start a new session of ${outcome.added.length === 1 ? 'it' : 'each'} for the hook to take effect.`);
  if (look.there.length) lines.push(`${names(look.there)} already ${look.there.length === 1 ? 'has' : 'have'} the hook.`);
  if (outcome.failed.length || look.stuck.length) {
    lines.push('The hook was not added to:');
    for (const { kind, why } of [...outcome.failed, ...look.stuck]) lines.push(`  ${kind.name}: ${why.replace(/\.$/, '')}.`);
    lines.push(`After you have mended that: ${stepsOn([...outcome.failed, ...look.stuck].map((each) => each.kind))}`);
  }
  if (outcome.left.length) {
    lines.push(`The hook was left out of ${names(outcome.left)}, as you said no. To add ${outcome.left.length === 1 ? 'it' : 'them'} later: ${stepsOn(outcome.left)}`);
  }
  const declined = look.earlier.filter((each) => each.answer === 'no');
  if (declined.length) {
    lines.push(`The hook was left out of ${names(declined.map((each) => each.kind))}, as you said no earlier. To add ${declined.length === 1 ? 'it' : 'them'}: ${stepsOn(declined.map((each) => each.kind))}`);
  }
  const changed = look.earlier.filter((each) => each.answer === 'yes');
  if (changed.length) {
    lines.push(
      `${names(changed.map((each) => each.kind))} had the hook turned on before and ${changed.length === 1 ? "doesn't" : "don't"} have all of it now, so ${changed.length === 1 ? 'it was' : 'they were'} left as ${changed.length === 1 ? 'it is' : 'they are'}. To put ${changed.length === 1 ? 'it' : 'them'} back: ${stepsOn(changed.map((each) => each.kind))}`,
    );
  }
  if (without.length && !brief) {
    lines.push(noPromptHookSaid(without));
    const none = without.filter((kind) => !takesHook(kind));
    if (none.length) lines.push(`Tricot has no live steps for ${names(none)} either, so ${none.length === 1 ? 'it shows' : 'they show'} nothing live on a card.`);
  }
  return lines;
}
