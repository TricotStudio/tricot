import path from 'node:path';
import express, { Router, type ErrorRequestHandler, type Request } from 'express';
import { z, ZodError } from 'zod';
import { findKind } from '../core/blocks/registry';
import { deletionSummaries, type Deletion } from '../core/deletions';
import type { StartFolder } from '../core/firstRun';
import { needsAcross } from '../core/needs';
import { BoardError, type ReactionPlace, type Store } from '../core/store';
import { searchStore } from '../core/search';
import { agentsWithSkills, tasksOf } from '../core/skills';
import { boardAgents } from '../core/mentions';
import { agentStep, agentStepName, agentsParams, canvas as canvasBodies, describeIssues, dismissNeeds, eventsParams, needsParams, people as bodies, searchParams, seenCursors } from '../core/schemas';
import { asPerson, peopleChange, personOnly, readerOf, type PersonGate, type Tier } from './access';
import type { Approvals } from './approvals';
import { openStepsStream, openStream, type Reader } from './live';
import type { PairingSessions } from './pairing';
import type { Presence } from './presence';
import type { Seats } from './seats';
import type { Steps } from './steps';
import { boardKey, type Actor, type Block } from '../core/types';
import { routes } from '../core/routes';
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

function param(req: Request, name: string): string {
  return String(req.params[name]);
}

