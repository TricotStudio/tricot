// Plain `tricot connect`: every agent on this computer, connected in one step.
//
// It finds the agents of the registry that are here (one with a command of
// its own: its program on the PATH; one that joins through its settings file:
// its program on the PATH, or that file), reads whether each already has this
// board (the agent's `get`, or the entry in its file), and shows one list:
// those connected marked so, those it can't connect with why, the rest ticked.
// Enter connects the ticked ones, each as `tricot connect <agent>` would:
// through its own command (connectAgent.ts), or by adding Tricot's entry to its
// file after keeping a copy of it (connectFile.ts). It ends in a few short
// lines: what is connected, what was left alone, how to turn the live steps
// off, and what failed and why, with how to connect those by hand.
//
// What it says is short, and what it does is the same as ever. The list gives
// each agent one line, with a note only where there is a decision to make (a
// server at another address, or why it can't be connected); one sentence under
// it says what else ticking adds; `?` in the list shows everything (each file,
// the copies kept, what is sent, how to turn it off, each command it runs).
// `--print` is that whole text, as a plain listing, and changes nothing, which
// is also what it does without a terminal to ask in.
//
// An agent with a server named tricot at another address (another board, or
// one moved) starts unticked: ticking it replaces that server, which --yes
// never does. --yes connects the ticked ones without asking. Where there is a
// terminal but no keys to tick with, it asks once, yes or no, for the ticked
// ones.
//
// The one question covers the hook too (connectHook.ts), which a person knows
// as live steps: an agent that has a hook and hasn't been answered for gets it
// with its connection, from the same tick, with a copy kept of each settings
// file it changes. An agent already connected with no hook yet is ticked for
// the hook alone. A hook that failed, or was answered for before, is said in
// the end.
//
// So does the Tricot skill (connectSkill.ts): an agent with a skill form
// gets its skill file from the same tick, whether it is connected now or was
// before, so "show me … on Tricot" works with Tricot stopped. It is a plain
// file in the agent's own folder, answered for apart from the hook.
import path from 'node:path';
import type { AgentKind, CommandConnect, ConnectView } from '../core/agents/agent';
import { agentsInCliOrder } from '../core/agents/registry';
import { setEnvironment, shellNoun, TOKEN_ENV } from '../core/connect';
import { listNames, orNames } from '../core/format';
import { which } from '../platform/which';
import { UNREAD_TOKEN, type Env } from './commandEnv';
import { addressOfServer, commandLines, runAgentCommand, sameAddress, tokenStops } from './connectAgent';
import { applyFile, backupName, fileAgentHere, isFileAgent, planFile, type FilePlan } from './connectFile';
import { applyHook, hookExplained, hookNotes, hookResult, hookShown, keepHookCopies, lookAtHooks, rememberHookAnswers, takesPromptHook, type HookLook, type HookOffer, type HookReport } from './connectHook';
import { applySkill, lookAtSkills, noSkillReport, rememberSkillAnswers, skillExplained, skillResult, skillShown, takesSkill, type SkillLook, type SkillOffer, type SkillReport, type YesNo } from './connectSkill';
import type { HooksEnv } from './hooks';
import type { CliResult } from './main';
import { shellOf } from './shell';
import { pickTicked, staticRows, type TickRow } from './tickList';

type State = 'connected' | 'ready' | 'replace' | 'cannot';

interface Found {
  kind: AgentKind;
  view: ConnectView;
  state: State;
  note: string; // its row in the list: only what needs a decision, else empty
  detail: string; // what that row says in full (--print, and `?`): the command it runs, or the file it changes
  why?: string; // cannot: why, as the end says it
  was?: string; // replace: the address of the server it has now
  shown: string[]; // what --print shows of what it would do, beyond its row
  connect?(): Promise<{ ok: true } | { ok: false; why: string }>; // ready or replace: does it, saying so
  readsToken: boolean; // it reads the board's token from TRICOT_TOKEN
  hook?: HookOffer; // it takes the hook and hasn't got it: ticking its row sets that up too
  skill?: SkillOffer; // it has a skill form and hasn't got the skill: ticking its row adds that too
}

// What the skill half of the question found and did, carried to the result.
interface Skills {
  look: SkillLook;
  outcome: SkillReport;
}

type Done = { ok: true } | { ok: false; why: string };

