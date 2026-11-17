// The routes behind each agent's rule (core/agentRules.ts), the model and
// thinking level it starts on:
//
// - GET /api/agent-rules: every rule set, by agent id. The page's chip reads
//   it, and the terminal as it starts an agent (cli/agentRules.ts). It
//   changes nothing, so it is a read like GET /api/agents: behind the Origin
//   check, and the token on the network.
// - POST /api/agent-rules/:agent: sets one, from the agent's panel. It
//   decides what the person's agents run on and spend, so it is the
//   person's alone, from one of their seats (access.ts asPerson, tier B):
//   an agent, or a script passing for the page, is refused, and there is no
//   MCP tool for it. What the agent can't take is refused, saying why.
import { Router, type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { cleanRule, ruleProblem } from '../core/agentRules';
import { findAgent } from '../core/agents/registry';
import { routes } from '../core/routes';
import { agentRule, describeIssues } from '../core/schemas';
import { personOnly, type PersonGate } from './access';
import type { AgentRulesStore } from './agentRules';
import { routesOn } from './routing';

export function createAgentRulesRouter(rules: AgentRulesStore, person: PersonGate): Router {
  const router = Router();
  const on = routesOn(router, '/api/agent-rules');

  on(routes.agentRules, (_req, res) => {
    res.json({ rules: rules.all() });
  });

  on(routes.setAgentRule, personOnly(person, 'B'), (req, res) => {
    const { agent } = agentRule.agent.parse(req.params);
    const kind = findAgent(agent);
    if (!kind) {
      res.status(404).json({ error: `Tricot doesn't know an agent called "${agent}".` });
      return;
    }
    const rule = cleanRule(agentRule.rule.parse(req.body ?? {}));
    const problem = ruleProblem(kind, rule);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    res.json({ rules: rules.set(kind.id, rule) });
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) res.status(400).json({ error: describeIssues(error) });
    else {
      console.error(error);
      res.status(500).json({ error: `Tricot couldn't keep the rule: ${(error as Error).message}` });
    }
  };
  router.use(errors);
  return router;
}
