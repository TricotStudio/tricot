// Types for tricot-describe.mjs, for the TypeScript that imports it (the Pi
// and OMP extension, and the tests). The fields are those POST
// /api/agents/:name/steps reads (StepInput in src/server/steps.ts), less `at`,
// which the sender adds.

export interface HookStep {
  text: string;
  session?: string;
  worker?: string;
  role?: string;
  task?: string;
  decision?: string;
  thread?: string;
  done?: boolean;
  running?: boolean;
  ended?: boolean;
  tool?: string;
  ms?: number;
  narration?: boolean;
}

export function describe(event: unknown, options?: { narration?: boolean }): HookStep | undefined;

// Gemini CLI's hook events, read as Claude Code's (https://geminicli.com/docs/hooks/reference/).
export const GEMINI_LONG_TOOLS: string[];
export function isGeminiEvent(event: unknown): boolean;
export function fromGemini(event: unknown): Record<string, unknown> | undefined;