// Whether it has something to add beside its connection: its hook, its skill.
const extra = (f: Found) => f.hook !== undefined || f.skill !== undefined;
// Whether its row can be ticked: to connect it, or, when it already is, to add its hook or its skill.
const takes = (f: Found) => f.state === 'ready' || f.state === 'replace' || (f.state === 'connected' && extra(f));
// Whether it starts ticked: one at another address never does.
const startsTicked = (f: Found) => f.state === 'ready' || (f.state === 'connected' && extra(f));

// What an agent's extras are called in the list: live steps for its hook, a skill for its skill.
const adds = (f: Found) => [f.hook && 'live steps', f.skill && 'a skill'].filter(Boolean).join(' and ');
// Its row's note: short, or (`full`: --print) what the row said before, the command or file in full.
const rowNote = (f: Found, full: boolean) => {
  if (!full) return f.state === 'connected' && extra(f) ? `${f.note}; adds ${adds(f)}` : f.note;
  if (!extra(f)) return f.detail;
  const hook = f.hook ? (takesPromptHook(f.kind) ? 'its hook' : 'its hook (live steps only)') : undefined;
  const added = [hook, f.skill && 'its Tricot skill'].filter(Boolean).join(' and ');
  return f.state === 'connected' ? `${f.detail}; adds ${added}` : `${f.detail}, and adds ${added}`;
};

// An address as a row names it: the port alone for one on this computer.
function shortAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  try {
    const url = new URL(address);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port ? `:${url.port}` : url.host;
  } catch {
    return undefined;
  }
}
const elsewhere = (was: string | undefined) => `on another board${shortAddress(was) ? ` (${shortAddress(was)})` : ''}: tick to switch`;

// The one sentence about what the agents in `takers` get beside the connection. Where all of them get the same it
// says why; where they differ, who gets each ("all but Cursor", or by name). `more`: where the rest is to be seen.
function alsoGets(takers: Found[], more: string): string | undefined {
  const things = [
    ['live steps', takers.filter((f) => f.hook)],
    ['a skill', takers.filter((f) => f.skill)],
  ] as const;
  const gets = things.filter(([, list]) => list.length);
  if (!gets.length) return undefined;
  const everyone = gets.every(([, list]) => list.length === takers.length);
  const who = (list: readonly Found[]) => {
    const rest = takers.filter((f) => !list.includes(f));
    return rest.length && rest.length <= 2 && list.length > rest.length ? ` (all but ${listNames(rest.map((f) => f.kind.name))})` : ` (${listNames(list.map((f) => f.kind.name))})`;
  };
  const what = gets.map(([thing, list]) => `${thing}${list.length === takers.length ? '' : who(list)}`).join(' and ');
  const why = everyone ? (gets.some(([thing]) => thing === 'live steps') ? ', so you see its work on the board' : ', so asking to see something on Tricot works with Tricot stopped') : '';
  return `${takers.length === 1 ? `${takers[0].kind.name} also gets` : 'Each also gets'} ${what}${why}. ${more}`;
}

export interface AllEnv {
  env: Env;
  mcpUrl: string; // the board's MCP address, before any agent's name
  view(kind: AgentKind): ConnectView; // the address as the agent names itself on the board
  howToConnect(): void; // every agent's instructions, as `tricot` prints them
  hooks: HooksEnv; // where the hook's plans are made and written, and its answers kept
}

