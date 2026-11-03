import { useCallback, useEffect, useRef, useState } from 'react';
import { needsInput } from '../core/attention';
import { newRepliesTo } from '../core/delivery';
import { clip } from '../core/format';
import { boardKey, type Board } from '../core/types';
import { eventsSince } from './events';
import { go } from './hooks';

// Opt-in desktop notifications and a soft chime for things that need the
// viewer's input, only while they're looking somewhere else.

const KEY = 'tricot:notify';
const SUPPORTED = typeof window !== 'undefined' && 'Notification' in window;

let audio: AudioContext | null = null;

// Browsers only let audio start after a click on the page, so the context is
// created (or resumed) from one.
function unlockAudio(): void {
  audio ??= new AudioContext();
  void audio.resume();
}

function chime(): void {
  if (!audio) return;
  const start = audio.currentTime;
  [659.25, 880].forEach((frequency, i) => {
    const oscillator = audio!.createOscillator();
    const gain = audio!.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    const at = start + i * 0.14;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.08, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    oscillator.connect(gain).connect(audio!.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.4);
  });
}

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function store(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Not remembered; fine.
  }
}

export interface Notifications {
  supported: boolean;
  blocked: boolean; // denied in the browser's site settings
  enabled: boolean;
  enable: () => void;
  disable: () => void;
}

export function useNotifications(board: Board | null, name: string): Notifications {
  const [permission, setPermission] = useState<NotificationPermission | null>(SUPPORTED ? Notification.permission : null);
  const [wanted, setWanted] = useState(stored);
  const enabled = wanted && permission === 'granted';
  const last = useRef<{ boardId: string; seq: number } | null>(null);

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
          const decision = event.decisionId ? board.decisions.find((d) => d.id === event.decisionId) : undefined;
          const notification = new Notification(board.title, {
            body: clip(`${event.actor.name} ${event.summary}`, 180),
            tag: event.decisionId ?? String(event.seq),
          });
          notification.onclick = () => {
            window.focus();
            if (decision) go.decision(board.id, decision.id);
            notification.close();
          };
        }
        chime();
      })
      .catch(() => {});
  }, [board, enabled, name]);

  const enable = useCallback(() => {
    if (!SUPPORTED) return;
    unlockAudio();
    const ask = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    void ask.then((result) => {
      setPermission(result);
      const on = result === 'granted';
      setWanted(on);
      store(on);
      if (on) chime(); // so the viewer knows what it sounds like
    });
  }, []);

  const disable = useCallback(() => {
    setWanted(false);
    store(false);
  }, []);

  return { supported: SUPPORTED, blocked: permission === 'denied', enabled, enable, disable };
}

// While the tab is hidden, agents' replies to this person's messages count on
// the tab's title, "(1) Tricot", so they see a reply landed from another tab;
// looking at the tab again clears it. It makes no sound: the chime above, when
// they turned it on, already rings for a reply to them, which needs them
// (core/attention.ts).
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

  useEffect(() => {
    if (count === 0) return;
    const title = document.title;
    document.title = `(${count}) ${title}`;
    return () => {
      document.title = title;
    };
  }, [count]);
}
