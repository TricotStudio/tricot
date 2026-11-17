// People's requests on a kind's own parts (core/parts.ts), said to the agent
// who'll act on them, as a website's are (site/agent.ts) and a Google Doc's
// paragraphs (connectors/google/agent.ts): who asked, what they pointed at,
// what to change and with which tool, and how to answer. Each kind that takes
// requests says the middle of it (code, note, diagram, image); this says the
// rest, and lists them for get_board and an agent's updates. Server-only:
// the kinds' server.ts files use it.

import { waitsOnAgent } from '../digest';
import { clip, listNames, samePerson } from '../format';
import { agentsIn } from '../mentions';
import { partOf } from '../parts';
import { canvasesOf, canvasName, pinAsk, pinComments, placePin, type OwnedCanvas } from '../pins';
import type { Block, Board, Comment, Pin } from '../types';
import type { PartWords } from './kind';

// A request on a part, as a kind phrases it.
export interface AskedPart {
  pin: Pin;
  block: Block;
  owned: OwnedCanvas;
}

// How a kind says a request on one of its parts: what was pointed at, in
// which block ("line 12 ("const total = 0") of the code block "src/cart.ts""),
// and how to make the change ("Change the block's text with update_block
// (block_id: …)"), ending without a full stop.
export interface AskWords {
  part(asked: AskedPart): string;
  how(asked: AskedPart): string;
  view: string; // what reloads in people's view: "the code"
}

// The block as a request names it: the code block "src/cart.ts" [block id: …],
// by its path, its title, or an image's caption.
export function blockNamed(block: Block, word: string): string {
  const name = block.type === 'code' ? block.path : block.title || (block.type === 'image' ? block.caption : undefined);
  return `the ${word}${name ? ` "${clip(name, 60)}"` : ''} [block id: ${block.id}]`;
}

// One request, said to the agent: who asked what, of which part, how to make
// the change, and how to answer. A part that is no longer there (its words
// changed since) is said so, as a doc's paragraph is.
export function askLine(asked: AskedPart, comments: Comment[], part: PartWords, words: AskWords): string {
  const { owned, pin } = asked;
  const ask = pinAsk(comments)!;
  const where = owned.task || owned.decision ? `, on ${canvasName(owned)}` : '';
  const latest = comments.findLast((c) => c.author.kind === 'human');
  const then = latest && latest !== ask ? `; then: "${clip(latest.body, 300)}"` : '';
  const said = `"${clip(ask.body, 500)}"${then}`;
  const asking = `${ask.author.name} asked you to ${part.ask?.verb ?? 'change'} ${words.part(asked)}${where}`;
  const reply = `reply in the thread with comment (pin_id: ${pin.id})`;
  if (!placePin(asked.block, pin)) return `${asking}, which is no longer there as pinned: ${said}. Read the block with get_block, then ${reply}.`;
  return `${asking}: ${said}. ${words.how(asked)}, then ${reply}; people's view of ${words.view} reloads by itself.`;
}

// The requests on a kind's part that wait on an agent, for get_board and an
// agent's updates, until one replies. One that @-mentions other agents than
// the one reading it is theirs.
export function partAsksDigest(part: PartWords, words: AskWords) {
  return (board: Board, viewer?: string): string | undefined => {
    const asks = canvasesOf(board).flatMap((owned) =>
      owned.canvas.pins.flatMap((pin) => {
        if (!pin.discussion) return [];
        const block = owned.canvas.blocks.find((b) => b.id === pin.blockId);
        if (!block || partOf(block, pin.anchor.kind) !== part) return [];
        const comments = pinComments(pin, owned);
        return pinAsk(comments) && waitsOnAgent(pin, comments) ? [{ asked: { owned, pin, block }, comments }] : [];
      }),
    );
    if (asks.length === 0) return undefined;
    return asks
      .map(({ asked, comments }) => {
        const line = askLine(asked, comments, part, words);
        const agents = agentsIn(board, pinAsk(comments)!.mentions);
        if (agents.length === 0 || (viewer && agents.some((a) => samePerson(a, viewer)))) return line;
        return `${line} For ${listNames(agents)}${viewer ? ': not for you; carry on.' : ' only.'}`;
      })
      .join('\n');
  };
}
