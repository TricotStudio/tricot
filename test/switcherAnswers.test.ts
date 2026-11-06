import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import type { ApprovalRequest } from '../src/core/approvals';
import { SEAT_NEEDED, type AdmissionView } from '../src/core/seats';
import { Store } from '../src/core/store';
import { holdAnswers, type Answers } from '../src/cli/switcher/answers';
import { createApp } from '../src/server/app';
import { AnswerHosts, HOST_GONE_MS } from '../src/server/answerHosts';
import { asThisTerminal } from '../src/cli/terminalKey';
import { NEEDS_SEAT, NOT_A_PERSON } from '../src/server/access';
import { HOST_FROM_PAGE, HOST_KEY_HEADER, HOST_LET_GO, NOT_FROM_HERE } from '../src/server/approvalsRoutes';
import { letIn, type TestSeat } from './seatHelper';
import { removeScratch } from './platform';

// Answering a request for permission from Tricot's terminal (T192, T187):
// the host registers with the board and is given a key, which makes it a
// Tricot terminal; to answer, it is let in as one of the person's seats, once,
// from a browser they let in, and signs each answer. The board refuses an
// answer from a terminal that isn't a seat (it asks to be let in), without a
// key, with one it never gave, one let go or gone quiet, or from another
// computer. The first answer wins, from a browser or the terminal, and the
// other is told who answered, and where.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch: string;
before(() => {
  mkdirSync(path.join(repo, '.review'), { recursive: true });
  scratch = mkdtempSync(path.join(repo, '.review', 'test-answers-'));
});
after(() => removeScratch(scratch));

const request = (more: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  harness: 'claude',
  tool: 'Bash',
  input: { command: 'rm -rf dist && npm run build' },
  session: 's1',
  forSession: ['Bash(npm run build:*)'],
  ...more,
});

