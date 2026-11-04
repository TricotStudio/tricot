// How much each field holds. The schemas check these before a call reaches the
// store, and the store checks them again as the last line, so one number
// answers for people, agents and the tests.
export const LIMITS = {
  blocks: 300,
  text: 20_000,
  columns: 20,
  rows: 300,
  cell: 2_000,
  items: 300,
  itemText: 500,
  title: 120,
  url: 2_000,
  pins: 500, // per canvas
  quote: 1_000,
  pinnedCells: 200,
  prompt: 2_000,
  area: 60,
  focus: 50, // files in a diff's focus
  boardTitle: 200,
  goal: 2_000,
  comment: 10_000,
  message: 10_000, // in a thread
  request: 500, // an ask on the board context
  lensName: 24,
  lensBrief: 300,
  note: 2_000,
  longNote: 4_000, // what a person says when they defer, explore or answer
  rationale: 4_000,
  reason: 500, // why an option no longer applies
  optionLabel: 200,
  optionDescription: 4_000,
  options: 26,
  criterion: 120,
  criteria: 12,
  askNames: 10,
  name: 60, // of a person or an agent
  taskTitle: 200,
  taskDetail: 4_000,
  taskLink: 500,
  noCommit: 300, // why a task's work has nothing to commit
  tasks: 50, // planned at once
  backlogCards: 5, // one agent opens on a board in an hour (core/store/tasks.ts)
  revision: 200,
  affects: 12, // decisions one names as ones it could affect
  affectWhy: 200, // why it could affect one
  revisit: 50, // decisions a person asks to be checked at once, after deciding one
  pinContext: 200, // the words around pinned text
  moves: 500,
  syncBlocks: 1_000,
  skills: 300, // an agent reports at most this many
  skillName: 60,
  skillDescription: 200, // longer ones are clipped
  skillInstructions: 8_000, // of a Tricot skill
  tricotSkills: 100,
  step: 160, // a line an agent's harness sends while it works (server/steps.ts)
  stepId: 120, // a harness's session or subagent id
} as const;
