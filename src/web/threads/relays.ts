import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { askedWhileWaiting, homeRelays, type Relay as HomeRelay, type RelayKind } from '../../core/homeConversation';
import { boardKey, type Board } from '../../core/types';
import { outbox } from '../conversation';
import type { WorkRelay } from '../shared/boardViews';
import { useBoardViews } from '../shared/boardViewsContext';
import { go } from '../shared/pages';

// Relays: what of the work a coordinator handed out needs the viewer, brought
// into Home's conversation (timeline.tsx) so they can stay there. Which they
// are is Home's conversation's (core/homeConversation.ts homeRelays, which the
// terminal's chat relays from too): an agent's question to the viewer, a
// thread done with its summary, and what a part relays of its cards through
// Work's slot (shared/boardViews.ts WorkSlot.relays: a card blocked). Here
// each gets what opens it, and the questions relayed while their thread waited
// on a person are remembered, per board in this browser, as a thread that
// moves on says nothing of them: they stay in the conversation as answered
// rather than go.

export type { RelayKind };

// A relay, with what opens it: its thread in the main pane, or the part's card.
export type Relay = HomeRelay<WorkRelay> & { open(): void };

const KEY = 'tricot:relayed:';
const KEEP = 200;

function remembered(board: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY + board) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function remember(board: string, ids: readonly string[]): void {
  try {
    const kept = [...remembered(board)];
    const more = ids.filter((id) => !kept.includes(id));
    if (more.length) localStorage.setItem(KEY + board, JSON.stringify([...kept, ...more].slice(-KEEP)));
  } catch {
    // Not kept: a question answered once its thread moved on goes from the conversation.
  }
}

// Every relay on the board, oldest first: the threads agents own, with what the viewer is sending in each, and what a
// part relays of its cards.
export function useRelays(board: Board, name: string, agents: readonly { name: string; state: string }[]): Relay[] {
  const part = useBoardViews().work();
  const all = useSyncExternalStore(outbox.subscribe, outbox.get);
  const key = boardKey(board);
  const relays = useMemo(
    () =>
      homeRelays(board, name, agents, remembered(key), (thread) => all.filter((o) => o.place === `thread:${thread.id}` && o.state !== 'failed'), part?.relays?.({ board, name }) ?? []).map(
        (relay): Relay => ({ ...relay, open: relay.card ? relay.card.open : () => go.timeline(board.id, relay.thread!.id) }),
      ),
    [board, name, agents, all, part, key],
  );
  // A question asked while its thread waits on a person, remembered so it stays once the thread moves on.
  const waiting = askedWhileWaiting(relays).join();
  useEffect(() => {
    if (waiting) remember(key, waiting.split(','));
  }, [key, waiting]);
  return relays;
}
