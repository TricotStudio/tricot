import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { boardKey, type Board, type BoardEvent } from '../../core/types';
import { api } from '../shared/api';
import { unseenSince } from '../live';

// "Since you were away": what others changed after this viewer last looked,
// so they review the changes instead of rereading the board. Leaving (hiding
// the tab, closing the page, going back to the board list) records the last
// event seen; anything later from someone else is new until the viewer
// opens it or marks everything seen. What is new is read from the server (a
// board carries no events): everything after the cursor, then what each change
// to the board adds.

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
// what needs them across boards (core/needs.ts).
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

export interface Away {
  events: BoardEvent[]; // unseen events from others, oldest first
  isNew: (event: BoardEvent) => boolean;
  decisions: Set<string>; // decisions with unseen changes
  items: Set<string>; // canvas blocks, groups and links with unseen changes
  boardCanvasChanged: boolean;
  sinceAt: string | null; // when the viewer last looked; later comments by others are unread
  markSeen: (id: string) => void;
  markAllSeen: () => void;
}

export function useAway(board: Board | null, name: string): Away {
  const boardId = board ? boardKey(board) : undefined;
  const latest = useRef(0);
  // Tagged with its board, so moving between boards never reuses the cursor.
  const [seen, setSeen] = useState<{ boardId: string; seq: number } | null>(null);
  const since = seen && seen.boardId === boardId ? seen.seq : null;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    latest.current = board?.seq ?? 0;
  }, [board]);

  // First load: start from what the viewer had seen; a first visit has
  // nothing new.
  useEffect(() => {
    if (!board || boardKey(board) !== boardId || since !== null) return;
    setSeen({ boardId, seq: readSeen(boardId) ?? board.seq });
  }, [board, boardId, since]);

  useEffect(() => {
    if (!boardId) return;
    const leave = () => writeSeen(boardId, latest.current);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') return leave();
      setSeen({ boardId, seq: readSeen(boardId) ?? latest.current });
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

  const scope = `${boardId}|${since}|${name}`;
  const [loaded, setLoaded] = useState<{ scope: string; events: BoardEvent[] }>({ scope: '', events: [] });
  const held = useRef(loaded);
  held.current = loaded;
  const seq = board?.seq;
  // The board's event the unseen events held are complete to.
  const covered = useRef({ scope: '', seq: 0 });
  useEffect(() => {
    if (!boardId || since === null || seq === undefined) return;
    let cancelled = false;
    const current = held.current.scope === scope ? held.current.events : [];
    const from = covered.current.scope === scope ? covered.current.seq : since;
    void unseenSince(boardId, name, from, seq)
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
  }, [boardId, since, name, seq, scope]);
  const fromOthers = useMemo(() => (loaded.scope === scope ? loaded.events : []), [loaded, scope]);

  // An event is seen once the thing it is about has been looked at: its
  // decision for decision events, its canvas item for board canvas edits.
  // By seq: the same event is read twice (here, and as the activity panel's page).
  const unseenSeqs = useMemo(() => new Set(fromOthers.map((e) => e.seq)), [fromOthers]);
  const isNew = useCallback(
    (event: BoardEvent) => {
      if (!unseenSeqs.has(event.seq)) return false;
      const subject = event.taskId ?? event.decisionId ?? event.itemId;
      return !subject || !dismissed.has(subject);
    },
    [unseenSeqs, dismissed],
  );

  const events = useMemo(() => fromOthers.filter(isNew), [fromOthers, isNew]);
  // A task's events carry its decision's id too, but opening the decision
  // doesn't see them, so they mark only the task.
  const decisions = useMemo(
    () => new Set(events.flatMap((e) => (e.decisionId && !e.taskId ? [e.decisionId] : []))),
    [events],
  );
  // Items stay marked inside a decision's canvas even after the decision is
  // opened, so the viewer can see which blocks changed.
  const items = useMemo(
    () => new Set(fromOthers.flatMap((e) => (e.itemId && !dismissed.has(e.itemId) ? [e.itemId] : []))),
    [fromOthers, dismissed],
  );
  const boardCanvasChanged = events.some((e) => e.type === 'canvas_changed' && !e.decisionId);
  const createdAt = board?.createdAt;
  const [lookedAt, setLookedAt] = useState<{ scope: string; at: string | null }>({ scope: '', at: null });
  useEffect(() => {
    if (!boardId || since === null || createdAt === undefined) return;
    const asked = `${boardId}|${since}`;
    if (since === 0) return setLookedAt({ scope: asked, at: createdAt });
    let cancelled = false;
    api
      .events(boardId, { since: since - 1, limit: 1 })
      .then((page) => !cancelled && setLookedAt({ scope: asked, at: page.events[0]?.seq === since ? page.events[0].at : null }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [boardId, since, createdAt]);
  const sinceAt = lookedAt.scope === `${boardId}|${since}` ? lookedAt.at : null;

  const markSeen = useCallback((id: string) => {
    setDismissed((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);

  const markAllSeen = useCallback(() => {
    if (!boardId) return;
    writeSeen(boardId, latest.current);
    setSeen({ boardId, seq: latest.current });
    setDismissed(new Set());
  }, [boardId]);

  return { events, isNew, decisions, items, boardCanvasChanged, sinceAt, markSeen, markAllSeen };
}