export async function connectAll({ env, mcpUrl, view, howToConnect, hooks }: AllEnv): Promise<CliResult> {
  const { ctx, values } = env;
  const { out } = ctx;
  if (values.name) {
    ctx.err(`--name names one agent on the board, so it goes with one: tricot connect <agent> --name "${values.name}". Nothing was changed.`);
    return { exitCode: 1 };
  }
  const kinds = agentsInCliOrder();
  const looked = await Promise.all(kinds.map((kind) => inspect(env, kind, view(kind))));
  const found = looked.filter((f): f is Found => f !== undefined);
  const missing = kinds.filter((_, i) => !looked[i]).map((kind) => kind.name);

  if (!found.length) {
    out(`Tricot found none of the agents it knows on this computer: it looked for each one's program on your PATH (${listNames(kinds.map((kind) => kind.command))}) and for the settings files of those that keep the board in one.`);
    out('');
    howToConnect();
    return { exitCode: 0 };
  }

  // The hook, for the agents that have one and haven't been answered for. One that can't be connected gets none.
  const look = lookAtHooks(hooks, found.map((f) => f.kind));
  for (const f of found) {
    const offer = look.offers.get(f.kind.id);
    if (offer && f.state !== 'cannot') f.hook = offer;
  }
  const offered = found.flatMap((f) => (f.hook ? [f.hook] : []));
  // The skill, for the agents that have a form of it and haven't been answered for: the same rule.
  const skills: Skills = { look: lookAtSkills(hooks, found.map((f) => f.kind)), outcome: noSkillReport() };
  for (const f of found) {
    const offer = skills.look.offers.get(f.kind.id);
    if (offer && f.state !== 'cannot') f.skill = offer;
  }
  const skillOffered = found.flatMap((f) => (f.skill ? [f.skill] : []));

  // --print shows all of it, as it always did; every other way shows one line for each agent and a sentence.
  const full = Boolean(values.print);
  const rowsOf = (showFull: boolean): TickRow[] =>
    found.map((f) => ({
      label: f.kind.name,
      note: rowNote(f, showFull),
      kind: takes(f) ? 'tick' : f.state === 'connected' ? 'done' : 'none',
      ticked: startsTicked(f),
    }));
  const rows = rowsOf(full);
  // What the hook and the skill do, in full: `lines`, when the exact lines are shown after it.
  const explained = (lines: boolean) => [...(offered.length ? hookExplained(offered, lines) : []), ...(offered.length && skillOffered.length ? [''] : []), ...(skillOffered.length ? skillExplained(skillOffered, lines) : [])];
  if (full) {
    out(`Tricot found ${found.length === 1 ? 'one agent' : `${found.length} agents`} on this computer${missing.length ? ` (not ${orNames(missing)})` : ''}.`);
    if (offered.length || skillOffered.length) {
      out('');
      for (const line of explained(true)) out(line);
      out('');
    }
  } else {
    out(`Found ${found.length === 1 ? 'one agent' : `${found.length} agents`} on this computer.`);
  }
  const startTicked = found.flatMap((f, i) => (startsTicked(f) ? [i] : []));
  const tickable = found.some(takes);
  const board = `the board at ${mcpUrl}`;
  const asStatic = (question: string) => {
    out(question);
    for (const line of staticRows(rows)) out(line);
  };
  // Under the rows where the list can't show `?`: the sentence about what ticking adds, and where to see the rest.
  const saidAlso = () => {
    const also = alsoGets(found.filter(startsTicked), 'tricot connect --print shows what changes.');
    if (also) out(`\n${also}`);
  };
  const nothing: HookReport = { added: [], failed: [], left: [] };
  const nothingDone: Skills = { look: skills.look, outcome: noSkillReport() };

  const keys = ctx.keys && ctx.ask && !values.yes && !values.print ? ctx.keys : undefined;
  if (!tickable) {
    if (!full) out('');
    asStatic(`Agents here, and ${board}:`);
    return finish(env, found, [], [], false, look, nothing, nothingDone);
  }
  if (values.print || (!values.yes && !ctx.ask)) {
    if (!full) out('');
    asStatic(`Tricot would connect the ticked ones to ${board}:`);
    if (!full) {
      saidAlso();
      out('');
      out('Nothing was changed.');
      ctx.err('Without a terminal to ask in, Tricot changed nothing: run tricot connect in a terminal to tick which, or add --yes to connect the ticked ones.');
      return { exitCode: 0 };
    }
    for (const f of found) {
      if (!startsTicked(f)) continue;
      const shown = [...f.shown, ...(f.hook ? hookShown(f.hook) : []), ...(f.skill ? skillShown(f.skill) : [])];
      if (!shown.length) continue;
      out('');
      for (const line of shown) out(line);
    }
    const printed = [
      ...hookResult(look, nothing, withoutPromptHook(found, (f) => f.state === 'connected' || startsTicked(f))),
      ...skillResult(skills.look, noSkillReport(), withoutSkill(found, (f) => f.state === 'connected' || startsTicked(f))),
    ];
    if (printed.length) {
      out('');
      for (const line of printed) out(line);
    }
    out('');
    out(`Nothing was changed: --print only shows what Tricot would do. tricot connect <agent> --print shows how to connect ${found.length === 1 ? 'it' : 'any one'} yourself.`);
    return { exitCode: 0 };
  }

  // The rows the question covered: all it shows in a list, the ticked ones where it is yes or no.
  let chosen: number[];
  let asked: number[];
  if (values.yes) {
    out('');
    asStatic(`Connecting the ticked ones to ${board}:`);
    saidAlso();
    chosen = asked = startTicked;
  } else if (keys) {
    const connecting = found.some((f) => f.state === 'ready' || f.state === 'replace');
    const them = found.length === 1 ? 'it' : 'them';
    const adding = offered.length && skillOffered.length ? 'live steps and a skill' : offered.length ? 'live steps' : 'a skill';
    const question = connecting ? `Connect ${them} to your board?` : `Add ${adding} to the ticked ones?`;
    // `?`: everything the list leaves out, as --print shows it: what the hook and the skill do, and each row in full.
    const notes = hookNotes(offered);
    const details = ['', ...explained(false), ...(notes.length ? ['To know:', ...notes] : []), ...(offered.length || skillOffered.length ? [''] : []), 'What each row does:', ...staticRows(rowsOf(true)), ''];
    out('');
    const picked = await pickTicked(keys, { question, rows, details, footer: alsoGets(found.filter(takes), '? shows what changes.') });
    if (picked === undefined) {
      out('Nothing was changed.');
      return { exitCode: 0 };
    }
    chosen = picked;
    asked = found.flatMap((f, i) => (takes(f) ? [i] : []));
  } else {
    out('');
    asStatic(`Tricot would connect the ticked ones to ${board}:`);
    saidAlso();
    asked = startTicked;
    chosen = startTicked.length && (await ctx.ask!(questionFor(found, startTicked), false)) ? startTicked : [];
  }
  const outcome: HookReport = { added: [], failed: [], left: [] };
  if (!chosen.length) {
    out('Nothing was changed.');
    // A no to the question is a no to each thing it offered: the hook, and the skill.
    const declined = asked.filter((i) => found[i].hook);
    outcome.left = declined.filter((i) => found[i].state === 'connected').map((i) => found[i].kind);
    rememberHookAnswers(hooks, Object.fromEntries(declined.map((i) => [found[i].kind.id, 'no' as const])));
    const skipped = asked.filter((i) => found[i].skill);
    skills.outcome.left = skipped.filter((i) => found[i].state === 'connected').map((i) => found[i].kind);
    rememberSkillAnswers(hooks.dataDir, Object.fromEntries(skipped.map((i) => [found[i].kind.id, 'no' as const])), 'connect');
    return finish(env, found, [], found.flatMap((f, i) => (f.state === 'ready' || f.state === 'replace' ? [i] : [])), true, look, outcome, skills);
  }

  out('');
  const results: { index: number; ok: boolean; why?: string }[] = [];
  const answers: Record<string, YesNo> = {};
  const skillAnswers: Record<string, YesNo> = {};
  for (const index of chosen) {
    const f = found[index];
    // A copy of each settings file the hook changes comes first, so a file the connection changes too is kept as it was.
    let copies: { file: string; copy: string }[] | { problem: string } | undefined;
    if (f.hook) {
      try {
        copies = keepHookCopies(hooks, f.hook);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        ctx.err(`${f.kind.name}: ${why}`);
        copies = { problem: why };
      }
    }
    let connected: Done = { ok: true };
    if (f.connect) {
      connected = await f.connect();
      results.push({ index, ...connected });
    }
    if (f.hook && copies) {
      let done: Done;
      if (!Array.isArray(copies)) done = { ok: false, why: `a copy of its settings couldn't be kept, so Tricot wrote nothing to them (${copies.problem.replace(/\.$/, '')})` };
      else if (!connected.ok) done = { ok: false, why: 'its connection did not go through, so the hook waits for it' };
      else done = applyHook(hooks, f.hook, copies);
      if (done.ok) {
        outcome.added.push(f.kind);
        answers[f.kind.id] = 'yes';
      } else {
        outcome.failed.push({ kind: f.kind, why: done.why });
      }
    }
    // The skill is a file of its own in the agent's own folder: it works without the connection (it is for when the
    // agent's tools are missing), so it goes in even where the connection didn't go through.
    if (f.skill) {
      const done = applySkill(hooks, f.skill);
      if (done.ok) {
        skills.outcome.added.push(f.kind);
        skillAnswers[f.kind.id] = 'yes';
      } else {
        skills.outcome.failed.push({ kind: f.kind, why: done.why });
      }
    }
  }
  // Ticked off is a no to the hook, as the first question's no is; a hook that failed is asked about again. The skill is the same.
  const notTicked = asked.filter((i) => !chosen.includes(i) && found[i].hook);
  outcome.left = notTicked.filter((i) => found[i].state === 'connected').map((i) => found[i].kind); // the others are said of as unticked
  for (const i of notTicked) answers[found[i].kind.id] = 'no';
  rememberHookAnswers(hooks, answers);
  const skillNotTicked = asked.filter((i) => !chosen.includes(i) && found[i].skill);
  skills.outcome.left = skillNotTicked.filter((i) => found[i].state === 'connected').map((i) => found[i].kind);
  for (const i of skillNotTicked) skillAnswers[found[i].kind.id] = 'no';
  rememberSkillAnswers(hooks.dataDir, skillAnswers, 'connect');
  const left = found.flatMap((f, i) => ((f.state === 'ready' || f.state === 'replace') && !chosen.includes(i) ? [i] : []));
  return finish(env, found, results, left, false, look, outcome, skills);
}

