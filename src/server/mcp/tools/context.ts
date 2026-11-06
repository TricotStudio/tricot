import type { Store } from '../../../core/store';
import type { Actor } from '../../../core/types';
import type { BlockReader } from '../content';
import type { McpOptions, Session } from '../session';

// What every tool's area is given to build its tools from: this server's
// board, who is calling, how it was set up, and the calling agent's session.
export interface ToolContext {
  store: Store;
  getActor: () => Actor;
  options: McpOptions;
  session: Session;
  blocks: BlockReader;
}
