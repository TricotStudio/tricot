import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Express, Request } from 'express';
import { lineMatches, searchPattern, type ProjectSearch } from '../src/core/projectSearch';
import { SEAT_GONE, SEAT_NEEDED } from '../src/core/seats';
import type { Store } from '../src/core/store';
import { asPerson, fromThisComputer, HOST_KEY_HEADER, HOST_LET_GO, NEEDS_SEAT, NOT_A_PERSON } from '../src/server/access';
import { createApiRouter } from '../src/server/api';
import { ApiParts } from '../src/server/apiParts';
import { AnswerHosts } from '../src/server/answerHosts';
import { Connectors } from '../src/server/connectors';
import { createConnectorsRouter } from '../src/server/connectors/routes';
import { Seats } from '../src/server/seats';
import { letIn, type TestSeat } from './seatHelper';
import { claude, noNetwork, request, routesOf, sam, startGate, type Gate } from './personGateKit';
import { WINDOWS, removeScratch } from './platform';

// One "is this you?" gate, in two tiers (access.ts asPerson).
// Tier A, shaping the board, takes Tricot's page or a registered Tricot
// terminal, and refuses a plain call from curl or a script with words that
// send agents to their MCP tools. Tier B, what is consequential, takes only
// one of the person's seats, which signs the request: a forged page and a
// terminal that registered itself are told to be let in. MCP, the hooks' own
// routes and plain reads are as they were.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-person-gate-'));
});
after(() => removeScratch(scratch));

// The board routes that need a seat (tier B), whatever their body says, as
// the report's route map lists them; the rest of the board's changes are tier A.
// (A part's, for decisions and tasks, are in its counterpart of this file.)
export const TIER_B_BOARD_ROUTES = [
  'POST /skills',
  'POST /skills/:skillId',
  'POST /skills/:skillId/delete',
  'POST /boards/:boardId/delete',
  'POST /pages/:pageId/delete',
  'POST /boards/:boardId/files/write', // a person's edit saved over a project file on this computer
  'POST /threads/:threadId/review', // a verdict on a thread's work waiting for review, which approves its commit
];

// The board routes only a Tricot terminal takes, with its own key: what the
// page or a seat says doesn't count there (the agents it holds to wake;
// the agent `tricot listen` holds asleep).
export const TERMINAL_BOARD_ROUTES = ['POST /boards/:boardId/wakes', 'POST /boards/:boardId/listen'];

