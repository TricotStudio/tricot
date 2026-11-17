import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { githubApi, type CardAnswer } from './api';

// A pull request's or issue's card, looked up through the server (which holds
// the token and keeps GitHub's rate limit in mind), shared by everything on
// the page that shows it: its title on the link card, and the card's own details.
const FRESH = 60_000;
const answers = new Map<string, { at: number; answer: CardAnswer }>();
const loading = new Map<string, Promise<CardAnswer | null>>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

// One look-up at a time per card: whoever asks while one is under way gets its answer.
export function loadCard(key: string, fresh = false): Promise<CardAnswer | null> {
  const known = answers.get(key);
  const under = loading.get(key);
  if (under) return under;
  if (!fresh && known && Date.now() - known.at < FRESH) return Promise.resolve(known.answer);
  const lookup = githubApi.card(key, fresh).then(
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
export function forgetCards(): void {
  answers.clear();
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

// The card for a key, loaded on mount and again when the page regains focus
// once a minute is up; `refresh` asks again now.
export function useGithubCard(key: string | undefined) {
  const answer = useSyncExternalStore(subscribe, () => (key ? answers.get(key)?.answer : undefined));
  const busy = useSyncExternalStore(subscribe, () => (key ? loading.has(key) : false));
  useEffect(() => {
    if (!key) return;
    void loadCard(key);
    const again = () => void loadCard(key);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [key]);
  const refresh = useCallback(() => (key ? loadCard(key, true) : Promise.resolve(null)), [key]);
  return { card: answer?.card, problem: answer?.problem, busy, refresh };
}
