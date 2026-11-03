// Live steps for every agent: what the rest of the app asks of the hook
// installers. What one is lives in installer.ts, the agents in registry.ts,
// and turning them on or off for the person in liveSteps.ts.

export type { HookChange, HookDetection, HookInstaller, HookOutcome, HookPreview, HookScope, HookSetup, HookState, HookStatus, HookTarget } from './installer';
export { UnreadableSettings } from './installer';
export { detectedHookInstallers, findHookInstaller, hookInstallers } from './registry';
export { applyLiveSteps, compactFiles, liveStepsAgent, liveStepsAgents, LiveStepsError, liveStepsInstaller, planLiveSteps } from './liveSteps';
export type { LiveStepsApplied, LiveStepsContext, LiveStepsOptions, LiveStepsPlan } from './liveSteps';
