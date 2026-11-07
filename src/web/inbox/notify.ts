import { useCallback, useEffect, useRef, useState } from 'react';
import { needsInput } from '../../core/attention';
import { newRepliesTo } from '../../core/delivery';
import { clip } from '../../core/format';
import { boardKey, type Board } from '../../core/types';
import { eventsSince } from '../live';
import { notificationsSupported, notificationsWanted, rememberNotifications, ring, turnOnNotifications, unlockAudio } from '../shared/notifications';
import { useTitlePart } from '../shared/tabTitle';
import { eventTarget } from './place';

// A board's notifications: what needs the viewer's input, while they're
// looking somewhere else (the switch and the chime: shared/notifications.ts).

export interface Notifications {
  supported: boolean;
  blocked: boolean; // denied in the browser's site settings
  enabled: boolean;
  enable: () => void;
  disable: () => void;
}

export function useNotifications(board: Board | null, name: string): Notifications {
  const [permission, setPermission] = useState<NotificationPermission | null>(notificationsSupported ? Notification.permission : null);
  const [wanted, setWanted] = useState(notificationsWanted);
  const enabled = wanted && permission === 'granted';
  const last = useRef<{ boardId: string; seq: number } | null>(null);
  const shown = useRef(board); // the board as it is now, for a click on a notification
  shown.current = board;

  // After a reload, the first click anywhere re-arms the sound.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    return () => window.removeEventListener('pointerdown', unlockAudio);
  }, [enabled]);

  useEffect(() => {
    if (!board) return;
    const previous = last.current;
    last.current = { boardId: boardKey(board), seq: board.seq };
    if (!previous || previous.boardId !== boardKey(board) || !enabled) return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;

    // What was logged since is read from the server: the board carries no events.
    void eventsSince(boardKey(board), previous.seq, board.seq, 100)
      .then((events) => {
        const fresh = events.filter((e) => needsInput(e, board, name));
        if (fresh.length === 0) return;
        for (const event of fresh.slice(-3)) {
          const notification = new Notification(board.title, {
            body: clip(`${event.actor.name} ${event.summary}`, 180),
            // One per decision: a newer one about it takes the older one's
            // place. A task's names the task's decision too, but is its own.
            tag: event.decisionId && !event.taskId ? event.decisionId : String(event.seq),
          });
          // A click brings the tab forward on what it was about, where the
          // Activity log and the inbox lead (place.ts), as the board is by
          // then: about a card or thread deleted since, it only comes forward.
          notification.onclick = () => {
            window.focus();
            const now = shown.current && boardKey(shown.current) === boardKey(board) ? shown.current : board;
            eventTarget(now, event)?.();
            notification.close();
          };
        }
        ring();
      })
      .catch(() => {});
  }, [board, enabled, name]);

  const enable = useCallback(() => {
    if (!notificationsSupported) return;
    void turnOnNotifications().then((on) => {
      setPermission(Notification.permission);
      setWanted(on);
    });
  }, []);

  const disable = useCallback(() => {
    setWanted(false);
    rememberNotifications(false);
  }, []);

  return { supported: notificationsSupported, blocked: permission === 'denied', enabled, enable, disable };
}

// While the tab is hidden, agents' replies to this person's messages count on
// the tab's title, "(1) Tricot roadmap · Tricot" (shared/tabTitle.ts), so they
// see a reply landed from another tab; looking at the tab again clears it. It
// makes no sound: the notifications above, when they turned them on, already
// ring for a reply to them, which needs them (core/attention.ts).
export function useReplyBadge(board: Board | null, name: string): void {
  const previous = useRef<Board | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const before = previous.current;
    previous.current = board;
    if (!board || !before || boardKey(before) !== boardKey(board) || document.visibilityState !== 'hidden') return;
    const fresh = newRepliesTo(name, before, board);
    if (fresh > 0) setCount((count) => count + fresh);
  }, [board, name]);

  useEffect(() => {
    const clear = () => document.visibilityState === 'visible' && setCount(0);
    document.addEventListener('visibilitychange', clear);
    return () => document.removeEventListener('visibilitychange', clear);
  }, []);

  useTitlePart('replies', count);
}
