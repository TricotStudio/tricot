import type { Store } from '../../../core/store';
import type { Actor } from '../../../core/types';
import type { BlockReader } from '../content';
import type { McpOptions, Session } from '../session';
import type { Phrases } from '../words';

// What every tool's area is given to build its tools from: this server's
// board, who is calling, how it was set up, and the calling agent's session, and
// what the tool groups registered with it say in the board's own texts (`words`).
export interface ToolContext {
  store: Store;
  getActor: () => Actor;
  options: McpOptions;
  session: Session;
  blocks: BlockReader;
  words: Phrases;
}
