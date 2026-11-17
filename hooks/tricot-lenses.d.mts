// Types for tricot-lenses.mjs, for the TypeScript that imports it
// (src/core/threads.ts, tricot-steps-extension.ts, and the tests).

export interface PresetLens {
  name: string;
  brief?: string;
}

export const LENSES: PresetLens[];

export function lensAsked(text: unknown): { lens: PresetLens } | { unknown: string } | undefined;

export function lensContext(lens: PresetLens | undefined): string | undefined;

export function unknownLensLine(name: string): string;
