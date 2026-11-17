// What only the command and the server use of Claude Code: how it starts for
// one session, with Tricot's hooks for it; its live-steps installer; what
// `tricot connect claude` says.

import path from 'node:path';
import { claudeCommand, shellQuote } from '../../connect';
import { claudeSession } from '../../sessions';
import { claudeFolder, claudeUserSettings, claude as hooks } from '../../../server/hooks/claude';
import { claudeSessionSettings, installedHooks } from '../../../server/hooks/session';
import type { AgentServerHalf, ConnectView } from '../agent';

const projectCommand = ({ url, token, shell }: ConnectView) => claudeCommand(url, { token, scope: 'project', shell });

function stepsHint({ out, name, shell }: ConnectView): void {
  out("To show Claude's steps on the card it works on (asks before changing anything):");
  out(`  tricot steps on --agent claude --project${name ? ` --name ${shellQuote(name, shell)}` : ''}`);
}

export const server: AgentServerHalf = {
  hooks,
  // Its personal skills: ~/.claude/skills/<name>/SKILL.md, in every project
  // (code.claude.com/docs/en/skills), in the folder CLAUDE_CONFIG_DIR moves.
  // Its docs on MCP: a server that failed or dropped is brought back from /mcp,
  // with Reconnect in the server's menu (code.claude.com/docs/en/mcp).
  skill: {
    folder: (target) => path.join(claudeFolder(target, 'user'), 'skills'),
    reconnect: 'run /mcp and pick Reconnect on tricot',
  },
  // A call may run for MCP_TOOL_TIMEOUT, about 28 hours unless set, but one
  // that sends nothing for CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT is cut: 300
  // seconds for a server over HTTP, as Tricot is, unless that or the server's
  // own "timeout" is set (code.claude.com/docs/en/mcp, and Claude Code 2.1's
  // own code). It sends _meta.progressToken with every tool call, and the
  // progress a wait sends every 30 seconds starts that limit over (seen with
  // 2.1.322 and 2.1.323: its MCP log, and a session on a scratch board with
  // the limit set to 40 seconds). But it checks every 30 seconds by the clock
  // on the wall, while its timers and Tricot's stop as the computer sleeps: on
  // waking from a sleep longer than the limit it cuts a wait before the next
  // progress comes (waits cut 325 to 1009 seconds after
  // their last progress, its checks minutes apart). So its limit is the idle
  // one, and a wait ends inside it as though no progress came.
  // Connected on its own, it sleeps between turns: a command its Bash
  // tool runs in the background starts a turn when it ends, idle or not, and
  // one left in the foreground moves to the background at its timeout (2
  // minutes unless set). Since 2.1.288 a background command in a session at a
  // terminal has no time limit; 2.1.285 to 2.1.287 stopped one after 30
  // minutes (its changelog, and code.claude.com/docs/en/tools-reference).
  mcpClient: { clientName: 'claude-code', callLimitSeconds: 300, listens: { background: 'run_in_background: true', since: '2.1.288' } },
  session: claudeSession,
  // Tried with Claude Code 2.1.321: a line pasted, then Enter, is sent.
  wakes: { enterAfterMs: 150 },
  // Its permission prompts on the board, a prompt that opens with ^Design
  // answered through that lens, and its steps when the person said yes to
  // live steps, as settings for the session; whatever its own settings run
  // already is left out, so nothing runs twice.
  sessionHooks({ target, source, url, name, stepsAsked }) {
    const installed = installedHooks(claudeUserSettings(target));
    const steps = !installed.steps && stepsAsked;
    const approvals = !installed.approvals;
    const lenses = !installed.lenses;
    const settings = claudeSessionSettings({ url, source, name, steps, approvals, lenses });
    const said = approvals
      ? steps
        ? 'Approvals and live steps come to the board for this session.'
        : 'Approvals come to the board for this session.'
      : steps
        ? 'Live steps come to the board for this session, and approvals through the hook in your Claude Code settings.'
        : 'Approvals come to the board, through the hook in your Claude Code settings.';
    return { ...(settings && { settings }), said };
  },
  // `--model` takes an alias or a full name, `--effort` a level (claude --help).
  ruleFlags: ({ model, effort }) => [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
  // It draws its whole window, on the emulator Tricot keeps each screen in.
  hostEnv: { CLAUDE_CODE_NO_FLICKER: '1' },
  show(view) {
    const { out, url, token, shell } = view;
    out('Run once; Claude Code then has the board in every session:');
    out(`  ${claudeCommand(url, { token, shell })}`);
    out(`Or for this project only (writes .mcp.json, ${token ? "which will hold the token: don't commit it" : 'which you can commit'}):`);
    out(`  ${projectCommand(view)}`);
    stepsHint(view);
  },
  alsoSaid: (view) => [`Or for this project only (writes .mcp.json, which you can commit), run this yourself:`, `  ${projectCommand(view)}`],
  afterConnected: stepsHint,
};
