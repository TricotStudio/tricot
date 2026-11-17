// A kind of block (src/core/blocks/<type>/), a connector (src/core/connectors/<id>/)
// and an agent (src/core/agents/<id>/) each have a server.ts for what only the
// server uses: making and changing blocks, what agents read, the zod schemas,
// what agents are told of a connector, how an agent starts and its hook installer.
// The browser never calls any of it, so the web build swaps it for an empty
// module and none of it is bundled. The rule lives here so the Vite build
// (vite.config.ts) and the check on its result (test/bundle.test.ts) share it.

export const KIND_SERVER_STUB = 'export const server = {};\n';

// Whether an import is a kind's, a connector's or an agent's index.ts reaching for its own server half.
export const isKindServerImport = (source: string, importer: string | undefined): boolean =>
  source === './server' && /[\\/]core[\\/](?:blocks|connectors|agents)[\\/][^\\/]+[\\/]index\.ts$/.test(importer ?? '');
