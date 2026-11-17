import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { eventCardId } from '../../core/cards';
import { eventMatches } from '../../core/changes';
import { pageWith } from '../../core/scratchPad';
import { boardKey, type Board, type BoardEvent } from '../../core/types';
import { api } from '../shared/api';
import type { Away } from '../shared/boardHost';
import { eventSubject } from '../shared/cardKinds';
import { allSince } from './events';

// "Since you were away": what others changed after this viewer last looked,
// so they review the changes instead of rereading the board. Leaving (hiding
// the tab, closing the page, going back to the board list) records the last
// event seen; anything later from someone else is new until the viewer
// opens it or marks everything seen. What is new is read from the server (a
// board carries no events): everything after the cursor, then what each change
// to the board adds.
//
// A visit is the viewer looking at the board in this tab, from opening it
// until they leave it for longer than VISIT_GAP_MS: the tab hidden, the
// board left for another page, the page reloaded or closed. A shorter look
// away is part of it. What others changed since the viewer was last here, as
// the visit began, holds for all of it, so a view of "Since you were last
// here" keeps its list while they work through it
// (opening a card, the tab hidden for a moment), and moves on at the next
// visit. What happens while they look joins it as it comes, and nothing in it
// goes: a card they answer or reopen themselves stays, in the group it is in
// now. The new dots go as they always did. The visit's start is kept for the
// tab (sessionStorage), so a reload is part of it too.

// Keyed by boardKey, so what the viewer has seen survives the board being renamed.
const PREFIX = 'tricot:seen:';
const key = (boardId: string) => `${PREFIX}${boardId}`;

function readSeen(boardId: string): number | null {
  try {
    const stored = localStorage.getItem(key(boardId));
    return stored === null ? null : Number(stored);
  } catch {
    return null;
  }
}

// What the viewer last saw on every board they opened here, by board key, for
// what needs them across boards.
export function seenEverywhere(): Record<string, number> {
  const seen: Record<string, number> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const stored = localStorage.key(i);
      if (!stored?.startsWith(PREFIX)) continue;
      const seq = Number(localStorage.getItem(stored));
      if (Number.isInteger(seq) && seq >= 0) seen[stored.slice(PREFIX.length)] = seq;
    }
  } catch {
    // Nothing remembered: every board reads as seen, as on a first visit.
  }
  return seen;
}

// Lets go of what was remembered of a board that is deleted.
export function forgetSeen(boardKey: string): void {
  try {
    localStorage.removeItem(key(boardKey));
  } catch {
    // Not remembered anyway.
  }
}

function writeSeen(boardId: string, seq: number): void {
  try {
    localStorage.setItem(key(boardId), String(seq));
  } catch {
    // Not remembered; the viewer will see everything as seen next time.
  }
}

const VISIT_GAP_MS = 30 * 60_000;
const visitKey = (boardId: string) => `tricot:visit:${boardId}`;

// Where this tab's visit began (the last event seen then), and when the
// viewer last left it, if they have.
interface VisitMark {
  seq: number;
  leftAt?: number;
}

function readVisit(boardId: string): VisitMark | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(visitKey(boardId)) ?? 'null') as VisitMark | null;
    return stored && Number.isInteger(stored.seq) ? stored : null;
  } catch {
    return null;
  }
}

function writeVisit(boardId: string, mark: VisitMark): void {
  try {
    sessionStorage.setItem(visitKey(boardId), JSON.stringify(mark));
  } catch {
    // Not kept: a reload starts a new visit.
  }
}

// Where the visit the viewer is on now begins, coming to the board having
// seen up to `seen`: where this tab's began, if they left it lately, or else
// here, a new one.
function visitFrom(boardId: string, seen: number): number {
  const kept = readVisit(boardId);
  const going = kept && (kept.leftAt === undefined || Date.now() - kept.leftAt < VISIT_GAP_MS);
  const seq = going ? Math.min(kept.seq, seen) : seen;
  writeVisit(boardId, { seq });
  return seq;
}

// The viewer leaves the board: when, so coming back soon goes on with the visit.
function leaveVisit(boardId: string): void {
  const kept = readVisit(boardId);
  if (kept) writeVisit(boardId, { seq: kept.seq, leftAt: Date.now() });
}

