// Areas: the short theme a decision belongs to ("Connectors", "Name and
// mark"), which groups decisions into rows on the decision map. Agents give
// each decision one, reusing the board's names; an area a person set is
// theirs, and agents leave it.

import { samePerson } from './format';
import type { Board, Decision } from './types';

// An area as it is stored: on one line, trimmed. Empty means none.
export function cleanArea(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// The board's areas, the most used first (then by name), with how many
// decisions each holds. Spelled as they were first given.
export function boardAreas(board: Pick<Board, 'decisions'>): { name: string; count: number }[] {
  const areas = new Map<string, { name: string; count: number }>();
  for (const decision of board.decisions) {
    if (!decision.area) continue;
    const key = decision.area.toLowerCase();
    const known = areas.get(key);
    if (known) known.count++;
    else areas.set(key, { name: decision.area, count: 1 });
  }
  return [...areas.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// The board's own spelling of an area, so "connectors" joins "Connectors".
export function knownArea(board: Pick<Board, 'decisions'>, area: string, except?: Decision): string | undefined {
  return board.decisions.find((d) => d !== except && d.area && samePerson(d.area, area))?.area;
}

