// The rules the schemas and the browser share. This file imports no library,
// so the web bundle can take it without zod: the schema files import from
// here, and nothing here imports a schema file. (test/bundle.test.ts fails
// when zod reaches the browser.)

// The words a refusal uses, said once: the schemas, which refuse a call before
// it reaches the store, and the store, which refuses it again as the last line,
// build their messages here so a person and an agent are told the same thing.
export const tooLong = (field: string, max: number): string => `${field} is too long (max ${max} characters).`;
export const mustNotBeEmpty = (field: string): string => `${field} must not be empty.`;

// On one line, trimmed: how a name or a short phrase is read.
export const tidy = (value: string): string => value.replace(/\s+/g, ' ').trim();

// A skill's name as people type it after a "/": one word (plugins join theirs
// with a colon), without the slash.
export const SKILL_NAME = /^[A-Za-z0-9][\w.:-]*$/;