describe("answering from Tricot's terminal", () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let app: Express;
  let base: string;
  let local: boolean;
  let clock: number;
  let hosts: AnswerHosts;
  let browser: TestSeat; // the person's browser, let in: it lets the terminal in

  beforeEach(async () => {
    dir = mkdtempSync(path.join(scratch, 'data-'));
    store = new Store(dir);
    store.load();
    local = true;
    clock = Date.now();
    hosts = new AnswerHosts(() => clock);
    app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', approvals: { hosts, fromThisMachine: () => local, waitMs: 300 } });
    browser = letIn(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.flush();
  });

  const post = async (route: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const register = async () => {
    const res = await post('/api/approvals/hosts');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.key as string;
  };
  const ask = async (more: Partial<ApprovalRequest> = {}) => (await post('/api/agents/Claude/approvals', request(more))).body as { id: string; key: string };
  const answerAs = (id: string, body: Record<string, unknown>, headers: Record<string, string>) => post(`/api/approvals/${id}/answer`, { actor: 'Wassim', ...body }, headers);
  const host = (key: string) => ({ [HOST_KEY_HEADER]: key });
  const page = () => ({ Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  // The person, in their browser: its page's headers, signed by its seat.
  const inBrowser = (id: string, body: Record<string, unknown>) => {
    const route = `/api/approvals/${id}/answer`;
    const sent = { actor: 'Wassim', ...body };
    return post(route, sent, { ...page(), ...browser.sign('POST', route, JSON.stringify(sent)) });
  };
  const answerOf = async (asked: { id: string; key: string }) => (await post(`/api/approvals/${asked.id}/wait`, { key: asked.key })).body;
  // The terminal asks to be let in; the person allows it in their browser, which shows the same code.
  const seated = async (answers: Answers) => {
    const asked = await answers.askSeat();
    assert.ok(asked.ok, JSON.stringify(asked));
    const waiting = (await (await fetch(`${base}/api/seats/admissions`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...browser.sign('GET', '/api/seats/admissions') } })).json()) as AdmissionView[];
    const mine = waiting.find((a) => a.code === asked.code);
    assert.ok(mine, 'the browser shows the code the terminal shows');
    const route = `/api/seats/admissions/${mine.id}/answer`;
    const allow = { actor: 'Wassim', allow: true };
    assert.equal((await post(route, allow, { ...page(), ...browser.sign('POST', route, JSON.stringify(allow)) })).status, 200);
    assert.equal(await answers.seatEnded(), 'admitted');
    assert.ok(answers.seated);
  };

  it("takes a terminal's answers once the person let it in: allow, for the session, and deny with the reason the agent reads", async () => {
    const answers = holdAnswers({ url: base, actor: 'Wassim', label: 'tricot claude', seatPollMs: 20 });
    const first = await ask();
    const before = await answers.answer(first.id, { behavior: 'allow' });
    assert.deepEqual(before, { ok: false, needsSeat: true, error: NEEDS_SEAT }, 'a terminal that is no seat is told to be let in');
    await seated(answers);
    assert.deepEqual(await answers.answer(first.id, { behavior: 'allow' }), { ok: true });
    assert.deepEqual(await answerOf(first), { state: 'answered', answer: { behavior: 'allow', by: 'Wassim', from: 'terminal' } });

    const second = await ask({ input: { command: 'npm run build' } });
    assert.deepEqual(await answers.answer(second.id, { behavior: 'allow', session: true }), { ok: true });
    assert.deepEqual(await answerOf(second), { state: 'answered', answer: { behavior: 'allow', session: true, by: 'Wassim', from: 'terminal' } });

    const third = await ask({ input: { command: 'git push --force' } });
    assert.deepEqual(await answers.answer(third.id, { behavior: 'deny', reason: 'Not on main' }), { ok: true });
    assert.deepEqual(await answerOf(third), {
      state: 'answered',
      answer: { behavior: 'deny', message: "Wassim denied this in Tricot's terminal: Not on main", by: 'Wassim', from: 'terminal' },
    });
    await answers.release();
    assert.equal((app.locals.seats as { list(): unknown[] }).list().length, 1, 'the terminal let go of its seat as it ended');
  });

  it('refuses an answer from a terminal that is no seat, with no key or page, a key it never gave, one let go, one gone quiet, and one from another computer', async () => {
    const asked = await ask();
    const refused = async (headers: Record<string, string>, error: string) => {
      const res = await answerAs(asked.id, { behavior: 'allow' }, headers);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error, error);
    };
    await refused({}, NOT_A_PERSON); // an agent with curl
    await refused(host('k'.repeat(43)), HOST_LET_GO);
    // A key with the page's headers too is still a key: the page's headers don't stand in for it.
    await refused({ ...host('k'.repeat(43)), ...page() }, HOST_LET_GO);
    await refused(page(), NEEDS_SEAT);

    const released = await register();
    assert.deepEqual((await post('/api/approvals/hosts/release', {}, host(released))).body, { released: true });
    await refused(host(released), HOST_LET_GO);
    assert.equal((await post('/api/approvals/hosts/heartbeat', {}, host(released))).status, 404);

    const quiet = await register();
    clock += HOST_GONE_MS + 1;
    await refused(host(quiet), HOST_LET_GO);

    const kept = await register();
    clock += HOST_GONE_MS - 1_000;
    assert.equal((await post('/api/approvals/hosts/heartbeat', {}, host(kept))).status, 200);
    clock += HOST_GONE_MS - 1_000;
    local = false;
    await refused(host(kept), NOT_FROM_HERE);
    assert.equal((await post('/api/approvals/hosts')).status, 403, 'nor registered from there');
    local = true;
    const notSeat = await answerAs(asked.id, { behavior: 'allow' }, host(kept));
    assert.deepEqual([notSeat.status, notSeat.body.code], [403, SEAT_NEEDED], 'kept by its heartbeat, a Tricot terminal, but no seat: a terminal anything could register');
    assert.equal((await answerOf(asked)).state, 'pending');
  });

  it("can't be registered by a page", async () => {
    const asPages: Record<string, string>[] = [page(), { 'Sec-Fetch-Site': 'same-origin' }, { Origin: base }];
    for (const headers of asPages) {
      const res = await post('/api/approvals/hosts', {}, headers);
      assert.equal(res.status, 403);
      assert.equal(res.body.error, HOST_FROM_PAGE);
    }
    assert.equal(hosts.size, 0);
  });

  it('lets the first answer win, from a browser or the terminal, and tells the other who answered and where', async () => {
    const answers = holdAnswers({ url: base, actor: 'Wassim', seatPollMs: 20 });
    await seated(answers);
    const one = await ask();
    assert.equal((await inBrowser(one.id, { behavior: 'allow', actor: 'Sam' })).status, 200);
    assert.deepEqual(await answers.answer(one.id, { behavior: 'deny' }), { ok: false, gone: true, error: 'Already answered: Sam allowed it in Chrome.' });

    const two = await ask({ input: { command: 'npm test' } });
    assert.deepEqual(await answers.answer(two.id, { behavior: 'deny' }), { ok: true });
    const lateToo = await inBrowser(two.id, { behavior: 'allow', actor: 'Sam' });
    assert.equal(lateToo.status, 404);
    assert.equal(lateToo.body.error, "Already answered: Wassim denied it in Tricot's terminal.");

    // At the same moment: one wins, the other is told.
    const three = await ask({ input: { command: 'npm run lint' } });
    const [fromTerminal, fromBrowser] = await Promise.all([answers.answer(three.id, { behavior: 'allow' }), inBrowser(three.id, { behavior: 'deny', actor: 'Sam' })]);
    assert.equal([fromTerminal.ok, fromBrowser.status === 200].filter(Boolean).length, 1, 'one wins');
    if (!fromTerminal.ok) assert.equal(fromTerminal.error, 'Already answered: Sam denied it in Chrome.');
    else assert.equal(fromBrowser.body.error, "Already answered: Wassim allowed it in Tricot's terminal.");
    await answers.release();
  });

  it('holdAnswers registers, answers as a seat, keeps answering when the board forgot its key, and lets go of both as it ends', async () => {
    const keys: string[] = [];
    // What the host sends and is given, seen from outside: the key never leaves this exchange.
    const watched: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/api/approvals/hosts') && res.status === 201) keys.push(((await res.clone().json()) as { key: string }).key);
      return res;
    };
    const answers = holdAnswers({ url: base, actor: 'Wassim', fetch: watched, seatPollMs: 20 });
    await seated(answers);
    const first = await ask();
    assert.deepEqual(await answers.answer(first.id, { behavior: 'allow' }), { ok: true });
    assert.equal(keys.length, 1);
    assert.equal(hosts.size, 1);

    // The board forgot its key (as a restart does): the seat is what answers, and it holds.
    hosts.release(keys[0]);
    const second = await ask({ input: { command: 'npm test' } });
    assert.deepEqual(await answers.answer(second.id, { behavior: 'deny', reason: 'Later' }), { ok: true });
    assert.deepEqual(await answerOf(second), { state: 'answered', answer: { behavior: 'deny', message: "Wassim denied this in Tricot's terminal: Later", by: 'Wassim', from: 'terminal' } });

    await answers.release();
    assert.equal(hosts.size, 0, 'let go as it ends');
    const fourth = await ask({ input: { command: 'ls' } });
    assert.equal((await answerAs(fourth.id, { behavior: 'allow' }, host(keys.at(-1)!))).status, 403, 'its key is no good after');
    assert.deepEqual(await answers.answer(fourth.id, { behavior: 'allow' }), { ok: false, error: "Tricot's board can't be reached to answer from here. Answer on the board, or try again in a moment." }, 'nor its seat');
  });

  it("holds a key for the board's stream: checked first, taken again once the board forgot it, none once let go", async () => {
    const keys: string[] = [];
    const watched: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/api/approvals/hosts') && res.status === 201) keys.push(((await res.clone().json()) as { key: string }).key);
      return res;
    };
    const answers = holdAnswers({ url: base, actor: 'Wassim', fetch: watched });
    const first = await answers.held();
    assert.equal(first, keys[0]);
    assert.equal(await answers.held(), first, 'the same while the board holds it');
    hosts.release(first!); // as a restart forgets it
    const second = await answers.held();
    assert.ok(second && second !== first, 'taken again');
    assert.equal(keys.length, 2);
    await answers.release();
    assert.equal(await answers.held(), undefined);
    assert.equal(hosts.size, 0);
  });

  it('answers a browser asking to act for the person: the first one from any terminal, which is let in with it, later ones only as a seat', async () => {
    const fresh = createApp(new Store(mkdtempSync(path.join(scratch, 'fresh-'))), { host: '127.0.0.1', mcpUrl: 'unused', approvals: { hosts } });
    const other: Server = await new Promise((resolve) => {
      const s = fresh.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      const { SeatKey } = await import('../src/cli/seatKey');
      const askFrom = async (key: InstanceType<typeof SeatKey>) =>
        (await (await fetch(`${url}/api/seats/admissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ publicKey: key.publicKey }) })).json()) as { id: string; code: string };
      const answers = holdAnswers({ url, actor: 'Wassim', label: 'tricot claude' });
      const first = await askFrom(new SeatKey());
      assert.deepEqual(await answers.admit(first.id, true), { ok: true }, 'no seat yet: any Tricot terminal lets the first browser in');
      assert.equal(answers.seated, true, 'and, its keypress the proof for both, is let in with it');
      const second = await askFrom(new SeatKey());
      assert.deepEqual(await answers.admit(second.id, true), { ok: true }, 'a seat now, it answers the next one');
      // Another terminal, registered after the first browser is in, is no seat.
      const other = holdAnswers({ url, actor: 'Wassim' });
      const third = await askFrom(new SeatKey());
      const refused = await other.admit(third.id, true);
      assert.equal(refused.ok, false);
      assert.equal((refused as { needsSeat?: boolean }).needsSeat, true, 'once there is a seat, only a seat answers');
      assert.equal(other.seated, false);
      await other.release();
      await answers.release();
    } finally {
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('lets the tricot command act once as this terminal: a key for the one call, let go after; let in for what needs a seat', async () => {
    const made = await asThisTerminal(base, {}, async (headers) => {
      assert.equal(hosts.size, 1, 'registered for the call');
      const res = await fetch(`${base}/api/boards`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'Wassim', title: 'From the picker' }) });
      return { status: res.status, key: headers[HOST_KEY_HEADER] };
    });
    assert.equal(made.status, 201, 'a person, at a Tricot terminal');
    assert.match(made.key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hosts.size, 0, 'let go after');
    const after = await post('/api/boards', { actor: 'Wassim', title: 'Again' }, host(made.key));
    assert.deepEqual([after.status, after.body.error], [403, HOST_LET_GO], 'its key is no good after');
    const plain = await post('/api/boards', { actor: 'Wassim', title: 'Plain' });
    assert.deepEqual([plain.status, plain.body.error], [403, NOT_A_PERSON]);

    // Deciding a card needs a seat: the call asks to be let in, says the code, and goes on once the person allows it.
    const board = store.createBoard({ title: 'Seats' }, { kind: 'human', name: 'Wassim' });
    const decision = store.postDecision(board.id, { question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }, { kind: 'agent', name: 'Claude' });
    const said: string[] = [];
    const route = `/api/decisions/${decision.id}/resolve`;
    const body = JSON.stringify({ actor: 'Wassim', optionId: 'a' });
    const decided = await asThisTerminal(
      base,
      {},
      async (headers, terminal) => {
        const send = async () => (await fetch(`${base}${route}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...terminal.sign('POST', route, body) }, body })).status;
        assert.equal(await send(), 403);
        const allowing = (async () => {
          for (;;) {
            const code = /code (\d{4})/.exec(said.join('\n'))?.[1];
            if (code) {
              const waiting = (await (await fetch(`${base}/api/seats/admissions`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...browser.sign('GET', '/api/seats/admissions') } })).json()) as AdmissionView[];
              const mine = waiting.find((a) => a.code === code)!;
              const answerRoute = `/api/seats/admissions/${mine.id}/answer`;
              const allow = JSON.stringify({ actor: 'Wassim', allow: true });
              await fetch(`${base}${answerRoute}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...page(), ...browser.sign('POST', answerRoute, allow) }, body: allow });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })();
        const letIn = await terminal.letIn((line) => said.push(line));
        await allowing;
        assert.deepEqual(letIn, { ok: true });
        return send();
      },
      fetch,
      'tricot test',
    );
    assert.equal(decided, 200);
    assert.match(said[0], /^Allow this terminal in Tricot's page, in a browser you've let in: it shows code \d{4}\. Waiting for you there…$/);
    assert.equal(store.getBoard(board.id).decisions[0].status, 'decided');
    assert.equal((app.locals.seats as { list(): unknown[] }).list().length, 1, 'its seat let go after the call');

    // A board that gives no key (too many terminals, an older Tricot): the call goes without, and is refused.
    for (let i = 0; i < 32; i++) await register();
    const full = await asThisTerminal(base, {}, async (headers) => {
      const res = await fetch(`${base}/api/boards`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'Wassim', title: 'Full' }) });
      return { status: res.status, sent: HOST_KEY_HEADER in headers };
    });
    assert.deepEqual(full, { status: 403, sent: false });
  });

  it("says so when the board can't be reached", async () => {
    const answers = holdAnswers({ url: 'http://127.0.0.1:9', actor: 'Wassim', timeoutMs: 500 });
    const outcome = await answers.answer('x', { behavior: 'allow' });
    assert.equal(outcome.ok, false);
    assert.match((outcome as { error: string }).error, /can't be reached/);
    await answers.release();
  });
});
