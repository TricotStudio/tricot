import { BoardError } from '../../store/errors';

// A chart highlights a category, by its text; only a code block's highlight
// is line numbers, which a chart refuses.
export function chartHighlight(highlight: unknown): string | undefined {
  if (Array.isArray(highlight)) throw new BoardError("A chart's highlight is a category: send its first-column value as text.");
  return highlight as string | undefined;
}
