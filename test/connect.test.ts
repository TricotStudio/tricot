import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  agentUrl,
  claudeCommand,
  codexLines,
  exportToken,
  geminiLines,
  gooseEntry,
  grokLines,
  hermesEntry,
  ompConfig,
  ompEntry,
  opencode2Lines,
  opencodeConfig,
  opencodeEntry,
  piLines,
  shellCommand,
  shellQuote,
} from '../src/core/connect';
import { panelTexts } from '../src/core/agents/registry';

const url = 'http://127.0.0.1:4545/mcp?agent=Pi';

// The Connect panel builds its Pi and OMP tabs from these.
describe('connecting Pi and OMP', () => {
  it('quotes an address with a query string, and only then', () => {
    assert.equal(shellQuote(url), `"${url}"`);
    assert.equal(shellQuote('http://127.0.0.1:4545/mcp'), 'http://127.0.0.1:4545/mcp');
  });

  it('gives Pi one command, with no token on this machine', () => {
    assert.deepEqual(piLines(url), [`pi mcp add tricot --url "${url}"`]);
  });

  it('has Pi read the token from the environment when there is one', () => {
    const lines = piLines(url, 's3cret');
    assert.deepEqual(lines, ['export TRICOT_TOKEN=s3cret', `pi mcp add tricot --url "${url}" --bearer-token-env-var TRICOT_TOKEN`]);
  });

  it('gives OMP an http entry named tricot, with no headers on this machine', () => {
    assert.deepEqual(ompConfig('http://127.0.0.1:4545/mcp?agent=OMP'), {
      mcpServers: { tricot: { type: 'http', url: 'http://127.0.0.1:4545/mcp?agent=OMP', timeout: 300000 } },
    });
  });

  it('has OMP expand the token from the environment, never holding it', () => {
    const entry = ompEntry(url, 's3cret');
    assert.deepEqual(entry.headers, { Authorization: 'Bearer ${TRICOT_TOKEN}' });
    assert.doesNotMatch(JSON.stringify(entry), /s3cret/);
  });
});

// The Connect panel builds its Gemini CLI and OpenCode tabs from these.
describe('connecting Gemini CLI and OpenCode', () => {
  const gemini = 'http://127.0.0.1:4545/mcp?agent=Gemini';
  const opencode = 'http://127.0.0.1:4545/mcp?agent=OpenCode';

  it('gives Gemini CLI one command, for every session (--scope user), with no token on this machine', () => {
    assert.deepEqual(geminiLines(gemini), [`gemini mcp add --scope user --transport http tricot "${gemini}"`]);
  });

  it('has Gemini CLI read the token from the environment when it loads its settings, never holding it', () => {
    const lines = geminiLines(gemini, 's3cret');
    assert.deepEqual(lines, ['export TRICOT_TOKEN=s3cret', `gemini mcp add --scope user --transport http --header 'Authorization: Bearer \${TRICOT_TOKEN}' tricot "${gemini}"`]);
    assert.doesNotMatch(lines[1], /s3cret/);
  });

  it('gives Grok Build one command, for every session (--scope user), with the token in a header that names the variable', () => {
    const grok = 'http://127.0.0.1:4545/mcp?agent=Grok';
    assert.deepEqual(grokLines(grok), [`grok mcp add --scope user --transport http tricot "${grok}"`]);
    const lines = grokLines(grok, 's3cret');
    assert.deepEqual(lines, ['export TRICOT_TOKEN=s3cret', `grok mcp add --scope user --transport http --header 'Authorization: Bearer \${TRICOT_TOKEN}' tricot "${grok}"`]);
    assert.doesNotMatch(lines[1], /s3cret/);
  });

  it('gives OpenCode a remote entry named tricot, which waits past wait_for_updates, with no headers on this machine', () => {
    assert.deepEqual(opencodeConfig(opencode), { mcp: { tricot: { type: 'remote', url: opencode, timeout: 300000 } } });
  });

  it('has OpenCode put the token in from the environment, never holding it', () => {
    const entry = opencodeEntry(opencode, 's3cret');
    assert.deepEqual(entry.headers, { Authorization: 'Bearer {env:TRICOT_TOKEN}' });
    assert.doesNotMatch(JSON.stringify(entry), /s3cret/);
  });

  it("gives OpenCode 2 its own command, writing the global config", () => {
    assert.deepEqual(opencode2Lines(opencode), [`opencode mcp add tricot --url "${opencode}" --global`]);
    assert.deepEqual(opencode2Lines(opencode, 's3cret'), [
      'export TRICOT_TOKEN=s3cret',
      `opencode mcp add tricot --url "${opencode}" --global --header "Authorization=Bearer {env:TRICOT_TOKEN}"`,
    ]);
  });
});

