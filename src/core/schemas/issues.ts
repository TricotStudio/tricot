import type { z } from 'zod';

type Issue = z.core.$ZodIssue;

// zod's own wording starts like this; anything else was written by a schema
// (a rule in text.ts, or a message a schema gave) and is a sentence already.
const DEFAULT_WORDING = /^(Invalid|Too big|Too small|Unrecognized)/;

const EXPECTED: Record<string, string> = {
  string: 'a string',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  array: 'an array',
  object: 'an object',
  record: 'an object',
  tuple: 'an array of two numbers',
};

// Where an issue is, as the sender wrote it: tasks[0].title.
function where(path: PropertyKey[]): string {
  if (path.length === 0) return 'The input';
  return path.reduce<string>((at, key, i) => (typeof key === 'number' ? `${at}[${key}]` : i === 0 ? String(key) : `${at}.${String(key)}`), '');
}

function describeIssue(issue: Issue): string {
  if (!DEFAULT_WORDING.test(issue.message)) return issue.message;
  const at = where(issue.path);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.message.endsWith('received undefined')) return `${at} is required.`;
      return `${at} must be ${EXPECTED[issue.expected] ?? issue.expected}.`;
    case 'invalid_value':
      return `${at} must be one of: ${issue.values.map(String).join(', ')}.`;
    case 'too_big':
      if (issue.origin === 'string') return `${at} is too long (max ${issue.maximum} characters).`;
      return issue.origin === 'array' ? `${at} can have at most ${issue.maximum} items.` : `${at} must be at most ${issue.maximum}.`;
    case 'too_small':
      return issue.origin === 'array' ? `${at} needs at least ${issue.minimum} item${Number(issue.minimum) === 1 ? '' : 's'}.` : `${at} must be at least ${issue.minimum}.`;
    case 'invalid_union':
      return `${at} is not valid.`;
    default:
      return `${at}: ${issue.message}`;
  }
}

// What a refused call says, the same whoever sent it: REST answers with it, and
// so does MCP. Each problem on its own, said once, in the words the field uses.
export function describeIssues(error: z.ZodError): string {
  return [...new Set(error.issues.map(describeIssue))].join(' ');
}