// The question where there are no keys to tick with: what is connected, and which of them get live steps and the skill.
function questionFor(found: Found[], ticked: number[]): string {
  const names = (pick: (f: Found) => boolean) => listNames(ticked.map((i) => found[i]).filter(pick).map((f) => f.kind.name));
  const connecting = names((f) => f.state === 'ready');
  const hooking = names((f) => f.hook !== undefined);
  const skilling = names((f) => f.skill !== undefined);
  // One list for both when the same agents take both; two when they differ.
  const adding = hooking && skilling ? (hooking === skilling ? `live steps and a skill to ${hooking}` : `live steps to ${hooking}, and a skill to ${skilling}`) : hooking ? `live steps to ${hooking}` : skilling ? `a skill to ${skilling}` : '';
  if (!adding) return `Connect ${connecting}?`;
  return connecting ? `Connect ${connecting}, and add ${adding}?` : `Add ${adding}?`;
}

// The agents with no prompt hook (live steps only, or none) that are connected, or would be: those the result
// says go by the wording of Tricot's tools. One left unticked, or that could not be connected, is not said of.
function withoutPromptHook(found: Found[], connected: (f: Found) => boolean): AgentKind[] {
  return found.filter((f) => !takesPromptHook(f.kind) && connected(f)).map((f) => f.kind);
}

