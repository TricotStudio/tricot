import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { ToolGroups } from '../src/server/mcp/toolGroups';
import { BOARD_TOOLS } from './canvasAgentKit';
import { call, group, names, serving } from './toolGroupsKit';

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

    it("has no words for a part's tools in a live step", () => {
      assert.deepEqual(new ToolGroups().stepLabels(), { tools: {}, cards: {} });
    });

    it('answers a call to a tool nobody registered as it answers any tool that does not exist', async () => {
      await serving(new ToolGroups(), async ({ client }) => {
        const never = await call(client, 'no_such_tool');
        assert.deepEqual([never.isError, never.content[0].text], [true, 'MCP error -32602: Tool no_such_tool not found']);
      });
    });
  });

  it("takes the words of the groups' tools in a live step together, in the order the groups were added", () => {
    const groups = new ToolGroups();
    groups.add(group('first', [], { stepLabels: { tools: { make_it: 'Making it' }, cards: { work_id: 'work' } } }));
    groups.add(group('quiet', []));
    groups.add(group('last', [], { stepLabels: { tools: { drop_it: 'Dropping it' }, cards: { job_id: 'job' } } }));
    assert.deepEqual(groups.stepLabels(), { tools: { make_it: 'Making it', drop_it: 'Dropping it' }, cards: { work_id: 'work', job_id: 'job' } });
    assert.deepEqual(Object.keys(groups.stepLabels().cards!), ['work_id', 'job_id']);
  });
});
