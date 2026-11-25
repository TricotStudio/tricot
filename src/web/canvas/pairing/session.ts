// A piece's pairing, from its full view (core/pairing.ts): the mode the view
// is in, Browse (or Read) or Pair; the agent to pair with: a session of its own
// (core/roles.ts), first where a Tricot terminal holding the board's
// coordinator can start one (`fresh`), and always once the person had one on
// this page (`own`, theirs again: one session serves every piece of a
// Sketchbook page, of Files, or of the board context); else one picked from the board's agents by
// the rule every place that names one asks (core/whoAnswers.ts: the one the
// piece names, offer.ts, else the most reachable, never the coordinator, which
// is pickable but stays free for the chat bar);
// the session the server keeps while pairing (server/pairing.ts),
// started as Pair is picked, kept alive while the page is there, and ended
// on leaving it; and what the session asked, read from the board.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { samePerson } from '../../../core/format';
import { ownName } from '../../../core/homeConversation';
import { pairedPlace } from '../../../core/homePairing';
import { addressTo, PAIRING_BEAT_MS, pairingRequests, type PairingRequest, type PairingSession } from '../../../core/pairing';
import { pairingThreadOf } from '../../../core/roles';
import type { Block } from '../../../core/types';
import { agentsOf, whoAnswers } from '../../../core/whoAnswers';
import { api, type RequestError } from '../../shared/api';
import { useAgents } from '../../agents';
import { ownedBy, useCanvas } from '../context';
import { pieceAgents, type AgentChoice, type CardAgent } from './offer';

export type { AgentChoice } from './offer';

const LAST_AGENT = 'tricot:pair-agent'; // the agent this browser last paired with

export type PairMode = 'browse' | 'pair';

// The picker's choice of a session of its own, in place of an agent's name.
export const NEW_SESSION = '\u0000new';

// A session of its own, as it can be offered here: the agent kind a terminal starts it as, whose kind it is ("Claude"),
// and its name when the person had one on this page (theirs again).
export interface FreshSession {
  launch: string;
  by: string;
  name?: string;
}

export interface Pairing {
  mode: PairMode;
  agent: string | null; // the agent requests are addressed to: none for a new session not started yet, or no agent at all
  who: string | null; // what the view calls it: the agent, or "a new Claude session"
  fresh: FreshSession | null; // a session of its own can be had here
  own: boolean; // the choice is a session of its own
  // A session of its own: its first request still to make it, made and its agent starting, held back by the terminal
  // (as many pairing sessions at work as it runs at once, or no free tab), or its agent up.
  ownState: 'first' | 'starting' | 'busy' | 'full' | 'up' | null;
  agents: AgentChoice[];
  session: PairingSession | null;
  requests: PairingRequest[]; // what the session asked, in order
  note: string | null; // said as a session ended, or couldn't start
  readOnly: boolean;
  busy: boolean; // a session is starting
  pair(agent?: string): void; // pair, with this agent (NEW_SESSION: a session of its own) when given
  browse(): void;
  dismissNote(): void;
  // A request's text as it is sent: addressed to the agent while pairing.
  address(text: string): string;
}

function lastAgent(): string | null {
  try {
    return localStorage.getItem(LAST_AGENT);
  } catch {
    return null;
  }
}

function keepAgent(name: string): void {
  try {
    localStorage.setItem(LAST_AGENT, name);
  } catch {
    // Storage unavailable: no tie is broken by it next time.
  }
}

