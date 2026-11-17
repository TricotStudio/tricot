import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { ToolGroups } from '../src/server/mcp/toolGroups';
import { BOARD_TOOLS } from './canvasAgentKit';
import { call, names, serving } from './toolGroupsKit';

// How the MCP server reaches the tools of a group (server/mcp/toolGroups.ts): a part of Tricot registers what each group of tools
// gives an agent, and the server asks the registry, so the board's own tools name none of them. What the
// tools do is the tests of each area's.

describe('The MCP server', () => {
  afterEach(() => mock.restoreAll());

  describe('with nothing registered, as a canvas alone is built', () => {
    it('lists the board\'s tools, in their order', async () => {
      await serving(new ToolGroups(), async ({ tools }) => {
        assert.deepEqual(names(tools), BOARD_TOOLS);
        assert.equal(tools.length, 26);
      });
    });

    it('answers a call to a tool nobody registered as it answers any tool that does not exist', async () => {
      await serving(new ToolGroups(), async ({ client }) => {
        const never = await call(client, 'no_such_tool');
        assert.deepEqual([never.isError, never.content[0].text], [true, 'MCP error -32602: Tool no_such_tool not found']);
      });
    });
  });
});
