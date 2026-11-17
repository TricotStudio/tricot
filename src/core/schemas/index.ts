// The one schema set. What people send (people.ts, the REST bodies today), what
// agents send (agents.ts, the MCP tools' arguments) and what the Store takes
// (shared.ts, inferred into its input types) are written from the same fields
// and the same limits. No shell is imported here: a REST server, an MCP server
// and a desktop shell all sit on it.
// A part's own (the bodies and queries of its routes, and
// its tools' arguments) are not exported here: the core
// names none of them.
export { LIMITS } from './limits';
export { describeIssues } from './issues';
export { SKILL_NAME, mustNotBeEmpty, tidy, tooLong } from './rules';
export { fields } from './fields';
export * from './shared';
export { newSkill, skillName, tricotSkill } from './skills';
export { EVENTS_PAGE, EVENTS_PAGE_MAX, projectFileParams, projectSearchParams, actorName, agentRule, agentStep, agentStepCards, approvals, agentStepName, agentUsage, agentUsageParams, agentsParams, canvas, eventsParams, listen, liveSteps, needsParams, people, searchKind, searchParams, seenCursors, wakes } from './people';
export { MAX_INLINE_IMAGES, THREAD_HINT, blockShape, readGuideArgs, tools } from './agents';
export type { BlockArgs } from './agents';
