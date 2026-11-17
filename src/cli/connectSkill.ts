// The skill half of plain `tricot connect` (connectAll.ts): every
// agent that has a skill form (`skill` in its server half) gets the Tricot
// skill with its connection, in the one question connect asks, so "show me … on
// Tricot" works with Tricot stopped, or with the agent's tools missing. What
// the skill says is showSkill.ts's; where it goes, and how the agent brings its
// tools back, is the agent's own (core/agents/agent.ts SkillForm). Which agents
// have one is read from the registry, never listed here.
//
// It is a plain file in the agent's own folder (<skills folder>/tricot-show/SKILL.md):
// no settings file is read or changed. Nothing is written without the yes the
// question asks (or --yes). A file already there as Tricot would write it is
// left alone; one an older Tricot wrote (its last line says so, with a checksum
// of the text above it) is replaced after a copy is kept beside it, ending in
// .tricot-backup; one its owner edited, or wrote, is left as it is, and said. A
// link is never written through or replaced, as for every file Tricot writes.
//
// The answer, yes or no, is kept per agent in the data folder (skills.json),
// as the hook's are (hooks.ts), apart from them: an agent that answered the
// hook's question before the skill existed is still offered the skill. The
// first `tricot` asks only about live steps, so it never asks about a skill.
// `tricot skill on|off` (skillCommand.ts) adds it later and takes it out again.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentKind, SkillForm } from '../core/agents/agent';
import { listNames } from '../core/format';
import { displayPath, linkTarget, writeFileAtomic, type HookTarget } from '../server/hooks';
import { BACKUP_SUFFIX, keepCopy, targetOf } from './connectFile';
import type { HooksEnv } from './hooks';
import { SKILL_FILE, SKILL_NAME, skillText, writtenByTricot } from './showSkill';

export type YesNo = 'yes' | 'no';
type Done = { ok: true } | { ok: false; why: string };

// Whether an agent has a skill form, as its server half says.
export const takesSkill = (kind: AgentKind): kind is AgentKind & { skill: SkillForm } => kind.skill !== undefined;

// ---- where it is, and what writing it would do --------------------------------------------------

// What adding the skill would do for one agent. `shown`: its file as a person reads it (~/…).
// - make: nothing is there; update: an older Tricot's is, which a copy of is kept beside.
// - same: it is there as it would be written.
// - kept: a file its owner edited, or wrote: left as it is.
// - refuse: a link, a folder, or a file that can't be read: left as it is.
export type SkillPlan =
  | { does: 'make'; file: string; shown: string; text: string }
  | { does: 'update'; file: string; shown: string; text: string; before: string }
  | { does: 'same'; file: string; shown: string }
  | { does: 'kept' | 'refuse'; file: string; shown: string; why: string };

export type SkillWrite = Extract<SkillPlan, { text: string }>;

export const skillFileOf = (kind: AgentKind & { skill: SkillForm }, target: HookTarget): string => path.join(kind.skill.folder(target), SKILL_NAME, SKILL_FILE);

export function planSkill(kind: AgentKind & { skill: SkillForm }, target: HookTarget): SkillPlan {
  const file = skillFileOf(kind, target);
  const shown = displayPath(file, target, 'user');
  const refuse = (why: string): SkillPlan => ({ does: 'refuse', file, shown, why });
  for (const place of [path.dirname(file), file]) {
    const link = linkTarget(place);
    if (link !== undefined) return refuse(`${displayPath(place, target, 'user')} is a link (to ${link}), and Tricot doesn't write through links or replace them`);
  }
  const text = skillText(kind);
  if (!existsSync(file)) return { does: 'make', file, shown, text };
  if (!statSync(file).isFile()) return refuse(`${shown} isn't a file`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return refuse(`${shown} can't be read (${(error as NodeJS.ErrnoException).code ?? error})`);
  }
  const before = bytes.toString('utf8');
  // Written back as text, every byte of a file it keeps a copy of must come out as it was.
  if (!Buffer.from(before, 'utf8').equals(bytes)) return refuse(`${shown} isn't UTF-8 text`);
  if (before === text) return { does: 'same', file, shown };
  if (writtenByTricot(before)) return { does: 'update', file, shown, text, before };
  return { does: 'kept', file, shown, why: `${shown} is not the file Tricot wrote (you edited it, or it is your own), so it was left as it is` };
}