// The agents with no skill form that are connected, or would be, as the result says of them. One left
// unticked, or that could not be connected, is not said of.
function withoutSkill(found: Found[], connected: (f: Found) => boolean): AgentKind[] {
  return found.filter((f) => !takesSkill(f.kind) && connected(f)).map((f) => f.kind);
}

// What it did, in a few short lines, and what it didn't and why, with how to connect those by hand.
// `left`: the ones it could have connected that weren't ticked.
function finish(env: Env, found: Found[], results: { index: number; ok: boolean; why?: string }[], left: number[], quiet: boolean, look: HookLook, hook: HookReport, skills: Skills): CliResult {
  const { ctx, values } = env;
  const { out } = ctx;
  const shell = shellOf(ctx.platform);
  const done = results.filter((r) => r.ok).map((r) => found[r.index]);
  const failed = results.filter((r) => !r.ok).map((r) => ({ f: found[r.index], why: r.why! }));
  const already = found.filter((f) => f.state === 'connected');
  const cannot = found.filter((f) => f.state === 'cannot').map((f) => ({ f, why: f.why! }));
  const unticked = left.map((i) => found[i]);
  // Without a yes for each, a server at another address stays: --yes never replaces one.
  const kept = unticked.filter((f) => f.state === 'replace');
  if (!quiet) out('');

  // What it did: connected now, and live steps or a skill added to one that was connected before.
  const names = (kinds: AgentKind[]) => listNames(kinds.map((kind) => kind.name));
  const connectedKinds = done.map((f) => f.kind);
  const later = (kinds: AgentKind[]) => kinds.filter((kind) => !connectedKinds.includes(kind));
  const stepsLater = later(hook.added);
  const skillLater = later(skills.outcome.added);
  const same = stepsLater.length === skillLater.length && stepsLater.every((kind) => skillLater.includes(kind));
  const did = [
    ...(connectedKinds.length ? [`Connected ${names(connectedKinds)}`] : []),
    ...(same && stepsLater.length ? [`Added live steps and a skill to ${names(stepsLater)}`] : [...(stepsLater.length ? [`Added live steps to ${names(stepsLater)}`] : []), ...(skillLater.length ? [`Added a skill to ${names(skillLater)}`] : [])]),
  ];
  const touched = new Set([...connectedKinds, ...hook.added, ...skills.outcome.added]);
  const lead = did.length ? '  ' : '';
  if (did.length) out(`✓ ${did.join('. ')}. Start a new session in ${touched.size === 1 ? 'it' : 'each'}.`);
  if (unticked.length) {
    const switching = kept.length === 1 ? `tricot connect ${kept[0].kind.id}` : 'tricot connect <agent>';
    const tail = !kept.length ? '' : values.yes ? ` --yes never switches an agent on another board; ${switching} does.` : ` To switch one on another board: ${switching}.`;
    out(`${lead}Left alone: ${listNames(unticked.map((f) => f.kind.name))}.${tail}`);
  }
  // How to turn off what is on: live steps that were added or already were, and the skill.
  const steps = hook.added.length > 0 || look.there.length > 0;
  const skill = skills.outcome.added.length > 0 || skills.look.there.length > 0;
  if (steps || skill) out(`${lead}${steps && skill ? 'Turn off live steps with tricot steps off, and the skill with tricot skill off.' : steps ? 'Turn the live steps off any time: tricot steps off' : 'Take the skill out any time: tricot skill off'}`);
  if (already.length) out(`Already connected: ${listNames(already.map((f) => f.kind.name))}.`);
  const connectedNow = (f: Found) => f.state === 'connected' || results.some((r) => r.ok && found[r.index] === f);
  for (const line of hookResult(look, hook, withoutPromptHook(found, connectedNow), true)) out(line);
  for (const line of skillResult(skills.look, skills.outcome, withoutSkill(found, connectedNow), true)) out(line);
  const notDone = [...cannot, ...failed];
  if (notDone.length) {
    out('Not connected:');
    for (const { f, why } of notDone) out(`  ${f.kind.name}: ${why}.`);
  }
  for (const { f } of notDone) {
    out('');
    out(`To connect ${f.kind.name} yourself:`);
    f.kind.show(f.view);
  }
  const readers = [...done, ...already].filter((f) => f.readsToken).map((f) => f.kind.name);
  if (env.token && readers.length) {
    const set = shell === 'powershell' ? setEnvironment(TOKEN_ENV, '<token>', shell) : `export ${TOKEN_ENV}=<token>`;
    out(`${listNames(readers)} ${readers.length === 1 ? 'reads' : 'read'} the board's token from ${TOKEN_ENV}: set it in the ${shellNoun(shell)} ${readers.length === 1 ? 'it runs' : 'each runs'} from, with ${set} (the token is in ${path.join(env.dataDir, 'token')}).`);
  }
  if (values.board && done.length + already.length) out(`Then tell ${done.length + already.length === 1 ? 'the agent' : 'each agent'}: Use the Tricot board ${values.board}.`);
  return { exitCode: notDone.length || hook.failed.length || look.stuck.length || skills.outcome.failed.length || skills.look.stuck.some((each) => each.refused) || (values.yes && kept.length) ? 1 : 0 };
}