// `readOnly`: the view shows what can't be paired on (an earlier version).
// `start: 'pair'`: it opens already paired, with the agent Pair would pick
// (the Files view's Pair), or `agent` (a pairing opened from Home), once;
// else it opens browsing.
// `own: false`: a piece whose requests go another way than a pin's routes (a Google Doc's, its connector's), which the
// server doesn't see to make a session's thread from: no session of its own is offered.
export function usePairing(block: Block, name: string, part: string, options: { readOnly?: boolean; start?: PairMode; agent?: string; own?: false } = {}): Pairing {
  const canvas = useCanvas();
  const { board, owner } = canvas;
  const readOnly = canvas.readOnly || Boolean(options.readOnly);
  const presence = useAgents();
  const [mode, setMode] = useState<PairMode>('browse');
  const [picked, setPicked] = useState<string | null>(null); // picked in this view, or paired with there
  const [last] = useState(lastAgent);
  const [session, setSession] = useState<PairingSession | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const current = useRef<PairingSession | null>(null);
  current.current = session;
  const starting = useRef(false); // a session is being started: a second press waits for it
  const [busy, setBusy] = useState(false); // …and the switch says so
  const wanted = useRef<PairMode>('browse'); // the mode last picked, as a session that was starting lands
  const touched = useRef(false); // the person did something since the last beat

  const agents = useMemo<AgentChoice[]>(() => agentsOf(board, presence), [board, presence]);
  const threads = board.threads;
  // A card that is not a task names nobody: it has no assignee and no claim.
  const named = useMemo(() => pieceAgents(block, { task: owner?.card as CardAgent | undefined, threads }), [block, owner, threads]);
  // A session of its own: theirs on this page again, else a new one a terminal holding a coordinator here starts. Not
  // on a card's canvas, whose comments are its card's.
  // One serves the whole page the block is on (a Sketchbook page, Files, or the board context).
  const place = owner || options.own === false ? undefined : pairedPlace(board, block.id);
  const offers = Boolean(place);
  const starter = offers ? agents.find((a) => a.starts && a.state !== 'unseen' && a.state !== 'away') : undefined;
  // Theirs on this page of the kind a terminal starts now (another kind's is another session), else their latest.
  const before = place ? pairingThreadOf(board, place.pageId, name, starter?.starts ? { kind: starter.starts } : {}) : undefined;
  const fresh = useMemo<FreshSession | null>(
    () => (before?.launch ? { launch: starter?.starts ?? before.launch, by: ownName(before.owner!), name: before.owner! } : starter?.starts ? { launch: starter.starts, by: ownName(starter.name) } : null),
    [before?.launch, before?.owner, starter?.starts, starter?.name],
  );
  // What the view pairs with: the choice made here, else a session of its own where one can be had, else the rule.
  const choice = picked && before && samePerson(picked, before.owner!) ? NEW_SESSION : (picked ?? (fresh ? NEW_SESSION : null));
  const own = choice === NEW_SESSION && Boolean(fresh);
  const agent = own ? (session?.agent ?? fresh!.name ?? null) : whoAnswers({ agents, picked: choice, named, last, pick: true });
  const who = own && !agent ? `a new ${fresh!.by} session` : agent;
  const up = Boolean(agent && presence.some((a) => samePerson(a.name, agent) && a.state !== 'away'));
  const held = before && presence.flatMap((a) => a.holds ?? []).find((h) => h.thread === before.id);
  const ownState = !own ? null : up ? 'up' : before?.status !== 'working' ? 'first' : held ? held.why : 'starting';

  const leave = useCallback(
    async (said: (summary?: string) => string | null) => {
      const ending = current.current;
      if (!ending) return;
      current.current = null;
      setSession(null);
      try {
        const { summary } = await api.endPairing(ending.id, name);
        setNote(said(summary));
      } catch {
        setNote(said());
      }
    },
    [name],
  );

  const start = useCallback(
    async (who: string | FreshSession) => {
      try {
        const started = await api.startPairing(name, { blockId: block.id, part, ...(typeof who === 'string' ? { agent: who } : { launch: who.launch }) });
        if (wanted.current !== 'pair') return void api.endPairing(started.id, name).catch(() => undefined); // left meanwhile
        current.current = started;
        setSession(started);
        // The agent paired with stays the one offered, whoever starts listening meanwhile; a session of its own stays one.
        if (typeof who !== 'string') return;
        setPicked(started.agent);
        keepAgent(started.agent);
      } catch (e) {
        setNote(`Couldn't start pairing with ${typeof who === 'string' ? who : `a new ${who.by} session`}: ${(e as Error).message}`);
      }
    },
    [name, block.id, part],
  );

  const pair = useCallback(
    (next?: string) => {
      if (readOnly) return;
      // Their own session's agent, picked by name (Open from Home), is that session again.
      const asked = next && before && samePerson(next, before.owner!) ? NEW_SESSION : next;
      const fresher = (asked ?? choice) === NEW_SESSION ? fresh : null;
      const who: string | FreshSession | null = fresher ?? (asked && asked !== NEW_SESSION ? asked : agent);
      if (asked) {
        setPicked(asked);
        if (asked !== NEW_SESSION) keepAgent(asked);
      }
      setMode('pair');
      wanted.current = 'pair';
      setNote(null);
      if (!who || starting.current) return; // no agent on the board: requests go to whoever takes them
      const was = current.current;
      if (was && (typeof who === 'string' ? samePerson(was.agent, who) : Boolean(was.launch))) return;
      starting.current = true;
      setBusy(true);
      void (async () => {
        if (was) await leave((summary) => summary ?? null);
        await start(who);
        starting.current = false;
        setBusy(false);
      })();
    },
    [readOnly, agent, choice, fresh, before, leave, start],
  );

  const began = useRef(false);
  useEffect(() => {
    if (began.current || options.start !== 'pair' || readOnly) return;
    began.current = true;
    pair(options.agent);
  }, [options.start, options.agent, readOnly, pair]);

  const browse = useCallback(() => {
    setMode('browse');
    wanted.current = 'browse';
    void leave((summary) => summary ?? null);
  }, [leave]);

  // While pairing: the page says it is there, and whether the person did
  // anything since; a session the server ended (idle, or from another tab)
  // puts the view back to browsing.
  useEffect(() => {
    if (!session) return;
    const touch = () => (touched.current = true);
    document.addEventListener('pointerdown', touch, true);
    document.addEventListener('keydown', touch, true);
    const timer = setInterval(() => {
      const active = touched.current;
      touched.current = false;
      api.pairingBeat(session.id, name, active).catch((e: RequestError) => {
        // Ended on the server; a beat lost on the way is only that, and the next one says so again.
        if (e.status !== 404 || current.current?.id !== session.id) return;
        current.current = null;
        setSession(null);
        setMode('browse');
        wanted.current = 'browse';
        setNote(`Pairing with ${session.agent} ended: nothing was asked for a while, or it moved to another tab.`);
      });
    }, PAIRING_BEAT_MS);
    // The page going away ends it, as it goes.
    const away = () => current.current && api.leavePairing(current.current.id, name);
    window.addEventListener('pagehide', away);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', touch, true);
      document.removeEventListener('keydown', touch, true);
      window.removeEventListener('pagehide', away);
    };
  }, [session, name]);

  // Closing the view ends the session.
  useEffect(
    () => () => {
      wanted.current = 'browse';
      if (current.current) api.leavePairing(current.current.id, name);
      current.current = null;
    },
    [name],
  );

  const pins = canvas.pins.get(block.id);
  const requests = useMemo(() => (session ? pairingRequests(pins ?? [], ownedBy({ owner }), session) : []), [session, pins, owner]);
  const names = useMemo(() => agents.map((a) => a.name), [agents]);
  const address = useCallback((text: string) => (mode === 'pair' && agent ? addressTo(text, agent, names) : text), [mode, agent, names]);

  return {
    mode,
    agent,
    who,
    fresh,
    own,
    ownState,
    agents,
    session,
    requests,
    note,
    readOnly,
    busy,
    pair,
    browse,
    dismissNote: () => setNote(null),
    address,
  };
}