// ---- pasting the commands into a shell ---------------------------------------

type Shell = 'zsh' | 'bash';

// The words a line pasted into an interactive shell becomes, for the little
// these commands use: plain characters, spaces, quotes and backslashes. Anything
// else the shell would act on is an error here: a glob (zsh stops with "no
// matches found"; bash keeps it only while no file matches), `&`, `$`, a
// backquote, history's `!` (live in double quotes too). The two differ where
// the shells do: bash takes `#` at the start of a word as a comment; zsh, by
// default, takes it as a word (comments typed in need INTERACTIVE_COMMENTS),
// and expands `=` at the start of a word to a command's path.
function words(line: string, shell: Shell): string[] {
  const out: string[] = [];
  let word: string | undefined;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      if (word !== undefined) out.push(word);
      word = undefined;
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error('a single quote is left open');
      word = (word ?? '') + line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let inside = '';
      for (i++; line[i] !== '"'; i++) {
        if (i >= line.length) throw new Error('a double quote is left open');
        if ('$`!'.includes(line[i])) throw new Error(`${line[i]} means something to ${shell} inside double quotes`);
        if (line[i] === '\\' && '$`"\\'.includes(line[i + 1])) i++;
        inside += line[i];
      }
      word = (word ?? '') + inside;
      i++;
    } else if (c === '\\') {
      if (i + 1 >= line.length) throw new Error('a backslash ends the line');
      word = (word ?? '') + line[i + 1];
      i += 2;
    } else if (c === '#' && word === undefined && shell === 'bash') {
      break;
    } else if (/[\w@%+:,./#-]/.test(c) || (c === '=' && !(word === undefined && shell === 'zsh'))) {
      word = (word ?? '') + c;
      i++;
    } else {
      throw new Error(`an unquoted ${c} means something to ${shell}`);
    }
  }
  if (word !== undefined) out.push(word);
  return out;
}

// The real shells, where this machine has them: `printf` prints each word the
// line hands it, so the agents' own commands never run. Neither reads any
// startup file of this user's.
const SHELLS: Record<Shell, string[]> = { zsh: ['-f', '-c'], bash: ['--norc', '--noprofile', '-c'] };
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const hasShell = (shell: Shell) => !spawnSync(shell, [...SHELLS[shell], ':'], { env }).error;
const realShells = (Object.keys(SHELLS) as Shell[]).filter(hasShell);

function inShell(shell: Shell, line: string): { status: number | null; argv: string[]; stderr: string } {
  const run = spawnSync(shell, [...SHELLS[shell], `printf '%s\\n' ${line}`], { env, encoding: 'utf8', timeout: 10_000 });
  return { status: run.status, argv: run.stdout.split('\n').slice(0, -1), stderr: run.stderr };
}

// Each line, in the model of both shells and in each real one, gives `argv`.
function assertPastes(line: string, argv: string[]): void {
  for (const shell of ['zsh', 'bash'] as const) assert.deepEqual(words(line, shell), argv, `${shell}-like: ${line}`);
  for (const shell of realShells) {
    const run = inShell(shell, line);
    assert.equal(run.status, 0, `${shell}: ${line}\n${run.stderr}`);
    assert.deepEqual(run.argv, argv, `${shell}: ${line}`);
  }
}

// Each command is its lines, and each line the words it should give.
function assertLines(text: string, argvs: string[][]): void {
  const lines = text.split('\n');
  assert.equal(lines.length, argvs.length, text);
  lines.forEach((line, n) => assertPastes(line, argvs[n]));
}

