// What only the server uses of Figma in core: what agents are told about it.
// The web build leaves this file out (see vite.config.ts).

import type { ConnectorServerHalf } from '../connector';

export const server: ConnectorServerHalf = {
  agent: {
    summary: () => ({
      shows: 'the real names of Figma files and frames, with a thumbnail',
      tools: 'Figma frames on link cards: read_figma_frame',
    }),
  },
};