export function createApiRouter(
  store: Store,
  info: { mcpUrl: string; version?: string; source?: string; folder?: StartFolder },
  presence?: Presence,
  steps?: Steps,
  pairing?: PairingSessions,
  approvals?: Approvals, // agents waiting for a person's OK, on the pages' streams (live.ts)
  person: PersonGate = (req, tier) => asPerson(req, tier), // who is a person, and at which tier (access.ts); the app's, with its terminals and seats
  seats?: Seats, // the person's seats (seats.ts): their streams' tickets, and the admissions they answer
): Router {
  const api = Router();
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
    if (!steps) throw new BoardError('Steps are not kept on this server.');
    const result = steps.record(name, step);
    res.status(result.shown ? 201 : result.reason === 'limited' ? 429 : 202).json(result);
  });

  // Every other change below is a person's (access.ts asPerson): made in
  // Tricot's page, or at a Tricot terminal (tier A). The name it is made in
  // comes in the request (human() below), so a plain call from curl or a
  // script is refused before any route reads it. Agents change boards
  // through MCP, as themselves. What is consequential needs one of the
  // person's seats too (tier B, `seated` on the route, T187): deciding,
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
  // A task's change is consequential when it moves the task (marking it
  // ready, sending it back, closing it) or approves its commit; renaming it,
  // its links, its place in its lane and who it's for are not.
  const taskChange = (req: Request): Tier => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return body.status !== undefined || body.approveCommit !== undefined || body.nothingToCommit !== undefined ? 'B' : 'A';
  };

  // `app` and `pid` let the `tricot` command tell its own server from anything
  // else on a port. `version` and `source` (the repository's page) are for the
  // foot of Home. `folder`: where it was started, from ~ (startFolder.ts),
  // for Home's first run; read-only, and behind the same access rules as every route.
  on(routes.info, (_req, res) => {
    res.json({ ...info, app: 'tricot', pid: process.pid });
  });

  on(routes.boards, (_req, res) => {
    res.json(store.listBoards());
  });

  // What needs this person across every board in use, most urgent first,
  // with each board's work and the agents on it, for Home and the inbox.
  // `seen` is a JSON object of the last event they saw on each board, by its
  // key, as their browser keeps it; a board left out has nothing unseen.
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
    res.json(
      needsAcross(boards, params.name, {
        seen,
        dismissed: store.dismissedNeeds(params.name),
        unseen: (board, since) => store.events(board.id, { since, unseenBy: params.name }),
        present: (board) => presence?.list(boardKey(board)) ?? [],
        // Connected, but on no board in use: a session just started, before
        // any project (Home's first run), or only on archived ones.
        connected: (presence?.agents() ?? []).filter((a) => a.board === undefined || !inUse.has(a.board)).map(({ board: _board, ...agent }) => agent),
      }),
    );
  });

  // What this person dismissed from their Needs you, by board key, for the
  // board page's own pill; a dismissal is theirs, kept for every browser.
  on(routes.dismissedNeeds, (req, res) => {
    res.json(store.dismissedNeeds(needsParams.pick({ name: true }).parse(req.query).name));
  });

  on(routes.dismissNeeds, (req, res) => {
    const body = dismissNeeds.parse(req.body);
    store.dismissNeeds(body.board, body.name, body.items);
    res.json(store.dismissedNeeds(body.name));
  });

  // The agents and the skills each reported, for the "/" list in a composer
  // and the user menu. With ?board=, where each is on that board (listening or
  // working: a request reaches it now; else it runs next time it connects).
  on(routes.agents, (req, res) => {
    const { board } = agentsParams.parse(req.query);
    const here = board === undefined ? undefined : store.getBoard(board);
    const seen = (presence?.agents(here && boardKey(here)) ?? []).map(({ board: key, ...agent }) => {
      const on = here ?? (key === undefined ? undefined : store.getBoard(key)); // presence keys on a board's first id, which still resolves; none: only connected
      return on ? { ...agent, board: { id: on.id, title: on.title } } : agent;
    });
    res.json(agentsWithSkills(store.agentSkills(), seen, store.tricotSkills(), here ? boardAgents(here, seen.map((a) => a.name)) : []));
  });

  // The tasks an agent has claimed and not finished, on every board in use.
  on(routes.agentWork, (req, res) => {
    const boards = store.listBoards().flatMap((b) => (b.archived ? [] : [store.getBoard(b.id)]));
    res.json(tasksOf(boards, param(req, 'name')));
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
    res.status(201).json(store.createBoard({ title: body.title, goal: body.goal }, human(body.actor)));
  });

  // Presence rides along with the board but is never saved with it, and `ver`
  // is the number of its latest change: the stream goes on from there (live.ts).
  // An earlier id answers too; the board's id field says where it lives now.
  on(routes.board, (req, res) => {
    const board = store.getBoard(param(req, 'boardId'));
    store.lapseFirstLooks(board); // a first look that ran out of time reads as open again
    res.json({ ...board, presence: presence?.list(boardKey(board)) ?? [], ver: store.changeVersion(board.id) });
  });

  // A board's events a page at a time (see eventsParams): the activity panel,
  // a card's history, what a person hasn't seen. `more` says there is another
  // page after this one, in the order they came in; `total` how many events
  // match, whatever the page; `seq` the board's last event, a cursor for what
  // comes next.
  on(routes.boardEvents, (req, res) => {
    const { decision, task, unseen_by, actor, limit, ...cursor } = eventsParams.parse(req.query);
    const board = store.getBoard(param(req, 'boardId'));
    const about = { decisionId: decision, taskId: task, unseenBy: unseen_by, byAgent: actor };
    const found = store.events(board.id, { ...about, ...cursor, limit: limit + 1 });
    res.json({ events: found.slice(0, limit), more: found.length > limit, total: store.countEvents(board.id, about), seq: board.seq });
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

  on(routes.startThread, (req, res) => {
    const body = bodies.startThread.parse(req.body);
    res.status(201).json(store.startThread(param(req, 'boardId'), body.body, human(body.actor), body.lens, { door: body.door }));
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
    const body = bodies.message.parse(req.body);
    res.json(store.postToThread(param(req, 'threadId'), body.body, human(body.actor)));
  });

  // Agents answer through the lens from then on.
  on(routes.setThreadLens, (req, res) => {
    const body = bodies.threadLens.parse(req.body);
    res.json(store.setThreadLens(param(req, 'threadId'), body.lens, human(body.actor)));
  });

  // Server-sent events: each change to the board, and who is on it (see live.ts),
  // and to a person, the requests for permission waiting.
  on(routes.boardStream, (req, res) => {
    openStream(store, presence, req, res, param(req, 'boardId'), steps, readerFor(req));
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

  on(routes.postDecision, (req, res) => {
    const body = bodies.postDecision.parse(req.body);
    const decision = store.postDecision(
      param(req, 'boardId'),
      {
        question: body.question,
        context: body.context,
        options: body.options?.filter((label) => label.trim()).map((label) => ({ label })),
        area: body.area,
      },
      human(body.actor),
    );
    res.status(201).json(decision);
  });

  on(routes.addOption, (req, res) => {
    const body = bodies.addOption.parse(req.body);
    const decision = store.updateDecision(
      param(req, 'decisionId'),
      { addOptions: [{ label: body.label, description: body.description }] },
      human(body.actor),
    );
    res.json(decision);
  });

  on(routes.reviseDecision, (req, res) => {
    const { actor, question, context, options } = bodies.revise.parse(req.body);
    res.json(store.updateDecision(param(req, 'decisionId'), { question, context, reviseOptions: options }, human(actor)));
  });

  // Files a card under an area, which then stays the person's: agents leave it.
  on(routes.setArea, (req, res) => {
    const { actor, area } = bodies.area.parse(req.body);
    res.json(store.updateDecision(param(req, 'decisionId'), { area }, human(actor)));
  });

  // Asks agents to re-check a card's options against the app as it is now, or cancels that.
  on(routes.requestRefresh, (req, res) => {
    const body = bodies.note.parse(req.body);
    res.json(store.requestRefresh(param(req, 'decisionId'), body.note, human(body.actor)));
  });

  // After deciding a card, asks agents to check the others it may change still
  // hold: a refresh of each, asked together. Answers with the cards asked about.
  on(routes.revisit, (req, res) => {
    const { actor, decisionIds } = bodies.revisit.parse(req.body);
    res.json(store.askToRevisit(param(req, 'decisionId'), decisionIds, human(actor)));
  });

  on(routes.cancelRefresh, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    res.json(store.cancelRefresh(param(req, 'decisionId'), human(body.actor)));
  });

  // Sets a card aside as no longer relevant; reopen brings it back.
  on(routes.retireDecision, seated, (req, res) => {
    const body = bodies.retire.parse(req.body);
    res.json(store.retire(param(req, 'decisionId'), body.note, human(body.actor)));
  });

  // What links to a card, in sentences, for the confirmation before deleting it.
  on(routes.decisionLinks, (req, res) => {
    res.json({ lines: store.decisionLinks(param(req, 'decisionId')) });
  });

  on(routes.taskLinks, (req, res) => {
    res.json({ lines: store.taskLinks(param(req, 'taskId')) });
  });

  // Deletes a card made by mistake, for good, once a person confirmed (a
  // second click; a board's name is typed out, a card's number isn't). There
  // is no agent tool for it: agents never delete a card.
  on(routes.deleteDecision, seated, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    store.deleteDecision(param(req, 'decisionId'), human(body.actor));
    res.json({ ok: true });
  });

  on(routes.resolveDecision, seated, (req, res) => {
    const { actor, ...input } = bodies.resolve.parse(req.body);
    res.json(store.resolve(param(req, 'decisionId'), input, human(actor)));
  });

  on(routes.exploreDecision, (req, res) => {
    const body = bodies.explore.parse(req.body);
    res.json(store.requestExploration(param(req, 'decisionId'), body.note, human(body.actor)));
  });

  on(routes.deferDecision, seated, (req, res) => {
    const body = bodies.defer.parse(req.body);
    res.json(store.defer(param(req, 'decisionId'), body.note, human(body.actor)));
  });

  on(routes.reopenDecision, seated, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    res.json(store.reopen(param(req, 'decisionId'), human(body.actor)));
  });

  on(routes.commentOnDecision, (req, res) => {
    const body = bodies.comment.parse(req.body);
    res.json(store.addComment(param(req, 'decisionId'), body.body, human(body.actor)));
  });

  on(routes.addTask, (req, res) => {
    const { actor, ...task } = bodies.task.parse(req.body);
    const [planned] = store.planTasks(param(req, 'boardId'), [task], human(actor));
    res.status(201).json(planned);
  });

  on(routes.requestPlan, (req, res) => {
    const body = bodies.note.parse(req.body);
    res.json(store.requestPlan(param(req, 'decisionId'), body.note, human(body.actor)));
  });

  on(routes.commentOnTask, (req, res) => {
    const body = bodies.comment.parse(req.body);
    res.json(store.addTaskComment(param(req, 'taskId'), body.body, human(body.actor)));
  });

  // A 👍, 👎 or 👀 on a comment or thread message, or with remove, taking one's
  // own back (core/reactions.ts). Answers with the comment or message.
  const react = (place: ReactionPlace, req: Request) => {
    const { actor, ...input } = bodies.react.parse(req.body);
    return store.react(place, { ...input, commentId: param(req, 'commentId') }, human(actor)).item;
  };
  on(routes.reactToTaskComment, (req, res) => {
    res.json(react({ taskId: param(req, 'taskId') }, req));
  });
  on(routes.reactToDecisionComment, (req, res) => {
    res.json(react({ decisionId: param(req, 'decisionId') }, req));
  });
  on(routes.reactToThreadMessage, (req, res) => {
    res.json(react({ threadId: param(req, 'threadId') }, req));
  });
  on(routes.reactToPinComment, (req, res) => {
    res.json(react({ pinId: param(req, 'pinId') }, req));
  });

  on(routes.updateTask, personOnly(person, taskChange), (req, res) => {
    const { actor, ...patch } = bodies.taskPatch.parse(req.body);
    res.json(store.updateTask(param(req, 'taskId'), patch, human(actor)));
  });

  // Sets a task aside as work that won't be done; bring-back puts it in the backlog or to do.
  on(routes.dropTask, seated, (req, res) => {
    const body = bodies.dropTask.parse(req.body);
    res.json(store.dropTask(param(req, 'taskId'), body.note, human(body.actor)));
  });

  on(routes.bringBackTask, seated, (req, res) => {
    const body = bodies.bringBack.parse(req.body);
    res.json(store.bringBackTask(param(req, 'taskId'), body.to, human(body.actor)));
  });

  on(routes.deleteTask, seated, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    store.deleteTask(param(req, 'taskId'), human(body.actor));
    res.json({ ok: true });
  });

  on(routes.askPeople, (req, res) => {
    const body = bodies.ask.parse(req.body);
    res.json(store.askPeople(param(req, 'decisionId'), body.names, body.note, human(body.actor)));
  });

  on(routes.unask, (req, res) => {
    const body = bodies.unask.parse(req.body);
    res.json(store.unask(param(req, 'decisionId'), body.name, human(body.actor)));
  });

  on(routes.addCriterion, (req, res) => {
    const body = bodies.criterion.parse(req.body);
    const criterion = { label: body.label, description: body.description };
    res.json(store.proposeCriteria(param(req, 'decisionId'), [criterion], human(body.actor)));
  });

  on(routes.removeCriterion, (req, res) => {
    const body = bodies.actorOnly.parse(req.body);
    res.json(store.removeCriterion(param(req, 'decisionId'), param(req, 'criterionId'), human(body.actor)));
  });

  on(routes.mark, (req, res) => {
    const body = bodies.mark.parse(req.body);
    res.json(store.mark(param(req, 'decisionId'), body.criterionId, body.optionId, body.value, human(body.actor)));
  });

  // ---- canvas --------------------------------------------------------------

  on(routes.addBlock, (req, res) => {
    const { actor, boardId, decisionId, taskId, ...input } = canvasBodies.addBlock.parse(req.body);
    res.status(201).json(store.addBlock({ boardId, decisionId, taskId }, input, human(actor)));
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

  // Pins part of a block: to a new task, question or comment from a person's
  // prompt, or to work that already exists.
  on(routes.pinTask, personOnly(person, (req) => (req.body?.ready ? 'B' : 'A')), (req, res) => {
    const { actor, part, text, ready } = canvasBodies.pinTask.parse(req.body);
    res.status(201).json(store.pinTask(param(req, 'id'), part, { text, ready }, human(actor)));
  });

  on(routes.pinQuestion, (req, res) => {
    const { actor, part, text } = canvasBodies.pinQuestion.parse(req.body);
    res.status(201).json(store.pinQuestion(param(req, 'id'), part, { text }, human(actor)));
  });

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
    const { actor, part, taskId, decisionId } = canvasBodies.pin.parse(req.body);
    res.status(201).json(store.pin(param(req, 'id'), part, { taskId, decisionId }, human(actor)));
  });

  on(routes.moveItems, (req, res) => {
    const { actor, boardId, decisionId, taskId, moves } = canvasBodies.move.parse(req.body);
    store.moveItems({ boardId, decisionId, taskId }, moves, human(actor));
    res.json({ ok: true });
  });

  on(routes.addGroup, (req, res) => {
    const { actor, boardId, decisionId, taskId, ...input } = canvasBodies.addGroup.parse(req.body);
    res.status(201).json(store.addGroup({ boardId, decisionId, taskId }, input, human(actor)));
  });

  on(routes.renameGroup, (req, res) => {
    const body = canvasBodies.renameGroup.parse(req.body);
    res.json(store.renameGroup(param(req, 'id'), body.title, human(body.actor)));
  });

  on(routes.addLink, (req, res) => {
    const body = canvasBodies.addLink.parse(req.body);
    res.status(201).json(store.addLink(body.from, body.to, body.label, human(body.actor)));
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
