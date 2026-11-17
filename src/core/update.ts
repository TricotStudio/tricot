// What a page is told about updates (GET /api/update, server/updateRoutes.ts):
// the version running, a newer release when there is one, and how this
// Tricot can move to it.

export interface Release {
  version: string;
  notes?: string; // a line or two on what's new, when the release says
  link?: string; // where to read more: its release page
}

// How this Tricot updates: by itself (it installs the new version with npm or
// Homebrew, or runs it with npx, and hands over to it on the same address), or
// with a command the person runs, why, and the command that restarts Tricot on
// it. `admin`: npm's or Homebrew's folder needs another account's rights,
// which is said in words (sudo), never run.
export type UpdateHow =
  | { self: true; via: 'npm' | 'brew' | 'npx' }
  | { self: false; command: string; restart?: string; why: string; admin?: boolean };

export interface UpdateFailure {
  version: string; // what it tried to update to
  at: string;
  message: string;
  log: string; // the updater's log, in the data folder
}

export interface UpdateState {
  current: string;
  available?: Release; // the latest release, when it is newer than this one
  checkedAt?: string; // when GitHub, or npm, last answered
  check: boolean; // whether the daily check is on
  how?: UpdateHow; // none until the server has found out how it was installed
  updating?: string; // handing over to this version now
  failed?: UpdateFailure; // the last update didn't finish: this Tricot came back instead
}

// What a check a person asked for found (POST /api/update/check), beside the
// state: the version running is the latest, a newer one is out (the state's
// `available` too), or neither GitHub nor npm answered, and why in plain
// words, to follow "Couldn't check: ".
export type Checked = { latest: true } | { newer: Release } | { error: string };

export type CheckedState = UpdateState & { checked: Checked };

// What it says on every way to update: a data upgrade keeps a copy first
// (core/store/migrations.ts).
export const BACKUP_NOTE = 'If the new version changes how boards are stored, it keeps a copy of them first.';
