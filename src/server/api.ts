import path from 'node:path';
import express, { Router, type ErrorRequestHandler, type Request } from 'express';
import { z, ZodError } from 'zod';
import { findKind } from '../core/blocks/registry';
import { deletionSummaries, type Deletion } from '../core/deletions';
import type { StartFolder } from '../core/firstRun';
import { BoardError, type FileBlockCode, type ReactionPlace, type Store } from '../core/store';
import { searchStore } from '../core/search';
import { projectsAcross, withoutNeeds } from '../core/projects';
import { agentsWithSkills } from '../core/skills';
import { boardAgents } from '../core/mentions';
import { canvasBody, cardIdsOf, projectFileParams, projectSearchParams, agentStep, agentStepCards, agentStepName, agentsParams, canvas as canvasBodies, describeIssues, eventsParams, listen as listenBody, needsParams, people as bodies, searchParams, seenCursors, wakes as wakesBody } from '../core/schemas';
import { asPerson, fromThisComputer, peopleChange, personOnly, readerOf, type PersonGate, type PersonVerdict } from './access';
import { osHome } from '../platform/paths';
import type { Approvals } from './approvals';
import type { Connectors } from './connectors';
import { openStepsStream, openStream, type FolderWatch, type Reader } from './live';
import type { PairingSessions } from './pairing';
import type { Presence } from './presence';
import type { Seats } from './seats';
import type { Steps } from './steps';
import { boardKey, type Actor, type Block, type Board } from '../core/types';
import { serveListener } from './listeners';
import type { ProjectFileText } from '../core/projectFiles';
import { listProjectFiles, projectFolder, projectImage, readProjectFile, writeProjectFile } from './projectFiles';
import { ProjectWatches } from './projectWatch';
import { searchProjectFiles } from './projectSearch';
import { heldBy } from './wakes';
import { OLDEST_COMMAND, PROTOCOL } from '../core/protocol';
import { routes } from '../core/routes';
import { ApiParts, type ApiKit, type NeedsSource } from './apiParts';
import { routesOn } from './routing';

// A board goes to the browser on every change, and has no event log and no
// block versions on it: people fetch those when they open them (the events
// and versions routes below), and a block says how many versions it has.
// Set as the app's json replacer, so every response follows it.
// A diff's raw patch is for agents (get_block): people's copy is drawn from
// its parsed files, so it goes without, at half the size.
// What a board keeps of deleted items to restore them is the server's: people
// see what was deleted, by whom and when.
export function peoplesCopy(key: string, value: unknown): unknown {
  if (key === 'deleted' && Array.isArray(value)) return deletionSummaries(value as Deletion[]);
  const block = value as Partial<Block> | null;
  if (typeof block?.id === 'string') return findKind(block.type)?.forPeople?.(block as Block) ?? value;
  return value;
}

function human(name: string): Actor {
  return { kind: 'human', name };
}

const ONLY_A_TERMINAL = "Refused: only a Tricot terminal (tricot claude, tricot codex, tricot listen) holds agents to wake, with its own key.";

// The board's project folder, or a 404 saying it has none.
function projectFolderOf(board: Board): string {
  const folder = (board as Board & { folder?: string }).folder;
  if (!folder) throw new BoardError("This board has no project folder. Choose one in the board's Files view.", 'not_found');
  return folder;
}

// A project file as its block on the Files canvas holds it.
function blockCode(read: ProjectFileText): FileBlockCode {
  return { path: read.named, text: read.text, start: read.start, ...(read.total && { total: read.total }), ...(read.commit && { commit: read.commit }) };
}

function param(req: Request, name: string): string {
  return String(req.params[name]);
}

