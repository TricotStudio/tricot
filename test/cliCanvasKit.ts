import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, type CliContext, type CliResult } from '../src/cli/main';
import { editionOf } from '../src/edition';
import type { RunningServer } from '../src/server/start';
import { removeScratch } from './platform';

// A package folder, a data folder and a port of the test's own, and `tricot` run over them: what test/cliCanvas.test.ts
// and its counterpart for a part both start the board with. HOME, the data folder and the port are the test's own; nothing here
// updates or installs anything. Call `begin()` before each test and `end()` after it.

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// What `tricot` and `tricot start` start here, and call themselves: a part where its file is, Canvas where it is
// not (src/edition.ts), each with the folder of its page under the package. A test of the plain command says the one it gets.
export async function startedEdition(): Promise<{ name: string; pageFolder: string }> {
  const canvas = (await editionOf(false)).edition === 'canvas';
  return canvas ? { name: 'Tricot Canvas', pageFolder: 'dist/canvas' } : { name: 'Tricot', pageFolder: 'dist/web' };
}

export class CliHarness {
  scratch = '';
  dataDir = '';
  root = '';
  port = 0;
  out: string[] = [];
  err: string[] = [];
  opened: string[] = [];
  private servers: RunningServer[] = [];

  // No PATH: no agent is found, and no agent's settings are read.
  ctx = (): CliContext => ({
    env: { TRICOT_DATA_DIR: this.dataDir, PORT: String(this.port), HOME: path.join(this.scratch, 'home'), USERPROFILE: path.join(this.scratch, 'home') },
    root: this.root,
    entry: path.join(repo, 'src/cli/tricot.ts'),
    out: (line) => this.out.push(line),
    err: (line) => this.err.push(line),
    open: (url) => this.opened.push(url),
    platform: 'linux',
  });

  run = async (...argv: string[]): Promise<CliResult> => {
    const result = await runCli(argv, this.ctx());
    if (result.server) this.servers.push(result.server);
    return result;
  };

  said = () => this.out.join('\n');

  // The server a test closed itself is no longer the harness's to close.
  forget = (): RunningServer => this.servers.pop()!;

  async begin(): Promise<void> {
    this.scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-cli-canvas-'));
    this.dataDir = path.join(this.scratch, 'data');
    this.root = path.join(this.scratch, 'pkg');
    mkdirSync(path.join(this.root, 'dist/web'), { recursive: true });
    mkdirSync(path.join(this.root, 'dist/canvas'), { recursive: true });
    writeFileSync(path.join(this.root, 'package.json'), '{"name":"tricot","version":"9.9.9"}');
    writeFileSync(path.join(this.root, 'dist/web/index.html'), '<!doctype html><title>Page with parts</title>');
    writeFileSync(path.join(this.root, 'dist/canvas/index.html'), '<!doctype html><title>Canvas page</title>');
    this.port = await freePort();
    this.out = [];
    this.err = [];
    this.opened = [];
  }

  async end(): Promise<void> {
    for (const server of this.servers.splice(0)) await server.close();
    removeScratch(this.scratch);
  }
}
