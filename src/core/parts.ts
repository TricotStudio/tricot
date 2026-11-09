// Parts of a block that people may ask agents to act on: a Google Doc's
// paragraphs, which its connector pins (core/connectors), and a kind's own
// parts, which it pins: a website's elements (core/blocks/site), a code
// block's lines, a note's words, a diagram's nodes and arrows, boxes on an
// image. People comment on them, and may ask agents to act on them; these are
// the words for that, whichever of the two says them. How any pinned part
// reads and behaves is its hooks' to say too (partHooks), the page's as much
// as the server's: nothing else switches on a part's kind.

import { kindOf, kinds } from './blocks/registry';
import type { PartHooks, PartsHooks, PartWords } from './blocks/kind';
import type { ConnectorAsk } from './connectors/connector';
import { connectorKinds, connectorPinning } from './connectors/registry';
import type { Block, Board } from './types';

// How a pinned part reads and behaves, by its anchor's kind ('spot'): its
// connector's (a Google Doc's paragraph), its block's kind's, or, for a part
// named without its block (or on a block that doesn't have it), the first
// kind's that has it. Undefined for a whole block, and for a kind of part
// no kind has.
export function partHooks(anchorKind: string, block?: Block): PartHooks | undefined {
  const connector = connectorPinning(anchorKind)?.pins;
  if (connector) return connector;
  const name = anchorKind as keyof PartsHooks;
  const own = block && kindOf(block.type).pins?.parts?.[name];
  return (own ?? kinds().find((kind) => kind.pins?.parts?.[name])?.pins?.parts?.[name]) as PartHooks | undefined;
}

// What a kind of part says of itself, by its name ("doc", "site", "code"):
// a comment's askPart, a pairing session's part.
export function partWords(name: string): PartWords | undefined {
  return connectorPinning(name)?.pins ?? kinds().find((kind) => kind.pins?.part?.kind === name)?.pins?.part;
}

// What a block's part pinned with this kind of anchor says of itself: a
// connector's (a Google Doc's paragraph), or its kind's own part, when its
// parts are pinned so ("line" on a code block; not on a diff, whose lines
// take no requests).
export function partOf(block: Block, anchorKind: string): PartWords | undefined {
  const connector = connectorPinning(anchorKind)?.pins;
  if (connector) return connector;
  const part = kindOf(block.type).pins?.part;
  return part && (part.anchors ?? [part.kind]).includes(anchorKind as never) ? part : undefined;
}

// Every kind of part people may ask agents to act on, connectors' first.
function asks(): ConnectorAsk[] {
  const said = [...connectorKinds().map((kind) => kind.pins?.ask), ...kinds().map((kind) => kind.pins?.part?.ask)];
  return said.filter((ask): ask is ConnectorAsk => Boolean(ask));
}

// The words for a request people pinned to a part, by the comment's askPart.
// A comment that doesn't say is on a Google Doc's paragraph: the first kind
// that took requests.
export function askingWords(part?: string): ConnectorAsk | undefined {
  return (part ? partWords(part)?.ask : undefined) ?? asks()[0];
}

// Names as a list of choices: "a, b or c". A name may have an "and" of its own.
const either = (names: string[]) => (names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`);

// Said when a comment on a part agents aren't asked to act on asks them to.
export function askRefusal(): string {
  const what = asks().map((ask) => ask.what);
  return what.length ? `Agents are asked to act only on ${either(what)}; comment on other parts.` : 'No part can be asked of agents; comment on it.';
}

// People's requests pinned to parts, waiting on an agent: named when an agent
// reads the board, catches up or waits.
export function partAsks(board: Board, viewer?: string): string | undefined {
  const lines = [...connectorKinds().map((kind) => kind.agent?.asks?.(board, viewer)), ...kinds().map((kind) => kind.agent.asks?.(board, viewer))];
  const said = lines.filter((line): line is string => Boolean(line));
  return said.length ? said.join('\n') : undefined;
}
