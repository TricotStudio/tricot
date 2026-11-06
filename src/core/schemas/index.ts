// The one schema set. What people send (people.ts, the REST bodies today), what
// agents send (agents.ts, the MCP tools' arguments) and what the Store takes
// (shared.ts, inferred into its input types) are written from the same fields
// and the same limits. No shell is imported here: a REST server, an MCP server
// and a desktop shell all sit on it.
export { LIMITS } from './limits';
export { describeIssues } from './issues';
export { SKILL_NAME, mustNotBeEmpty, tidy, tooLong } from './rules';
export { fields } from './fields';
export * from './shared';
export { newSkill, skillName, tricotSkill } from './skills';
export { EVENTS_PAGE, EVENTS_PAGE_MAX, actorName, agentStep, approvals, agentStepName, agentUsage, agentUsageParams, agentsParams, canvas, dismissNeeds, eventsParams, liveSteps, needsParams, people, searchKind, searchParams, seenCursors } from './people';
export { AREA_HINT, GUIDE_TOPICS, MAX_INLINE_IMAGES, THREAD_HINT, blockShape, pinShape, tools } from './agents';
export type { BlockArgs, GuideTopic, PinArgs } from './agents';