// One agent: none when it isn't on this computer.
async function inspect(env: Env, kind: AgentKind, view: ConnectView): Promise<Found | undefined> {
  return isFileAgent(kind) ? inspectFile(env, kind, view) : inspectCommand(env, kind as AgentKind & { connect: CommandConnect }, view);
}

async function inspectCommand(env: Env, kind: AgentKind & { connect: CommandConnect }, view: ConnectView): Promise<Found | undefined> {
  const { ctx } = env;
  const way = kind.connect;
  const unread = env.token === UNREAD_TOKEN;
  const token = unread ? undefined : env.token;
  const words = way.words(view.url, token);
  const file = which(words[0], ctx.env);
  if (!file) return undefined;
  const shell = shellOf(ctx.platform);
  const base = { kind, view, shown: [], readsToken: way.readsToken };
  const stops = tokenStops(way, token, unread);
  if (stops) {
    const why =
      stops === 'unread'
        ? `the board needs its token, which isn't in ${env.dataDir} yet: start Tricot (tricot), then connect again`
        : "it takes the board's token only as part of its command's own arguments, which others on this computer could read while it runs, so Tricot doesn't run it";
    const short = stops === 'unread' ? 'start Tricot (tricot), then connect again' : "it takes the token only in its command's arguments";
    return { ...base, state: 'cannot', note: `can't: ${short}`, detail: `can't: ${why}`, why };
  }
  const existing = await addressOfServer(ctx, way, file, token);
  if (existing !== undefined && sameAddress(existing, view.url)) return { ...base, state: 'connected', note: 'already connected', detail: 'already connected to this board' };
  const replacing = existing !== undefined;
  const lines = commandLines(way, words, token, shell, replacing);
  const found: Found = {
    ...base,
    state: replacing ? 'replace' : 'ready',
    note: replacing ? elsewhere(existing) : '',
    detail: replacing ? `has a server named tricot at ${existing}: tick it to replace that one, running ${lines.join(', then ')}` : `runs ${lines.join(', then ')}`,
    ...(replacing && { was: existing }),
    async connect() {
      ctx.out(`${kind.name}: ${lines.join(', then ')}`);
      const result = await runAgentCommand({ ctx, agent: kind, way, file, words, token, replacing, id: kind.id });
      if (result.ok) after(env, kind, view, found);
      return result;
    },
  };
  return found;
}