export function createApiRouter(
  store: Store,
  info: { mcpUrl: string; version?: string; source?: string; folder?: StartFolder; chooseFolder?: () => Promise<string | undefined> },
  presence?: Presence,
  steps?: Steps,
  pairing?: PairingSessions,
  approvals?: Approvals, // agents waiting for a person's OK, on the pages' streams (live.ts)
  person: PersonGate = (req, tier) => asPerson(req, tier), // who is a person, and at which tier (access.ts); the app's, with its terminals and seats
  seats?: Seats, // the person's seats (seats.ts): their streams' tickets, and the admissions they answer
  parts: ApiParts = new ApiParts(), // the routes a part of Tricot adds (apiParts.ts): a part's, which createApp registers; none, the canvas alone
  connectors?: Pick<Connectors, 'get'>, // the app's connectors, which a part's route may act through (apiParts.ts)
): Router {
  const api = Router();
  const watches = new ProjectWatches(); // the project folders a Files view is open on (projectWatch.ts)
  // What changes in a board's project folder, for a person's stream while a
  // Files view is open on it: the paths, once they settle. The view reads the
  // list again, and the file open if it is among them. A board with no folder,
  // or one that can't be read, has nothing to watch.
  const watchFolder: FolderWatch = (board, send) => {
    const folder = (board as Board & { folder?: string }).folder;
    let real: string;
    try {
      if (!folder) return () => {};
      real = projectFolder(folder).real;
    } catch {
      return () => {};
    }
    const listed = async () => (await listProjectFiles(folder)).files.map((file) => file.path);
    return watches.listen(real, listed, send);
  };
  const on = routesOn(api, '/api');

  // A step from an agent's harness while it works: one line of what it is
  // doing, shown live on the card it is working on and kept in memory only
  // (steps.ts). Its body is small (app.ts holds it to STEP_BODY_LIMIT). A
  // step that is rate-limited, or has no board to go on, is answered all the
  // same, as `shown: false`: the hook that sent it has nothing to do about it.
  // The agent's own, from its hook: the one change here that isn't a person's.
  on(routes.recordStep, (req, res) => {
    const { name } = agentStepName.parse(req.params);
    const step = agentStep.parse(req.body);
    const cards = agentStepCards(store.cardKinds()).parse(req.body);
    if (!steps) throw new BoardError('Steps are not kept on this server.');
    const result = steps.record(name, { ...step, ...cards });
    res.status(result.shown ? 201 : result.reason === 'limited' ? 429 : 202).json(result);
  });

  // Every other change below is a person's (access.ts asPerson): made in
  // Tricot's page, or at a Tricot terminal (tier A). The name it is made in
  // comes in the request (human() below), so a plain call from curl or a
  // script is refused before any route reads it. Agents change boards
  // through MCP, as themselves. What is consequential needs one of the
  // person's seats too (tier B, `seated` on the route): deciding,
  // retiring, deferring, reopening, deleting, marking ready, approving a
  // commit, and Tricot skills. Reads pass, as people's pages make them: none
  // holds what an agent can't already read over MCP, but for the requests
  // for permission waiting on the streams, which go to a person alone, in
  // full to a seat (stream routes below, live.ts).
  api.use(peopleChange(person));
  const seated = personOnly(person, 'B');
  const readerFor = (req: Request): Reader | undefined => {
    const reader = readerOf(req, person, seats);
    return reader && { ...reader, approvals, seats };
  };

  // `app` and `pid` let the `tricot` command tell its own server from anything
  // else on a port. `version` and `source` (the repository's page) are for the
  // foot of Home. `folder`: where it was started, from ~ (startFolder.ts),
  // for Home's first run; read-only, and behind the same access rules as every route.
  // `protocol` and `oldestCommand` are for the commands that reach the board:
  // what it serves, and the oldest command it serves (core/protocol.ts).
  // `parts` lists the ids of the API parts it serves besides the core's (the full
  // edition: its one id; the canvas alone: `[]`), so a client tells Canvas from a part
  // before it asks for one of that edition's routes. It is added to what the board
  // says and changes no other field, so readers that ignore it, older commands
  // among them, are not affected.
  on(routes.info, (_req, res) => {
    // First run can use the launch folder as a local file root only here.
    res.json({ ...info, ...(!store.localFiles && { folder: undefined }), app: 'tricot', pid: process.pid, protocol: PROTOCOL, oldestCommand: OLDEST_COMMAND, parts: parts.ids() });
  });

  on(routes.boards, (_req, res) => {
    res.json(store.listBoards());
  });

  // The boards in use and the agents around them, for Home and the board
  // switcher, with each project's work at a glance. What waits on this person,
  // most urgent first, is a part's to add (the needs source a part registers,
  // apiParts.ts: a part's), and the report says nothing waits on anyone
  // without one. `seen` is a JSON object of the last event they saw on each
  // board, by its key, as their browser keeps it; a board left out has nothing
  // unseen.
  let needsSource: NeedsSource | undefined;
  on(routes.needs, (req, res) => {
    const params = needsParams.parse(req.query);
    let seen: Record<string, number> = {};
    if (params.seen) {
      try {
        seen = seenCursors.parse(JSON.parse(params.seen));
      } catch {
        throw new BoardError('seen must be a JSON object of board keys to event numbers, e.g. {"my-board-x1y2":12}.');
      }
    }
    const boards = store.listBoards().flatMap((b) => (b.archived ? [] : [store.getBoard(b.id)]));
    const inUse = new Set(boards.map(boardKey));
    const ask = {
      seen,
      unseen: (board: Board, since: number) => store.events(board.id, { since, unseenBy: params.name }),
      present: (board: Board) => presence?.list(boardKey(board)) ?? [],
      // Connected, but on no board in use: a session just started, before
      // any project (Home's first run), or only on archived ones.
      connected: (presence?.agents() ?? []).filter((a) => a.board === undefined || !inUse.has(a.board)).map(({ board: _board, ...agent }) => agent),
    };
    res.json(needsSource ? needsSource(boards, params.name, ask) : withoutNeeds(projectsAcross(boards, ask)));
  });

  // The agents and the skills each reported, for the "/" list in a composer
  // and the user menu. With ?board=, where each is on that board (listening or
  // working: a request reaches it now; else it runs next time it connects).
  on(routes.agents, (req, res) => {
    const { board } = agentsParams.parse(req.query);
    const here = board === undefined ? undefined : store.getBoard(board);
    // With each, what its latest session said of it: which agent it is, and what it runs on (its panel's head).
    const seen = (presence?.agents(here && boardKey(here)) ?? []).map(({ board: key, ...agent }) => {
      const on = here ?? (key === undefined ? undefined : store.getBoard(key)); // presence keys on a board's first id, which still resolves; none: only connected
      const session = presence?.sessionOf(agent.name);
      return { ...agent, ...session, ...(on && { board: { id: on.id, title: on.title } }) };
    });
    res.json(agentsWithSkills(store.agentSkills(), seen, store.tricotSkills(), here ? boardAgents(here, seen.map((a) => a.name)) : []));
  });

  // The skills people add in Tricot (core/skills.ts): for one agent or, with
  // none, every agent. Agents never write them; a request carries them.
  on(routes.addSkill, seated, (req, res) => {
    const { actor, ...skill } = bodies.addSkill.parse(req.body);
    res.status(201).json(store.addTricotSkill(actor, skill));
  });

  on(routes.editSkill, seated, (req, res) => {
    const { actor: _actor, ...patch } = bodies.editSkill.parse(req.body);
    res.json(store.editTricotSkill(param(req, 'skillId'), patch));
  });

  on(routes.deleteSkill, seated, (req, res) => {
    bodies.actorOnly.parse(req.body);
    res.json(store.deleteTricotSkill(param(req, 'skillId')));
  });

  on(routes.createBoard, (req, res) => {
    const body = bodies.createBoard.parse(req.body);
    res.status(201).json(store.createBoard({ title: body.title, goal: body.goal, folder: body.folder }, human(body.actor)));
  });

  // Presence rides along with the board but is never saved with it, and `ver`
  // is the number of its latest change: the stream goes on from there (live.ts).
  // An earlier id answers too; the board's id field says where it lives now.
  on(routes.board, (req, res) => {
    const board = store.getBoard(param(req, 'boardId'));
    store.sweepKinds(board); // a first look that ran out of time reads as open again
    res.json({ ...board, presence: presence?.list(boardKey(board)) ?? [], ver: store.changeVersion(board.id) });
  });

  // A board's events a page at a time (see eventsParams): the activity panel,
  // a card's history, what a person hasn't seen. `more` says there is another
  // page after this one, in the order they came in; `total` how many events
  // match, whatever the page; `seq` the board's last event, a cursor for what
  // comes next.
  on(routes.boardEvents, (req, res) => {
    const { since, before, limit, unseen_by, actor, ...cards } = eventsParams.parse(req.query);
    const board = store.getBoard(param(req, 'boardId'));
    const about = { ...Object.fromEntries(Object.entries(cards).map(([kind, id]) => [`${kind}Id`, id])), unseenBy: unseen_by, byAgent: actor };
    const found = store.events(board.id, { ...about, since, before, limit: limit + 1 });
    res.json({ events: found.slice(0, limit), more: found.length > limit, total: store.countEvents(board.id, about), seq: board.seq });
  });

  // The system's own "choose a folder" dialog, for a board's project folder:
  // a page is never told a folder's path, but this server runs on the
  // person's computer and can ask it. It opens there, so only for a person on
  // this computer, not a browser on another device; and it is answered with
  // the folder from the home folder (~/code/app) when it is in it, to be
  // checked as any typed one is when the board is saved.
  on(routes.chooseFolder, personOnly(person), async (req, res) => {
    if (!fromThisComputer(req)) {
      res.status(403).json({ error: 'The folder dialog opens on the computer Tricot runs on, not this one. Type the folder\'s path instead.' });
      return;
    }
    if (!info.chooseFolder) throw new BoardError("This Tricot doesn't open a folder dialog. Type the folder's path instead.", 'not_found');
    let chosen: string | undefined;
    try {
      chosen = await info.chooseFolder();
    } catch (error) {
      throw new BoardError((error as Error).message);
    }
    if (!chosen) {
      res.json({});
      return;
    }
    const home = osHome();
    const inside = path.relative(home, chosen);
    const shown = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? `~/${inside.split(path.sep).join('/')}` : chosen;
    res.json({ folder: shown });
  });

  // The board's project files, for its Files view: read from its
  // folder on this computer, so a person's to read (asPerson); an agent has
  // the folder itself. What is listed, and what is kept out, is projectFiles.ts.
  on(routes.projectFiles, personOnly(person), async (req, res) => {
    const board = store.getBoard(param(req, 'boardId'));
    res.json(await listProjectFiles(projectFolderOf(board)));
  });
  on(routes.projectFile, personOnly(person), async (req, res) => {
    const { path: file, lines } = projectFileParams.parse(req.query);
    const board = store.getBoard(param(req, 'boardId'));
    res.json(await readProjectFile(projectFolderOf(board), file, lines));
  });
  // What is inside them: the lines that match, in the files the list shows. The page
  // asking again, or going away, closes the request, which ends the search.
  on(routes.projectSearch, personOnly(person), async (req, res) => {
    const { q, case: matchCase, word, regex } = projectSearchParams.parse(req.query);
    const board = store.getBoard(param(req, 'boardId'));
    const stop = new AbortController();
    res.on('close', () => stop.abort());
    res.json(await searchProjectFiles(projectFolderOf(board), { q, matchCase: matchCase === '1', word: word === '1', regex: regex === '1' }, stop.signal));
  });
  // A picture of it, as it is, for Files to show: only a picture's
  // bytes, typed by its name, never sniffed, and never run if opened on its
  // own (an SVG's scripts); read anew each time, as the file can change.
  on(routes.projectImage, personOnly(person), async (req, res, next) => {
    const { path: file } = projectFileParams.parse(req.query);
    const board = store.getBoard(param(req, 'boardId'));
    const { real, type } = await projectImage(projectFolderOf(board), file);
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
    res.sendFile(real, { dotfiles: 'allow', headers }, (error) => {
      if (!error) return;
      if (!res.headersSent) res.removeHeader('Content-Type');
      next(error);
    });
  });
  // A file someone edits or pairs on in Files keeps its code block on the
  // board's Files canvas: found again, or made from the file as
  // it is now, the first time.
  on(routes.projectFileBlock, personOnly(person), async (req, res) => {
    const body = bodies.fileBlock.parse(req.body);
    const board = store.getBoard(param(req, 'boardId'));
    const read = await readProjectFile(projectFolderOf(board), body.path);
    const code = blockCode(read);
    // Found again, it is brought up to the file as it is now, as an agent pairing on it changes the file itself.
    const { block, pageId, made } = store.syncFileBlock(board.id, code, human(body.actor));
    res.status(made ? 201 : 200).json({ block, pageId });
  });
  // A person's edit to a project file, saved over it on this computer:
  // so one of their seats (tier B), as deciding is; and only over the version
  // they opened, never over what an agent saved since (a 409 saying so). The
  // file's block on the Files canvas follows what was saved, made if need be.
  on(routes.projectFileWrite, seated, async (req, res) => {
    const body = bodies.fileWrite.parse(req.body);
    const board = store.getBoard(param(req, 'boardId'));
    const saved = await writeProjectFile(projectFolderOf(board), body.path, body.text, body.base);
    const actor = human(body.actor);
    const code = blockCode(saved);
    const { block, made } = store.fileBlock(board.id, code, actor);
    const kept = made ? block : store.updateBlock(block.id, { text: saved.text, start: saved.start, total: saved.total ?? 0, commit: saved.commit ?? '' }, actor);
    res.json({ file: saved, block: kept });
  });

  // A new title gives the board a new id; the response carries it.
  on(routes.updateBoard, (req, res) => {
    const { actor, ...patch } = bodies.updateBoard.parse(req.body);
    res.json(store.updateBoard(param(req, 'boardId'), patch, human(actor)));
  });

  on(routes.archiveBoard, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    res.json(store.setArchived(param(req, 'boardId'), true, human(body.actor)));
  });

  on(routes.unarchiveBoard, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    res.json(store.setArchived(param(req, 'boardId'), false, human(body.actor)));
  });

  // Deletes an archived board for good, for a person who typed its title.
  // There is no agent tool for it: agents never delete a board.
  on(routes.deleteBoard, seated, (req, res) => {
    const body = bodies.deleteBoard.parse(req.body);
    const board = store.getBoard(param(req, 'boardId'));
    store.deleteBoard(board.id, human(body.actor), body.confirm);
    presence?.forget(boardKey(board));
    steps?.forget(boardKey(board));
    pairing?.forget(boardKey(board));
    res.json({ ok: true });
  });

  // Asks agents to bring the board context up to date, all of it or the blocks
  // a person selected, or cancels that.
  on(routes.requestSync, (req, res) => {
    const body = bodies.sync.parse(req.body);
    res.json(store.requestSync(param(req, 'boardId'), body.blockIds, human(body.actor)));
  });

  on(routes.cancelSync, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    res.json(store.cancelSync(param(req, 'boardId'), human(body.actor)));
  });

  // Asks agents for something on the board context ("Get me an architecture
  // view of the project"), or cancels a request that's open or being answered.
  on(routes.askAgents, (req, res) => {
    const body = bodies.askAgents.parse(req.body);
    store.askAgents(param(req, 'boardId'), body.text, human(body.actor));
    res.json(store.getBoard(param(req, 'boardId')));
  });

  // About blocks a person selected on a Sketchbook page: asking agents for a
  // decision, tasks or anything about them, whose answer lands beside them (the
  // page starts a thread about them now, startThread with blockIds, and this
  // stays for what already asks here). Keeping copies of them in the board
  // context is a part's.
  on(routes.askOnPage, (req, res) => {
    const { actor, blockIds, kind, text } = bodies.askOnPage.parse(req.body);
    res.status(201).json(store.askOnPage(param(req, 'pageId'), { blockIds, kind, text }, human(actor)));
  });

  on(routes.cancelRequest, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    store.cancelRequest(param(req, 'requestId'), human(body.actor), param(req, 'boardId'));
    res.json(store.getBoard(param(req, 'boardId')));
  });

  // Threads: conversations with agents. People start one with a message, and
  // write in it; agents answer over MCP.
  on(routes.boardThreads, (req, res) => {
    res.json(store.getBoard(param(req, 'boardId')).threads ?? []);
  });

  // In Files, `file` is the project file open there: the thread starts on its
  // block on the Files canvas, made, or brought up to the file, with the thread.
  // Reading the file is the person's, as Files' own routes are.
  on(routes.startThread, async (req, res) => {
    const body = bodies.startThread.parse(req.body);
    const boardId = param(req, 'boardId');
    if (body.file === undefined) {
      res.status(201).json(store.startThread(boardId, body.body, human(body.actor), body.lens, { door: body.door, pageId: body.pageId, blockIds: body.blockIds, messageLens: body.messageLens }));
      return;
    }
    if (body.pageId !== undefined || body.blockIds?.length) throw new BoardError('A thread about a file is started on the file alone: leave out the page and the blocks.');
    const read = await readProjectFile(projectFolderOf(store.getBoard(boardId)), body.file);
    res.status(201).json(store.startThreadOnFile(boardId, body.body, human(body.actor), body.lens, blockCode(read), { door: body.door, messageLens: body.messageLens }));
  });

  // What the Board Context's Ask agents bar sent, before the chat bar: a
  // message in the board's General thread, which the first one starts.
  on(routes.askInGeneral, (req, res) => {
    const body = bodies.message.parse(req.body);
    res.status(201).json(store.askInGeneral(param(req, 'boardId'), body.body, human(body.actor)));
  });

  on(routes.thread, (req, res) => {
    res.json(store.getThread(param(req, 'threadId')).thread);
  });

  on(routes.postToThread, (req, res) => {
    const body = bodies.threadMessage.parse(req.body);
    res.json(store.postToThread(param(req, 'threadId'), body.body, human(body.actor), [], body.messageLens));
  });

  // Agents answer through the lens from then on.
  on(routes.setThreadLens, (req, res) => {
    const body = bodies.threadLens.parse(req.body);
    res.json(store.setThreadLens(param(req, 'threadId'), body.lens, human(body.actor)));
  });

  // Server-sent events: each change to the board, and who is on it (see live.ts),
  // and to a person, the requests for permission waiting, and, asked for while
  // its Files view is open (`files=1`), what changes in its project folder.
  on(routes.boardStream, (req, res) => {
    const reader = readerFor(req);
    openStream(store, presence, req, res, param(req, 'boardId'), steps, reader, reader && req.query.files === '1' ? watchFolder : undefined);
  });

  // A Tricot terminal's view of the agents it started and holds to wake on
  // this board (cli/switcher/wake.ts), every few seconds and as each
  // falls asleep or is given something to do: while it holds them they show
  // asleep once their turn is over, and their waits end their turn
  // (sleepers.ts). It hears back each one's record and what is due for it
  // (wakes.ts). A terminal's alone, with its key: Tricot's page acts as the
  // person too, but holds no agent to wake.
  on(routes.wakes, (req, res) => {
    const person = res.locals.person as PersonVerdict | undefined;
    if (!person?.ok || person.from !== 'terminal') {
      res.status(403).json({ error: ONLY_A_TERMINAL });
      return;
    }
    if (!presence) throw new BoardError('Agents are not woken on this server.');
    const { holder, agents, gone } = wakesBody.parse(req.body);
    res.json(heldBy(store, presence, store.getBoard(param(req, 'boardId')), holder, agents, gone ?? []));
  });

  // `tricot listen`, which an agent connected on its own runs in the
  // background to sleep between turns (listeners.ts): it holds the
  // agent asleep while this answer stays open, and ends it when something
  // concerns it. A Tricot terminal's alone, as above: the command registers
  // as one on this computer for the call.
  on(routes.listen, (req, res) => {
    const person = res.locals.person as PersonVerdict | undefined;
    if (!person?.ok || person.from !== 'terminal') {
      res.status(403).json({ error: ONLY_A_TERMINAL });
      return;
    }
    if (!presence) throw new BoardError('Agents are not woken on this server.');
    const { session, listener } = listenBody.parse(req.body);
    serveListener(store, presence, param(req, 'boardId'), session, listener, req, res);
  });

  // Pairing sessions (server/pairing.ts): a person starting one with an agent
  // in a piece's full view, its page saying it is still there, and leaving it.
  // An ended one answers 404 with ended: the page goes back to browsing.
  const pairs = () => {
    if (!pairing) throw new BoardError('Pairing is not offered on this server.');
    return pairing;
  };
  on(routes.startPairing, (req, res) => {
    const { actor, blockId, part, agent } = bodies.pairingStart.parse(req.body);
    res.status(201).json(pairs().start({ blockId, part, person: actor, agent }));
  });
  on(routes.pairingBeat, (req, res) => {
    const { actor, active } = bodies.pairingBeat.parse(req.body);
    const session = pairs().beat(param(req, 'id'), actor, active);
    if (session) res.json(session);
    else res.status(404).json({ error: 'This pairing session has ended.', ended: true });
  });
  on(routes.endPairing, (req, res) => {
    const { actor } = bodies.pairingEnd.parse(req.body);
    const ended = pairs().end(param(req, 'id'), actor);
    if (ended) res.json(ended);
    else res.status(404).json({ error: 'This pairing session has ended.', ended: true });
  });

  // Every board's steps as they come, for the home page's project rows (live.ts),
  // and to a person, the requests for permission waiting.
  on(routes.stepsStream, (req, res) => {
    if (!steps) throw new BoardError('Steps are not kept on this server.');
    openStepsStream(store, steps, req, res, readerFor(req));
  });

  // Where the board is, for a page to check itself against: its latest change
  // and event, and how many of each it has.
  on(routes.boardLive, (req, res) => {
    res.json(store.liveState(param(req, 'boardId')));
  });

  // Search over decisions, tasks, comments, findings and canvas blocks, closed
  // ones included: a board's, or every board's with all=1. kinds is a comma-
  // separated list, open=1 leaves closed cards out. A query under two
  // characters finds nothing.
  const search = (req: Request, boardId?: string) => {
    const params = searchParams.parse(req.query);
    const allBoards = params.all === '1' || params.all === 'true';
    if (!boardId && !allBoards) throw new BoardError('Search a board at /api/boards/:boardId/search, or every board with all=1.');
    const openOnly = params.open === '1' || params.open === 'true';
    return searchStore(store, params.q ?? '', { boardId, allBoards, kinds: params.kinds, openOnly, limit: params.limit });
  };
  on(routes.boardSearch, (req, res) => {
    res.json(search(req, param(req, 'boardId')));
  });
  on(routes.search, (req, res) => {
    res.json(search(req));
  });

  // A 👍, 👎 or 👀 on a comment or thread message, or with remove, taking one's
  // own back (core/reactions.ts). Answers with the comment or message.
  const react = (place: ReactionPlace, req: Request) => {
    const { actor, ...input } = bodies.react.parse(req.body);
    return store.react(place, { ...input, commentId: param(req, 'commentId') }, human(actor)).item;
  };
  on(routes.reactToThreadMessage, (req, res) => {
    res.json(react({ threadId: param(req, 'threadId') }, req));
  });
  on(routes.reactToPinComment, (req, res) => {
    res.json(react({ pinId: param(req, 'pinId') }, req));
  });

  // ---- canvas --------------------------------------------------------------

  // The Sketchbook's pages: people make, rename and arrange them, and delete
  // one for good once they confirm (its blocks go with it).
  on(routes.addPage, (req, res) => {
    const body = bodies.addPage.parse(req.body);
    res.status(201).json(store.addPage(param(req, 'boardId'), body.title, human(body.actor)));
  });

  on(routes.updatePage, (req, res) => {
    const { actor, title, after } = bodies.updatePage.parse(req.body);
    const pageId = param(req, 'pageId');
    if (title !== undefined) store.renamePage(pageId, title, human(actor));
    res.json(after !== undefined ? store.movePage(pageId, after, human(actor)) : store.getPage(pageId).page);
  });

  on(routes.deletePage, seated, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    store.deletePage(param(req, 'pageId'), human(body.actor));
    res.json({ ok: true });
  });

  on(routes.addBlock, (req, res) => {
    const { actor, ...input } = canvasBodies.addBlock.parse(req.body);
    res.status(201).json(store.addBlock(canvasBody(store.cardKinds(), canvasBodies.addBlock).parse(req.body), input, human(actor)));
  });

  on(routes.updateBlock, (req, res) => {
    const { actor, rev, ...patch } = canvasBodies.patchBlock.parse(req.body);
    res.json(store.updateBlock(param(req, 'id'), patch, human(actor), rev));
  });

  // Make a chart: a bar chart of a table's numbers, beside it (what a table's kind derives).
  on(routes.deriveBlock, (req, res) => {
    const { actor } = bodies.actorOnly.parse(req.body);
    res.status(201).json(store.deriveBlock(param(req, 'id'), human(actor)));
  });

  // A block's versions, newest (the current one) first, without their content;
  // then any earlier one in full, to preview it.
  on(routes.blockVersions, (req, res) => {
    const block = store.blockOf(param(req, 'id'));
    res.json({ rev: block.rev, versions: store.versionSummaries(block.id) });
  });

  on(routes.blockVersion, (req, res) => {
    res.json(store.blockVersion(param(req, 'id'), Number(param(req, 'rev'))));
  });

  // A person deletes an earlier version, or all of them; the current one
  // stays. Kept aside like a removed item: /canvas/items/:id/restore with the
  // id sent back puts them back.
  on(routes.deleteVersion, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    const rev = z.coerce.number().int().parse(param(req, 'rev'));
    const { id, kind, label } = store.deleteVersion(param(req, 'id'), rev, human(body.actor));
    res.json({ ok: true, deleted: { id, kind, label } });
  });

  on(routes.deleteEarlierVersions, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    const { id, kind, label } = store.deleteEarlierVersions(param(req, 'id'), human(body.actor));
    res.json({ ok: true, deleted: { id, kind, label } });
  });

  on(routes.restoreBlock, (req, res) => {
    const { actor, rev, blockRev } = canvasBodies.restore.parse(req.body);
    res.json(store.restoreBlock(param(req, 'id'), rev, human(actor), blockRev));
  });

  // Pins part of a block to a comment from a person's prompt, or to work that
  // already exists. A task or a question made from a pin is a part's, with the
  // rest of its routes.
  on(routes.pinComment, (req, res) => {
    const { actor, part, body, ask } = canvasBodies.pinComment.parse(req.body);
    res.status(201).json(store.pinComment(param(req, 'id'), part, body, human(actor), { ask: Boolean(ask) }));
  });

  // Replies about a pinned part people commented on, and resolving its thread.
  on(routes.commentOnPin, (req, res) => {
    const body = bodies.comment.parse(req.body);
    res.json(store.commentOnPin(param(req, 'id'), body.body, human(body.actor)));
  });

  on(routes.resolvePin, (req, res) => {
    const { actor, resolved } = canvasBodies.resolvePin.parse(req.body);
    res.json(store.resolvePin(param(req, 'id'), resolved, human(actor)));
  });

  on(routes.pinToCard, (req, res) => {
    const { actor, part } = canvasBodies.pin.parse(req.body);
    res.status(201).json(store.pin(param(req, 'id'), part, cardIdsOf(store.cardKinds()).parse(req.body), human(actor)));
  });

  on(routes.moveItems, (req, res) => {
    const { actor, moves } = canvasBodies.move.parse(req.body);
    store.moveItems(canvasBody(store.cardKinds(), canvasBodies.move).parse(req.body), moves, human(actor));
    res.json({ ok: true });
  });

  // Blocks copied from any canvas of this Tricot, pasted on this one: the
  // store makes the copies (core/store/pasting.ts).
  on(routes.pasteBlocks, (req, res) => {
    const { actor, ids, at } = canvasBodies.pasteBlocks.parse(req.body);
    res.status(201).json(store.pasteBlocks(canvasBody(store.cardKinds(), canvasBodies.pasteBlocks).parse(req.body), { ids, at }, human(actor)));
  });

  on(routes.addGroup, (req, res) => {
    const { actor, ...input } = canvasBodies.addGroup.parse(req.body);
    res.status(201).json(store.addGroup(canvasBody(store.cardKinds(), canvasBodies.addGroup).parse(req.body), input, human(actor)));
  });

  on(routes.renameGroup, (req, res) => {
    const body = canvasBodies.renameGroup.parse(req.body);
    res.json(store.renameGroup(param(req, 'id'), body.title, human(body.actor)));
  });

  on(routes.addLink, (req, res) => {
    const body = canvasBodies.addLink.parse(req.body);
    res.status(201).json(store.addLink(body.from, body.to, body.label, human(body.actor), body.weight));
  });

  on(routes.relabelLink, (req, res) => {
    const body = canvasBodies.relabelLink.parse(req.body);
    res.json(store.relabelLink(param(req, 'id'), body.label, human(body.actor)));
  });

  // Removing an item (or deleting a thread) keeps it aside for 30 days;
  // restoring puts it back as it was, with the same id, and says what
  // couldn't come back.
  on(routes.removeItem, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    const { id, kind, label } = store.removeItem(param(req, 'id'), human(body.actor));
    res.json({ ok: true, deleted: { id, kind, label } });
  });

  on(routes.restoreItem, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    const { deletion, notes } = store.restoreItem(param(req, 'id'), human(body.actor));
    res.json({ restored: { id: deletion.id, kind: deletion.kind, label: deletion.label }, notes });
  });

  // Images are stored as files; the type is checked from the bytes.
  on(routes.uploadAsset, express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'Send the image as the request body with an image/* content type.' });
      return;
    }
    // With the picture's size, so a new block can start at it.
    const assetId = store.saveAsset(req.body);
    const size = store.assetSize(assetId);
    res.status(201).json({ assetId, ...(size && { width: size.width, height: size.height }) });
  });

  on(routes.asset, (req, res, next) => {
    const { file, mimeType } = store.assetFile(param(req, 'id'));
    // The default data folder is ~/.tricot, and sendFile refuses
    // paths through dot-folders unless told otherwise. The path is built from
    // a validated asset id, so allowing it is safe.
    const headers = {
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    };
    res.sendFile(path.resolve(file), { dotfiles: 'allow', headers }, (error) => {
      if (!error) return;
      // sendFile sets the headers before reading the file, so a failed read
      // would otherwise be cached by browsers for a year as if it were the image.
      if (!res.headersSent) {
        res.removeHeader('Cache-Control');
        res.removeHeader('Content-Type');
      }
      next(error);
    });
  });

  // What a part of Tricot adds (apiParts.ts), here and nowhere else: after the
  // gate above, so a part's changes are a person's and its tiers are its own,
  // and before the 404 and the error handler below, which are its too.
  const kit: ApiKit = { store, presence, ...(connectors && { connectors }), on, seated, personOnly: (tier) => personOnly(person, tier), human, param, react, onApprovalAnswered: (listener) => void approvals?.onAnswered(listener) };
  needsSource = parts.needs(kit);
  parts.mount(api, kit);

  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof BoardError) {
      const status = { not_found: 404, conflict: 409, invalid: 400 }[error.code];
      res.status(status).json({ error: error.message });
    } else if (error instanceof ZodError) {
      res.status(400).json({ error: describeIssues(error) });
    } else if (typeof error?.status === 'number' && error.status < 500) {
      res.status(error.status).json({ error: error.status === 413 ? 'That is too large.' : error.message });
    } else {
      console.error(error);
      res.status(500).json({ error: 'Internal error' });
    }
  };
  api.use(errors);

  return api;
}
