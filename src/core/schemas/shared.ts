import { z } from 'zod';
import { EMOJIS } from '../reactions';
import { fields } from './fields';

// What people and agents send in the same shape: nested inside a call, in the
// words the core uses. The Store's input types are these, inferred. Each shell
// puts its own envelope around them (REST bodies, MCP tool arguments).

export const newOption = z.object({
  label: fields.optionLabel.describe('Short name for the option'),
  description: z.string().optional().describe('One or two sentences on what choosing it means'),
  pros: z.array(z.string()).optional(),
  cons: z.array(z.string()).optional(),
});

export const newCriterion = z.object({
  label: fields.criterionLabel.describe('What the options should be judged on, e.g. "No silent behaviour change"'),
  description: z.string().optional(),
});

// A change to one option. Nothing is deleted: an option that no longer applies
// is marked outdated, and can be brought back.
export const optionChange = z.object({
  id: z.string(), // its letter
  label: fields.optionLabelChange.optional(),
  description: fields.optionDescriptionChange.optional(), // '' clears it
  outdated: z.boolean().optional(), // true marks it outdated, false brings it back
  reason: fields.optionReason.optional(), // why it no longer applies; agents must give one
});

export const resolveInput = z.object({
  optionId: z.string().optional(),
  answer: z.string().optional(),
  rationale: fields.rationale.optional(),
  provisional: z.boolean().optional(),
});

export const newFinding = z.object({
  optionId: z.string().optional(),
  summary: fields.findingSummary,
  metrics: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  links: z.array(z.string()).optional(),
});

// A reaction as people and agents send it: one of the three (core/reactions.ts),
// or with remove, taking one's own back. REST and the react tool take these
// fields as they are; each names the comment its own way.
export const reactionInput = z.object({
  emoji: z.enum(EMOJIS),
  remove: z.boolean().optional(),
});

// A thread's lens as people or agents choose it: a preset's name (General,
// Legal…), or a name of one's own with a brief; and optionally an agent.
export const lensInput = z.object({
  name: fields.lensName,
  brief: fields.lensBrief.optional(),
  agent: z.string().optional(),
});

export const newTask = z.object({
  title: fields.taskTitle,
  detail: fields.taskDetail.optional(),
  decisionIds: z.array(z.string()).optional(), // optional: bugs and chores implement no decision
  assignee: fields.assignee.optional(), // the agent it's for, by name; none (or '') for any agent
});

export const taskStatus = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done']);

export const taskPatch = z.object({
  status: taskStatus.optional(),
  note: fields.taskNote.optional(),
  link: fields.taskLink.optional(),
  title: fields.taskTitle.optional(),
  detail: fields.taskDetail.optional(),
  decisionIds: z.array(z.string()).optional(),
  stillValid: z.boolean().optional(), // re-checked after a decision it builds on changed
  approveCommit: z.boolean().optional(), // a person approves the work and asks for a commit of it (status done)
  commit: z.string().optional(), // the hash, reported once an approved commit is made
  nothingToCommit: fields.noCommit.optional(), // why there is nothing to commit: sent with in_review, or answering an approved commit
  after: z.string().nullable().optional(), // people only: its place in its lane, right after this task, or first (null)
  assignee: fields.assignee.nullable().optional(), // the agent it's for, by name; null (or '') for any agent, first to claim
});

// The canvas a call is about: the board's, a decision's or a task's.
export const canvasRef = z.object({
  boardId: z.string().optional(),
  decisionId: z.string().optional(),
  taskId: z.string().optional(),
});

// A call names exactly one of them; in the words agents are told.
export const ONE_CANVAS = 'Pass exactly one of board_id (board context), decision_id or task_id.';
export const namesOneCanvas = (ref: z.infer<typeof canvasRef>): boolean => [ref.boardId, ref.decisionId, ref.taskId].filter(Boolean).length === 1;

export const newGroup = z.object({
  title: fields.groupTitle,
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});

export const move = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  groupId: z.string().nullable().optional(), // blocks only; positions are relative to the group
});
