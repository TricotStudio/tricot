import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { onConnectorMessage } from '../live';
import { slackApi, type ThreadAnswer } from './api';

// A linked thread's card, looked up through the server (which holds the token
// and keeps Slack's rate limits in mind), shared by everything on the page that
// shows it: its title on the link card, and the card's own details.
const FRESH = 60_000;
const answers = new Map<string, { at: number; answer: ThreadAnswer }>();
const loading = new Map<string, Promise<ThreadAnswer | null>>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

// One look-up at a time per thread: whoever asks while one is under way gets its answer.
export function loadThread(key: string, fresh = false): Promise<ThreadAnswer | null> {
  const known = answers.get(key);
  const under = loading.get(key);
  if (under) return under;
  // A thread that couldn't be shown is asked about again: the person may have just signed in (the server keeps its own short memory).
  if (!fresh && known?.answer.thread && Date.now() - known.at < FRESH) return Promise.resolve(known.answer);
  const lookup = slackApi.thread(key, fresh).then(
    (answer) => {
      answers.set(key, { at: Date.now(), answer });
      return answer;
    },
    () => known?.answer ?? null, // the card stays as it was
  );
  loading.set(key, lookup);
  notify();
  void lookup.finally(() => {
    loading.delete(key);
    notify();
  });
  return lookup;
}

// A new sign-in, or none: what was looked up may be different now.
export function forgetThreads(): void {
  answers.clear();
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

// The card for a key, loaded on mount and again when the page regains focus
// once a minute is up; `refresh` asks again now.
export function useSlackThread(key: string | undefined) {
  const answer = useSyncExternalStore(subscribe, () => (key ? answers.get(key)?.answer : undefined));
  const busy = useSyncExternalStore(subscribe, () => (key ? loading.has(key) : false));
  useEffect(() => {
    if (!key) return;
    void loadThread(key);
    const again = () => void loadThread(key);
    window.addEventListener('focus', again);
    // A sign-in finished in the other tab: what was looked up may be different now.
    const stop = onConnectorMessage((message) => {
      if (message.id !== 'slack') return;
      forgetThreads();
      void loadThread(key);
    });
    return () => {
      window.removeEventListener('focus', again);
      stop();
    };
  }, [key]);
  const refresh = useCallback(() => (key ? loadThread(key, true) : Promise.resolve(null)), [key]);
  return { thread: answer?.thread, problem: answer?.problem, busy, refresh };
}
