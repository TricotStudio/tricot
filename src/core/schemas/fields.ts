import { LIMITS } from './limits';
import { sized, text } from './text';

// The fields people and agents both send, each held to one rule. A rule is what
// the store holds the same field to, counted the same way (see text.ts), so
// REST, MCP and the store refuse the same input in the same words.
export const fields = {
  boardTitle: text({ empty: 'title', name: 'A board title', max: LIMITS.boardTitle }),
  goal: text({ name: 'A goal', max: LIMITS.goal }),

  question: text({ empty: 'question' }),
  area: text({ name: 'An area', max: LIMITS.area, tidy: true }), // '' clears it
  optionLabel: text({ empty: 'option label' }),
  optionLabelChange: text({ empty: 'option label', name: 'An option label', max: LIMITS.optionLabel }),
  optionDescriptionChange: text({ name: 'An option description', max: LIMITS.optionDescription }),
  optionReason: text({ name: 'A reason', max: LIMITS.reason }),
  criterionLabel: text({ empty: 'criterion', name: 'A criterion', max: LIMITS.criterion }),
  findingSummary: text({ empty: 'summary' }),
  rationale: text({ name: 'A rationale', max: LIMITS.rationale }),
  affectWhy: text({ empty: 'why', name: 'Why', max: LIMITS.affectWhy }),
  retireReason: text({ empty: 'reason', name: 'A reason', max: LIMITS.note }),

  note: text({ name: 'A note', max: LIMITS.note }),
  longNote: text({ name: 'A note', max: LIMITS.longNote }),
  comment: text({ empty: 'comment', name: 'A comment', max: LIMITS.comment }),
  message: text({ empty: 'A message', name: 'A message', max: LIMITS.message }),
  request: text({ empty: 'A request', name: 'A request', max: LIMITS.request, tidy: true }),
  requestNote: text({ empty: 'A note', name: 'A note', max: LIMITS.note }),
  lensName: text({ empty: 'A lens name', name: 'A lens name', max: LIMITS.lensName, tidy: true }),
  lensNameOrNone: text({ name: 'A lens name', max: LIMITS.lensName, tidy: true }), // '' is no lens
  lensBrief: text({ name: 'A lens brief', max: LIMITS.lensBrief, tidy: true }),

  personName: text({ empty: 'name', name: 'A name', max: LIMITS.name }),
  assignee: text({ name: 'An assignee', max: LIMITS.name, trim: true }), // '' is any agent
  taskTitle: text({ empty: 'task title', name: 'A task title', max: LIMITS.taskTitle }),
  taskDetail: text({ name: 'Task detail', max: LIMITS.taskDetail }),
  taskLink: text({ empty: 'link', name: 'A link', max: LIMITS.taskLink }),
  noCommit: text({ empty: 'reason', name: 'A reason', max: LIMITS.noCommit }),
  taskNote: text({ empty: 'note', name: 'A note', max: LIMITS.note }),

  groupTitle: text({ empty: 'group title', name: 'A group title', max: LIMITS.title }),
  groupTitleOrNone: text({ name: 'A group title', max: LIMITS.title, trim: true }),
  linkLabel: text({ name: 'A link label', max: LIMITS.title }),
  prompt: text({ empty: 'prompt', name: 'The prompt', max: LIMITS.prompt }),
  pinContext: text({ name: 'The text around pinned words', max: LIMITS.pinContext }),
};

// People to ask about a decision: at least one, at most ten.
export const askNames = sized(fields.personName, {
  min: [1, 'Ask at least one person.'],
  max: [LIMITS.askNames, `Ask at most ${LIMITS.askNames} people at once.`],
});
