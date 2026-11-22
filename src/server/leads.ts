// The boards that agents connected on their own coordinate (core/roles.ts). An
// agent takes the coordinator's role on a board as it sleeps there by `tricot
// listen` (mcp/session.ts), and its name holds the role while any MCP session
// of its name does: a second session of it, as when its client connects again,
// serves the role as the first does and lists the role's tools from the start
// (mcp.ts), so they never leave an agent that is still the board's coordinator.
//
// Once no session of its name holds it, the role is parting for RESUME_MS: a
// session of its name that starts in that time takes it back, and nobody
// counts the agent a coordinator meanwhile (presence.ts coordinatorsOn), so a
// thread a person starts then is no one's.
//
// A restart of Tricot ends every session at once, and the agent's client,
// connecting again within seconds, would list the board's tools without its
// role's until the agent next listened. So as the server stops (start.ts) it
// keeps the roles held then in LEADS_FILE in the data folder, and the next
// start reads them back as parting (and deletes the file) when it comes within
// RESUME_MS of that stop. Nothing else is written: otherwise this lives in
// memory, as presence does, and a Tricot that stopped abruptly carries none over.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keepPrivate } from '../platform/private';

export const RESUME_MS = 5 * 60_000; // how long a role no session holds waits for a session of its name
export const LEADS_FILE = 'coordinators.json';
export const leadsFile = (dataDir: string) => path.join(dataDir, LEADS_FILE);

// What the file holds: when the server stopped, and the agents' names by board key.
interface LeadsData {
  version: 1;
  stopped: string;
  boards: Record<string, string[]>;
}

interface Lead {
  name: string;
  holders: Set<string>; // the sessions that hold it
  until?: number; // none while a session holds it; parting until then
}

export class Leads {
  private boards = new Map<string, Map<string, Lead>>(); // by board key, then the agent's name, lower-cased

  constructor(private readonly options: { dataDir?: string; now?: () => number } = {}) {
    this.carryIn();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // A lead as it stands now: none once it has parted for good.
  private live(board: string, key: string): Lead | undefined {
    const leads = this.boards.get(board);
    const lead = leads?.get(key);
    if (!lead || lead.until === undefined || lead.until > this.now()) return lead;
    leads!.delete(key);
    if (!leads!.size) this.boards.delete(board);
    return undefined;
  }

  // This session takes the role on the board for its name: whether its name takes it now, as no session of its held it.
  take(board: string, name: string, holder: string): boolean {
    const key = name.toLowerCase();
    const lead = this.live(board, key);
    const took = !lead || lead.until !== undefined;
    let leads = this.boards.get(board);
    if (!leads) this.boards.set(board, (leads = new Map()));
    leads.set(key, { name, holders: new Set([...(lead?.holders ?? []), holder]) });
    return took;
  }

  // Whether an agent of this name coordinates the board now, through any session of its.
  holds(board: string, name: string): boolean {
    const lead = this.live(board, name.toLowerCase());
    return lead !== undefined && lead.until === undefined;
  }

  // A session of this name started: it holds every role its name holds, and takes back the ones parting. Whether it
  // coordinates a board now.
  resume(name: string, holder: string): boolean {
    const key = name.toLowerCase();
    let any = false;
    for (const board of [...this.boards.keys()]) {
      const lead = this.live(board, key);
      if (!lead) continue;
      lead.holders.add(holder);
      delete lead.until;
      any = true;
    }
    return any;
  }

  // This session ended: a role only it held is parting.
  release(holder: string): void {
    for (const leads of this.boards.values()) {
      for (const lead of leads.values()) {
        if (lead.holders.delete(holder) && !lead.holders.size) lead.until = this.now() + RESUME_MS;
      }
    }
  }

  // The server stops: the roles held now, and those parting still, for the next start.
  carryOut(): void {
    const dir = this.options.dataDir;
    if (!dir) return;
    const boards: Record<string, string[]> = {};
    for (const [board, leads] of [...this.boards]) {
      const names = [...leads.keys()].flatMap((key) => this.live(board, key)?.name ?? []);
      if (names.length) boards[board] = names;
    }
    const file = leadsFile(dir);
    if (!Object.keys(boards).length) return void rmSync(file, { force: true });
    const temp = `${file}.${process.pid}.tmp`;
    const data: LeadsData = { version: 1, stopped: new Date(this.now()).toISOString(), boards };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      keepPrivate(temp);
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      console.warn(`Tricot couldn't keep which agents coordinate its boards (${(error as Error).message}): each takes its role again as it next listens.`);
    }
  }

  // The server starts: the roles the last one kept as it stopped, as parting, if it stopped within RESUME_MS.
  private carryIn(): void {
    const dir = this.options.dataDir;
    if (!dir) return;
    const file = leadsFile(dir);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return; // none kept
    }
    rmSync(file, { force: true });
    try {
      const data = JSON.parse(text) as Partial<LeadsData>;
      const stopped = Date.parse(String(data.stopped));
      const now = this.now();
      if (data.version !== 1 || !(now - stopped <= RESUME_MS) || !data.boards || typeof data.boards !== 'object') return;
      for (const [board, names] of Object.entries(data.boards)) {
        if (!Array.isArray(names)) continue;
        const leads = new Map<string, Lead>();
        for (const name of names) if (typeof name === 'string' && name) leads.set(name.toLowerCase(), { name, holders: new Set(), until: now + RESUME_MS });
        if (leads.size) this.boards.set(board, leads);
      }
    } catch {
      // A file it can't read carries nothing over: each agent takes its role again as it next listens.
    }
  }
}
