// What only REST and MCP need of comparison blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { ComparisonTypes } from './index';
import type { AgentHalf, PeopleHalf, ServerHalf } from '../kind';
import { BoardError } from '../../store/errors';

export const agent: AgentHalf<ComparisonTypes> = {
  addShape: {},
  updateShape: {},
  docs: { brief: "comparison → nothing (decision canvases: the options' finding metrics)", add: "comparison → nothing (decision canvases only; renders the options' finding metrics side by side)" },
  read: () => () => ({ type: 'comparison' }),
};

export const people: PeopleHalf = { create: z.object({ type: z.literal('comparison') }) };

export const server: ServerHalf<ComparisonTypes> = {
  patchFields: [],

  create(_input, { located }) {
    if (!located.decision) throw new BoardError('Comparison blocks only work on a decision canvas.');
    return {};
  },

  describe: () => [],
  snapshot: () => ({}),
  restorePatch: () => ({}),

  digest: () => "Live table of the options' finding metrics (see get_decision).",
  searchText: () => [],

  agent,
  people,
};
