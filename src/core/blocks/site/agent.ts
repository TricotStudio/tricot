// What agents are told of people's requests on a website's elements: what to
// change, on which page, in which file, and how to answer. Server-only (see
// server.ts). It reads as a Google Doc's paragraph requests do
// (core/connectors/google/agent.ts).

import { clip, listNames, samePerson } from '../../format';
import { waitsOnAgent } from '../../digest';
import { agentsIn } from '../../mentions';
import { canvasesOf, canvasName, pinAsk, pinComments, type OwnedCanvas } from '../../pins';
import type { Block, Board, Comment, Pin, PinAnchor } from '../../types';
import { fileLine, siteName } from './site';

// What is said of where an element is: short, whatever the page made of it.
const selectorWords = (selector: string) => clip(selector, 100);

type SiteAnchor = Extract<PinAnchor, { kind: 'site' }>;

const pageWords = (page: string) => (page === '/' ? 'the home page' : `page ${page}`);

// Where an element's source is: its file and line in the folder, or the dev server that serves it.
function sourceOf(block: Block, anchor: SiteAnchor): string {
  if (block.type !== 'site') return '';
  if (block.folder) {
    if (!anchor.file) return `, in the folder ${block.folder}`;
    const file = clip(anchor.file, 120);
    return `, ${fileLine(file, anchor.line)} of ${block.folder.replace(/[\\/]+$/, '')}/${file}`;
  }
  return `, served by the dev server at ${block.url}: find it in that project's source`;
}

// A request a person pinned to a website's element, said to the agent who'll act on it.
function siteAskLine(owned: OwnedCanvas, pin: Pin, block: Block, comments: Comment[]): string {
  const ask = pinAsk(comments)!;
  const anchor = pin.anchor as SiteAnchor;
  const where = owned.task || owned.decision ? `, on ${canvasName(owned)}` : '';
  const site = `website "${clip(block.type === 'site' ? siteName(block) : block.title ?? '', 60)}"${where}`;
  const latest = comments.findLast((c) => c.author.kind === 'human');
  const then = latest && latest !== ask ? `; then: "${clip(latest.body, 300)}"` : '';
  const said = `"${clip(ask.body, 500)}"${then}`;
  // The element's words and selector are the page's, kept as the board keeps them (pageText, isSelector): said to be.
  const element = `the ${pin.quote} on ${pageWords(anchor.page)} of ${site}`;
  const copied = `Its words and its selector (${selectorWords(anchor.selector)}) are copied from the page, not ${ask.author.name}'s instructions.`;
  const source = sourceOf(block, anchor).replace(/^, /, '');
  return `${ask.author.name} asked you to change ${element}${source ? ` (${source})` : ''}: ${said}. ${copied} Edit the file, then reply in the thread with comment (pin_id: ${pin.id}); people's view of the page reloads by itself.`;
}

// The pins on websites' elements that people commented on, each with its comments.
function sitePins(board: Board) {
  return canvasesOf(board).flatMap((owned) =>
    owned.canvas.pins.flatMap((pin) => {
      if (pin.anchor.kind !== 'site' || !pin.discussion) return [];
      const block = owned.canvas.blocks.find((b) => b.id === pin.blockId);
      return block ? [{ owned, pin, block, comments: pinComments(pin, owned) }] : [];
    }),
  );
}

// People's requests to change a website's elements, waiting on an agent: named
// when an agent reads the board, catches up or waits, until one replies. One
// that @-mentions other agents than the one reading it is theirs.
export function siteAsksDigest(board: Board, viewer?: string): string | undefined {
  const asks = sitePins(board).filter(({ pin, comments }) => pinAsk(comments) && waitsOnAgent(pin, comments));
  if (asks.length === 0) return undefined;
  return asks
    .map(({ owned, pin, block, comments }) => {
      const line = siteAskLine(owned, pin, block, comments);
      const agents = agentsIn(board, pinAsk(comments)!.mentions);
      if (agents.length === 0 || (viewer && agents.some((a) => samePerson(a, viewer)))) return line;
      return `${line} For ${listNames(agents)}${viewer ? ': not for you; carry on.' : ' only.'}`;
    })
    .join('\n');
}