export function useAway(board: Board | null, name: string): Away {
  const boardId = board ? boardKey(board) : undefined;
  const latest = useRef(0);
  // Tagged with its board, so moving between boards never reuses the cursor.
  const [seen, setSeen] = useState<{ boardId: string; seq: number } | null>(null);
  const since = seen && seen.boardId === boardId ? seen.seq : null;
  // Where the visit began: at or before `since`, which moves on each return.
  const [visit, setVisit] = useState<{ boardId: string; seq: number } | null>(null);
  const visitSeq = visit && visit.boardId === boardId ? visit.seq : null;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    latest.current = board?.seq ?? 0;
  }, [board]);

  // First load: start from what the viewer had seen; a first visit has
  // nothing new.
  useEffect(() => {
    if (!board || boardKey(board) !== boardId || since !== null) return;
    const seq = readSeen(boardId) ?? board.seq;
    setSeen({ boardId, seq });
    setVisit({ boardId, seq: visitFrom(boardId, seq) });
  }, [board, boardId, since]);

  useEffect(() => {
    if (!boardId) return;
    const leave = () => {
      writeSeen(boardId, latest.current);
      leaveVisit(boardId);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') return leave();
      const seq = readSeen(boardId) ?? latest.current;
      setSeen({ boardId, seq });
      setVisit({ boardId, seq: visitFrom(boardId, seq) });
      setDismissed(new Set());
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', leave);
    return () => {
      leave();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', leave);
    };
  }, [boardId]);

  // Everything logged since the visit began, the viewer's own doing too: what
  // others changed is what is new, and what the viewer did goes on the story
  // of the card it touched, so a card they answer or reopen keeps its line
  // in the group it is in now. Loaded
  // from where the visit began, which holds while `since` moves on, so the
  // viewer's return asks for nothing again.
  const scope = `${boardId}|${visitSeq}`;
  const [loaded, setLoaded] = useState<{ scope: string; events: BoardEvent[] }>({ scope: '', events: [] });
  const held = useRef(loaded);
  held.current = loaded;
  const seq = board?.seq;
  // The board's event the events held are complete to.
  const covered = useRef({ scope: '', seq: 0 });
  useEffect(() => {
    if (!boardId || visitSeq === null || seq === undefined) return;
    let cancelled = false;
    const current = held.current.scope === scope ? held.current.events : [];
    const from = covered.current.scope === scope ? covered.current.seq : visitSeq;
    void allSince(boardId, from, seq)
      .then((found) => {
        if (cancelled) return;
        covered.current = { scope, seq };
        const fresh = found.filter((event) => event.seq > (current.at(-1)?.seq ?? 0));
        if (fresh.length || held.current.scope !== scope) setLoaded({ scope, events: [...current, ...fresh] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [boardId, visitSeq, seq, scope]);
  const sinceVisit = useMemo(() => (loaded.scope === scope ? loaded.events : []), [loaded, scope]);
  // What others changed: the news, as the server reads it for a reload (unseenBy).
  const fromOthers = useMemo(
    () => (since === null ? [] : sinceVisit.filter((e) => e.seq > since && eventMatches(e, { unseenBy: name }))),
    [sinceVisit, since, name],
  );

  // An event is seen once the thing it is about has been looked at: its
  // decision for decision events, its canvas item for board canvas edits.
  // By seq: the same event is read twice (here, and as the page of changes).
  const unseenSeqs = useMemo(() => new Set(fromOthers.map((e) => e.seq)), [fromOthers]);
  const isNew = useCallback(
    (event: BoardEvent) => {
      if (!unseenSeqs.has(event.seq)) return false;
      const subject = eventSubject(event)?.id ?? event.itemId;
      return !subject || !dismissed.has(subject);
    },
    [unseenSeqs, dismissed],
  );

  const events = useMemo(() => fromOthers.filter(isNew), [fromOthers, isNew]);
  // A task's events carry its decision's id too, but opening the decision
  // doesn't see them, so they mark only the task: `decisions` holds the ids of
  // events about a decision alone, which is what Away says of it.
  const decisions = useMemo(
    () =>
      new Set(
        events.flatMap((e) => {
          const decision = eventCardId(e, 'decision');
          return decision && !eventCardId(e, 'task') ? [decision] : [];
        }),
      ),
    [events],
  );
  // Items stay marked inside a decision's canvas even after the decision is
  // opened, so the viewer can see which blocks changed.
  const items = useMemo(
    () => new Set(fromOthers.flatMap((e) => (e.itemId && !dismissed.has(e.itemId) ? [e.itemId] : []))),
    [fromOthers, dismissed],
  );
  // The Sketchbook's pages with unseen changes, for a dot on the Sketchbook's tab and on each page in its Pages menu.
  const pagesChanged = useMemo(() => {
    const changed = new Set<string>();
    for (const e of events) {
      const page = board && e.type === 'canvas_changed' && e.itemId ? pageWith(board, e.itemId) : undefined;
      if (page) changed.add(page.id);
    }
    return changed;
  }, [events, board]);
  const boardCanvasChanged = events.some((e) => e.type === 'canvas_changed' && !eventCardId(e, 'decision') && !(board && e.itemId && pageWith(board, e.itemId)));
  const createdAt = board?.createdAt;
  const sinceAt = useLookedAt(boardId, since, createdAt);
  // The same for where the visit began, asked only when it isn't `since`.
  const visitLookedAt = useLookedAt(boardId, visitSeq === since ? null : visitSeq, createdAt);
  const visitAt = visitSeq === since ? sinceAt : visitLookedAt;
  const visitNow = useMemo(() => ({ events: sinceVisit, sinceAt: visitAt }), [sinceVisit, visitAt]);

  const markSeen = useCallback((id: string) => {
    setDismissed((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);

  const markAllSeen = useCallback(() => {
    if (!boardId) return;
    writeSeen(boardId, latest.current);
    setSeen({ boardId, seq: latest.current });
    setDismissed(new Set());
  }, [boardId]);

  return { events, isNew, decisions, items, boardCanvasChanged, pagesChanged, sinceAt, visit: visitNow, markSeen, markAllSeen };
}

// When the viewer last looked, as of event `seq`: when that event was logged,
// or the board made for none. Null until known, or for no `seq`.
function useLookedAt(boardId: string | undefined, seq: number | null, createdAt: string | undefined): string | null {
  const [lookedAt, setLookedAt] = useState<{ scope: string; at: string | null }>({ scope: '', at: null });
  useEffect(() => {
    if (!boardId || seq === null || createdAt === undefined) return;
    const asked = `${boardId}|${seq}`;
    if (seq === 0) return setLookedAt({ scope: asked, at: createdAt });
    let cancelled = false;
    api
      .events(boardId, { since: seq - 1, limit: 1 })
      .then((page) => !cancelled && setLookedAt({ scope: asked, at: page.events[0]?.seq === seq ? page.events[0].at : null }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [boardId, seq, createdAt]);
  return lookedAt.scope === `${boardId}|${seq}` ? lookedAt.at : null;
}
