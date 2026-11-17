// What only REST and MCP need of comparison blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { ComparisonTypes } from './index';
import type { AgentHalf, PeopleHalf, ServerHalf } from '../kind';

export const agent: AgentHalf<ComparisonTypes> = {
  // A comparison is the table of a decision's options, which a part's cards have: a server that offers none tells agents of no such block.
  offeredBy: 'cards',
  addShape: {},
  updateShape: {},
  // What it shows, and on which canvases, is for a part's decisions to say: this says only its type.
  docs: { brief: 'comparison → nothing', add: 'comparison → nothing' },
  read: () => () => ({ type: 'comparison' }),
};

export const people: PeopleHalf = { create: z.object({ type: z.literal('comparison') }) };

export const server: ServerHalf<ComparisonTypes> = {
  patchFields: [],

  cardOnly: 'Comparison blocks only work on the canvas of a card that shows them.',

  create: () => ({}),

  describe: () => [],
  snapshot: () => ({}),
  restorePatch: () => ({}),

  digest: () => "Live table of the options' finding metrics (see get_decision).",
  searchText: () => [],

  agent,
  people,
};
