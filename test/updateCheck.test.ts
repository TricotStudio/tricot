import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWords, lineOfAnswer, lineOfError } from '../src/web/update/updateCheck';

// What the menu's "Check for updates" row says (src/web/updateCheck.ts),
// from what POST /api/update/check answered (T171).

describe("The menu's Check for updates", () => {
  it('says what the check found', () => {
    assert.equal(checkWords({ kind: 'checking' }), 'Checking…');
    assert.equal(checkWords(lineOfAnswer({ checked: { latest: true } })), "You're on the latest version.");
    assert.deepEqual(lineOfAnswer({ checked: { newer: { version: '0.1.2', notes: 'Boards open faster.' } } }), { kind: 'newer', version: '0.1.2' });
    assert.equal(checkWords({ kind: 'newer', version: '0.1.2' }), 'Tricot 0.1.2 is out.');
    assert.equal(
      checkWords(lineOfAnswer({ checked: { error: "GitHub and the npm registry can't be reached" } })),
      "Couldn't check: GitHub and the npm registry can't be reached. Try again later.",
    );
  });

  it("says a source checkout's own words, and plain ones when the server doesn't answer", () => {
    const checkout = "This Tricot runs from a copy of its source code, so it doesn't check for updates: update it with git pull && npm install && npm run build.";
    assert.equal(checkWords(lineOfError({ status: 409, message: checkout })), checkout);
    assert.equal(checkWords(lineOfError(new TypeError('Failed to fetch'))), "Couldn't check: Tricot itself isn't answering. Try again later.");
    assert.equal(
      checkWords(lineOfError({ status: 403, message: 'Tricot checks for updates from its page, or with `tricot update` on the computer it runs on.' })),
      "Couldn't check: Tricot checks for updates from its page, or with `tricot update` on the computer it runs on. Try again later.",
      'one full stop',
    );
    assert.equal(checkWords(lineOfError({ status: 500, message: '' })), "Couldn't check: Tricot answered 500. Try again later.");
  });
});
