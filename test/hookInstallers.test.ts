import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli/main';
import { findHookInstaller, hookInstallers, UnreadableSettings, type HookInstaller, type HookTarget } from '../src/server/hooks';
import { claude } from '../src/server/hooks/claude';
import { codex, CODEX_TRUST, CODEX_USAGE } from '../src/server/hooks/codex';
import { APPROVAL_STATUS, APPROVAL_TIMEOUT_S } from '../src/server/hooks/commandHooks';
import { gemini, GEMINI_WAITS } from '../src/server/hooks/gemini';
import { goose, GOOSE_WAITS } from '../src/server/hooks/goose';
import { grok, GROK_WAITS } from '../src/server/hooks/grok';
import { hermes, HERMES_APPROVAL, HERMES_BEGIN, HERMES_END, HERMES_OWN_LINES, HERMES_WAITS } from '../src/server/hooks/hermes';
import { writeFileAtomic } from '../src/server/hooks/installer';
import { omp } from '../src/server/hooks/omp';
import { opencode } from '../src/server/hooks/opencode';
import { pi } from '../src/server/hooks/pi';
import { removeScratch, WINDOWS } from './platform';

// A path as a hook command writes it: with forward slashes on Windows, which
// every shell there leaves alone (shellPath in src/server/hooks/installer.ts).
const asWritten = (file: string) => (WINDOWS ? file.replaceAll('\\', '/') : file);
// A path from the project as a step says it: with this system's separators (windowsShell.test.ts).
const fromProject = (file: string) => file.split('/').join(path.sep);
// A file's path from the home folder, with forward slashes on every system.
const fromHome = (home: string, file: string) => path.relative(home, file).split(path.sep).join('/');

// Every installer runs against a home folder made for the test: nothing here
// reads or writes a real agent's settings, and no agent is run.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(repo, 'hooks');
const TRICOT_URL = 'http://127.0.0.1:4800';
const setup = { url: TRICOT_URL, source: SOURCE };

let scratch: string;
before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'tricot-hook-installers-'));
});
after(() => removeScratch(scratch));

const freshHome = (): HookTarget => {
  const home = mkdtempSync(path.join(scratch, 'home-'));
  return { home, env: {} };
};
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const mtimes = (files: string[]) => files.map((f) => statSync(f).mtimeMs);

// The installed hook script, as the agent runs it: an event on stdin.
function runScript(script: string, event: Record<string, unknown>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--dry-run'], { env: { PATH: process.env.PATH } });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(event));
  });
}

