// `npm run demo` (scripts/demo.ts) against a scratch board, so it can't stop
// halfway again without a test saying so (T239): it seeds the whole board
// without a seat, leaving what is a person's alone open; with --let-in it asks
// to be let in, as a terminal does, and once allowed resolves and defers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AdmissionView } from '../src/core/seats';
import { Seats } from '../src/server/seats';
import { startServer, type RunningServer } from '../src/server/start';
import { letIn, type TestSeat } from './seatHelper';

const demo = fileURLToPath(new URL('../scripts/demo.ts', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

// Runs the demo; `onOut` hears what it prints as it prints it.
function runDemo(args: string[], onOut: (out: string) => void = () => {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', demo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      onOut(out);
    });
    child.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

interface Board {
  title: string;
  decisions: { question: string; status: string }[];
  canvas: { blocks?: unknown[] } & Record<string, unknown>;
}

async function seeded(server: RunningServer, out: string): Promise<Board> {
  const id = /Seeded board ([^:\s]+):/.exec(out)?.[1];
  assert.ok(id, out);
  return (await (await fetch(`${server.url}/api/boards/${id}`)).json()) as Board;
}

const statusOf = (board: Board, question: string) => board.decisions.find((d) => d.question === question)?.status;

describe('npm run demo', () => {
  let scratch: string;
  let dataDir: string;
  let webDir: string;
  let server: RunningServer | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-demo-'));
    dataDir = path.join(scratch, 'data');
    webDir = path.join(scratch, 'web');
    mkdirSync(webDir);
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Tricot</title>');
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('seeds the whole board without a seat, leaving resolving and deferring to the person', async () => {
    server = await startServer({ port: await freePort(), dataDir, webDir });
    const ran = await runDemo([server.url]);
    assert.equal(ran.code, 0, ran.err);
    const board = await seeded(server, ran.out);
    assert.equal(board.title, 'API client retry logic');
    assert.equal(board.decisions.length, 6);
    assert.equal(statusOf(board, 'Which retry strategy should the API client use?'), 'exploring');
    assert.equal(statusOf(board, 'Maximum retry attempts?'), 'provisional');
    assert.equal(statusOf(board, 'Where should retry configuration live?'), 'open');
    assert.equal(statusOf(board, 'Expose retry metrics on the ops dashboard?'), 'open');
    assert.match(ran.out, /Left open for you to resolve or defer on the board/);
    // It got to the end: the decision canvas's last block is there.
    assert.match(JSON.stringify(board), /Option a: per-call config/);
    // And it never let itself in: the first browser can still be let in from a terminal.
    await server.close();
    server = undefined;
    assert.equal(new Seats({ dataDir }).bootstrapOpen(), true);
  });

  it('with --let-in, asks to be let in, and once allowed from a browser resolves one decision and defers the other', async () => {
    // The person's browser, let in before.
    const browser: TestSeat = letIn(new Seats({ dataDir }));
    server = await startServer({ port: await freePort(), dataDir, webDir });
    const url = server.url;
    let allowing: Promise<string> | undefined;
    const allow = async (code: string): Promise<string> => {
      for (;;) {
        const waiting = (await (await fetch(`${url}/api/seats/admissions`, { headers: { 'Sec-Fetch-Site': 'same-origin', ...browser.sign('GET', '/api/seats/admissions') } })).json()) as AdmissionView[];
        const terminal = waiting.find((a) => a.code === code);
        if (terminal) {
          const route = `/api/seats/admissions/${terminal.id}/answer`;
          const body = JSON.stringify({ actor: 'Sam', allow: true });
          const res = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, ...browser.sign('POST', route, body) }, body });
          assert.equal(res.status, 200);
          return terminal.label;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const ran = await runDemo([url, '--let-in'], (out) => {
      const code = /code (\d{4})/.exec(out)?.[1];
      if (code && !allowing) allowing = allow(code);
    });
    assert.equal(ran.code, 0, ran.err);
    assert.ok(allowing, ran.out);
    assert.equal(await allowing, "Tricot's terminal (npm run demo)");
    const board = await seeded(server, ran.out);
    assert.equal(statusOf(board, 'Where should retry configuration live?'), 'decided');
    assert.equal(statusOf(board, 'Expose retry metrics on the ops dashboard?'), 'deferred');
    assert.doesNotMatch(ran.out, /Left open/);
  });
});
