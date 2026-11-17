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

// Goose's and Hermes's hook events, read as Claude Code's
// (https://goose-docs.ai/docs/guides/context-engineering/hooks,
// https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks).
export const GOOSE_LONG_TOOLS: string[];
export function isGooseEvent(event: unknown): boolean;
export function fromGoose(event: unknown): Record<string, unknown> | undefined;
export const HERMES_LONG_TOOLS: string[];
export function isHermesEvent(event: unknown): boolean;
export function fromHermes(event: unknown): Record<string, unknown> | undefined;

// Grok Build's hook events, read as Claude Code's (the hooks guide in github.com/xai-org/grok-build).
export const GROK_LONG_TOOLS: string[];
export function isGrokEvent(event: unknown): boolean;
export function fromGrok(event: unknown): Record<string, unknown> | undefined;

// Copilot CLI's hook events, read as Claude Code's (docs.github.com/copilot/reference/hooks-reference):
// its hook's command says --copilot, as its events can't be told from Claude Code's by their fields.
export const COPILOT_LONG_TOOLS: string[];
export function fromCopilot(event: unknown): Record<string, unknown> | undefined;
