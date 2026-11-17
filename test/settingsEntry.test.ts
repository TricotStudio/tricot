import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EntryRefused, withEntry, type EntrySpot } from '../src/core/settingsEntry';

// Tricot's entry in an agent's settings file (core/settingsEntry.ts): the text
// with the entry, and every other character as it was. Each case checks the
// whole text it gives, or that it refuses, and why.
const value = { type: 'remote', url: 'http://127.0.0.1:4545/mcp?agent=Sam', timeout: 300 };
const json: EntrySpot = { format: 'json', section: 'servers', name: 'tricot' };
const yaml: EntrySpot = { format: 'yaml', section: 'servers', name: 'tricot' };

const refused = (text: string, spot: EntrySpot, why: RegExp) =>
  assert.throws(
    () => withEntry(text, spot, value),
    (error: unknown) => error instanceof EntryRefused && why.test(error.why),
  );

const entryJson = (indent: string, unit = '  ') => JSON.stringify(value, null, unit).split('\n').join(`\n${indent}`);

describe("Tricot's entry in a JSON settings file", () => {
  it("puts the entry in place of Tricot's own, and gives the one that was there", () => {
    const before = '{\n  "servers": {\n    "tricot": { "url": "http://127.0.0.1:4000/mcp" }, // old\n    "b": 2\n  }\n}\n';
    const { next, existing } = withEntry(before, json, value);
    assert.equal(existing, '{ "url": "http://127.0.0.1:4000/mcp" }');
    assert.equal(next, `{\n  "servers": {\n    "tricot": ${entryJson('    ')}, // old\n    "b": 2\n  }\n}\n`);
  });

  it("refuses what isn't JSON it can read, or where the entry can't go, saying why", () => {
    refused('{\n  "a": 1\n  "b": 2\n}', json, /^isn't JSON Tricot can read \(no comma between two members, line 3\)$/);
    refused('{ "a": ', json, /isn't JSON Tricot can read \(it ends too soon/);
    refused('{ /* never ends', json, /a comment that never ends/);
    refused('[1, 2]', json, /^isn't a JSON object$/);
    refused('{"servers": []}', json, /^has "servers" that isn't an object$/);
    refused('{"servers": {}, "servers": {}}', json, /^has "servers" twice$/);
    refused('{"servers": {"tricot": 1, "tricot": 2}}', json, /^has "tricot" twice in "servers"$/);
  });
});

describe("Tricot's entry in a YAML settings file", () => {
  it("refuses a layout it doesn't edit, saying why", () => {
    refused('servers:\n\ta: 1\n', yaml, /^is indented with tabs \(line 2\)$/);
    refused('a: 1\n---\nb: 2\n', yaml, /^holds more than one YAML document \(line 2\)$/);
    refused('- a\n- b\n', yaml, /^has a line at the top Tricot can't read as a key \(line 1\)$/);
    refused('servers:\n  - a\n', yaml, /^has "servers:" as a list/);
    refused('servers: {a: 1}\n', yaml, /^has "servers:" written on one line \(\{a: 1\}\), which Tricot doesn't edit$/);
    refused('servers: &mine\n  a: 1\n', yaml, /written on one line \(&mine\)/);
    refused('servers:\n  a: 1\nservers:\n  b: 2\n', yaml, /^has "servers:" twice$/);
    refused('servers:\n  tricot: 1\n  tricot: 2\n', yaml, /^has "tricot:" twice under "servers:"$/);
    refused('servers:\n    a: 1\n  b: 2\n', yaml, /^has a line under "servers:" Tricot can't place \(line 3\)$/);
    refused('servers:\n  ? complex\n  : key\n', yaml, /^has a line under "servers:" Tricot can't read as a name \(line 2\)$/);
  });
});
