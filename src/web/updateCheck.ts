import type { CheckedState } from '../core/update';

// "Check for updates", in the menu under your name (update.tsx,
// CheckForUpdates): what its row says while the server asks GitHub, then
// npm, and once it has answered (POST /api/update/check, server/updateRoutes.ts).

export type CheckLine =
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'newer'; version: string } // the update notice shows it
  | { kind: 'failed'; reason: string } // neither answered, or the server didn't
  | { kind: 'refused'; words: string }; // this Tricot doesn't check (a source checkout), in the server's words

// What the server found.
export function lineOfAnswer(answer: Pick<CheckedState, 'checked'>): CheckLine {
  const { checked } = answer;
  if ('newer' in checked) return { kind: 'newer', version: checked.newer.version };
  if ('error' in checked) return { kind: 'failed', reason: checked.error };
  return { kind: 'latest' };
}

// What became of a request the server refused (409: this Tricot doesn't
// check, and says how it's updated) or never answered.
export function lineOfError(error: { status?: number; message?: string }): CheckLine {
  if (error.status === 409 && error.message) return { kind: 'refused', words: error.message };
  if (error.status === undefined) return { kind: 'failed', reason: "Tricot itself isn't answering" };
  return { kind: 'failed', reason: error.message || `Tricot answered ${error.status}` };
}

// The row's words.
export function checkWords(line: CheckLine): string {
  switch (line.kind) {
    case 'checking':
      return 'Checking…';
    case 'latest':
      return "You're on the latest version.";
    case 'newer':
      return `Tricot ${line.version} is out.`;
    case 'failed':
      return `Couldn't check: ${line.reason.trim().replace(/[\s.]+$/, '')}. Try again later.`;
    case 'refused':
      return line.words;
  }
}
