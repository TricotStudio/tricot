import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MAX_PATCH } from '../src/core/blocks/diff/diff';
import { BoardError, Store } from '../src/core/store';
import type { Block } from '../src/core/types';
import { createApp } from '../src/server/app';
import { blockReader } from '../src/server/mcp/content';
import { readGuide } from './guide';
import { removeScratch } from './platform';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type Diff = Extract<Block, { type: 'diff' }>;
type Code = Extract<Block, { type: 'code' }>;

// A home folder of its own, as the site tests have, so the repositories and
// files blocks read are inside it, and one folder outside it.
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tricot-repo-')));
const home = path.join(scratch, 'home');
const outside = path.join(scratch, 'elsewhere');
mkdirSync(home, { recursive: true });
mkdirSync(outside, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home; // the home folder on Windows (os.homedir())
process.env.USERPROFILE = home;

after(() => removeScratch(scratch));

// git with nothing of the person's settings: a test's own author, no signing.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(scratch, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Sam',
  GIT_AUTHOR_EMAIL: 'sam@example.com',
  GIT_COMMITTER_NAME: 'Sam',
  GIT_COMMITTER_EMAIL: 'sam@example.com',
};
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = gitEnv.GIT_CONFIG_GLOBAL;
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });

const lines = (n: number, name = 'line') => Array.from({ length: n }, (_, i) => `const ${name}${i + 1} = ${i + 1};`).join('\n') + '\n';

// A repository with two commits, then work in progress: a staged file, an
// unstaged change and a new file git doesn't track yet.
function makeRepo(name: string): string {
  const repo = path.join(home, 'code', name);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  run(repo, 'init', '-q');
  writeFileSync(path.join(repo, 'src', 'store.ts'), lines(30));
  writeFileSync(path.join(repo, 'README.md'), '# App\n');
  run(repo, 'add', '-A');
  run(repo, 'commit', '-qm', 'First');
  writeFileSync(path.join(repo, 'src', 'store.ts'), lines(30).replace('const line12 = 12;', 'const line12 = 1200; // committed'));
  run(repo, 'commit', '-qam', 'Second');
  writeFileSync(path.join(repo, 'README.md'), '# App\n\nNow with docs.\n');
  writeFileSync(path.join(repo, 'src', 'staged.ts'), 'export const staged = true;\n');
  run(repo, 'add', 'src/staged.ts');
  writeFileSync(path.join(repo, 'src', 'fresh.ts'), 'export const fresh = true;\n');
  return repo;
}