// Writes the plan: the copy of an older file first, then the file. It writes
// nothing when the file changed since it was read. Gives the copy's path, when one was kept.
export function writeSkill(plan: SkillWrite): { backup?: string } {
  const now = existsSync(plan.file) ? readFileSync(plan.file, 'utf8') : undefined;
  if (now !== (plan.does === 'update' ? plan.before : undefined)) throw new Error(`${plan.shown} changed while Tricot was asking, so Tricot wrote nothing to it. Run it again.`);
  if (plan.does === 'make') {
    writeFileAtomic(plan.file, plan.text);
    return {};
  }
  const backup = `${plan.file}${BACKUP_SUFFIX}`;
  keepCopy(plan.file, backup, plan.shown);
  writeFileAtomic(plan.file, plan.text);
  return { backup };
}

export const backupBase = (plan: { file: string }) => `${path.basename(plan.file)}${BACKUP_SUFFIX}`;

// Takes the skill out: its file when it is Tricot's as it wrote it (some version of it), the copy
// Tricot kept of an older one, and the folder when that leaves it empty.
export type Removal = { does: 'remove'; file: string; shown: string; copy?: string } | { does: 'none'; shown: string } | { does: 'kept' | 'refuse'; shown: string; why: string };

export function planRemoval(kind: AgentKind & { skill: SkillForm }, target: HookTarget): Removal {
  const file = skillFileOf(kind, target);
  const shown = displayPath(file, target, 'user');
  for (const place of [path.dirname(file), file]) {
    const link = linkTarget(place);
    if (link !== undefined) return { does: 'refuse', shown, why: `${displayPath(place, target, 'user')} is a link (to ${link}), and Tricot doesn't delete through links` };
  }
  if (!existsSync(file)) return { does: 'none', shown };
  let text: string;
  try {
    if (!statSync(file).isFile()) return { does: 'refuse', shown, why: `${shown} isn't a file` };
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { does: 'refuse', shown, why: `${shown} can't be read (${(error as NodeJS.ErrnoException).code ?? error})` };
  }
  if (!writtenByTricot(text)) return { does: 'kept', shown, why: `${shown} is not the file Tricot wrote (you edited it, or it is your own), so it was left as it is` };
  const copy = `${file}${BACKUP_SUFFIX}`;
  const hasCopy = linkTarget(copy) === undefined && existsSync(copy) && statSync(copy).isFile() && writtenByTricot(readFileSync(copy, 'utf8'));
  return { does: 'remove', file, shown, ...(hasCopy && { copy }) };
}

export function removeSkill(plan: Extract<Removal, { does: 'remove' }>): void {
  rmSync(plan.file, { force: true });
  if (plan.copy) rmSync(plan.copy, { force: true });
  try {
    rmdirSync(path.dirname(plan.file)); // only when nothing else of the person's is in it
  } catch {
    // Not empty (or already gone): it stays.
  }
}

// ---- the answers --------------------------------------------------------------------------------

export const SKILL_ANSWER_FILE = 'skills.json';

interface Kept {
  at: string;
  how: 'connect' | 'skill on' | 'skill off';
  agents: Record<string, YesNo>;
}

// What was answered for each agent.
export function rememberedSkillAnswers(dataDir: string): Record<string, YesNo> {
  try {
    const kept = JSON.parse(readFileSync(path.join(dataDir, SKILL_ANSWER_FILE), 'utf8')) as Partial<Kept>;
    const agents = kept.agents && typeof kept.agents === 'object' && !Array.isArray(kept.agents) ? kept.agents : {};
    return Object.fromEntries(Object.entries(agents).filter(([, answer]) => answer === 'yes' || answer === 'no')) as Record<string, YesNo>;
  } catch {
    return {};
  }
}