const theirs = {
  permissions: { allow: ['Bash(npm test)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }], Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }] },
};

describe('the hook installer registry', () => {
  it('has one installer per agent, each found by its id', () => {
    assert.deepEqual(
      hookInstallers().map((i) => [i.id, i.name, i.agentName]),
      [
        ['claude', 'Claude Code', 'Claude'],
        ['codex', 'Codex', 'Codex'],
        ['pi', 'Pi', 'Pi'],
        ['omp', 'OMP', 'OMP'],
        ['gemini', 'Gemini CLI', 'Gemini'],
        ['opencode', 'OpenCode', 'OpenCode'],
        ['goose', 'Goose', 'Goose'],
        ['hermes', 'Hermes Agent', 'Hermes'],
        ['grok', 'Grok Build', 'Grok'],
      ],
    );
    assert.equal(findHookInstaller('codex'), codex);
    assert.equal(findHookInstaller('gemini'), gemini);
    assert.equal(findHookInstaller('opencode'), opencode);
    assert.equal(findHookInstaller('goose'), goose);
    assert.equal(findHookInstaller('hermes'), hermes);
    assert.equal(findHookInstaller('grok'), grok);
    assert.equal(findHookInstaller('cursor'), undefined);
    assert.deepEqual(claude.scopes, ['user', 'project']);
    for (const other of [codex, pi, omp, gemini, opencode, goose, hermes, grok]) assert.deepEqual(other.scopes, ['user']);
  });

  it("finds an agent by its folder or its command on PATH, without running it", () => {
    const target = freshHome();
    assert.deepEqual(
      hookInstallers().map((i) => i.detect(target).found),
      [false, false, false, false, false, false, false, false, false],
    );
    mkdirSync(path.join(target.home, '.codex'));
    mkdirSync(path.join(target.home, '.omp'));
    mkdirSync(path.join(target.home, '.gemini'));
    mkdirSync(path.join(target.home, '.grok'));
    const bin = path.join(target.home, 'bin');
    const program = (name: string) => path.join(bin, name);
    write(program('pi'), '#!/bin/sh\nexit 1\n');
    chmodSync(program('pi'), 0o755);
    write(program('opencode'), '#!/bin/sh\nexit 1\n');
    chmodSync(program('opencode'), 0o755);
    write(path.join(bin, 'claude'), 'not runnable'); // not executable: not a command (Windows has no such mode)
    const withPath = { ...target, env: { PATH: [path.join(target.home, 'nowhere'), bin].join(path.delimiter) } };
    assert.deepEqual(codex.detect(withPath), { found: true, folder: path.join(target.home, '.codex') });
    assert.deepEqual(omp.detect(withPath), { found: true, folder: path.join(target.home, '.omp') });
    assert.deepEqual(pi.detect(withPath), { found: true, command: program('pi') });
    if (!WINDOWS) assert.deepEqual(claude.detect(withPath), { found: false });
    assert.deepEqual(gemini.detect(withPath), { found: true, folder: path.join(target.home, '.gemini') });
    assert.deepEqual(opencode.detect(withPath), { found: true, command: program('opencode') });
    assert.deepEqual(grok.detect(withPath), { found: true, folder: path.join(target.home, '.grok') });
    mkdirSync(path.join(target.home, '.config/opencode'), { recursive: true });
    assert.deepEqual(opencode.detect(target), { found: true, folder: path.join(target.home, '.config/opencode') });
  });

  it("finds Goose by its own folder, not the plugin Tricot adds, wherever its settings are kept, and Hermes by its folder or command", () => {
    const target = freshHome();
    assert.equal(goose.detect(target).found, false);
    mkdirSync(path.join(target.home, '.agents/plugins/tricot-steps'), { recursive: true });
    assert.equal(goose.detect(target).found, false, "Tricot's own plugin folder is not Goose");
    mkdirSync(path.join(target.home, '.config/goose'), { recursive: true });
    assert.deepEqual(goose.detect(target), { found: true, folder: path.join(target.home, '.config/goose') });

    const moved = freshHome();
    const xdg = path.join(moved.home, 'xdg');
    mkdirSync(path.join(xdg, 'goose'), { recursive: true });
    assert.equal(goose.detect(moved).found, false);
    assert.deepEqual(goose.detect({ ...moved, env: { XDG_CONFIG_HOME: xdg } }), { found: true, folder: path.join(xdg, 'goose') });
    const appData = path.join(moved.home, 'AppData');
    mkdirSync(path.join(appData, 'Block/goose/config'), { recursive: true });
    assert.equal(goose.detect({ ...moved, env: { APPDATA: appData } }).found, true, "Windows keeps it under %APPDATA%\\Block\\goose\\config");
    const root = path.join(moved.home, 'goose-root');
    mkdirSync(path.join(root, 'config'), { recursive: true });
    assert.equal(goose.detect({ ...moved, env: { GOOSE_PATH_ROOT: root } }).found, true, '$GOOSE_PATH_ROOT moves all of it');

    const here = freshHome();
    assert.equal(hermes.detect(here).found, false);
    mkdirSync(path.join(here.home, '.hermes'));
    assert.deepEqual(hermes.detect(here), { found: true, folder: path.join(here.home, '.hermes') });
    const elsewhere = freshHome();
    const profile = path.join(elsewhere.home, 'profile');
    mkdirSync(profile);
    assert.deepEqual(hermes.detect({ ...elsewhere, env: { HERMES_HOME: profile } }), { found: true, folder: profile });
  });
});

describe('Claude Code steps, for every project (~/.claude)', () => {
  const files = (home: string) => ({
    settings: path.join(home, '.claude/settings.json'),
    script: path.join(home, '.claude/hooks/tricot-steps.mjs'),
    describe: path.join(home, '.claude/hooks/tricot-describe.mjs'),
    approve: path.join(home, '.claude/hooks/tricot-approve.mjs'),
    usage: path.join(home, '.claude/hooks/tricot-usage.mjs'),
    kept: path.join(home, '.claude/hooks/tricot-usage.json'),
  });
  // The note that says permission prompts come to the board.
  const APPROVALS_SAID = /When Claude Code asks permission to run something, the request comes to the card it is working on in Tricot/;

  it('shows the exact files and lines it would write, and writes nothing', () => {
    const target = freshHome();
    const { script } = files(target.home);
    const preview = claude.preview(target, setup);
    assert.equal(preview.unchanged, false);
    assert.deepEqual(
      preview.changes.map((c) => [fromHome(target.home, c.path), c.does, c.same]),
      [
        ['.claude/hooks/tricot-steps.mjs', 'write', false],
        ['.claude/hooks/tricot-describe.mjs', 'write', false],
        ['.claude/hooks/tricot-approve.mjs', 'write', false],
        ['.claude/hooks/tricot-usage.mjs', 'write', false],
        ['.claude/hooks/tricot-usage.json', 'write', false],
        ['.claude/settings.json', 'add', false],
      ],
    );
    const command = `node "${asWritten(script)}" --name Claude --url ${TRICOT_URL}`;
    assert.ok(preview.text.includes('add to ~/.claude/settings.json'), preview.text);
    assert.ok(preview.text.includes(JSON.stringify(command)), 'the command, as it goes in the JSON');
    assert.match(preview.text, /"async": true/);
    const lines = JSON.parse(preview.changes[5].lines!);
    assert.deepEqual(Object.keys(lines.hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop', 'PermissionRequest']);
    // The approval hook: one Claude Code waits for, as long as the person takes.
    assert.deepEqual(lines.hooks.PermissionRequest, [
      { hooks: [{ type: 'command', command: `node "${asWritten(files(target.home).approve)}" --name Claude --url ${TRICOT_URL}`, timeout: APPROVAL_TIMEOUT_S, statusMessage: APPROVAL_STATUS }] },
    ]);
    assert.equal(APPROVAL_TIMEOUT_S, 604_800, 'a week, inside what a JavaScript timer holds');
    assert.ok(preview.notes.some((n) => APPROVALS_SAID.test(n)), 'said in words before anyone says yes');
    assert.match(preview.changes[2].what, /permission prompts to the board/);
    assert.deepEqual(lines.statusLine, { type: 'command', command: `node "${asWritten(files(target.home).usage)}" --name Claude --url ${TRICOT_URL}` });
    assert.equal(existsSync(path.join(target.home, '.claude')), false, 'a preview changes nothing');
    assert.equal(claude.status(target).state, 'off');
  });

  it('adds its hooks beside the person\'s own, once, and takes them out again', async () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.settings, JSON.stringify(theirs, null, 2));
    const first = claude.install(target, { ...setup, name: 'Claude Builder' });
    assert.equal(first.changed, true);
    assert.deepEqual(first.files, [f.script, f.describe, f.approve, f.usage, f.kept, f.settings]);
    const added = json(f.settings);
    assert.deepEqual(added.permissions, theirs.permissions);
    assert.deepEqual(added.hooks.PreToolUse[0], theirs.hooks.PreToolUse[0]);
    assert.equal(added.hooks.PreToolUse[1].hooks[0].command, `node "${asWritten(f.script)}" --name 'Claude Builder' --url ${TRICOT_URL}`);
    assert.equal(added.hooks.PostToolUse[0].matcher, 'Bash|Agent|Task');
    assert.equal(added.hooks.Stop.length, 2);
    assert.equal(readFileSync(f.script, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-steps.mjs'), 'utf8'));
    assert.equal(readFileSync(f.describe, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-describe.mjs'), 'utf8'));
    assert.equal(readFileSync(f.approve, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-approve.mjs'), 'utf8'));
    assert.equal(added.hooks.PermissionRequest[0].hooks[0].command, `node "${asWritten(f.approve)}" --name 'Claude Builder' --url ${TRICOT_URL}`);
    assert.equal(added.hooks.PermissionRequest[0].hooks[0].async, undefined, 'Claude Code waits for it');
    assert.deepEqual(claude.status(target), { state: 'on', where: [f.settings, f.script, f.describe, f.approve, f.usage, f.kept], sendsAs: 'Claude Builder', usage: 'on' });

    // The copy runs from where it was put, with the module beside it.
    const ran = await runScript(f.script, { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: 'Read', tool_input: { file_path: '/w/src/a.ts' } });
    assert.equal(ran.code, 0);
    assert.equal(JSON.parse(ran.stdout).text, `Reading ${fromProject('src/a.ts')}`);

    const before = mtimes([f.script, f.describe, f.approve, f.usage, f.kept, f.settings]);
    const again = claude.install(target, { ...setup, name: 'Claude Builder' });
    assert.equal(again.changed, false, again.message);
    assert.equal(claude.preview(target, { ...setup, name: 'Claude Builder' }).unchanged, true);
    assert.deepEqual(mtimes([f.script, f.describe, f.approve, f.usage, f.kept, f.settings]), before, 'nothing written again');

    const renamed = claude.install(target, { ...setup, name: 'Claude', narration: true });
    assert.deepEqual(renamed.files, [f.settings], 'only the settings change');
    const narrated = json(f.settings);
    assert.equal(narrated.hooks.PreToolUse.length, 2, 'replaced, not added twice');
    assert.equal(narrated.hooks.PermissionRequest.length, 1, 'the approval hook too');
    assert.match(narrated.hooks.MessageDisplay[0].hooks[0].command, /--narration$/);
    assert.equal(claude.preview(target, setup).changes[5].does, 'replace');

    const removed = claude.uninstall(target);
    assert.equal(removed.changed, true);
    assert.deepEqual(json(f.settings), theirs, 'every other setting as it was');
    assert.equal(existsSync(f.script) || existsSync(f.describe) || existsSync(f.approve) || existsSync(f.usage) || existsSync(f.kept), false);
    assert.equal(claude.status(target).state, 'off');
    assert.equal(claude.uninstall(target).changed, false);
  });

  it('says partly when a piece is missing', () => {
    const target = freshHome();
    const f = files(target.home);
    claude.install(target, setup);
    rmSync(f.describe);
    assert.deepEqual(claude.status(target), {
      state: 'partly',
      where: [f.settings, f.script, f.describe, f.approve, f.usage, f.kept],
      missing: ['~/.claude/hooks/tricot-describe.mjs'],
      sendsAs: 'Claude',
      usage: 'on',
    });
    const settings = json(f.settings);
    delete settings.hooks.Stop;
    write(f.settings, JSON.stringify(settings));
    assert.deepEqual(claude.status(target).missing, ['the Stop hook in ~/.claude/settings.json', '~/.claude/hooks/tricot-describe.mjs']);
    claude.install(target, setup);
    assert.equal(claude.status(target).state, 'on', 'adding again mends it');

    // Steps set up before approvals came: partly, until turned on again.
    const older = json(f.settings);
    delete older.hooks.PermissionRequest;
    write(f.settings, JSON.stringify(older));
    rmSync(f.approve);
    assert.deepEqual(claude.status(target).missing, ['the PermissionRequest approval hook in ~/.claude/settings.json', '~/.claude/hooks/tricot-approve.mjs']);
    assert.equal(claude.status(target).state, 'partly');
    claude.install(target, setup);
    assert.equal(claude.status(target).state, 'on');
  });

  it('leaves settings it cannot read alone, and says so', () => {
    for (const broken of ['{ not json', '[1, 2]', '{"hooks": "none"}', '{"hooks": {"Stop": {}}}']) {
      const target = freshHome();
      const f = files(target.home);
      write(f.settings, broken);
      assert.throws(() => claude.preview(target, setup), UnreadableSettings);
      assert.throws(() => claude.install(target, setup), /so it was left as it is/);
      assert.throws(() => claude.uninstall(target), UnreadableSettings);
      assert.equal(readFileSync(f.settings, 'utf8'), broken);
      assert.equal(existsSync(f.script), false, 'nothing else written either');
      const status = claude.status(target);
      assert.equal(status.state, 'off');
      assert.match(status.problem!, /settings\.json/);
    }
  });

  it("uses CLAUDE_CONFIG_DIR when it is set", () => {
    const target = freshHome();
    const config = path.join(target.home, 'claude-work');
    claude.install({ ...target, env: { CLAUDE_CONFIG_DIR: config } }, setup);
    assert.ok(existsSync(path.join(config, 'settings.json')));
    assert.ok(existsSync(path.join(config, 'hooks/tricot-steps.mjs')));
    assert.equal(existsSync(path.join(target.home, '.claude')), false);
  });
});

describe('Claude Code steps, for one project (steps on --agent claude --project)', () => {
  it("writes the project's .claude, with a command that finds the script from the project", async () => {
    const target = freshHome();
    const project = path.join(target.home, 'work/app');
    mkdirSync(project, { recursive: true });
    const scoped = { ...target, project };
    const preview = claude.preview(scoped, setup, 'project');
    assert.ok(preview.text.includes('write .claude/hooks/tricot-steps.mjs'), preview.text);
    claude.install(scoped, setup, 'project');
    const settings = json(path.join(project, '.claude/settings.json'));
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/tricot-steps.mjs" --name Claude --url ${TRICOT_URL}`);
    assert.equal(claude.status(scoped, 'project').state, 'on');
    assert.equal(claude.status(scoped).state, 'off', 'the user scope is apart');
    assert.equal(existsSync(path.join(target.home, '.claude')), false);
    assert.throws(() => claude.preview(target, setup, 'project'), /project folder/);
    claude.uninstall(scoped, 'project');
    assert.equal(claude.status(scoped, 'project').state, 'off');
  });

  it('goes through the same installer from the command line', async () => {
    const target = freshHome();
    const project = path.join(target.home, 'app');
    mkdirSync(project);
    const out: string[] = [];
    const ctx = (answer?: boolean) => ({
      env: { TRICOT_DATA_DIR: path.join(target.home, 'data'), PORT: '4801', HOME: target.home },
      root: repo,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line: string) => out.push(line),
      err: (line: string) => out.push(line),
      open: () => {},
      cwd: project,
      ...(answer !== undefined && { ask: async () => answer }),
    });
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project'], ctx(true))).exitCode, 0);
    assert.ok(existsSync(path.join(project, '.claude/hooks/tricot-describe.mjs')), 'the module the script imports goes too');
    assert.equal(claude.status({ ...target, project }, 'project').state, 'on');
    out.length = 0;
    assert.equal((await runCli(['steps', 'on', '--agent', 'claude', '--project'], ctx())).exitCode, 0, 'set up already: nothing to ask');
    assert.match(out.join('\n'), /already set up like this/);
    const ran = await runScript(path.join(project, '.claude/hooks/tricot-steps.mjs'), { hook_event_name: 'Stop', session_id: 's' });
    assert.equal(JSON.parse(ran.stdout).text, 'Finished its turn');
    assert.equal((await runCli(['steps', 'off', '--agent', 'claude', '--project'], ctx())).exitCode, 0);
    assert.equal(claude.status({ ...target, project }, 'project').state, 'off');
    assert.match(out.join('\n'), /Every other setting is as it was/);
  });
});

describe('Codex steps (~/.codex/hooks.json)', () => {
  const files = (folder: string) => ({
    hooks: path.join(folder, 'hooks.json'),
    script: path.join(folder, 'hooks/tricot-steps.mjs'),
    describe: path.join(folder, 'hooks/tricot-describe.mjs'),
    approve: path.join(folder, 'hooks/tricot-approve.mjs'),
  });
  const theirsCodex = { description: 'My hooks', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/start.py', timeout: 3 }] }] } };

  it('shows its hooks and that Codex asks to trust them, and writes nothing', () => {
    const target = freshHome();
    const preview = codex.preview(target, setup);
    assert.equal(preview.notes.length, 3);
    assert.match(preview.notes[0], /When Codex asks permission to run something, the request comes to the card/);
    assert.deepEqual(preview.notes.slice(1), [CODEX_TRUST, CODEX_USAGE]);
    assert.ok(preview.text.includes('add to ~/.codex/hooks.json'));
    assert.ok(preview.text.includes('open /hooks in Codex'));
    assert.deepEqual(
      preview.changes.map((c) => fromHome(target.home, c.path)),
      ['.codex/hooks/tricot-steps.mjs', '.codex/hooks/tricot-describe.mjs', '.codex/hooks/tricot-approve.mjs', '.codex/hooks/tricot-usage.mjs', '.codex/hooks.json'],
    );
    const hooks = JSON.parse(preview.changes[4].lines!).hooks;
    assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStop']);
    // The steps' own entry on it, async, then the approval hook, which Codex waits for.
    assert.equal(hooks.PermissionRequest.length, 2);
    assert.equal(hooks.PermissionRequest[0].hooks[0].async, true);
    assert.deepEqual(hooks.PermissionRequest[1].hooks[0], {
      type: 'command',
      command: `node "${asWritten(files(path.join(target.home, '.codex')).approve)}" --name Codex --url ${TRICOT_URL} --codex`,
      timeout: APPROVAL_TIMEOUT_S,
      statusMessage: APPROVAL_STATUS,
    });
    assert.equal(hooks.PostToolUse[0].matcher, '^(Bash|Agent)$');
    assert.deepEqual(hooks.PreToolUse[0].hooks[0], { type: 'command', command: `node "${asWritten(files(path.join(target.home, '.codex')).script)}" --name Codex --url ${TRICOT_URL} --usage`, async: true });
    assert.equal(existsSync(path.join(target.home, '.codex')), false);
  });

  it('notes hooks of its own in config.toml, which it never changes', () => {
    const target = freshHome();
    const toml = '# mine\nmodel = "gpt-5"\n\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n';
    write(path.join(target.home, '.codex/config.toml'), toml);
    assert.equal(codex.preview(target, setup).notes.length, 4);
    codex.install(target, setup);
    codex.uninstall(target);
    assert.equal(readFileSync(path.join(target.home, '.codex/config.toml'), 'utf8'), toml);
  });

  it('adds its hooks beside the person\'s own, once, and takes them out again', async () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.codex'));
    write(f.hooks, JSON.stringify(theirsCodex));
    const done = codex.install(target, setup);
    assert.equal(done.changed, true);
    assert.deepEqual(done.notes.slice(1), [CODEX_TRUST, CODEX_USAGE]);
    const added = json(f.hooks);
    assert.equal(added.description, 'My hooks');
    assert.deepEqual(added.hooks.SessionStart, theirsCodex.hooks.SessionStart);
    assert.equal(added.hooks.PermissionRequest[0].hooks[0].async, true);
    assert.match(added.hooks.PermissionRequest[1].hooks[0].command, /tricot-approve\.mjs" --name Codex --url \S+ --codex$/);
    assert.equal(readFileSync(f.approve, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-approve.mjs'), 'utf8'));
    const status = codex.status(target);
    assert.equal(status.state, 'on');
    assert.match(status.note!, /trusted it in \/hooks/);

    // Codex's events, through the copied script: a command as Bash, a patch by its files.
    const shell = await runScript(f.script, { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/w', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'npm test -- --token SECRET' } });
    assert.deepEqual([JSON.parse(shell.stdout).text, JSON.parse(shell.stdout).running], ['Running npm test', true]);
    const patch = await runScript(f.script, { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: src/b.ts\n+SECRET\n*** End Patch' } });
    assert.equal(JSON.parse(patch.stdout).text, 'Editing src/b.ts');
    const asking = await runScript(f.script, { hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } });
    assert.equal(JSON.parse(asking.stdout).text, 'Waiting for your permission');

    assert.equal(codex.install(target, setup).changed, false);
    assert.deepEqual(json(f.hooks), added);
    codex.uninstall(target);
    assert.deepEqual(json(f.hooks), theirsCodex);
    assert.equal(existsSync(f.approve), false, 'the approval script goes with them');
    assert.equal(codex.status(target).state, 'off');
  });

  it('leaves a hooks.json it cannot read alone', () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.codex'));
    write(f.hooks, '{"hooks": {,}}');
    assert.throws(() => codex.install(target, setup), /hooks\.json isn't valid JSON .*so it was left as it is/);
    assert.throws(() => codex.uninstall(target), UnreadableSettings);
    assert.equal(readFileSync(f.hooks, 'utf8'), '{"hooks": {,}}');
  });

  it('uses CODEX_HOME when it is set, and only the user scope', () => {
    const target = freshHome();
    const codexHome = path.join(target.home, 'codex-home');
    codex.install({ ...target, env: { CODEX_HOME: codexHome } }, setup);
    assert.ok(existsSync(path.join(codexHome, 'hooks.json')));
    assert.equal(existsSync(path.join(target.home, '.codex')), false);
    assert.throws(() => codex.preview({ ...target, project: target.home }, setup, 'project'), /user scope, not project/);
  });
});

for (const [installer, extensions, name] of [
  [pi, '.pi/agent/extensions', 'Pi'],
  [omp, '.omp/agent/extensions', 'OMP'],
] as [HookInstaller, string, string][]) {
  describe(`${name} steps (~/${extensions}/tricot-steps)`, () => {
    const files = (home: string) => {
      const folder = path.join(home, extensions, 'tricot-steps');
      return { folder, index: path.join(folder, 'index.ts'), describe: path.join(folder, 'tricot-describe.mjs'), settings: path.join(folder, 'tricot-steps.json') };
    };

    it('shows the files it would write, with its settings, and writes nothing', () => {
      const target = freshHome();
      const preview = installer.preview(target, setup);
      assert.deepEqual(
        preview.changes.map((c) => fromHome(target.home, c.path)),
        [`${extensions}/tricot-steps/index.ts`, `${extensions}/tricot-steps/tricot-describe.mjs`, `${extensions}/tricot-steps/tricot-steps.json`],
      );
      assert.deepEqual(JSON.parse(preview.changes[2].lines!), { name, url: TRICOT_URL });
      assert.ok(preview.text.includes(`write ~/${extensions}/tricot-steps/index.ts`), preview.text);
      assert.match(preview.text, /can't hold up or change/);
      assert.equal(existsSync(path.join(target.home, extensions)), false);
      assert.equal(installer.status(target).state, 'off');
    });

    it("adds its extension beside the person's own, once, and takes it out again", () => {
      const target = freshHome();
      const f = files(target.home);
      const mine = path.join(target.home, extensions, 'mine.ts');
      write(mine, 'export default function () {}\n');
      const done = installer.install(target, { ...setup, name: `${name} Builder` });
      assert.equal(done.changed, true);
      assert.equal(readFileSync(f.index, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-steps-extension.ts'), 'utf8'));
      assert.equal(readFileSync(f.describe, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-describe.mjs'), 'utf8'));
      assert.deepEqual(json(f.settings), { name: `${name} Builder`, url: TRICOT_URL });
      assert.deepEqual(installer.status(target), { state: 'on', where: [f.index, f.describe, f.settings], sendsAs: `${name} Builder` });

      const before = mtimes([f.index, f.describe, f.settings]);
      assert.equal(installer.install(target, { ...setup, name: `${name} Builder` }).changed, false);
      assert.deepEqual(mtimes([f.index, f.describe, f.settings]), before);
      assert.deepEqual(installer.install(target, setup).files, [f.settings], 'a new name changes only the settings');

      rmSync(f.describe);
      assert.deepEqual(installer.status(target).state, 'partly');
      assert.deepEqual(installer.status(target).missing, [`~/${extensions}/tricot-steps/tricot-describe.mjs`]);

      assert.equal(installer.uninstall(target).changed, true);
      assert.equal(existsSync(f.folder), false, 'its folder goes');
      assert.equal(readFileSync(mine, 'utf8'), 'export default function () {}\n', 'their extension stays');
      assert.equal(installer.status(target).state, 'off');
      assert.equal(installer.uninstall(target).changed, false);
    });

    it('keeps its folder when something else was put in it', () => {
      const target = freshHome();
      const f = files(target.home);
      installer.install(target, setup);
      write(path.join(f.folder, 'notes.md'), 'mine');
      installer.uninstall(target);
      assert.equal(readFileSync(path.join(f.folder, 'notes.md'), 'utf8'), 'mine');
      assert.equal(existsSync(f.index), false);
    });
  });
}

describe('Pi steps', () => {
  it('uses PI_CODING_AGENT_DIR when it is set', () => {
    const target = freshHome();
    const agentDir = path.join(target.home, 'pi-agent');
    pi.install({ ...target, env: { PI_CODING_AGENT_DIR: agentDir } }, setup);
    assert.ok(existsSync(path.join(agentDir, 'extensions/tricot-steps/index.ts')));
    assert.equal(existsSync(path.join(target.home, '.pi')), false);
  });
});

describe('Gemini CLI steps (~/.gemini/settings.json)', () => {
  const files = (folder: string) => ({
    settings: path.join(folder, 'settings.json'),
    script: path.join(folder, 'hooks/tricot-steps.mjs'),
    describe: path.join(folder, 'hooks/tricot-describe.mjs'),
  });
  const theirsGemini = {
    security: { auth: { selectedType: 'oauth-personal' } },
    mcpServers: { tricot: { httpUrl: 'http://127.0.0.1:4545/mcp?agent=Gemini' } },
    hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ name: 'lint', type: 'command', command: './lint.sh' }] }] },
  };

  it('shows its hooks, and that Gemini CLI waits for them, and writes nothing', () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.gemini'));
    const preview = gemini.preview(target, setup);
    assert.deepEqual(preview.notes, [GEMINI_WAITS]);
    assert.ok(preview.text.includes('add to ~/.gemini/settings.json'), preview.text);
    assert.deepEqual(
      preview.changes.map((c) => [fromHome(target.home, c.path), c.does]),
      [
        ['.gemini/hooks/tricot-steps.mjs', 'write'],
        ['.gemini/hooks/tricot-describe.mjs', 'write'],
        ['.gemini/settings.json', 'add'],
      ],
    );
    const hooks = JSON.parse(preview.changes[2].lines!).hooks;
    assert.deepEqual(Object.keys(hooks), ['BeforeTool', 'AfterTool', 'Notification', 'AfterAgent']);
    assert.equal(hooks.BeforeTool[0].matcher, undefined, 'every tool');
    assert.equal(hooks.AfterTool[0].matcher, '^(run_shell_command|codebase_investigator|cli_help|generalist|browser_agent)$');
    assert.deepEqual(hooks.BeforeTool[0].hooks[0], {
      name: 'tricot-steps',
      type: 'command',
      command: `node --no-warnings "${asWritten(f.script)}" --name Gemini --url ${TRICOT_URL}`,
      timeout: 5000,
    });
    assert.equal(existsSync(path.join(target.home, '.gemini')), false);
    assert.equal(gemini.status(target).state, 'off');
  });

  it("adds its hooks beside the person's own settings, once, and takes them out again", async () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.gemini'));
    write(f.settings, JSON.stringify(theirsGemini, null, 2));
    const done = gemini.install(target, { ...setup, name: 'Gemini Builder' });
    assert.equal(done.changed, true);
    assert.deepEqual(done.files, [f.script, f.describe, f.settings]);
    assert.match(done.message, /Gemini CLI picks it up in its next session/);
    const added = json(f.settings);
    assert.deepEqual(added.security, theirsGemini.security);
    assert.deepEqual(added.mcpServers, theirsGemini.mcpServers);
    assert.deepEqual(added.hooks.BeforeTool[0], theirsGemini.hooks.BeforeTool[0], 'theirs first, as it was');
    assert.equal(added.hooks.BeforeTool[1].hooks[0].command, `node --no-warnings "${asWritten(f.script)}" --name 'Gemini Builder' --url ${TRICOT_URL}`);
    assert.deepEqual(gemini.status(target), { state: 'on', where: [f.settings, f.script, f.describe], sendsAs: 'Gemini Builder' });

    // Gemini CLI's own events, through the copied script, as the steps Claude Code's would give.
    const event = { session_id: 'g1', cwd: '/w', transcript_path: '/w/SECRET.json', timestamp: '2026-11-03T12:00:00Z' };
    const step = async (more: Record<string, unknown>) => {
      const ran = await runScript(f.script, { ...event, ...more });
      assert.equal(ran.code, 0);
      assert.doesNotMatch(ran.stdout, /SECRET/);
      return ran.stdout ? JSON.parse(ran.stdout) : undefined;
    };
    assert.equal((await step({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: '/w/src/a.ts' } })).text, `Reading ${fromProject('src/a.ts')}`);
    const test = { tool_name: 'run_shell_command', tool_input: { command: 'npm test -- --token SECRET', description: 'SECRET' } };
    const started = await step({ hook_event_name: 'BeforeTool', ...test });
    assert.deepEqual([started.text, started.running, started.session], ['Running npm test', true, 'g1']);
    const ended = await step({ hook_event_name: 'AfterTool', ...test, tool_response: { llmContent: 'SECRET', returnDisplay: 'SECRET' } });
    assert.deepEqual([ended.text, ended.ended, ended.tool], ['Ran npm test', true, started.tool], 'its end pairs with its start');
    const failed = await step({ hook_event_name: 'AfterTool', ...test, tool_response: { llmContent: 'SECRET', error: { message: 'SECRET' } } });
    assert.equal(failed.text, 'npm test failed');
    const claim = await step({ hook_event_name: 'BeforeTool', tool_name: 'mcp_tricot_claim_task', tool_input: { task_id: 't_1', note: 'SECRET' } });
    assert.deepEqual([claim.text, claim.task], ['Claiming the task', 't_1']);
    assert.equal((await step({ hook_event_name: 'Notification', notification_type: 'ToolPermission', message: 'SECRET' })).text, 'Waiting for your permission in the terminal');
    assert.deepEqual(
      [(await step({ hook_event_name: 'AfterAgent', prompt: 'SECRET', prompt_response: 'SECRET' })).text],
      ['Finished its turn'],
    );
    assert.equal(await step({ hook_event_name: 'BeforeAgent', prompt: 'SECRET' }), undefined);

    const before = mtimes([f.script, f.describe, f.settings]);
    assert.equal(gemini.install(target, { ...setup, name: 'Gemini Builder' }).changed, false);
    assert.deepEqual(mtimes([f.script, f.describe, f.settings]), before, 'nothing written again');
    assert.deepEqual(gemini.install(target, setup).files, [f.settings], 'a new name changes only the settings');
    assert.equal(json(f.settings).hooks.BeforeTool.length, 2, 'replaced, not added twice');

    const removed = gemini.uninstall(target);
    assert.equal(removed.changed, true);
    assert.deepEqual(json(f.settings), theirsGemini, 'every other setting as it was');
    assert.equal(existsSync(f.script) || existsSync(f.describe), false);
    assert.equal(gemini.status(target).state, 'off');
    assert.equal(gemini.uninstall(target).changed, false);
  });

  it('says when its settings switch hooks off, and leaves that as it is', () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.gemini'));
    write(f.settings, JSON.stringify({ hooksConfig: { enabled: false } }));
    assert.match(gemini.preview(target, setup).notes[1], /turn Gemini CLI's hooks off/);
    gemini.install(target, setup);
    assert.deepEqual(json(f.settings).hooksConfig, { enabled: false });
    write(f.settings, JSON.stringify({ hooksConfig: { disabled: ['tricot-steps'] } }));
    assert.match(gemini.preview(target, setup).notes[1], /switch off the hook named tricot-steps/);
  });

  it('leaves settings it cannot read alone (with comments, say), and says so', () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.gemini'));
    const commented = '{\n  // mine\n  "theme": "Dracula"\n}\n';
    write(f.settings, commented);
    assert.throws(() => gemini.install(target, setup), /settings\.json isn't valid JSON .*so it was left as it is/);
    assert.equal(readFileSync(f.settings, 'utf8'), commented);
    assert.equal(existsSync(f.script), false);
  });

  it('uses GEMINI_CLI_HOME when it is set, and only the user scope', () => {
    const target = freshHome();
    const geminiHome = path.join(target.home, 'gemini-home');
    gemini.install({ ...target, env: { GEMINI_CLI_HOME: geminiHome } }, setup);
    assert.ok(existsSync(path.join(geminiHome, '.gemini/settings.json')));
    assert.equal(existsSync(path.join(target.home, '.gemini')), false);
    assert.throws(() => gemini.preview({ ...target, project: target.home }, setup, 'project'), /user scope, not project/);
  });
});

describe('Grok Build steps (~/.grok/hooks/tricot-steps.json)', () => {
  const files = (folder: string) => ({
    hooks: path.join(folder, 'hooks/tricot-steps.json'),
    script: path.join(folder, 'hooks/tricot-steps.mjs'),
    describe: path.join(folder, 'hooks/tricot-describe.mjs'),
  });
  // A hook file of the person's own beside it: Grok loads every *.json in the folder.
  const theirsGrok = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bin/safety-check.sh', timeout: 10 }] }] } };

  it('shows its hook file, and that Grok Build waits for it, and writes nothing', () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.grok'));
    const preview = grok.preview(target, setup);
    assert.deepEqual(preview.notes, [GROK_WAITS]);
    assert.ok(preview.text.includes('add to ~/.grok/hooks/tricot-steps.json'), preview.text);
    assert.deepEqual(
      preview.changes.map((c) => [fromHome(target.home, c.path), c.does]),
      [
        ['.grok/hooks/tricot-steps.mjs', 'write'],
        ['.grok/hooks/tricot-describe.mjs', 'write'],
        ['.grok/hooks/tricot-steps.json', 'add'],
      ],
    );
    const hooks = JSON.parse(preview.changes[2].lines!).hooks;
    assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop']);
    assert.equal(hooks.PreToolUse[0].matcher, undefined, 'every tool');
    assert.equal(hooks.PostToolUse[0].matcher, 'run_terminal_command|spawn_subagent');
    assert.equal(hooks.PostToolUseFailure[0].matcher, 'run_terminal_command|spawn_subagent');
    assert.equal(hooks.Notification[0].matcher, 'permission_prompt');
    assert.deepEqual(hooks.PreToolUse[0].hooks[0], { type: 'command', command: `node "${asWritten(f.script)}" --name Grok --url ${TRICOT_URL}`, timeout: 5 });
    assert.equal(existsSync(path.join(target.home, '.grok')), false);
    assert.equal(grok.status(target).state, 'off');
  });

  it("sets up its own hook file beside the person's, once, runs as Grok sends its events, and takes it out again", async () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.grok'));
    const theirFile = path.join(path.dirname(f.hooks), 'safety.json');
    write(theirFile, JSON.stringify(theirsGrok, null, 2));
    const done = grok.install(target, { ...setup, name: 'Grok Builder' });
    assert.equal(done.changed, true);
    assert.deepEqual(done.files, [f.script, f.describe, f.hooks]);
    assert.match(done.message, /Grok Build picks it up in its next session/);
    assert.deepEqual(json(theirFile), theirsGrok, 'their file is not touched');
    assert.equal(json(f.hooks).hooks.PreToolUse[0].hooks[0].command, `node "${asWritten(f.script)}" --name 'Grok Builder' --url ${TRICOT_URL}`);
    assert.deepEqual(grok.status(target), { state: 'on', where: [f.hooks, f.script, f.describe], sendsAs: 'Grok Builder' });

    // Grok Build's own events (its hooks guide, "Writing Hook Scripts": camelCase fields, and snake_case ones beside them), through the copied script.
    const grokEvent = (name: string, snake: string, more: Record<string, unknown>) => ({
      hookEventName: snake,
      hook_event_name: name,
      sessionId: 'k1',
      session_id: 'k1',
      cwd: '/w',
      workspaceRoot: '/w',
      timestamp: '2026-11-05T12:00:00Z',
      ...more,
    });
    const tool = (name: string, input: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
      toolName: name,
      tool_name: name,
      toolInput: input,
      tool_input: input,
      toolUseId: 'call_1',
      tool_use_id: 'call_1',
      toolInputTruncated: false,
      ...more,
    });
    const step = async (event: Record<string, unknown>) => {
      const ran = await runScript(f.script, event);
      assert.equal(ran.code, 0);
      assert.doesNotMatch(ran.stdout, /SECRET/);
      return ran.stdout ? JSON.parse(ran.stdout) : undefined;
    };
    assert.equal((await step(grokEvent('PreToolUse', 'pre_tool_use', tool('read_file', { target_file: '/w/src/a.ts' })))).text, `Reading ${fromProject('src/a.ts')}`);
    const test = tool('run_terminal_command', { command: 'npm test -- --token SECRET', description: 'SECRET' });
    const started = await step(grokEvent('PreToolUse', 'pre_tool_use', test));
    assert.deepEqual([started.text, started.running, started.session, started.tool], ['Running npm test', true, 'k1', 'call_1']);
    const ended = await step(grokEvent('PostToolUse', 'post_tool_use', { ...test, toolResult: { type: 'Bash', output_for_prompt: 'SECRET' }, tool_response: { type: 'SECRET' }, durationMs: 4200, duration_ms: 4200 }));
    assert.deepEqual([ended.text, ended.ended, ended.tool, ended.ms], ['Ran npm test', true, 'call_1', 4200], 'its end pairs with its start');
    const failed = await step(grokEvent('PostToolUseFailure', 'post_tool_use_failure', { ...test, error: 'SECRET' }));
    assert.equal(failed.text, 'npm test failed');
    const claim = await step(grokEvent('PreToolUse', 'pre_tool_use', tool('tricot__claim_task', { task_id: 't_1', note: 'SECRET' })));
    assert.deepEqual([claim.text, claim.task], ['Claiming the task', 't_1']);
    assert.equal((await step(grokEvent('Notification', 'notification', { notificationType: 'permission_prompt', message: 'SECRET' }))).text, 'Waiting for your permission in the terminal');
    assert.equal((await step(grokEvent('Stop', 'stop', { reason: 'end_turn', stopHookActive: false, lastAssistantMessage: 'SECRET' }))).text, 'Finished its turn');
    assert.equal(await step(grokEvent('SessionStart', 'session_start', { source: 'startup' })), undefined);

    const before = mtimes([f.script, f.describe, f.hooks]);
    assert.equal(grok.install(target, { ...setup, name: 'Grok Builder' }).changed, false);
    assert.deepEqual(mtimes([f.script, f.describe, f.hooks]), before, 'nothing written again');
    assert.deepEqual(grok.install(target, setup).files, [f.hooks], 'a new name changes only the hook file');
    assert.equal(json(f.hooks).hooks.PreToolUse.length, 1, 'replaced, not added twice');

    const removed = grok.uninstall(target);
    assert.equal(removed.changed, true);
    assert.deepEqual(json(f.hooks), {}, 'a file with no hooks, which Grok reads as none');
    assert.deepEqual(json(theirFile), theirsGrok, 'their file is not touched');
    assert.equal(existsSync(f.script) || existsSync(f.describe), false);
    assert.equal(grok.status(target).state, 'off');
    assert.equal(grok.uninstall(target).changed, false);
  });

  it('leaves a hook file of its name it cannot read alone, and says so', () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.grok'));
    write(f.hooks, 'not json {{{');
    assert.throws(() => grok.install(target, setup), /isn't valid JSON .*so it was left as it is/);
    assert.equal(readFileSync(f.hooks, 'utf8'), 'not json {{{');
    assert.equal(existsSync(f.script), false);
  });

  it('uses GROK_HOME when it is set, and only the user scope', () => {
    const target = freshHome();
    const grokHome = path.join(target.home, 'grok-home');
    grok.install({ ...target, env: { GROK_HOME: grokHome } }, setup);
    assert.ok(existsSync(path.join(grokHome, 'hooks/tricot-steps.json')));
    assert.equal(existsSync(path.join(target.home, '.grok')), false);
    assert.throws(() => grok.preview({ ...target, project: target.home }, setup, 'project'), /user scope, not project/);
  });
});

describe('OpenCode steps (~/.config/opencode/plugins/tricot-steps.js)', () => {
  const files = (config: string) => ({
    plugin: path.join(config, 'plugins/tricot-steps.js'),
    folder: path.join(config, 'tricot-steps'),
    describe: path.join(config, 'tricot-steps/tricot-describe.mjs'),
    settings: path.join(config, 'tricot-steps/tricot-steps.json'),
  });

  it('shows the files it would write, with its settings, and writes nothing', () => {
    const target = freshHome();
    const preview = opencode.preview(target, setup);
    assert.deepEqual(
      preview.changes.map((c) => [fromHome(target.home, c.path), c.what]),
      [
        ['.config/opencode/plugins/tricot-steps.js', 'the plugin: sends each step to Tricot'],
        ['.config/opencode/tricot-steps/tricot-describe.mjs', 'puts each step in words'],
        ['.config/opencode/tricot-steps/tricot-steps.json', 'the name it shows as, and where Tricot is'],
      ],
    );
    assert.deepEqual(JSON.parse(preview.changes[2].lines!), { name: 'OpenCode', url: TRICOT_URL });
    assert.match(preview.text, /write ~\/\.config\/opencode\/plugins\/tricot-steps\.js/);
    assert.match(preview.text, /in version 1 or 2.*can't hold up or change what OpenCode does/);
    assert.equal(existsSync(path.join(target.home, '.config')), false);
    assert.equal(opencode.status(target).state, 'off');
  });

  it("adds its plugin beside the person's own, once, and takes it out again", () => {
    const target = freshHome();
    const f = files(path.join(target.home, '.config/opencode'));
    const mine = path.join(target.home, '.config/opencode/plugins/mine.ts');
    const config = path.join(target.home, '.config/opencode/opencode.json');
    write(mine, 'export const Mine = async () => ({})\n');
    write(config, '{ "theme": "opencode" }\n');
    const done = opencode.install(target, { ...setup, name: 'OpenCode Builder' });
    assert.equal(done.changed, true);
    assert.equal(done.message, 'Set up OpenCode\'s steps in ~/.config/opencode/plugins/tricot-steps.js and ~/.config/opencode/tricot-steps. OpenCode loads it in its next session.');
    assert.equal(readFileSync(f.plugin, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-steps-opencode.js'), 'utf8'));
    assert.equal(readFileSync(f.describe, 'utf8'), readFileSync(path.join(SOURCE, 'tricot-describe.mjs'), 'utf8'));
    assert.deepEqual(json(f.settings), { name: 'OpenCode Builder', url: TRICOT_URL });
    assert.deepEqual(opencode.status(target), { state: 'on', where: [f.plugin, f.describe, f.settings], sendsAs: 'OpenCode Builder' });

    const before = mtimes([f.plugin, f.describe, f.settings]);
    assert.equal(opencode.install(target, { ...setup, name: 'OpenCode Builder' }).changed, false);
    assert.deepEqual(mtimes([f.plugin, f.describe, f.settings]), before);
    assert.deepEqual(opencode.install(target, setup).files, [f.settings], 'a new name changes only the settings');

    rmSync(f.describe);
    assert.equal(opencode.status(target).state, 'partly');
    assert.deepEqual(opencode.status(target).missing, ['~/.config/opencode/tricot-steps/tricot-describe.mjs']);

    const removed = opencode.uninstall(target);
    assert.equal(removed.changed, true);
    assert.match(removed.message, /^Removed Tricot's steps plugin \(~\/\.config\/opencode\/plugins\/tricot-steps\.js and /);
    assert.equal(existsSync(f.plugin) || existsSync(f.folder), false, 'its file and folder go');
    assert.equal(readFileSync(mine, 'utf8'), 'export const Mine = async () => ({})\n', 'their plugin stays');
    assert.equal(readFileSync(config, 'utf8'), '{ "theme": "opencode" }\n', 'its config is never touched');
    assert.equal(opencode.status(target).state, 'off');
    assert.equal(opencode.uninstall(target).changed, false);
  });

  it('uses XDG_CONFIG_HOME when it is set', () => {
    const target = freshHome();
    const xdg = path.join(target.home, 'xdg');
    opencode.install({ ...target, env: { XDG_CONFIG_HOME: xdg } }, setup);
    assert.ok(existsSync(path.join(xdg, 'opencode/plugins/tricot-steps.js')));
    assert.equal(existsSync(path.join(target.home, '.config')), false);
  });
});

// From the security audit (#77): the files Tricot writes keep their mode, and
// it never writes through a link, nor replaces one.
describe('Goose steps (a plugin in ~/.agents/plugins/tricot-steps)', () => {
  const files = (home: string) => {
    const plugin = path.join(home, '.agents/plugins/tricot-steps');
    return { plugin, hooks: path.join(plugin, 'hooks/hooks.json'), script: path.join(plugin, 'hooks/tricot-steps.mjs'), describe: path.join(plugin, 'hooks/tricot-describe.mjs') };
  };

  it('shows its hooks, and that Goose waits for them, and writes nothing', () => {
    const target = freshHome();
    const f = files(target.home);
    const preview = goose.preview(target, setup);
    assert.ok(preview.notes.includes(GOOSE_WAITS), preview.notes.join('\n'));
    assert.ok(preview.text.includes('add to ~/.agents/plugins/tricot-steps/hooks/hooks.json'), preview.text);
    assert.deepEqual(
      preview.changes.map((c) => [fromHome(target.home, c.path), c.does]),
      [
        ['.agents/plugins/tricot-steps/hooks/tricot-steps.mjs', 'write'],
        ['.agents/plugins/tricot-steps/hooks/tricot-describe.mjs', 'write'],
        ['.agents/plugins/tricot-steps/hooks/hooks.json', 'add'],
      ],
    );
    const hooks = JSON.parse(preview.changes[2].lines!).hooks;
    assert.deepEqual(Object.keys(hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
    assert.equal(hooks.PreToolUse[0].matcher, undefined, 'every tool');
    assert.equal(hooks.PostToolUse[0].matcher, '^(shell|delegate)$');
    assert.equal(hooks.PostToolUseFailure[0].matcher, '^(shell|delegate)$');
    assert.deepEqual(hooks.PreToolUse[0].hooks[0], { type: 'command', command: `node "${asWritten(f.script)}" --name Goose --url ${TRICOT_URL}`, timeout: 5 });
    assert.equal(existsSync(path.join(target.home, '.agents')), false);
    assert.equal(goose.status(target).state, 'off');
  });

  it("writes the plugin, once, runs Goose's own events through its script, and takes it out", async () => {
    const target = freshHome();
    const f = files(target.home);
    const done = goose.install(target, { ...setup, name: 'Goose Builder' });
    assert.equal(done.changed, true);
    assert.deepEqual(done.files, [f.script, f.describe, f.hooks]);
    assert.match(done.message, /Goose picks it up in its next session/);
    assert.equal(json(f.hooks).hooks.Stop[0].hooks[0].command, `node "${asWritten(f.script)}" --name 'Goose Builder' --url ${TRICOT_URL}`);
    assert.deepEqual(goose.status(target), { state: 'on', where: [f.hooks, f.script, f.describe], sendsAs: 'Goose Builder' });
    assert.equal(existsSync(path.join(f.plugin, 'plugin.json')), false, 'no manifest: Goose names a plugin that only has hooks after its folder');

    // Goose's own events, through the copied script, as the steps Claude Code's would give.
    const event = { session_id: 'gs1', working_dir: '/w' };
    const step = async (more: Record<string, unknown>) => {
      const ran = await runScript(f.script, { ...event, ...more });
      assert.equal(ran.code, 0);
      assert.doesNotMatch(ran.stdout, /SECRET/);
      return ran.stdout ? JSON.parse(ran.stdout) : undefined;
    };
    const test = { tool_name: 'shell', tool_input: { command: 'npm test -- --token SECRET', timeout_secs: 5 }, tool_call_id: 'call-1' };
    const started = await step({ event: 'PreToolUse', ...test });
    assert.deepEqual([started.text, started.running, started.tool, started.session], ['Running npm test', true, 'call-1', 'gs1']);
    const ended = await step({ event: 'PostToolUse', ...test });
    assert.deepEqual([ended.text, ended.ended, ended.tool], ['Ran npm test', true, 'call-1']);
    assert.equal((await step({ event: 'PostToolUseFailure', ...test })).text, 'npm test failed');
    assert.equal((await step({ event: 'PreToolUse', tool_name: 'edit', tool_input: { path: '/w/src/a.ts', before: 'SECRET', after: 'SECRET' } })).text, `Editing ${fromProject('src/a.ts')}`);
    const claim = await step({ event: 'PreToolUse', tool_name: 'tricot__claim_task', tool_input: { task_id: 't_1', note: 'SECRET' } });
    assert.deepEqual([claim.text, claim.task], ['Claiming the task', 't_1']);
    assert.equal((await step({ event: 'Stop', last_assistant_message: 'SECRET' })).text, 'Finished its turn');
    assert.equal(await step({ event: 'SessionStart' }), undefined);

    const before = mtimes([f.script, f.describe, f.hooks]);
    assert.equal(goose.install(target, { ...setup, name: 'Goose Builder' }).changed, false);
    assert.deepEqual(mtimes([f.script, f.describe, f.hooks]), before, 'nothing written again');
    assert.deepEqual(goose.install(target, setup).files, [f.hooks], 'a new name changes only the hooks');
    assert.equal(json(f.hooks).hooks.PreToolUse.length, 1, 'replaced, not added twice');

    const removed = goose.uninstall(target);
    assert.equal(removed.changed, true);
    assert.deepEqual(json(f.hooks), {}, 'its hooks out, nothing else in the file');
    assert.equal(existsSync(f.script) || existsSync(f.describe), false);
    assert.equal(goose.status(target).state, 'off');
    assert.equal(goose.uninstall(target).changed, false);
  });

  it("keeps hooks of someone else's in the same plugin file, as they were", () => {
    const target = freshHome();
    const f = files(target.home);
    const mine = { hooks: { PreToolUse: [{ matcher: '^shell$', hooks: [{ type: 'command', command: './lint.sh' }] }] } };
    write(f.hooks, JSON.stringify(mine));
    goose.install(target, setup);
    assert.deepEqual(json(f.hooks).hooks.PreToolUse[0], mine.hooks.PreToolUse[0]);
    assert.equal(json(f.hooks).hooks.PreToolUse.length, 2);
    goose.uninstall(target);
    assert.deepEqual(json(f.hooks), mine);
  });

  it('leaves a hooks file it cannot read alone, and says so', () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.hooks, '{ not json');
    assert.throws(() => goose.install(target, setup), /hooks\.json isn't valid JSON .*so it was left as it is/);
    assert.equal(readFileSync(f.hooks, 'utf8'), '{ not json');
  });

  it('puts the plugin under $GOOSE_PATH_ROOT when that is set, and only the user scope', () => {
    const target = freshHome();
    const root = path.join(target.home, 'goose-root');
    goose.install({ ...target, env: { GOOSE_PATH_ROOT: root } }, setup);
    assert.ok(existsSync(path.join(root, '.agents/plugins/tricot-steps/hooks/hooks.json')));
    assert.equal(existsSync(path.join(target.home, '.agents')), false);
    assert.throws(() => goose.preview({ ...target, project: target.home }, setup, 'project'), /user scope, not project/);
  });
});

describe('Hermes steps (shell hooks in ~/.hermes/config.yaml)', () => {
  const files = (home: string) => ({
    folder: path.join(home, '.hermes'),
    config: path.join(home, '.hermes/config.yaml'),
    script: path.join(home, '.hermes/agent-hooks/tricot-steps.mjs'),
    describe: path.join(home, '.hermes/agent-hooks/tricot-describe.mjs'),
    allowlist: path.join(home, '.hermes/shell-hooks-allowlist.json'),
  });
  const theirsHermes = '# my Hermes\nmodel:\n  default: anthropic/claude-sonnet-4.6   # the usual\nmcp_servers:\n  github:\n    url: "https://example.com/mcp"\n';
  const block = (f: ReturnType<typeof files>, name = 'Hermes') => {
    const command = JSON.stringify(`node "${asWritten(f.script)}" --name ${name} --url ${TRICOT_URL}`);
    return [
      HERMES_BEGIN,
      'hooks:',
      '  pre_tool_call:',
      `    - command: ${command}`,
      '      timeout: 5',
      '  post_tool_call:',
      '    - matcher: "terminal|delegate_task"',
      `      command: ${command}`,
      '      timeout: 5',
      '  post_llm_call:',
      `    - command: ${command}`,
      '      timeout: 5',
      '  pre_approval_request:',
      `    - command: ${command}`,
      '      timeout: 5',
      HERMES_END,
    ].join('\n');
  };

  it("won't make config.yaml: Hermes makes it, with its defaults, the first time it runs", () => {
    const target = freshHome();
    const f = files(target.home);
    mkdirSync(f.folder);
    assert.throws(() => hermes.preview(target, setup), /config\.yaml isn't there yet .*so it was left as it is/);
    assert.throws(() => hermes.install(target, setup), UnreadableSettings);
    assert.equal(existsSync(f.config), false);
    assert.equal(existsSync(f.script), false, 'nothing else written either');
    assert.equal(hermes.status(target).state, 'off');
  });

  it('shows its hooks as the lines it would add to config.yaml, what to know, and writes nothing', () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.config, theirsHermes);
    const preview = hermes.preview(target, setup);
    assert.deepEqual(preview.notes, [HERMES_OWN_LINES, HERMES_APPROVAL, HERMES_WAITS]);
    assert.deepEqual(
      preview.changes.map((c) => [fromHome(target.home, c.path), c.does]),
      [
        ['.hermes/agent-hooks/tricot-steps.mjs', 'write'],
        ['.hermes/agent-hooks/tricot-describe.mjs', 'write'],
        ['.hermes/config.yaml', 'add'],
      ],
    );
    assert.equal(preview.changes[2].lines, block(f));
    assert.ok(preview.text.includes('add to ~/.hermes/config.yaml'), preview.text);
    assert.equal(readFileSync(f.config, 'utf8'), theirsHermes);
    assert.equal(existsSync(f.script), false);
    assert.equal(hermes.status(target).state, 'off');
  });

  it("adds its section after the person's own lines, once, runs Hermes's own events through its script, and takes it out", async () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.config, theirsHermes);
    const done = hermes.install(target, { ...setup, name: 'Hermes Builder' });
    assert.equal(done.changed, true);
    assert.deepEqual(done.files, [f.script, f.describe, f.config]);
    assert.match(done.message, /^Set up Hermes Agent's steps in .*Hermes asks you to approve it the first time/);
    assert.equal(readFileSync(f.config, 'utf8'), `${theirsHermes}\n${block(f, "'Hermes Builder'")}\n`, "theirs first, comments and all, then a blank line and Tricot's lines");
    assert.deepEqual(hermes.status(target), { state: 'on', where: [f.config, f.script, f.describe], sendsAs: 'Hermes Builder', trust: 'Needs your OK in Hermes the first time it runs' });

    // Hermes's own events, through the copied script, as the steps Claude Code's would give.
    const event = { session_id: 'h1', cwd: '/w', profile: 'default' };
    const step = async (more: Record<string, unknown>) => {
      const ran = await runScript(f.script, { ...event, ...more });
      assert.equal(ran.code, 0);
      assert.doesNotMatch(ran.stdout, /SECRET/);
      return ran.stdout ? JSON.parse(ran.stdout) : undefined;
    };
    const test = { tool_name: 'terminal', tool_input: { command: 'npm test -- --token SECRET' } };
    const started = await step({ hook_event_name: 'pre_tool_call', ...test, extra: { tool_call_id: 'tc1', task_id: 'SECRET' } });
    assert.deepEqual([started.text, started.running, started.tool, started.session], ['Running npm test', true, 'tc1', 'h1']);
    const ended = await step({ hook_event_name: 'post_tool_call', ...test, extra: { tool_call_id: 'tc1', status: 'ok', duration_ms: 1500, result: 'SECRET' } });
    assert.deepEqual([ended.text, ended.ended, ended.tool, ended.ms], ['Ran npm test', true, 'tc1', 1500]);
    assert.equal((await step({ hook_event_name: 'post_tool_call', ...test, extra: { status: 'error', error_message: 'SECRET' } })).text, 'npm test failed');
    assert.equal((await step({ hook_event_name: 'pre_tool_call', tool_name: 'patch', tool_input: { path: '/w/src/a.ts', old_string: 'SECRET' }, extra: {} })).text, `Editing ${fromProject('src/a.ts')}`);
    const claim = await step({ hook_event_name: 'pre_tool_call', tool_name: 'mcp__tricot__claim_task', tool_input: { task_id: 't_1', note: 'SECRET' }, extra: {} });
    assert.deepEqual([claim.text, claim.task], ['Claiming the task', 't_1']);
    assert.equal((await step({ hook_event_name: 'pre_approval_request', extra: { command: 'SECRET' } })).text, 'Waiting for your permission in the terminal');
    assert.equal((await step({ hook_event_name: 'post_llm_call', extra: { assistant_response: 'SECRET' } })).text, 'Finished its turn');
    assert.equal(await step({ hook_event_name: 'on_session_start', extra: {} }), undefined);

    const before = mtimes([f.script, f.describe, f.config]);
    assert.equal(hermes.install(target, { ...setup, name: 'Hermes Builder' }).changed, false);
    assert.deepEqual(mtimes([f.script, f.describe, f.config]), before, 'nothing written again');
    assert.deepEqual(hermes.install(target, setup).files, [f.config], 'a new name changes only the config');
    assert.equal(readFileSync(f.config, 'utf8'), `${theirsHermes}\n${block(f)}\n`, 'replaced, not added twice');

    const removed = hermes.uninstall(target);
    assert.equal(removed.changed, true);
    assert.equal(readFileSync(f.config, 'utf8'), theirsHermes, 'every other line exactly as it was');
    assert.equal(existsSync(f.script) || existsSync(f.describe), false);
    assert.equal(hermes.status(target).state, 'off');
    assert.equal(hermes.uninstall(target).changed, false);
  });

  it('keeps a file with Windows line ends, or no last line end, tidy', () => {
    const target = freshHome();
    const f = files(target.home);
    const windows = 'model: x\r\nmcp_servers: {}\r\n';
    write(f.config, windows);
    hermes.install(target, setup);
    const text = readFileSync(f.config, 'utf8');
    assert.ok(text.startsWith(`${windows}\r\n${HERMES_BEGIN}\r\n`), JSON.stringify(text));
    assert.ok(!/[^\r]\n/.test(text), 'every line end the file had');
    hermes.uninstall(target);
    assert.equal(readFileSync(f.config, 'utf8'), windows);
    write(f.config, 'model: x');
    hermes.install(target, setup);
    assert.ok(readFileSync(f.config, 'utf8').startsWith('model: x\n\n# >>>'));
    hermes.uninstall(target);
    assert.equal(readFileSync(f.config, 'utf8'), 'model: x\n', 'the last line end it needed stays');
  });

  it("stops at a hooks section of the person's own, however it is written, and leaves the file as it is", () => {
    for (const own of ['hooks:\n  pre_tool_call:\n    - command: ./mine.sh\n', 'hooks: {}\n', '"hooks":\n  outbound: []\n']) {
      const target = freshHome();
      const f = files(target.home);
      write(f.config, `model: x\n${own}`);
      assert.throws(() => hermes.preview(target, setup), /config\.yaml has a hooks: section of its own \(line 2\).*so it was left as it is/, own);
      assert.throws(() => hermes.install(target, setup), UnreadableSettings);
      assert.equal(readFileSync(f.config, 'utf8'), `model: x\n${own}`);
      assert.equal(existsSync(f.script), false, 'nothing else written either');
    }
    // A commented-out one, or one nested under another key, is not a section of its own.
    const target = freshHome();
    const f = files(target.home);
    write(f.config, '# hooks:\nplugins:\n  hooks:\n    x: 1\n');
    assert.equal(hermes.install(target, setup).changed, true);
  });

  it('says so when its lines are opened but not closed, and changes nothing', () => {
    const target = freshHome();
    const f = files(target.home);
    const broken = `model: x\n${HERMES_BEGIN}\nhooks: {}\n`;
    write(f.config, broken);
    assert.throws(() => hermes.install(target, setup), /without its closing one/);
    assert.throws(() => hermes.uninstall(target), /without its closing one/);
    assert.equal(hermes.status(target).state, 'partly');
    assert.match(hermes.status(target).problem!, /without its closing one/);
    assert.equal(readFileSync(f.config, 'utf8'), broken);
  });

  it('says whether Hermes has been told yes to each of its hooks, from its allowlist', () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.config, theirsHermes);
    hermes.install(target, setup);
    const command = `node "${asWritten(f.script)}" --name Hermes --url ${TRICOT_URL}`;
    const approvals = (events: string[]) => JSON.stringify({ approvals: events.map((event) => ({ event, command })) });
    write(f.allowlist, approvals(['pre_tool_call', 'post_tool_call']));
    assert.equal(hermes.status(target).trust, 'Needs your OK in Hermes the first time it runs', 'two of four');
    write(f.allowlist, approvals(['pre_tool_call', 'post_tool_call', 'post_llm_call', 'pre_approval_request']));
    assert.equal(hermes.status(target).trust, undefined);
    write(f.allowlist, 'not json');
    assert.equal(hermes.status(target).trust, 'Needs your OK in Hermes the first time it runs');
  });

  it('is partly there when a script or an event is gone, and takes out what is left', () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.config, theirsHermes);
    hermes.install(target, setup);
    rmSync(f.describe);
    assert.equal(hermes.status(target).state, 'partly');
    assert.deepEqual(hermes.status(target).missing, ['~/.hermes/agent-hooks/tricot-describe.mjs']);
    write(f.config, readFileSync(f.config, 'utf8').replace('  post_llm_call:\n    - command', '  post_llm_call_gone:\n    - command'));
    assert.ok(hermes.status(target).missing!.includes('the post_llm_call hook in ~/.hermes/config.yaml'));
    hermes.uninstall(target);
    assert.equal(readFileSync(f.config, 'utf8'), theirsHermes);
    assert.equal(hermes.status(target).state, 'off');
  });

  it('uses $HERMES_HOME when it is set, and only the user scope', () => {
    const target = freshHome();
    const profile = path.join(target.home, 'profile');
    write(path.join(profile, 'config.yaml'), theirsHermes);
    hermes.install({ ...target, env: { HERMES_HOME: profile } }, setup);
    assert.ok(existsSync(path.join(profile, 'agent-hooks/tricot-steps.mjs')));
    assert.ok(readFileSync(path.join(profile, 'config.yaml'), 'utf8').includes(HERMES_BEGIN));
    assert.equal(existsSync(path.join(target.home, '.hermes')), false);
    assert.throws(() => hermes.preview({ ...target, project: target.home }, setup, 'project'), /user scope, not project/);
  });

  it('shows what taking it out would do, line by line', () => {
    const target = freshHome();
    const f = files(target.home);
    write(f.config, theirsHermes);
    assert.equal(hermes.previewUninstall(target).unchanged, true);
    hermes.install(target, setup);
    const preview = hermes.previewUninstall(target);
    assert.deepEqual(
      preview.changes.map((c) => [fromHome(target.home, c.path), c.does]),
      [
        ['.hermes/config.yaml', 'remove'],
        ['.hermes/agent-hooks/tricot-steps.mjs', 'delete'],
        ['.hermes/agent-hooks/tricot-describe.mjs', 'delete'],
      ],
    );
    assert.equal(preview.changes[0].lines, block(f));
  });
});

describe('the files Tricot writes', { skip: WINDOWS && 'checks POSIX file modes and symlinks' }, () => {
  const modeOf = (file: string) => (statSync(file).mode & 0o777).toString(8);
  const settingsOf = (installer: HookInstaller, home: string) =>
    installer === claude ? path.join(home, '.claude/settings.json') : installer === gemini ? path.join(home, '.gemini/settings.json') : path.join(home, '.codex/hooks.json');

  for (const installer of [claude, codex, gemini]) {
    it(`keeps a 600 ${installer.name} settings file 600, installing and uninstalling, and makes a new one 600`, () => {
      const target = freshHome();
      const settings = settingsOf(installer, target.home);
      write(settings, JSON.stringify({ hooks: {} }));
      chmodSync(settings, 0o600);
      installer.install(target, setup);
      assert.equal(modeOf(settings), '600', 'after install');
      installer.uninstall(target);
      assert.equal(modeOf(settings), '600', 'after uninstall');

      chmodSync(settings, 0o640);
      installer.install(target, setup);
      assert.equal(modeOf(settings), '640', 'whatever mode it had');

      const fresh = freshHome();
      installer.install(fresh, setup);
      assert.equal(modeOf(settingsOf(installer, fresh.home)), '600', "a new one is the person's alone");
    });
  }

  it("refuses a script that is a link (a project's tricot-steps.mjs linked to ~/.zshrc), in the preview, and writes nothing through it", () => {
    const target = freshHome();
    const zshrc = path.join(target.home, '.zshrc');
    write(zshrc, 'export PATH=/mine\n');
    const script = path.join(target.home, '.claude/hooks/tricot-steps.mjs');
    mkdirSync(path.dirname(script), { recursive: true });
    symlinkSync(zshrc, script);
    assert.throws(
      () => claude.preview(target, setup),
      (error: Error) => error instanceof UnreadableSettings && /tricot-steps\.mjs is a link \(to .*\.zshrc\).*doesn't write through links/.test(error.message),
    );
    assert.throws(() => claude.install(target, setup), UnreadableSettings);
    assert.equal(readFileSync(zshrc, 'utf8'), 'export PATH=/mine\n');
    assert.ok(lstatSync(script).isSymbolicLink(), 'the link is left as it is');
    assert.equal(existsSync(path.join(target.home, '.claude/settings.json')), false, 'nothing else written either');
  });

  it('refuses the same in a project, from `tricot steps on --agent claude --project`', async () => {
    const target = freshHome();
    const zshrc = path.join(target.home, '.zshrc');
    write(zshrc, 'export PATH=/mine\n');
    const project = path.join(target.home, 'cloned');
    mkdirSync(path.join(project, '.claude/hooks'), { recursive: true });
    symlinkSync(zshrc, path.join(project, '.claude/hooks/tricot-steps.mjs'));
    const said: string[] = [];
    const result = await runCli(['steps', 'on', '--agent', 'claude', '--project'], {
      env: { TRICOT_DATA_DIR: path.join(target.home, 'data'), PORT: '4801', HOME: target.home },
      root: repo,
      entry: path.join(repo, 'src/cli/tricot.ts'),
      out: (line) => said.push(line),
      err: (line) => said.push(line),
      open: () => {},
      cwd: project,
      ask: async () => true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(said.join('\n'), /\.claude\/hooks\/tricot-steps\.mjs is a link/);
    assert.equal(readFileSync(zshrc, 'utf8'), 'export PATH=/mine\n');
  });

  for (const [installer, settingsName, dotfile] of [
    [claude, '.claude/settings.json', 'dotfiles/claude/settings.json'],
    [codex, '.codex/hooks.json', 'dotfiles/codex/hooks.json'],
    [gemini, '.gemini/settings.json', 'dotfiles/gemini/settings.json'],
  ] as [HookInstaller, string, string][]) {
    it(`follows a link from ${settingsName} into a dotfiles folder, writing the real file and keeping the link and its 600`, () => {
      const target = freshHome();
      const real = path.join(target.home, dotfile);
      write(real, JSON.stringify({ theirs: true }));
      chmodSync(real, 0o600);
      const settings = path.join(target.home, settingsName);
      mkdirSync(path.dirname(settings), { recursive: true });
      symlinkSync(path.relative(path.dirname(settings), real), settings); // as stow makes them: relative
      const preview = installer.preview(target, setup);
      assert.ok(preview.notes.includes(`~/${settingsName} links to ~/${dotfile}; Tricot adds its lines there.`), preview.notes.join('\n'));
      assert.match(preview.text, /links to ~\/dotfiles/);

      installer.install(target, setup);
      assert.ok(lstatSync(settings).isSymbolicLink(), 'still a link');
      assert.equal(json(real).theirs, true);
      assert.ok(json(real).hooks.Stop ?? json(real).hooks.AfterAgent, "Tricot's lines are in the real file");
      assert.equal(modeOf(real), '600');
      assert.equal(installer.status(target).state, 'on');
      assert.equal(installer.preview(target, setup).unchanged, true, 'read through the link, it is set up');

      assert.ok(installer.previewUninstall(target).notes.includes(`~/${settingsName} links to ~/${dotfile}; Tricot takes its lines out there.`));
      installer.uninstall(target);
      assert.ok(lstatSync(settings).isSymbolicLink(), 'still a link');
      assert.deepEqual(json(real), { theirs: true });
      assert.equal(modeOf(real), '600');
      assert.equal(installer.status(target).state, 'off');
    });
  }

  it('refuses a user settings link that leads nowhere, or to a folder', () => {
    const target = freshHome();
    const settings = path.join(target.home, '.claude/settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    symlinkSync(path.join(target.home, 'dotfiles/gone.json'), settings);
    assert.throws(() => claude.preview(target, setup), /settings\.json is a link to .*gone\.json, which isn't there/);
    assert.throws(() => claude.install(target, setup), UnreadableSettings);
    rmSync(settings);
    mkdirSync(path.join(target.home, 'dotfiles/folder'), { recursive: true });
    symlinkSync(path.join(target.home, 'dotfiles/folder'), settings);
    assert.throws(() => claude.preview(target, setup), /which isn't a file/);
    assert.ok(lstatSync(settings).isSymbolicLink());
  });

  it("still refuses a project's settings file that is a link, as a cloned repository could plant one", () => {
    const target = freshHome();
    const real = path.join(target.home, 'dotfiles/claude/settings.json');
    write(real, JSON.stringify({ theirs: true }));
    const project = path.join(target.home, 'cloned');
    mkdirSync(path.join(project, '.claude'), { recursive: true });
    symlinkSync(real, path.join(project, '.claude/settings.json'));
    const scoped = { ...target, project };
    assert.throws(() => claude.preview(scoped, setup, 'project'), /\.claude\/settings\.json is a link \(to .*\).*doesn't write through links/);
    assert.throws(() => claude.install(scoped, setup, 'project'), UnreadableSettings);
    assert.deepEqual(json(real), { theirs: true });
    // Tricot's hooks put there by hand: taking them out is refused the same way.
    write(real, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node tricot-steps.mjs' }] }] } }));
    assert.throws(() => claude.previewUninstall(scoped, 'project'), /is a link/);
    assert.throws(() => claude.uninstall(scoped, 'project'), UnreadableSettings);
    assert.ok(lstatSync(path.join(project, '.claude/settings.json')).isSymbolicLink());
  });

  for (const [installer, extensions] of [
    [pi, '.pi/agent/extensions'],
    [omp, '.omp/agent/extensions'],
  ] as [HookInstaller, string][]) {
    it(`refuses links in ${installer.name}'s extension folder, or the folder as a link, adding or taking it out`, () => {
      const target = freshHome();
      const elsewhere = path.join(target.home, 'elsewhere');
      write(path.join(elsewhere, 'index.ts'), 'mine');
      const folder = path.join(target.home, extensions, 'tricot-steps');
      mkdirSync(path.dirname(folder), { recursive: true });
      symlinkSync(elsewhere, folder);
      assert.throws(() => installer.preview(target, setup), /tricot-steps is a link/);
      assert.throws(() => installer.install(target, setup), UnreadableSettings);
      assert.throws(() => installer.uninstall(target), UnreadableSettings, "a linked folder's files are someone else's");
      assert.equal(readFileSync(path.join(elsewhere, 'index.ts'), 'utf8'), 'mine');

      const other = freshHome();
      const zshrc = path.join(other.home, '.zshrc');
      write(zshrc, 'mine');
      const index = path.join(other.home, extensions, 'tricot-steps/index.ts');
      mkdirSync(path.dirname(index), { recursive: true });
      symlinkSync(zshrc, index);
      assert.throws(() => installer.preview(other, setup), /index\.ts is a link/);
      assert.throws(() => installer.install(other, setup), UnreadableSettings);
      assert.equal(readFileSync(zshrc, 'utf8'), 'mine');
    });
  }

  it("refuses links among OpenCode's plugin and its folder, adding or taking them out", () => {
    const target = freshHome();
    const zshrc = path.join(target.home, '.zshrc');
    write(zshrc, 'mine');
    const plugin = path.join(target.home, '.config/opencode/plugins/tricot-steps.js');
    mkdirSync(path.dirname(plugin), { recursive: true });
    symlinkSync(zshrc, plugin);
    assert.throws(() => opencode.preview(target, setup), /plugins\/tricot-steps\.js is a link/);
    assert.throws(() => opencode.install(target, setup), UnreadableSettings);
    assert.throws(() => opencode.uninstall(target), UnreadableSettings);
    assert.equal(readFileSync(zshrc, 'utf8'), 'mine');
    assert.ok(lstatSync(plugin).isSymbolicLink(), 'the link is left as it is');
    assert.equal(existsSync(path.join(target.home, '.config/opencode/tricot-steps')), false, 'nothing else written either');

    const other = freshHome();
    const elsewhere = path.join(other.home, 'elsewhere');
    write(path.join(elsewhere, 'tricot-steps.json'), 'mine');
    const folder = path.join(other.home, '.config/opencode/tricot-steps');
    mkdirSync(path.dirname(folder), { recursive: true });
    symlinkSync(elsewhere, folder);
    assert.throws(() => opencode.preview(other, setup), /opencode\/tricot-steps is a link/);
    assert.throws(() => opencode.install(other, setup), UnreadableSettings);
    assert.throws(() => opencode.uninstall(other), UnreadableSettings, "a linked folder's files are someone else's");
    assert.equal(readFileSync(path.join(elsewhere, 'tricot-steps.json'), 'utf8'), 'mine');
    assert.equal(existsSync(path.join(other.home, '.config/opencode/plugins')), false);
  });

  it("makes the files of an extension or a plugin the person's alone (600)", () => {
    const target = freshHome();
    opencode.install(target, setup);
    for (const file of opencode.status(target).where) assert.equal(modeOf(file), '600', file);
  });

  it("keeps Hermes's config.yaml at the mode it had, and refuses it, or a script, as a link", () => {
    const target = freshHome();
    const config = path.join(target.home, '.hermes/config.yaml');
    write(config, 'model: x\n');
    chmodSync(config, 0o600);
    hermes.install(target, setup);
    assert.equal(modeOf(config), '600', 'after install');
    hermes.uninstall(target);
    assert.equal(modeOf(config), '600', 'after uninstall');

    const dotfiles = path.join(target.home, 'dotfiles/config.yaml');
    write(dotfiles, 'model: x\n');
    rmSync(config);
    symlinkSync(dotfiles, config);
    assert.throws(() => hermes.preview(target, setup), /config\.yaml is a link \(to .*\).*doesn't write through links/);
    assert.throws(() => hermes.install(target, setup), UnreadableSettings);
    assert.equal(readFileSync(dotfiles, 'utf8'), 'model: x\n');
    assert.ok(lstatSync(config).isSymbolicLink(), 'the link is left as it is');

    const other = freshHome();
    const zshrc = path.join(other.home, '.zshrc');
    write(zshrc, 'mine');
    write(path.join(other.home, '.hermes/config.yaml'), 'model: x\n');
    mkdirSync(path.join(other.home, '.hermes/agent-hooks'));
    symlinkSync(zshrc, path.join(other.home, '.hermes/agent-hooks/tricot-steps.mjs'));
    assert.throws(() => hermes.install(other, setup), /tricot-steps\.mjs is a link/);
    assert.equal(readFileSync(zshrc, 'utf8'), 'mine');
    assert.equal(readFileSync(path.join(other.home, '.hermes/config.yaml'), 'utf8'), 'model: x\n');
  });

  it("makes Goose's plugin files the person's alone (600)", () => {
    const target = freshHome();
    goose.install(target, setup);
    for (const file of goose.status(target).where) assert.equal(modeOf(file), '600', file);
  });

  it('never writes through a link, even one put where its temporary file goes', () => {
    const target = freshHome();
    const victim = path.join(target.home, 'victim');
    write(victim, 'mine');
    const file = path.join(target.home, 'settings.json');
    symlinkSync(victim, file);
    assert.throws(() => writeFileAtomic(file, '{}'), UnreadableSettings);
    rmSync(file);
    symlinkSync(victim, `${file}.tricot-${process.pid}.tmp`);
    writeFileAtomic(file, '{}');
    assert.equal(readFileSync(victim, 'utf8'), 'mine');
    assert.equal(readFileSync(file, 'utf8'), '{}');
    assert.equal(lstatSync(file).isSymbolicLink(), false);
  });
});