describe('The person gate, in two tiers', () => {
  let gate: Gate;
  let ids: Record<string, string>;
  let dir: string;
  let store: Store;
  let base: string;
  let seat: TestSeat;
  let app: Express;

  beforeEach(async () => {
    gate = await startGate(scratch, repo);
    ({ ids, dir, store, base, seat, app } = gate);
    const board = store.createBoard({ title: 'Gate' }, sam);
    const thread = store.startThread(board.id, 'Which?', claude);
    const message = store.postToThread(thread.id, 'Looks right', claude).messages.at(-1)!;
    const sketch = store.addPage(board.id, 'Sketch', sam);
    Object.assign(ids, { boardId: board.id, threadId: thread.id, commentId: message.id, pageId: sketch.id });
  });
  afterEach(() => gate.stop());

  const plain = () => gate.plain();
  const page = (method: string) => gate.page(method);
  const terminal = () => gate.terminal();
  const call = (...args: Parameters<Gate['call']>) => gate.call(...args);
  const filled = (route: string) => gate.filled(route);
  const tierA = (...args: Parameters<Gate['tierA']>) => gate.tierA(...args);
  const terminalOnly = (...args: Parameters<Gate['terminalOnly']>) => gate.terminalOnly(...args);
  const tierB = (...args: Parameters<Gate['tierB']>) => gate.tierB(...args);

  it("guards every change on the board routes at its tier, all but the steps an agent's hook posts", async () => {
    const routes = routesOf(createApiRouter(store, { mcpUrl: 'unused' }, undefined, undefined, undefined, undefined, undefined, undefined, new ApiParts()));
    const changes = routes.filter((r) => r.method !== 'GET');
    assert.ok(changes.length >= 45, `found ${changes.length}`);
    for (const named of TIER_B_BOARD_ROUTES) assert.ok(changes.some((r) => `${r.method} ${r.path}` === named), `${named} is a route`);
    for (const { method, path: route } of changes) {
      if (route === '/agents/:name/steps') continue;
      const named = `${method} ${route}`;
      if (TIER_B_BOARD_ROUTES.includes(named)) await tierB(method, `/api${filled(route)}`);
      else if (TERMINAL_BOARD_ROUTES.includes(named)) await terminalOnly(method, `/api${filled(route)}`, { holder: 'terminal-under-test', agents: [] });
      else await tierA(method, `/api${filled(route)}`);
    }
    // The steps from an agent's hook: its own, with no Origin (past the gate, and shown on the board: its thread was deleted above).
    const step = await call('POST', '/api/agents/Claude/steps', plain(), { text: 'Reading the thread', session: 's1', thread: ids.threadId });
    assert.equal(step.status, 201);
  });

  it("guards every change on the connectors' routes at tier B, and what each one adds", async () => {
    const posts = routesOf(createConnectorsRouter(new Connectors({ dataDir: dir, fetch: noNetwork }), store)).filter((r) => r.method !== 'GET');
    const block = store.addBlock({ boardId: ids.boardId }, { content: { type: 'link', url: 'https://docs.google.com/document/d/abcdefghijklmnop/edit' } }, sam).id;
    const listed = [
      ['/:id/start', '/google/start'],
      ['/:id/disconnect', '/google/disconnect'],
      ['/picker', '/google/picker'],
      ['/chosen', '/google/chosen'],
      ['/draft', `/google/docs/${block}/draft`],
      ['/discard', `/google/docs/${block}/discard`],
      ['/save', `/google/docs/${block}/save`],
      ['/pins', `/google/docs/${block}/pins`],
      ['/resolve', `/google/docs/${block}/resolve`],
      ['/token', '/figma/token'],
      ['/frames', '/figma/frames'],
      ['/images/:blockId/refresh', `/figma/images/${block}/refresh`],
      ['/device/start', '/github/device/start'],
      ['/device/poll', '/github/device/poll'],
      ['/device/cancel', '/github/device/cancel'],
      ['/token', '/github/token'],
      ['/blocks/:blockId/diff', `/github/blocks/${block}/diff`],
      ['/blocks/:blockId/file', `/github/blocks/${block}/file`],
      ['/key', '/linear/key'],
    ];
    assert.deepEqual(posts.map((r) => r.path).sort(), listed.map(([route]) => route).sort(), 'every change a connector takes is listed here');
    for (const [, route] of listed) await tierB('POST', `/api/connectors${route}`);
    assert.equal((await call('GET', '/api/connectors', plain())).status, 200, 'reads pass');
  });

  it('guards changing live steps at tier B, which stays on this computer; updating at tier B, checking at tier A', async () => {
    for (const route of ['/api/live-steps/claude/preview', '/api/live-steps/claude/apply']) await tierB('POST', route, { actor: 'Sam', action: 'on', fingerprint: 'a'.repeat(64) });
    assert.equal((await call('GET', '/api/live-steps', plain())).status, 200, 'reads pass');
  });


  it('shows what agents wait for in full to a seat alone, sealed to the page and a terminal, and nothing to a plain call', async () => {
    const asked = (await (await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) })).json()) as { id: string };
    assert.ok(asked.id, 'the hook asks with no Origin, as it always has');
    await tierB('GET', '/api/approvals');
    const list = await fetch(`${base}/api/approvals`, { headers: { ...page('GET'), ...seat.sign('GET', '/api/approvals') } });
    assert.match(await list.text(), /SECRET-COMMAND-42/);
    await tierB('POST', `/api/approvals/${asked.id}/answer`, { actor: 'Sam', behavior: 'maybe' }); // past the gate: then 400

    // A stream's frames, until `until` shows; the approvals frames it carried.
    // Approvals are sent as a stream opens, before anything `poke` makes.
    const frames = async (route: string, headers: Record<string, string>, poke: () => Promise<unknown> | unknown, until: RegExp) => {
      const res = await fetch(`${base}${route}`, { headers });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      text += decoder.decode((await reader.read()).value, { stream: true });
      await poke();
      while (!until.test(text)) text += decoder.decode((await reader.read()).value, { stream: true });
      await reader.cancel();
      return { status: res.status, text, approvals: [...text.matchAll(/event: approvals\ndata: (.*)\n/g)].map((m) => m[1]) };
    };
    const stream = await fetch(`${base}/api/approvals/stream`, { headers: plain() });
    assert.deepEqual([stream.status, ((await stream.json()) as { error: string }).error], [403, NOT_A_PERSON]);
    const ticket = (await (await fetch(`${base}/api/seats/ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...page('POST'), ...seat.sign('POST', '/api/seats/ticket', '{}') }, body: '{}' })).json()) as { ticket: string };
    for (const [headers, full] of [[page('GET'), false], [terminal(), false]] as const) {
      const own = await frames('/api/approvals/stream', headers, async () => {}, /event: approvals/);
      assert.doesNotMatch(own.approvals[0], /SECRET-COMMAND-42/, 'sealed: who waits, not what they ask');
      assert.match(own.approvals[0], /"sealed":true/);
      assert.match(own.text, new RegExp(`event: seat\\ndata: \\{"seated":${full}\\}`));
    }
    let n = 0;
    const change = () => store.startThread(ids.boardId, `Another ${++n}`, sam);
    const step = () => fetch(`${base}/api/agents/Claude/steps`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `Step ${++n}`, session: 's1', thread: ids.threadId }) });
    for (const [route, poke, until] of [
      ['/api/approvals/stream', () => {}, /event: approvals/],
      [`/api/boards/${ids.boardId}/stream`, change, /event: change/],
      ['/api/steps/stream', step, /event: steps/],
    ] as const) {
      if (!route.startsWith('/api/approvals')) {
        const seen = await frames(route, plain(), poke, until);
        assert.deepEqual([seen.status, seen.approvals], [200, []], `${route}: the board for anyone, but no approvals`);
      }
      for (const headers of [page('GET'), terminal()]) {
        const shown = await frames(route, headers, () => {}, /event: approvals/);
        assert.equal(shown.approvals.length, 1, `${route} ${JSON.stringify(headers)}`);
        assert.doesNotMatch(shown.approvals[0], /SECRET-COMMAND-42/);
      }
      const joiner = route.includes('?') ? '&' : '?';
      const full = await frames(`${route}${joiner}ticket=${ticket.ticket}`, page('GET'), () => {}, /event: approvals/);
      assert.match(full.approvals[0], /SECRET-COMMAND-42/, `${route}: in full with a seat's ticket`);
      const forged = await frames(`${route}${joiner}ticket=${'t'.repeat(43)}`, page('GET'), () => {}, /event: approvals/);
      assert.doesNotMatch(forged.approvals[0], /SECRET-COMMAND-42/, `${route}: a made-up ticket reads sealed`);
      assert.match(forged.text, /event: seat\ndata: \{"seated":false,"stale":true\}/, 'and is told to get another');
    }
  });


  it("searches inside a board's project files for a person alone, in the files the list shows and nowhere else", async () => {
    await tierA('GET', `/api/boards/${ids.boardId}/files/search?q=needle`); // a board with no folder: past the gate, then told so
    // The project folder is in the home folder, as a board's folder must be: a home of this test's own.
    const home = mkdtempSync(path.join(os.tmpdir(), 'tricot-search-'));
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    Object.assign(process.env, { HOME: home, USERPROFILE: home });
    try {
      const project = path.join(home, 'proj');
      mkdirSync(path.join(project, 'src'), { recursive: true });
      const write = (file: string, text: string | Buffer) => writeFileSync(path.join(project, ...file.split('/')), text);
      write('src/a.ts', "const Needle = 1;\r\nconst needle2 = 'x';\n");
      write('src/b.ts', 'nothing here\n');
      write('notes.md', 'a needle in a haystack\n');
      write('.env', 'needle=1\n'); // hidden, and a key's name: not in the list
      write('data.bin', Buffer.from('needle\0needle')); // binary
      write('big.txt', `needle\n${'x'.repeat(1024 * 1024)}`); // over 1 MB
      if (!WINDOWS) {
        mkdirSync(path.join(home, 'outside'));
        writeFileSync(path.join(home, 'outside', 'x.txt'), 'needle outside\n');
        symlinkSync(path.join(home, 'outside', 'x.txt'), path.join(project, 'src', 'link.ts')); // a link to a file outside the folder
        symlinkSync(path.join(home, 'outside'), path.join(project, 'src', 'out'), 'dir'); // and to a folder
      }
      const board = store.createBoard({ title: 'Searched', folder: '~/proj' }, sam);
      const search = async (query: string) => {
        const res = await fetch(`${base}/api/boards/${board.id}/files/search?${query}`, { headers: page('GET') });
        assert.equal(res.status, 200, query);
        return (await res.json()) as ProjectSearch;
      };
      const where = (found: ProjectSearch) => found.files.map((file) => `${file.path}:${file.lines.map((line) => line.line).join(',')}`);

      const plainly = await search('q=needle');
      assert.deepEqual(where(plainly), ['notes.md:1', 'src/a.ts:1,2'], 'any case, by path, the CRLF line read as one; no key, binary, big file or link');
      assert.deepEqual(plainly.files[1].lines[0], { line: 1, text: 'const Needle = 1;', marks: [[6, 12]] });
      assert.deepEqual([plainly.matches, plainly.searched, plainly.skipped, plainly.partial, plainly.invalid, plainly.truncated], [3, 3, 2, undefined, undefined, undefined]);
      assert.deepEqual(where(await search('q=needle&case=1')), ['notes.md:1', 'src/a.ts:2']);
      assert.deepEqual(where(await search('q=needle&word=1')), ['notes.md:1', 'src/a.ts:1']);
      assert.deepEqual(where(await search('q=n%5Ba-z%5D%2Bdle&regex=1&case=1')), ['notes.md:1', 'src/a.ts:2'], 'a regular expression');
      assert.deepEqual(where(await search('q=n%5Ba-z%5D%2Bdle')), [], 'is plain text without the switch');
      assert.deepEqual((await search('q=(&regex=1')).invalid, 'Unterminated group', 'an invalid one says why, and is no failure');
      assert.ok((await search('q=a)(b&regex=1&word=1')).invalid, 'whole words wrap a pattern in a group, which must not make a wrong one right');

      const long = lineMatches(`${'x'.repeat(300)} needle ${'y'.repeat(300)}`, searchPattern({ q: 'needle' }) as RegExp)!;
      assert.equal(long.text, `…${'x'.repeat(19)} needle ${'y'.repeat(133)}…`, 'a long line is cut around its match');
      assert.deepEqual(long.marks, [[21, 27]]);
      write('uni.txt', 'naïve and naïvely\n');
      write('long.txt', `${'x'.repeat(6000)} zebrafish\n`);
      const naive = await search(`q=na%C3%AFve&word=1`);
      assert.deepEqual([where(naive), naive.files[0].lines[0].marks], [['uni.txt:1'], [[0, 5]]], 'a letter beyond ASCII is part of a word');
      assert.deepEqual(where(await search('q=n%5Cp%7BL%7D%2Bve&regex=1')), ['uni.txt:1'], 'a regular expression reads \\p{L}');
      assert.deepEqual(where(await search('q=zebrafish')), ['long.txt:1'], 'a long line is searched, too');
      write('many.txt', 'needle\n'.repeat(300));
      const capped = await search('q=needle');
      assert.deepEqual([capped.matches, capped.partial, capped.files.reduce((n, file) => n + file.lines.length, 0)], [200, 'matches', 200]);
      write('evil.txt', `${'a'.repeat(40)}b\n`); // a pattern that backtracks for ever on it must not hold the server
      const began = Date.now();
      assert.equal((await search('q=(a%2B)%2B%24&regex=1')).partial, 'time', 'a regular expression that takes too long stops the search');
      assert.ok(Date.now() - began < 3000, 'and the server answers, rather than hanging');
      const refused = await fetch(`${base}/api/boards/${board.id}/files/search?q=`, { headers: page('GET') });
      assert.equal(refused.status, 400, 'nothing to search for');

      // What changes in the folder, live, to a person alone, on the board's own
      // stream while its Files view asks (`files=1`): a file saved is told once
      // it settles, by its path; one in node_modules or a hidden folder is not.
      // A plain program on the same stream asking the same is told nothing of it.
      const live = new AbortController();
      const lapse = setTimeout(() => live.abort(), 8000);
      const streamUrl = `${base}/api/boards/${board.id}/stream?files=1`;
      const plain = await fetch(streamUrl, { signal: live.signal });
      const stream = await fetch(streamUrl, { headers: page('GET'), signal: live.signal });
      assert.equal(stream.status, 200);
      const framesOf = (response: Response) => {
        const reader = response.body!.getReader();
        let text = '';
        return {
          next: async () => {
            const { value, done } = await reader.read();
            if (done) throw new Error('the stream ended');
            return (text += new TextDecoder().decode(value));
          },
          get text() {
            return text;
          },
        };
      };
      const frames = framesOf(stream);
      const told = async (): Promise<{ paths: string[] }> => {
        for (;;) {
          const frame = /event: files\ndata: (.*)\n/.exec(await frames.next());
          if (frame) return JSON.parse(frame[1]) as { paths: string[] };
        }
      };
      mkdirSync(path.join(project, 'node_modules'));
      mkdirSync(path.join(project, '.cache'));
      const saving = setInterval(() => {
        write('node_modules/x.js', 'x');
        write('.cache/y', 'y');
        write('src/b.ts', `saved ${Date.now()}\n`);
      }, 300); // until the watch has started
      try {
        const change = await told();
        assert.ok(change.paths.includes('src/b.ts'), `told ${JSON.stringify(change)}`);
        assert.ok(!change.paths.some((file) => /node_modules|\.cache/.test(file)), `told ${JSON.stringify(change)}`);
        const other = framesOf(plain);
        for (const until = Date.now() + 600; Date.now() < until; ) await Promise.race([other.next().catch(() => ''), new Promise((resolve) => setTimeout(resolve, until - Date.now()))]);
        assert.match(other.text, /event: hello/, 'the plain program hears the board');
        assert.doesNotMatch(other.text, /event: files/, 'but not what changes in its folder');
      } finally {
        clearInterval(saving);
        clearTimeout(lapse);
        live.abort();
      }

      // A person's edit, saved over the file from Files: only over the version
      // it was typed on (the hash read with it); one typed on an older
      // version is refused, and the file stays as it was.
      const opened = (await (await fetch(`${base}/api/boards/${board.id}/files/read?path=src%2Fb.ts`, { headers: page('GET') })).json()) as { hash: string };
      const saveRoute = `/api/boards/${board.id}/files/write`;
      const onDisk = () => readFileSync(path.join(project, 'src', 'b.ts'), 'utf8');
      assert.equal((await call('POST', saveRoute, 'seat', { actor: 'Sam', path: 'src/b.ts', text: 'saved by Sam\n', base: opened.hash })).status, 200);
      assert.equal(onDisk(), 'saved by Sam\n');
      assert.equal((await call('POST', saveRoute, 'seat', { actor: 'Sam', path: 'src/b.ts', text: 'over it\n', base: opened.hash })).status, 409, 'typed on the version before');
      assert.equal(onDisk(), 'saved by Sam\n', 'and the file stays as it was');
    } finally {
      for (const [key, value] of Object.entries(was)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeScratch(home);
    }
  });

  it("leaves MCP, the hooks' own routes and plain reads as they were, with no Origin", async () => {
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    const made = (await client.callTool({ name: 'create_board', arguments: { title: 'From MCP' } })) as { isError?: boolean };
    assert.notEqual(made.isError, true);
    const commented = (await client.callTool({ name: 'reply_in_thread', arguments: { thread_id: ids.threadId, body: 'Done on my side' } })) as { isError?: boolean };
    assert.notEqual(commented.isError, true);
    await client.close();

    const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/agents/Claude/steps', { text: 'Reading', session: 's1', thread: ids.threadId })).status, 201);
    const usage = { usage: { source: 'codex-rollout', plan: 'plus', windows: [{ id: '5h', usedPercent: 26, resetsAt: 1_900_000_000_000, minutes: 300 }], tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, total: 6 } }, at: 1_800_000_000_000 };
    assert.equal((await post('/api/agents/Codex/usage', usage)).status, 200);
    const asked = (await (await post('/api/agents/Claude/approvals', request({ input: { command: 'ls' } }))).json()) as { id: string; key: string };
    assert.equal((await post(`/api/approvals/${asked.id}/wait`, { key: asked.key })).status, 200);
    assert.equal((await post(`/api/approvals/${asked.id}/withdraw`, { key: asked.key })).status, 200);
    const host = (await (await post('/api/approvals/hosts', {})).json()) as { key: string };
    assert.equal((await post('/api/approvals/hosts/heartbeat', {}, { [HOST_KEY_HEADER]: host.key })).status, 200);
    assert.equal((await post('/api/approvals/hosts/release', {}, { [HOST_KEY_HEADER]: host.key })).status, 200);

    // /api/instance is the approval hook's check (404 here: a test's server holds no lock).
    for (const route of ['/api/instance', '/api/info', '/api/boards', `/api/boards/${ids.boardId}`, `/api/boards/${ids.boardId}/events`, `/api/boards/${ids.boardId}/live`, '/api/agents', '/api/update', '/api/connectors', '/api/live-steps', '/api/search?all=1&q=ship']) {
      const res = await fetch(`${base}${route}`);
      assert.ok(res.status !== 403, `${route}: ${res.status}`);
    }
  });


  // What a program on this computer could try against the gate, as findings of its review.
  describe('Findings of the gate review', () => {
    it('F1: a forged page can no longer delete a page in your name', async () => {
      const forged = page('POST');
      const route = `/api/pages/${ids.pageId}/delete`;
      const gone = await call('POST', route, forged, { actor: 'Sam' });
      assert.deepEqual([gone.status, gone.code], [403, SEAT_NEEDED]);
      assert.equal(store.getPage(ids.pageId).page.id, ids.pageId, 'nothing deleted');
      // Signed with a key that isn't a seat's, or a seat's id with another key: refused all the same.
      const other = letIn(new Seats());
      const wrong = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...forged, ...other.sign('POST', route, '{}') }, body: '{}' });
      assert.equal(wrong.status, 403);
      const borrowed = { ...other.key.sign(seat.id, 'POST', route, '{"actor":"Sam"}') };
      const posing = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...forged, ...borrowed }, body: '{"actor":"Sam"}' });
      assert.deepEqual([posing.status, ((await posing.json()) as { error: string }).error], [403, "Refused: this request's signature doesn't match it."]);
      assert.equal(store.getPage(ids.pageId).page.id, ids.pageId);
    });

    it('F2: a terminal a program registers for itself can no longer delete a page, or let itself in', async () => {
      const own = (await (await fetch(`${base}/api/approvals/hosts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { key: string };
      const its = { [HOST_KEY_HEADER]: own.key };
      assert.equal((await call('POST', `/api/pages/${ids.pageId}/delete`, its, { actor: 'Sam' })).code, SEAT_NEEDED);
      assert.equal(store.getPage(ids.pageId).page.id, ids.pageId, 'not deleted');
      // It asks to be let in with a key of its own: the person's seats see it, and it can't answer itself.
      const { SeatKey } = await import('../src/cli/seatKey');
      const mine = new SeatKey();
      const admission = (await (await fetch(`${base}/api/seats/admissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...its }, body: JSON.stringify({ publicKey: mine.publicKey, label: 'Totally the real one' }) })).json()) as { id: string; code: string };
      assert.match(admission.code, /^\d{4}$/);
      const self = await call('POST', `/api/seats/admissions/${admission.id}/answer`, its, { actor: 'Sam', allow: true });
      assert.deepEqual([self.status, self.code], [403, SEAT_NEEDED], 'a terminal that is no seat answers nothing once a seat exists');
      assert.equal((await call('GET', '/api/seats/admissions', its)).code, SEAT_NEEDED, 'nor reads what waits');
      const state = (await (await fetch(`${base}/api/seats/admissions/${admission.id}`, { headers: its })).json()) as { state: string };
      assert.equal(state.state, 'waiting');
    });

    it('F3: an agent can no longer read its own request or answer it, by forged headers or a terminal of its own', async () => {
      const asked = (await (await fetch(`${base}/api/agents/Claude/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) })).json()) as { id: string; key: string };
      const own = (await (await fetch(`${base}/api/approvals/hosts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as { key: string };
      for (const headers of [page('GET'), { 'Sec-Fetch-Site': 'same-origin' }, { [HOST_KEY_HEADER]: own.key }]) {
        const read = await fetch(`${base}/api/approvals`, { headers });
        assert.equal(read.status, 403, `read with ${JSON.stringify(headers)}`);
        assert.doesNotMatch(await read.text(), /SECRET-COMMAND-42/);
      }
      for (const headers of [page('POST'), { [HOST_KEY_HEADER]: own.key }]) {
        const answer = await call('POST', `/api/approvals/${asked.id}/answer`, headers, { actor: 'Sam', behavior: 'allow', session: true });
        assert.deepEqual([answer.status, answer.code], [403, SEAT_NEEDED], `answer with ${JSON.stringify(headers)}`);
      }
      const waited = (await (await fetch(`${base}/api/approvals/${asked.id}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: asked.key }) })).json()) as { state: string };
      assert.equal(waited.state, 'pending', 'the hook still waits for the person');
      // The person's seat answers it, and says where.
      const allowed = await call('POST', `/api/approvals/${asked.id}/answer`, 'seat', { actor: 'Sam', behavior: 'deny', reason: 'Not now' });
      assert.equal(allowed.status, 200);
      const answered = (await (await fetch(`${base}/api/approvals/${asked.id}/wait`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: asked.key }) })).json()) as { answer: { message: string; where?: string } };
      assert.equal(answered.answer.message, 'Sam denied this in Chrome: Not now');
    });

    it('a removed seat is told so, and signs nothing more', async () => {
      const second = letIn(app);
      assert.equal((await call('POST', `/api/seats/${second.id}/remove`, 'seat', { actor: 'Sam' })).status, 200);
      const route = `/api/pages/${ids.pageId}/delete`;
      const text = JSON.stringify({ actor: 'Sam' });
      const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...page('POST'), ...second.sign('POST', route, text) }, body: text });
      assert.deepEqual([res.status, ((await res.json()) as { code: string }).code], [403, SEAT_GONE]);
    });
  });
});

describe('asPerson', () => {
  const req = (headers: Record<string, string>, method = 'POST', address = '127.0.0.1') =>
    ({ method, originalUrl: '/api/x', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), header: (name: string) => headers[Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ''], socket: { remoteAddress: address } }) as never;
  const hosts = new AnswerHosts();
  const registered = hosts.register();
  const key = 'key' in registered ? registered.key : '';

  it('takes the page and a terminal held now at tier A, and nothing else', () => {
    assert.deepEqual(asPerson(req({ Origin: 'http://127.0.0.1:4545' }), 'A', { hosts }), { ok: true, from: 'page' });
    assert.deepEqual(asPerson(req({ Origin: 'http://127.0.0.1:4545', 'Sec-Fetch-Site': 'same-origin' }), 'A', { hosts }), { ok: true, from: 'page' });
    assert.deepEqual(asPerson(req({ 'Sec-Fetch-Site': 'same-origin' }, 'GET'), 'A', { hosts }), { ok: true, from: 'page' }, "a page's read: no Origin");
    assert.deepEqual(asPerson(req({ [HOST_KEY_HEADER]: key }), 'A', { hosts }), { ok: true, from: 'terminal' });
    const refusals: [Record<string, string>, string, string?][] = [
      [{}, NOT_A_PERSON], // curl, a script, an agent
      [{ 'Sec-Fetch-Site': 'same-origin' }, NOT_A_PERSON], // a change with no Origin is no page's
      [{ Origin: 'http://127.0.0.1:4545', 'Sec-Fetch-Site': 'none' }, NOT_A_PERSON],
      [{ 'Sec-Fetch-Site': 'none' }, NOT_A_PERSON, 'GET'], // typed in the address bar
      [{ [HOST_KEY_HEADER]: 'k'.repeat(43) }, HOST_LET_GO],
      [{ [HOST_KEY_HEADER]: 'k'.repeat(43), Origin: 'http://127.0.0.1:4545' }, HOST_LET_GO],
    ];
    for (const [headers, error, method] of refusals) assert.deepEqual(asPerson(req(headers, method), 'A', { hosts }), { ok: false, error }, JSON.stringify(headers));
    assert.deepEqual(asPerson(req({ [HOST_KEY_HEADER]: key }, 'POST', '192.168.1.20'), 'A', { hosts }), { ok: false, error: NOT_A_PERSON }, 'a key from another computer');
    assert.deepEqual(asPerson(req({ [HOST_KEY_HEADER]: key })), { ok: false, error: HOST_LET_GO }, 'no terminals here');
  });

  it('takes a seat alone at tier B; on the network, another device with the token too, never this computer', () => {
    for (const headers of [{ Origin: 'http://127.0.0.1:4545' }, { [HOST_KEY_HEADER]: key }] as Record<string, string>[]) {
      assert.deepEqual(asPerson(req(headers), 'B', { hosts }), { ok: false, error: NEEDS_SEAT, code: SEAT_NEEDED }, JSON.stringify(headers));
    }
    assert.deepEqual(asPerson(req({}), 'B', { hosts }), { ok: false, error: NOT_A_PERSON }, 'a plain call is told what it is');
    // Network mode: past the token, a request from another device stands for the person.
    const device = (r: Request) => !fromThisComputer(r, () => ['192.168.1.5']);
    assert.deepEqual(asPerson(req({}, 'POST', '192.168.1.20'), 'B', { hosts, device }), { ok: true, from: 'device' });
    assert.deepEqual(asPerson(req({ Origin: 'http://192.168.1.5:4545' }, 'POST', '192.168.1.5'), 'B', { hosts, device }), { ok: false, error: NEEDS_SEAT, code: SEAT_NEEDED }, "this computer's own network address is this computer");
    assert.deepEqual(asPerson(req({ Origin: 'http://127.0.0.1:4545' }, 'POST', '::ffff:127.0.0.1'), 'B', { hosts, device }).ok, false);
    assert.deepEqual(asPerson(req({ Origin: 'http://192.168.1.5:4545' }, 'POST', '::ffff:192.168.1.5'), 'B', { hosts, device }).ok, false);
  });
});
