// Plain `tricot` in a terminal (boardCommands.ts start): which agents to start
// with the board, asked before the board starts in this terminal, or under
// its address when it runs already. One row for each agent Tricot can start
// whose program is here (agentsHere.ts), ticked as they were the last time
// (kept in the data folder), else the first. Enter starts the ticked ones
// with the board, as `tricot claude codex` would (agentCommand.ts): the board
// in the background, kept running while they run, each agent connected for its
// session. Esc, or Enter with none ticked, starts the board alone in this
// terminal, as `tricot` always did. Whether each agent has the board for good
// isn't asked: started from here it has it for its session, and asking Claude
// Code takes seconds.
//
// No list where there is no terminal, with --background or --no-ask, or with
// no agent to start: the board starts alone, as before.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listNames } from '../core/format';
import { startableHere } from './agentsHere';
import type { Env } from './commandEnv';
import { pickTicked } from './tickList';

const LAST_FILE = 'last-agents.json';

function lastStarted(dataDir: string): string[] {
  try {
    const kept = JSON.parse(readFileSync(path.join(dataDir, LAST_FILE), 'utf8')) as unknown;
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function keepStarted(dataDir: string, ids: string[]): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dataDir, LAST_FILE), `${JSON.stringify(ids)}\n`, { mode: 0o600 });
  } catch {
    // Not kept: the first agent is ticked next time, which is all it costs.
  }
}

// The agents to start, by id; none: the board alone. `running`: the board runs already, its address said above.
export async function pickAgents(env: Env, running: boolean): Promise<string[] | undefined> {
  const { ctx, values, dataDir } = env;
  if (!ctx.keys || values.background || values['no-ask']) return undefined;
  const here = startableHere(env);
  if (!here.length) return undefined;
  const last = lastStarted(dataDir).filter((id) => here.some((kind) => kind.id === id));
  const ticked = new Set(last.length ? last : [here[0].id]);
  const chosen = await pickTicked(ctx.keys, {
    question: running ? 'Start an agent with it?' : 'Start Tricot with an agent?',
    rows: here.map((kind) => ({ label: kind.name, note: '', kind: 'tick', ticked: ticked.has(kind.id) })),
    footer: running ? 'Esc: leave the board as it runs.' : 'Esc: start the board alone, here.',
    words: { enter: 'start', chose: (names) => `Starting ${names}`, none: 'The board alone', cancelled: 'The board alone' },
    all: false,
  });
  if (!chosen?.length) return undefined;
  const ids = chosen.map((i) => here[i].id);
  keepStarted(dataDir, ids);
  ctx.out(`${listNames(chosen.map((i) => here[i].name))} ${chosen.length === 1 ? 'starts' : 'start'} with the board, each connected for its session: next time, tricot ${ids.join(' ')} does the same.`);
  return ids;
}
