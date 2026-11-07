// Each agent's rule (core/agentRules.ts): the model and thinking level it
// starts on, as the person set it in its panel. It is the person's, the same
// on every board, so it is kept beside the boards rather than in one: in the
// data folder (agent-rules.json, readable by its owner alone, as seats.json
// is), where it outlives a restart and no board's data, event log or
// migrations carry it. Without a data folder (tests) it is kept in memory.
//
// A file that can't be read is left alone until the person sets a rule,
// which writes it again: until then each agent starts on its own settings.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanRule, type AgentRule, type AgentRules } from '../core/agentRules';
import { keepPrivate } from '../platform/private';

export const RULES_FILE = 'agent-rules.json';
export const rulesFile = (dataDir: string) => path.join(dataDir, RULES_FILE);

interface RulesData {
  version: 1;
  rules: AgentRules;
}

// What the file holds, as rules: strings only, trimmed, an empty one left out.
function readRules(value: unknown): AgentRules {
  const rules = (value as Partial<RulesData> | null)?.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return {};
  const kept: AgentRules = {};
  for (const [id, rule] of Object.entries(rules)) {
    if (!rule || typeof rule !== 'object') continue;
    const { model, effort } = rule as Record<string, unknown>;
    const clean = cleanRule({ model: typeof model === 'string' ? model : undefined, effort: typeof effort === 'string' ? effort : undefined });
    if (clean.model || clean.effort) kept[id] = clean;
  }
  return kept;
}

export class AgentRulesStore {
  private rules: AgentRules = {};

  constructor(private readonly options: { dataDir?: string } = {}) {
    if (!options.dataDir) return;
    let text: string;
    try {
      text = readFileSync(rulesFile(options.dataDir), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Tricot couldn't read ${rulesFile(options.dataDir)} (${(error as Error).message}): each agent starts on its own settings until you set its model again.`);
      return;
    }
    try {
      this.rules = readRules(JSON.parse(text));
    } catch (error) {
      console.warn(`Tricot couldn't read ${rulesFile(options.dataDir)} (${(error as Error).message}): each agent starts on its own settings until you set its model again.`);
    }
  }

  all(): AgentRules {
    return structuredClone(this.rules);
  }

  // Sets one agent's rule, checked already (agentRulesRoutes.ts): nothing set takes its entry out.
  set(id: string, rule: AgentRule): AgentRules {
    const clean = cleanRule(rule);
    const next = { ...this.rules };
    if (clean.model || clean.effort) next[id] = clean;
    else delete next[id];
    this.save(next); // kept only once it is written: a refusal leaves the rules as they were
    this.rules = next;
    return this.all();
  }

  private save(rules: AgentRules): void {
    const dir = this.options.dataDir;
    if (!dir) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = rulesFile(dir);
    const temp = `${file}.${process.pid}.tmp`;
    const data: RulesData = { version: 1, rules };
    try {
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      keepPrivate(temp);
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
