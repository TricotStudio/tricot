import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_INSTRUCTIONS } from '../src/server/mcp';
import { instructionsFor } from '../src/server/mcp/instructions';
import { ToolGroups } from '../src/server/mcp/toolGroups';
import { CANVAS_ABOUT, CANVAS_FILE, firstDifference, goldenText, golden, meet, read, toolsNamedIn } from './instructionsSurface';

// What every agent is told on connecting is composed from named lines (server/mcp/instructions.ts): the core's
// are the ones true without a part, and the tool groups add their own at the positions they name. With nothing
// registered the text opens with a short neutral line and says only what a canvas has. The golden holds the
// text itself, in full: test/golden/mcp-instructions-canvas.txt. What the text is with a part's group, and that the
// canvas's names none of its words, is in its counterpart of this file.

describe('The instructions with nothing registered, as a canvas alone is built', () => {
  const advice = `Take it again with \`npx tsx test/instructionsSurface.ts --write canvas\` when the core's own lines were meant to change, and read the diff of test/golden/mcp-instructions-canvas.txt.`;

  it("tells each agent the text in the golden: the neutral line, and the lines that are true without a part", async () => {
    const { told } = await meet(new ToolGroups());
    const was = golden(CANVAS_FILE);
    assert.deepEqual(Object.keys(was), ['plain', 'woken']);
    for (const variant of ['plain', 'woken'] as const) {
      assert.ok(told[variant] === was[variant].text, `\nThe canvas-only ${variant} instructions are not what they were, from ${firstDifference(was[variant].text, told[variant])}\n${advice}\n`);
      assert.equal(was[variant].says, was[variant].text.length, 'the golden says its length');
    }
    assert.equal(told.listening, told.woken, 'one that sleeps by `tricot listen` is told as a woken one is');
    assert.equal(read(CANVAS_FILE), goldenText(CANVAS_ABOUT, { plain: was.plain.text, woken: was.woken.text }), 'the file is what writing it gives');
    assert.equal(instructionsFor(new ToolGroups(), false), told.plain);
    assert.equal(instructionsFor(undefined, true), told.woken, 'no registry is the canvas alone too');
  });

  it(`is well under the ${MAX_INSTRUCTIONS} characters clients show: no more than half`, () => {
    for (const woken of [false, true]) assert.ok(instructionsFor(undefined, woken).length <= MAX_INSTRUCTIONS / 2, `${instructionsFor(undefined, woken).length} characters`);
  });

  it('names the tools a canvas alone lists that it was told about, and only ones it lists', async () => {
    const canvas = await meet(new ToolGroups());
    const named = toolsNamedIn(canvas.told.plain, new Set(canvas.tools));
    assert.deepEqual(['list_boards', 'get_board', 'create_board', 'reply_in_thread', 'wait_for_updates', 'get_updates', 'read_guide'].filter((name) => !named.includes(name)), []);
  });
});
