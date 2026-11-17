import { useEffect, useState } from 'react';
import type { ConnectorStatus } from '../../../core/connectors';
import type { Block } from '../../../core/types';
import { figmaRoutes } from '../../../core/connectors/figma/routes';
import { get, post } from '../../shared/api';
import { forgetFiles } from '../live';

// Figma's calls to the server: its routes (core/connectors/figma/routes.ts), served
// by server/connectors/figma/routes.ts.

// What a link card shows of a file or frame.
export interface FigmaCard {
  name: string;
  fileName: string;
  frame: boolean;
  modifiedTime?: string;
  thumbnail?: string; // an asset id
}

// The card, or why there isn't one: not_connected, needs_sign_in, no_access, rate_limited…
export interface CardAnswer {
  file: FigmaCard | null;
  problem?: { code: string; message: string };
}

const FRESH = 20_000;
const answers = new Map<string, { at: number; answer: Promise<CardAnswer> }>();
const listeners = new Set<() => void>();

// What was looked up may be wrong now: Figma was connected or disconnected.
export function forgetFigma(): void {
  answers.clear();
  forgetFiles();
  for (const listener of listeners) listener();
}

export const figmaApi = {
  // A link card's name and thumbnail. Asked again after a few seconds; the server keeps it longer.
  card(fileId: string): Promise<CardAnswer> {
    const known = answers.get(fileId);
    if (known && Date.now() - known.at < FRESH) return known.answer;
    const answer = get(figmaRoutes.file)<CardAnswer>({ fileId });
    answers.set(fileId, { at: Date.now(), answer });
    answer.catch(() => answers.delete(fileId));
    return answer;
  },

  // A token pasted: checked with Figma and kept, or why not.
  connect: (token: string) => post(figmaRoutes.token)<{ connector: ConnectorStatus }>({ token }),

  // "Bring in this frame", from the link card's block; "Refresh", on an image brought in.
  bringIn: (blockId: string, actor: string) => post(figmaRoutes.bringIn)<{ block: Block }>({ actor, blockId }),
  refresh: (blockId: string, actor: string) => post(figmaRoutes.refresh)<{ block: Block; changed: boolean }>({ actor }, { blockId }),
};

// A link's card, looked up through the server: null while it loads.
export function useFigmaCard(fileId: string | undefined): CardAnswer | null {
  const [shown, setShown] = useState<{ fileId: string; answer: CardAnswer } | null>(null);
  useEffect(() => {
    if (!fileId) return;
    let live = true;
    const load = () => {
      figmaApi.card(fileId).then(
        (answer) => live && setShown({ fileId, answer }),
        (e: Error) => live && setShown({ fileId, answer: { file: null, problem: { code: 'error', message: e.message } } }),
      );
    };
    load();
    listeners.add(load);
    window.addEventListener('focus', load);
    return () => {
      live = false;
      listeners.delete(load);
      window.removeEventListener('focus', load);
    };
  }, [fileId]);
  return shown && shown.fileId === fileId ? shown.answer : null;
}