// These answers, kept beside the others already kept for other agents.
export function rememberSkillAnswers(dataDir: string, answers: Record<string, YesNo>, how: Kept['how']): void {
  if (!Object.keys(answers).length) return;
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, SKILL_ANSWER_FILE);
    const kept: Kept = { at: new Date().toISOString(), how, agents: { ...rememberedSkillAnswers(dataDir), ...answers } };
    writeFileSync(file, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Not remembered: the question comes again next time, which is all it costs.
  }
}

// ---- what connect finds -------------------------------------------------------------------------

export interface SkillOffer {
  kind: AgentKind;
  plan: SkillWrite; // what adding it would do
}

// What the agents found here have, skill by skill.
export interface SkillLook {
  offers: Map<string, SkillOffer>; // by agent id: it has a skill form, hasn't got it, and wasn't answered for
  there: AgentKind[]; // already has it, as Tricot would write it
  earlier: { kind: AgentKind; answer: YesNo }[]; // answered before, and not on: left as it is
  stuck: { kind: AgentKind; why: string; refused: boolean }[]; // a file left as it is: its owner's (`refused` false), or a link or a folder
}

export function lookAtSkills(h: HooksEnv, here: AgentKind[]): SkillLook {
  const target = targetOf(h.ctx);
  const answers = rememberedSkillAnswers(h.dataDir);
  const look: SkillLook = { offers: new Map(), there: [], earlier: [], stuck: [] };
  for (const kind of here) {
    if (!takesSkill(kind)) continue;
    const plan = planSkill(kind, target);
    switch (plan.does) {
      case 'same':
        look.there.push(kind);
        break;
      case 'kept':
      case 'refuse':
        look.stuck.push({ kind, why: plan.why, refused: plan.does === 'refuse' });
        break;
      default: {
        const answer = answers[kind.id];
        // A no is never asked again; a yes with no file now is a person who took it out.
        if (answer === 'no' || (answer === 'yes' && plan.does === 'make')) look.earlier.push({ kind, answer });
        else look.offers.set(kind.id, { kind, plan });
      }
    }
  }
  return look;
}

// ---- what is said -------------------------------------------------------------------------------

export const SKILL_TURN_OFF = 'Take it out any time with `tricot skill off`.';

// How to add it by hand: for one agent, or every one found.
const skillOn = (kinds: AgentKind[]) => (kinds.length === 1 ? `tricot skill on --agent ${kinds[0].id}` : 'tricot skill on (every agent it finds), or tricot skill on --agent <id> for one');

// What the skill does, in the plain words of the result and the question.
const SKILL_DOES = 'tells the agent to put what you ask to see on a Tricot page, with tricot show, and to hand you the link';

// What the question is about, said before it: what the skill is, and the files it adds.
// `lines`: the exact text is shown after it (--print, or no terminal to ask in).
export function skillExplained(offers: SkillOffer[], lines = false): string[] {
  const names = offers.map((offer) => offer.kind.name);
  const width = Math.max(...names.map((name) => name.length));
  return [
    `${listNames(names)} also ${offers.length === 1 ? 'gets' : 'get'} a Tricot skill, so asking to see something on Tricot works while Tricot is stopped, or when the agent's Tricot tools are missing: it ${SKILL_DOES}. It is one file in the agent's own folder, and no settings file is changed:`,
    ...offers.map((offer) => `  ${offer.kind.name.padEnd(width)}  ${offer.plan.shown}`),
    `${lines ? '' : 'Its exact text: tricot connect --print. '}Where an older Tricot's skill is already there, Tricot keeps a copy beside it, ending in ${BACKUP_SUFFIX}, before it replaces it; a skill file you changed yourself is left as it is. The skill sends nothing anywhere. ${SKILL_TURN_OFF}`,
  ];
}

// What --print and a run without a terminal show of the skill: its exact file.
export function skillShown(offer: SkillOffer): string[] {
  const { plan } = offer;
  const said =
    plan.does === 'update'
      ? `${offer.kind.name}'s skill, for every project, would replace an older one at ${plan.shown} (kept beside it, as ${backupBase(plan)}) with this file:`
      : `${offer.kind.name}'s skill, for every project, would be made at ${plan.shown}, as this file:`;
  return [said, plan.text.replace(/\n$/, '')];
}

