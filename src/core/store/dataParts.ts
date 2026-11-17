// The parts of Tricot that keep data of their own in the database, besides
// core, each with a data version of its own. Core's version stays
// SQLite's user_version, so every older Tricot still refuses newer core data;
// another part's is its row in the `data_versions` table, which only Tricots
// from data version 15 on know of. A part's is the first. A part is a Store's own: it is the `data` of a StorePart (storePart.ts),
// and the Store hands those of its parts to the database when it opens it, so
// two Stores in one process keep to their own. migrations.ts runs them
// (openData): it says in what order, and what it does with the data of a part
// that a newer Tricot saved (the Store switches that part off), or of a part
// this Tricot doesn't have (left alone).

import type { Migration } from './migrations';

// What a part's own data versions are told apart from: core is the part
// whose list is MIGRATIONS, and whose version is user_version.
export const CORE = 'core';

// The data version that made `data_versions`: no part keeps a version before
// it, so no part's migration can be written on a core older than it. Like the
// migration that made it, it never changes.
export const PARTS_FROM = 15;

// A part's migration names the core data version it was written on (`core`:
// how many core migrations there were), and runs once core is at that
// version, before core's next one (migrations.ts, "In what order").
export interface PartMigration extends Migration {
  core: number;
}

export interface DataPart {
  // Lower-case letters and digits, as it reads in a backup's name
  // (tricot-v15-<part>-v2-<time>.db); never 'core'.
  name: string;
  // In the order they run; one is only ever added at the end, as core's are.
  migrations: readonly PartMigration[];
}

const NAME = /^[a-z][a-z0-9]*$/;

// Whether a name read from a file is one a part could have: only those go
// into a backup's name, so nothing in the file can make a path of its own.
export const isPartName = (name: string): boolean => NAME.test(name) && name !== CORE;

// Says what is wrong with a list of parts, before anything is opened: a
// misbuilt part is a mistake in Tricot, not in the data. `coreKnown`, when
// given, is how many core migrations this Tricot has: no part's migration
// may be written on a later core.
export function checkParts(parts: readonly DataPart[], coreKnown?: number): void {
  const seen = new Set<string>();
  for (const { name, migrations } of parts) {
    if (!NAME.test(name)) throw new Error(`A part's name is lower-case letters and digits, starting with a letter: "${name}" is not.`);
    if (name === CORE) throw new Error(`"${CORE}" is the part whose migrations are MIGRATIONS: another part can't take its name.`);
    if (seen.has(name)) throw new Error(`There are two parts named ${name}.`);
    seen.add(name);
    let previous = PARTS_FROM;
    migrations.forEach(({ name: what, core }, i) => {
      const which = `${name}'s migration ${i + 1} (${what})`;
      if (!Number.isInteger(core) || core < PARTS_FROM) throw new Error(`${which} must name the core data version it was written on, ${PARTS_FROM} or later.`);
      if (core < previous) throw new Error(`${which} is written on core data version ${core}, older than the one before it (${previous}).`);
      if (coreKnown !== undefined && core > coreKnown) throw new Error(`${which} is written on core data version ${core}, and this Tricot's core goes up to ${coreKnown}.`);
      previous = core;
    });
  }
}

const added: DataPart[] = [];

// The process-wide list, for what is given no parts of its own: openData and
// openDatabase called with no list, and a Store built with no `parts` option,
// which reads it when it is built and adds it to the data parts of its own.
// A Store built with `parts` never reads it. A part is better the `data` of a
// StorePart; this stays for what is given no parts.
//
// Adds a part whose data the database keeps a version of. It is for code
// that plugs into Tricot without changing it, and is called before the store
// is built: the database is migrated when it opens.
export function addDataPart(part: DataPart): void {
  checkParts([...added, part]);
  added.push(part);
}

// The parts besides core, in the order they were added.
export const dataParts = (): readonly DataPart[] => added;
