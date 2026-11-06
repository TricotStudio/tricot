import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { onConnectorMessage } from '../live';
import { linearApi, type CardAnswer } from './api';

// An issue's card, looked up through the server (which holds the token and
// keeps Linear's rate limit in mind), shared by everything on the page that
// shows it: its title on the link card, and the card's own details.
const FRESH = 60_000;
const answers = new Map<string, { at: number; answer: CardAnswer }>();
const loading = new Map<string, Promise<CardAnswer | null>>();
const listeners = new Set<() => void>();
let hearing = false;

const notify = () => listeners.forEach((listener) => listener());

// A new sign-in, or none: what was looked up may be different now.
export function forgetCards(): void {
  answers.clear();
  notify();
}

// One look-up at a time per issue: whoever asks while one is under way gets its answer.
export function loadCard(identifier: string, fresh = false): Promise<CardAnswer | null> {
  if (!hearing) {
    hearing = true;
    onConnectorMessage(forgetCards); // for as long as the page lives: a sign-in in another tab changes every card
  }
  const known = answers.get(identifier);
  const under = loading.get(identifier);
  if (under) return under;
  if (!fresh && known && Date.now() - known.at < FRESH) return Promise.resolve(known.answer);
  const lookup = linearApi.card(identifier, fresh).then(
    (answer) => {
      answers.set(identifier, { at: Date.now(), answer });
      return answer;
    },
    () => known?.answer ?? null, // the card stays as it was
  );
  loading.set(identifier, lookup);
  notify();
  void lookup.finally(() => {
    loading.delete(identifier);
    notify();
  });
  return lookup;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

// The card for an identifier, loaded on mount and again when the page regains
// focus once a minute is up; `refresh` asks again now.
export function useLinearCard(identifier: string | undefined) {
  const answer = useSyncExternalStore(subscribe, () => (identifier ? answers.get(identifier)?.answer : undefined));
  const busy = useSyncExternalStore(subscribe, () => (identifier ? loading.has(identifier) : false));
  useEffect(() => {
    if (!identifier) return;
    void loadCard(identifier);
    const again = () => void loadCard(identifier);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [identifier]);
  const refresh = useCallback(() => (identifier ? loadCard(identifier, true) : Promise.resolve(null)), [identifier]);
  return { card: answer?.card, problem: answer?.problem, busy, refresh };
}