// What was done, for the result.
export interface SkillReport {
  added: AgentKind[];
  failed: { kind: AgentKind; why: string }[];
  left: AgentKind[]; // offered to one already connected, and not ticked: the others are left whole, and said of as unticked
}

export const noSkillReport = (): SkillReport => ({ added: [], failed: [], left: [] });

// The result's lines about the skill: which agents got it, which already had it, which were left as they
// were and why, and which have no skill form, so nothing is half set up without being said. `without` is
// the agents with no skill form that are connected (or were). `brief`: leaves out what was added and the agents
// with no skill form, which the caller's own short summary says (connectAll's ending); every problem, and every
// answer kept, is still said.
export function skillResult(look: SkillLook, outcome: SkillReport, without: AgentKind[], brief = false): string[] {
  const lines: string[] = [];
  const names = (kinds: AgentKind[]) => listNames(kinds.map((kind) => kind.name));
  const it = (kinds: AgentKind[]) => (kinds.length === 1 ? 'it' : 'each');
  if (outcome.added.length && !brief) {
    lines.push(`Skill added to ${names(outcome.added)}: it ${SKILL_DOES}, even while Tricot is stopped.`);
    lines.push(`Start a new session of ${it(outcome.added)} for the skill to show up.`);
  }
  if (look.there.length) lines.push(`${names(look.there)} already ${look.there.length === 1 ? 'has' : 'have'} the skill.`);
  const refused = [...outcome.failed, ...look.stuck.filter((each) => each.refused)];
  if (refused.length) {
    lines.push('The skill was not added to:');
    for (const { kind, why } of refused) lines.push(`  ${kind.name}: ${why.replace(/\.$/, '')}.`);
    lines.push(`After you have mended that: ${skillOn(refused.map((each) => each.kind))}`);
  }
  const owned = look.stuck.filter((each) => !each.refused);
  if (owned.length) {
    lines.push('Left as they are:');
    for (const { kind, why } of owned) lines.push(`  ${kind.name}: ${why.replace(/\.$/, '')}.`);
    lines.push(`To have Tricot's skill there, move that file away, then: ${skillOn(owned.map((each) => each.kind))}`);
  }
  if (outcome.left.length) {
    lines.push(`The skill was left out of ${names(outcome.left)}, as you said no. To add ${outcome.left.length === 1 ? 'it' : 'them'} later: ${skillOn(outcome.left)}`);
  }
  const declined = look.earlier.filter((each) => each.answer === 'no');
  if (declined.length) {
    lines.push(`The skill was left out of ${names(declined.map((each) => each.kind))}, as you said no earlier. To add ${declined.length === 1 ? 'it' : 'them'}: ${skillOn(declined.map((each) => each.kind))}`);
  }
  const taken = look.earlier.filter((each) => each.answer === 'yes');
  if (taken.length) {
    const kinds = taken.map((each) => each.kind);
    lines.push(`${names(kinds)} had the skill added before and ${kinds.length === 1 ? "doesn't" : "don't"} have it now, so ${kinds.length === 1 ? 'it was' : 'they were'} left as ${kinds.length === 1 ? 'it is' : 'they are'}. To put ${kinds.length === 1 ? 'it' : 'them'} back: ${skillOn(kinds)}`);
  }
  if (without.length && !brief) lines.push(`Tricot has no skill to add to ${names(without)} yet.`);
  return lines;
}

// Writes the skill, saying what it wrote. A file that can't be written is said, and the agent still has what it had.
export function applySkill(h: HooksEnv, offer: SkillOffer): Done {
  const { out, err } = h.ctx;
  try {
    const { backup } = writeSkill(offer.plan);
    const { plan } = offer;
    out(`${offer.kind.name}: ${plan.does === 'update' ? `replaced the skill at ${plan.shown} with this Tricot's` : `added the skill at ${plan.shown}`}.`);
    if (backup) out(`  ${plan.shown} as it was is kept beside it, as ${backupBase(plan)}.`);
    return { ok: true };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    err(`${offer.kind.name}: ${why}`);
    return { ok: false, why: `${offer.plan.shown} wasn't written (${why.replace(/\.$/, '')})` };
  }
}