function inspectFile(env: Env, kind: AgentKind, view: ConnectView): Found | undefined {
  if (!isFileAgent(kind)) return undefined;
  const { ctx } = env;
  if (!fileAgentHere(kind, ctx)) return undefined;
  const base = { kind, view, readsToken: true };
  const plan = planFile(kind, ctx, view.url, env.token);
  switch (plan.does) {
    case 'same':
      return { ...base, shown: [], state: 'connected', note: 'already connected', detail: 'already connected to this board' };
    case 'refuse': {
      const why = `${plan.shown} ${plan.why}, so it was left as it is`;
      return { ...base, shown: [], state: 'cannot', note: `can't: ${plan.shown} ${plan.why}`, detail: `can't: ${plan.shown} ${plan.why}`, why };
    }
    default: {
      const was = plan.does === 'replace' ? plan.was : undefined;
      const detail =
        plan.does === 'make'
          ? `makes ${plan.shown}, with its entry`
          : plan.does === 'add'
            ? `adds its entry to ${plan.shown}, keeping a copy of the file`
            : `has a server named tricot at ${was ?? 'another address'} in ${plan.shown}: tick it to put the board's in its place, keeping a copy of the file`;
      const found: Found = {
        ...base,
        state: plan.does === 'replace' ? 'replace' : 'ready',
        note: plan.does === 'replace' ? elsewhere(was) : '',
        detail,
        ...(was && { was }),
        shown: [`${kind.name}'s entry, for ${plan.shown} (under "${kind.connect.section}"):`, kind.connect.entry(view.url, env.token)],
        async connect() {
          return writeFile(env, kind, view, plan, found);
        },
      };
      return found;
    }
  }
}

function writeFile(env: Env, kind: AgentKind, view: ConnectView, plan: Extract<FilePlan, { next: string }>, found: Found): Done {
  const { ctx } = env;
  let backup: string | undefined;
  try {
    ({ backup } = applyFile(plan));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    ctx.err(`${kind.name}: ${why}`);
    return { ok: false, why: `${plan.shown} wasn't written (${why.replace(/\.$/, '')})` };
  }
  const kept = backup ? ` (the file as it was is kept beside it, as ${backupName(plan)})` : '';
  const did = plan.does === 'make' ? `made ${plan.shown}, with its entry` : plan.does === 'add' ? `added its entry to ${plan.shown}${kept}` : `put the board's entry in place of the old one in ${plan.shown}${kept}`;
  ctx.out(`${kind.name}: ${did}.`);
  after(env, kind, view, found);
  return { ok: true };
}

// What the agent says once it worked, indented under it. What it says about
// showing steps (Claude Code's project hint) is left out when the hook goes in
// with it, which does that for every project.
function after(env: Env, kind: AgentKind, view: ConnectView, found: Found): void {
  const indent = (line: string) => env.ctx.out(`  ${line}`);
  for (const line of kind.afterwards ?? []) indent(line);
  if (!found.hook) kind.afterConnected?.({ ...view, out: indent });
}
