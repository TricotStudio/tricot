// Windows has no POSIX file modes, signals, pseudo-terminals or /bin/sh, so
// tests that need one skip there, saying which: `{ skip: WINDOWS && 'needs ...' }`,
// as the diagram tests skip without Chrome.
export const WINDOWS = process.platform === 'win32';
