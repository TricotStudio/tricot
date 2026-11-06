import { useEffect } from 'react';
import { clip } from '../../core/format';

// The tab's title, so a person with several tabs open can tell them apart:
// "Tricot roadmap · Tricot" on a board, "Connectors · Tricot", and "Tricot"
// on Home. The board's name comes first, because a browser cuts a long title
// from the right. While the tab is in the background it also says what waits
// for the person: "⏸ Claude needs you · Tricot roadmap" when an agent waits
// for their OK (access/approvals.tsx), and "(2) Tricot roadmap · Tricot"
// when agents replied to them (inbox/notify.ts).
//
// Each part is given by what knows it, and the title is made again from all
// of them on every change, never from the title before: a board renamed
// while the tab is in the background shows its new name when the tab comes
// back. The shell writes it (shell/Shell.tsx).

export interface TitleParts {
  page?: string; // the page's own name: a board's, "Connectors"; Home has none
  replies: number; // agents' replies to the person since the tab went to the background
  needsYou: string; // who waits for the person's OK, in words: "⏸ Claude needs you" (core/approvals.ts needsYouTitle)
  hidden: boolean; // the tab is in the background
}

const BRAND = 'Tricot';
// A board's name is clipped past this, so the title still ends with what
// the page is in a window's title or the browser's history.
export const NAME_LIMIT = 60;

export function tabTitle({ page, replies, needsYou, hidden }: TitleParts): string {
  const name = clip(page ?? '', NAME_LIMIT);
  const plain = name ? `${name} · ${BRAND}` : BRAND;
  if (!hidden) return plain;
  // Who needs the person leads, with the page's name after it so they can
  // tell which tab asks; the count of replies stays in front, where tabs
  // usually carry one.
  const lead = needsYou ? (name ? `${needsYou} · ${name}` : needsYou) : plain;
  return replies > 0 ? `(${replies}) ${lead}` : lead;
}

type GivenPart = 'page' | 'replies' | 'needsYou';
const NONE: Pick<TitleParts, GivenPart> = { page: undefined, replies: 0, needsYou: '' };

// The parts as the page holds them, and the title they make.
export class TabTitleStore {
  private parts: TitleParts = { ...NONE, hidden: false };
  private readonly listeners = new Set<() => void>();

  set(change: Partial<TitleParts>): void {
    this.parts = { ...this.parts, ...change };
    for (const listener of this.listeners) listener();
  }

  title = (): string => tabTitle(this.parts);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const tabTitleStore = new TabTitleStore();

// Gives the title a part while the component that calls it is on the page,
// and takes it back when it leaves: a page its name, the inbox its count of
// replies, the approvals who needs the person.
export function useTitlePart<P extends GivenPart>(part: P, value: TitleParts[P]): void {
  useEffect(() => {
    const given: Partial<TitleParts> = {};
    given[part] = value;
    tabTitleStore.set(given);
    return () => {
      const back: Partial<TitleParts> = {};
      back[part] = NONE[part];
      tabTitleStore.set(back);
    };
  }, [part, value]);
}