describe('Diff and code blocks read from a repository', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let client: Client;
  let store: Store;
  let repo: string;
  let taskId: string;

  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await call(name, args);
    assert.ok(!result.isError, `${name} failed: ${result.content[0]?.text}`);
    return result.content[0].text;
  }
  async function refused(name: string, args: Record<string, unknown>, message: RegExp) {
    const result = await call(name, args);
    assert.equal(result.isError, true, `${name} wasn't refused: ${result.content[0]?.text}`);
    assert.match(result.content[0].text, message);
  }
  const idOf = (text: string) => text.match(/\[id: ([^\]]+)\]/)![1];
  const diffOf = (id: string) => store.blockOf(id) as Diff;
  const codeOf = (id: string) => store.blockOf(id) as Code;
  const addDiff = async (args: Record<string, unknown>) => diffOf(idOf(await callText('add_block', { task_id: taskId, type: 'diff', ...args })));
  const addCode = async (args: Record<string, unknown>) => codeOf(idOf(await callText('add_block', { task_id: taskId, type: 'code', ...args })));
  const paths = (block: Diff) => block.files.map((f) => `${f.status} ${f.path}`);

  before(async () => {
    repo = makeRepo('app');
    dir = mkdtempSync(path.join(scratch, 'data-'));
    store = new Store(dir);
    store.load();
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused' });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
    const boardId = idOf(await callText('create_board', { title: 'App' }));
    taskId = idOf(await callText('plan_tasks', { board_id: boardId, tasks: [{ title: 'Store work' }] }));
  });

  after(async () => {
    await client.close();
    server.closeAllConnections();
    server.close();
    await store.flush();
  });

  it('tells agents about the new fields', async () => {
    const { tools } = await client.listTools();
    for (const name of ['add_block', 'update_block']) {
      const properties = tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, unknown>;
      for (const field of ['repo', 'range', 'against', 'paths', 'file', 'lines']) assert.ok(properties[field], `${name} has ${field}`);
    }
    assert.match(tools.find((t) => t.name === 'add_block')!.description ?? '', /diff → repo \(Tricot runs git diff\) or patch/);
    const add = await readGuide(client, 'blocks');
    assert.match(add, /diff → repo \(your repository's folder: Tricot diffs it itself, by default your uncommitted work against HEAD\)/);
    assert.match(add, /code → file \(a file on this computer, read for you/);
  });

  it('diffs a range of commits, and one commit as git show does', async () => {
    const range = await addDiff({ repo, range: 'HEAD~1..HEAD' });
    assert.deepEqual(paths(range), ['modified src/store.ts']);
    assert.match(range.patch, /^-const line12 = 12;$/m);
    assert.match(range.patch, /^\+const line12 = 1200; \/\/ committed$/m);

    const one = await addDiff({ repo: '~/code/app', range: 'HEAD~1' });
    assert.deepEqual(paths(one), ['added README.md', 'added src/store.ts'], 'the first commit, against nothing');
    const head = await addDiff({ repo, range: 'HEAD' });
    assert.equal(head.patch, range.patch, 'one commit is its own changes');
  });

  it('diffs the working tree against a commit: staged, unstaged and new files together, leaving the index as it was', async () => {
    const statusBefore = run(repo, 'status', '--porcelain');
    const work = await addDiff({ repo });
    assert.deepEqual(paths(work), ['modified README.md', 'added src/fresh.ts', 'added src/staged.ts']);
    assert.match(work.patch, /^\+export const fresh = true;$/m);
    assert.equal(run(repo, 'status', '--porcelain'), statusBefore, "the repository's index is left alone");
    assert.match(statusBefore, /^\?\? src\/fresh\.ts$/m);

    const sinceFirst = await addDiff({ repo, against: 'HEAD~1' });
    assert.deepEqual(paths(sinceFirst), ['modified README.md', 'added src/fresh.ts', 'added src/staged.ts', 'modified src/store.ts']);
  });

  it('limits a diff to some paths, from the top folder, wherever in the repository it is named from', async () => {
    const limited = await addDiff({ repo: path.join(repo, 'src'), paths: ['src/fresh.ts', 'README.md'], focus: ['fresh.ts'] });
    assert.deepEqual(paths(limited), ['modified README.md', 'added src/fresh.ts']);
    assert.deepEqual(limited.focus, ['src/fresh.ts']);
    const folder = await addDiff({ repo, against: 'HEAD~1', paths: ['src'] });
    assert.deepEqual(paths(folder), ['added src/fresh.ts', 'added src/staged.ts', 'modified src/store.ts']);
  });

  it('keeps a big diff as it keeps a big patch sent as text, its biggest files left out', async () => {
    const big = makeRepo('big');
    writeFileSync(path.join(big, 'data.txt'), `${'x'.repeat(99)}\n`.repeat(Math.ceil((MAX_PATCH * 1.2) / 100)));
    const added = await callText('add_block', { task_id: taskId, type: 'diff', repo: big });
    assert.match(added, /The patch is over 2 MB, so the changes in 1 of its biggest files were left out[^\n]*: data\.txt/);
    const block = diffOf(idOf(added));
    assert.equal(block.files.find((f) => f.path === 'data.txt')?.omitted, true);
    assert.ok(block.files.find((f) => f.path === 'src/fresh.ts')?.hunks.length);
  });

  it('updates a diff from the repository, keeping the old patch as a version', async () => {
    const block = await addDiff({ repo, range: 'HEAD~1..HEAD' });
    const updated = await callText('update_block', { block_id: block.id, rev: block.rev, repo, paths: ['README.md'] });
    assert.match(updated, /^Updated diff/);
    assert.deepEqual(paths(diffOf(block.id)), ['modified README.md']);
    assert.match(await callText('get_block', { block_id: block.id }), /- v2 \(current\) · [^\n]+ · replaced the patch: now 1 file, \+2 −0/);
  });

  it('reads a code block from a file: its lines, numbered as in the file, with its path and commit', async () => {
    const part = await addCode({ file: path.join(repo, 'src', 'store.ts'), lines: '10-14', highlight: '12' });
    assert.equal(part.path, 'src/store.ts');
    assert.equal(part.text, lines(14).split('\n').slice(9).join('\n').replace('const line12 = 12;', 'const line12 = 1200; // committed'));
    assert.deepEqual([part.start, part.total, part.highlight], [10, 30, [[12, 12]]]);
    assert.equal(part.commit, run(repo, 'rev-parse', '--short', 'HEAD').trim());

    const rest = await addCode({ file: '~/code/app/src/store.ts', lines: '28-' });
    assert.deepEqual([rest.start, rest.total, rest.text], [28, 30, 'const line28 = 28;\nconst line29 = 29;\nconst line30 = 30;\n']);

    // A whole file, changed since its commit: no commit, as the text isn't from one.
    const whole = await addCode({ file: path.join(repo, 'README.md') });
    assert.deepEqual([whole.path, whole.text, whole.start, whole.total, whole.commit], ['README.md', '# App\n\nNow with docs.\n', undefined, undefined, undefined]);

    // Outside any repository: named from the home folder.
    mkdirSync(path.join(home, 'notes'), { recursive: true });
    writeFileSync(path.join(home, 'notes', 'plan.py'), 'print("plan")\n');
    const loose = await addCode({ file: '~/notes/plan.py' });
    assert.deepEqual([loose.path, loose.commit, loose.language], ['~/notes/plan.py', undefined, undefined]);

    // A hidden file or folder in a repository is read when git doesn't ignore
    // it, and a repository in one (an agent's worktree) is read and diffed.
    const dotted = makeRepo('dotted');
    mkdirSync(path.join(dotted, '.github'), { recursive: true });
    writeFileSync(path.join(dotted, '.github', 'ci.yml'), 'on: push\n');
    run(dotted, 'add', '.github/ci.yml');
    run(dotted, 'commit', '-qm', 'CI');
    const ci = await addCode({ file: path.join(dotted, '.github', 'ci.yml') });
    assert.deepEqual([ci.path, ci.text, ci.commit], ['.github/ci.yml', 'on: push\n', run(dotted, 'rev-parse', '--short', 'HEAD').trim()]);
    writeFileSync(path.join(dotted, '.github', 'new.yml'), 'on: pull_request\n');
    assert.equal((await addCode({ file: path.join(dotted, '.github', 'new.yml') })).commit, undefined, 'not committed yet');
    run(dotted, 'worktree', 'add', '-q', '.claude/worktrees/agent-1');
    const worktree = path.join(dotted, '.claude', 'worktrees', 'agent-1');
    writeFileSync(path.join(worktree, 'src', 'agent.ts'), 'export const agent = 1;\n');
    assert.deepEqual(paths(await addDiff({ repo: worktree })), ['added src/agent.ts']);
    assert.equal((await addCode({ file: path.join(worktree, 'src', 'agent.ts') })).path, 'src/agent.ts');
    assert.ok(!paths(await addDiff({ repo: dotted })).some((p) => p.includes('.claude')), 'a repository inside it is not a new file');

    // An update reads it again, and clears what the new text doesn't have.
    const updated = await callText('update_block', { block_id: part.id, rev: part.rev, file: path.join(repo, 'README.md') });
    assert.match(updated, /^Updated code "README\.md"/);
    const now = codeOf(part.id);
    assert.deepEqual([now.text, now.start, now.total, now.commit, now.highlight], ['# App\n\nNow with docs.\n', undefined, undefined, undefined, undefined]);
  });

  it('still takes a patch and text as sent', async () => {
    const patch = run(repo, 'diff', 'HEAD~1', 'HEAD');
    const sent = await addDiff({ patch });
    assert.equal(sent.patch, patch);
    const code = await addCode({ path: 'src/a.ts', text: 'export const a = 1;\n', start: 5, total: 9 });
    assert.deepEqual([code.path, code.text, code.start, code.total], ['src/a.ts', 'export const a = 1;\n', 5, 9]);
  });

  it('refuses what it should not read, saying why', async () => {
    run(outside, 'init', '-q');
    writeFileSync(path.join(outside, 'secret.ts'), 'export const key = 1;\n');
    await refused('add_block', { task_id: taskId, type: 'diff', repo: outside }, /A repository's folder must be inside your home folder/);
    await refused('add_block', { task_id: taskId, type: 'code', file: path.join(outside, 'secret.ts') }, /A code block's file must be inside your home folder/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo: 'code/app' }, /A repository's folder is a full path on this computer/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo: `${home}/code/../code/app` }, /without \.\. in it/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo: '~/code/missing' }, /There's no folder at /);

    // Hidden folders of the home folder, and git's own, hold keys: refused.
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY\n');
    await refused('add_block', { task_id: taskId, type: 'code', file: '~/.ssh/id_ed25519' }, /can't be in a hidden folder of your home folder \(~\/\.ssh\)/);
    await refused('add_block', { task_id: taskId, type: 'code', file: path.join(repo, '.git', 'HEAD') }, /can't be in a \.git folder/);
    // A hidden file is read in a repository unless git ignores it, and never outside one.
    const secrets = makeRepo('secrets');
    writeFileSync(path.join(secrets, '.gitignore'), '.env\n');
    writeFileSync(path.join(secrets, '.env'), 'TOKEN=secret\n');
    await refused('add_block', { task_id: taskId, type: 'code', file: path.join(secrets, '.env') }, /~\/code\/secrets\/\.env is hidden, or in a hidden folder, and git ignores it: hidden files hold keys/);
    writeFileSync(path.join(home, 'notes', '.token'), 'secret\n');
    await refused('add_block', { task_id: taskId, type: 'code', file: '~/notes/.token' }, /~\/notes\/\.token is hidden, or in a hidden folder, and isn't in a git repository/);

    // Not a repository, a bad range, nothing to show.
    mkdirSync(path.join(home, 'plain'), { recursive: true });
    await refused('add_block', { task_id: taskId, type: 'diff', repo: '~/plain' }, /isn't in a git repository, so there's nothing to diff/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo, range: 'nope..HEAD' }, /range "nope\.\.HEAD" names "nope", which isn't a commit in ~\/code\/app/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo, range: '--output=/tmp/x' }, /isn't a commit as git names one/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo, against: 'v9' }, /against "v9" isn't a commit in ~\/code\/app/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo, range: 'HEAD..HEAD' }, /git diff HEAD\.\.HEAD finds no changes in ~\/code\/app, so there's nothing to show/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo, paths: ['docs'] }, /git diff HEAD finds no changes in ~\/code\/app \(in docs\) \(staged, unstaged or new files\)/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo, range: 'HEAD', against: 'HEAD' }, /range \(commits to compare\) or against/);
    await refused('add_block', { task_id: taskId, type: 'diff', repo, patch: 'diff --git a/x b/x' }, /Send patch or repo, not both/);

    // Over the limit.
    writeFileSync(path.join(home, 'notes', 'huge.txt'), lines(40_000, 'a_rather_long_variable_name'));
    await refused('add_block', { task_id: taskId, type: 'code', file: '~/notes/huge.txt' }, /~\/notes\/huge\.txt is 1\.\d MB; a code block holds at most 1 MB\. Pass lines/);
    await refused('add_block', { task_id: taskId, type: 'code', file: '~/notes/huge.txt', lines: '1-39000' }, /Lines 1–39000 of ~\/notes\/huge\.txt come to 1\.\d MB; a code block holds at most 1 MB/);
    await refused('add_block', { task_id: taskId, type: 'code', file: '~/notes/huge.txt', lines: '50000-' }, /has 40000 lines, so lines "50000-" start past its end/);
    await refused('add_block', { task_id: taskId, type: 'code', file: '~/notes/huge.txt', lines: 'ten' }, /lines "ten" isn't a range of lines/);
    await refused('add_block', { task_id: taskId, type: 'code', file: '~/notes/huge.txt', lines: '1-10', start: 3 }, /leave out start and total/);
    const tooBig = makeRepo('too-big');
    writeFileSync(path.join(tooBig, 'data.txt'), `${'y'.repeat(99)}\n`.repeat(Math.ceil((MAX_PATCH * 8.2) / 100)));
    await refused('add_block', { task_id: taskId, type: 'diff', repo: tooBig }, /The diff in ~\/code\/too-big is over 16 MB, more than a diff block takes\. Limit it to the files that matter with paths\./);

    // Fields of another kind, on update.
    const code = await addCode({ path: 'a.ts', text: 'a\n' });
    await refused('update_block', { block_id: code.id, rev: code.rev, repo }, /code "a\.ts" isn't a diff: repo, range, against and paths make a diff's patch/);
    await refused('update_block', { block_id: code.id, rev: code.rev, lines: '1-2' }, /Pass lines with file/);
  });

  it('reads blocks a decision is posted with', async () => {
    const boardId = idOf(await callText('create_board', { title: 'Choices' }));
    const posted = await callText('post_decision', {
      board_id: boardId,
      question: 'Ship the store change?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      blocks: [{ type: 'diff', repo, range: 'HEAD~1..HEAD', option: 'a' }],
    });
    const decisionId = idOf(posted);
    assert.match(await callText('get_canvas', { decision_id: decisionId }), /- src\/store\.ts \+1 −1/);
    mkdirSync(path.join(home, 'loose'), { recursive: true });
    await refused(
      'post_decision',
      { board_id: boardId, question: 'Again?', blocks: [{ type: 'note', text: 'x' }, { type: 'diff', repo: '~/loose' }] },
      /^Block 2 in blocks: [^\n]*isn't in a git repository[^\n]* Nothing was posted\./,
    );
  });
});

describe('Reading the computer when Tricot listens on the network', () => {
  it('is refused, and says to send the content instead', async () => {
    const store = new Store(mkdtempSync(path.join(scratch, 'data-')));
    store.load();
    const { fill } = blockReader(store, false);
    const refusal = (message: RegExp) => (error: unknown) => error instanceof BoardError && message.test(error.message);
    await assert.rejects(fill({ type: 'diff', repo: home }), refusal(/reachable from other machines, so repo is disabled\. Send patch\./));
    await assert.rejects(fill({ type: 'code', file: path.join(home, 'notes', 'plan.py') }), refusal(/reachable from other machines, so file is disabled\. Send text\./));
    assert.deepEqual(await fill({ type: 'diff', patch: 'p' }), { type: 'diff', patch: 'p' }, 'what is sent is left as it is');
  });
});