// On this machine, and an address that carries its token (`?token=`), whose
// `&agent=` would end the command if it weren't quoted.
const ADDRESSES = {
  'on this machine': 'http://127.0.0.1:4545/mcp',
  'with its token in the address': 'http://192.168.1.20:4545/mcp?token=Zm9v-YmFy_YmF6',
};
const named = (address: string, name: string) => `${address}${address.includes('?') ? '&' : '?'}agent=${name}`;
const TOKENS = ['Zm9v-YmFy_YmF6', '<token>'];

describe('the commands, pasted into zsh and bash', () => {
  it(`runs the real shells where there are some (here: ${realShells.join(', ') || 'none'})`, () => {
    for (const shell of realShells) assert.deepEqual(inShell(shell, 'a "b c"').argv, ['a', 'b c']);
  });

  it('catches the address left bare, as zsh does', () => {
    const bare = 'claude mcp add --transport http tricot http://127.0.0.1:4545/mcp?agent=Claude';
    assert.throws(() => words(bare, 'zsh'), /unquoted \?/);
    if (realShells.includes('zsh')) {
      const run = inShell('zsh', bare);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /no matches found/);
    }
    // And a comment after a command, which zsh takes as more arguments.
    assert.deepEqual(words('export A=b   # in the shell', 'bash'), ['export', 'A=b']);
    assert.deepEqual(words('export A=b   # in the shell', 'zsh'), ['export', 'A=b', '#', 'in', 'the', 'shell']);
  });

  for (const [where, address] of Object.entries(ADDRESSES)) {
    describe(`the Connect panel, ${where}`, () => {
      const texts = panelTexts(address);

      it('gives Claude Code its address, named Claude, for every session (--scope user: its own default is the one folder)', () => {
        assertLines(texts.claude, [['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot', named(address, 'Claude')]]);
      });

      it('gives Codex its address, named Codex', () => {
        assertLines(texts.codex, [['codex', 'mcp', 'add', 'tricot', '--url', named(address, 'Codex')]]);
      });

      it('gives Pi its address, named Pi', () => {
        assertLines(texts.pi, [['pi', 'mcp', 'add', 'tricot', '--url', named(address, 'Pi')]]);
      });

      it("gives OMP an entry for its file, not a command, and other clients the address as it is", () => {
        assert.equal(JSON.parse(texts.omp).mcpServers.tricot.url, named(address, 'OMP'));
        assert.equal(texts.other, address);
      });

      it('gives Gemini CLI its address, named Gemini, for every session', () => {
        assertLines(texts.gemini, [['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot', named(address, 'Gemini')]]);
      });

      it('gives Grok Build its address, named Grok, for every session', () => {
        assertLines(texts.grok, [['grok', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot', named(address, 'Grok')]]);
      });

      it('gives OpenCode an entry for its file, named OpenCode', () => {
        assert.deepEqual(JSON.parse(texts.opencode), { mcp: { tricot: { type: 'remote', url: named(address, 'OpenCode'), timeout: 300000 } } });
      });

      it("gives Goose and Hermes an entry for their YAML files, named, which waits past wait_for_updates", () => {
        assert.equal(texts.goose, ['extensions:', '  tricot:', '    name: tricot', '    type: streamable_http', `    uri: ${JSON.stringify(named(address, 'Goose'))}`, '    enabled: true', '    timeout: 300'].join('\n'));
        assert.equal(texts.hermes, ['mcp_servers:', '  tricot:', `    url: ${JSON.stringify(named(address, 'Hermes'))}`, '    timeout: 300'].join('\n'));
        assert.doesNotMatch(texts.goose + texts.hermes, /^\s*[{[]/, 'YAML, not JSON');
      });
    });
  }

  for (const token of TOKENS) {
    describe(`tricot connect, with the board's token${token === '<token>' ? ' unread (<token>)' : ''}`, () => {
      const address = agentUrl('http://192.168.1.20:4545/mcp', 'Dev one');

      it('sends it from Claude Code as a header, for every session or one project', () => {
        const header = ['--header', `Authorization: Bearer ${token}`];
        assertLines(claudeCommand(address, { token }), [['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', 'tricot', address, ...header]]);
        assertLines(claudeCommand(address, { token, scope: 'project' }), [
          ['claude', 'mcp', 'add', '--scope', 'project', '--transport', 'http', 'tricot', address, ...header],
        ]);
      });

      it('exports it for Codex and Pi, on a line of its own', () => {
        const exported = ['export', `TRICOT_TOKEN=${token}`];
        assertLines(codexLines(address, token).join('\n'), [exported, ['codex', 'mcp', 'add', 'tricot', '--url', address, '--bearer-token-env-var', 'TRICOT_TOKEN']]);
        assertLines(piLines(address, token).join('\n'), [exported, ['pi', 'mcp', 'add', 'tricot', '--url', address, '--bearer-token-env-var', 'TRICOT_TOKEN']]);
        assertPastes(exportToken(token), exported);
      });

      it('exports it for Gemini CLI, whose header names the variable for Gemini to expand, not the shell', () => {
        assertLines(geminiLines(address, token).join('\n'), [
          ['export', `TRICOT_TOKEN=${token}`],
          ['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http', '--header', 'Authorization: Bearer ${TRICOT_TOKEN}', 'tricot', address],
        ]);
      });

      it("has Goose and Hermes fill the header in from the environment, and never hold the token", () => {
        const goose = gooseEntry(address, token);
        assert.deepEqual(goose.env_keys, ['TRICOT_TOKEN']);
        assert.deepEqual(goose.headers, { Authorization: 'Bearer ${TRICOT_TOKEN}' });
        assert.deepEqual(hermesEntry(address, token).headers, { Authorization: 'Bearer ${TRICOT_TOKEN}' });
        assert.doesNotMatch(JSON.stringify([goose, hermesEntry(address, token)]), new RegExp(token.replace(/[<>]/g, '\\$&')));
        assert.equal(gooseEntry(address).headers, undefined);
        assert.equal(hermesEntry(address).headers, undefined);
      });

      it('exports it for Grok Build, whose header names the variable for Grok to expand when it loads its config, not the shell', () => {
        assertLines(grokLines(address, token).join('\n'), [
          ['export', `TRICOT_TOKEN=${token}`],
          ['grok', 'mcp', 'add', '--scope', 'user', '--transport', 'http', '--header', 'Authorization: Bearer ${TRICOT_TOKEN}', 'tricot', address],
        ]);
      });

      it("exports it for OpenCode 2's command, whose header OpenCode fills in from the environment", () => {
        assertLines(opencode2Lines(address, token).join('\n'), [
          ['export', `TRICOT_TOKEN=${token}`],
          ['opencode', 'mcp', 'add', 'tricot', '--url', address, '--global', '--header', 'Authorization=Bearer {env:TRICOT_TOKEN}'],
        ]);
      });
    });
  }

  it('names the agent in the address, with the token for clients that need it there', () => {
    assert.equal(agentUrl('http://h:1/mcp'), 'http://h:1/mcp');
    assert.equal(agentUrl('http://h:1/mcp', 'Dev one'), 'http://h:1/mcp?agent=Dev%20one');
    assert.equal(agentUrl('http://h:1/mcp', 'Dev', 'a/b+c'), 'http://h:1/mcp?agent=Dev&token=a%2Fb%2Bc');
    assert.equal(agentUrl('http://h:1/mcp?token=t&agent=Old', 'New'), 'http://h:1/mcp?token=t&agent=New');
  });

  it('quotes any word so that it comes back as it was', () => {
    for (const word of ['', 'Dev one', '$HOME', 'it\'s', 'a!b', 'back\\slash', '"q"', '*', '=x', '~x', '#x', 'a&b', 'x;y', '`id`', '(x)', '{a,b}']) {
      assertPastes(shellCommand(['tricot', 'steps', 'on', '--agent', 'claude', '--project', '--name', word]), ['tricot', 'steps', 'on', '--agent', 'claude', '--project', '--name', word]);
    }
    assert.equal(shellQuote('Dev one'), '"Dev one"');
    assert.equal(shellQuote('a!b'), "'a!b'");
    assert.equal(shellQuote("it's $5"), "'it'\\''s $5'");
  });
});
