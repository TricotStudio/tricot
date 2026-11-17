// What only the command and the server use of Codex: how it starts for one
// session, its live-steps installer, what `tricot connect codex` says.

import path from 'node:path';
import { codexLines, shellNoun, TOKEN_ENV, tokenLineName } from '../../connect';
import { codexSession } from '../../sessions';
import { codexFolder, codexHooksFile, codex as hooks } from '../../../server/hooks/codex';
import { installedHooks } from '../../../server/hooks/session';
import type { AgentServerHalf, QueueWakeTraits } from '../agent';

// Its session (a thread) and turn are ids like 01a1c30e-d098-7180-a25a-36079312fc22.
const CODEX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idIn = (value: unknown) => (typeof value === 'string' && CODEX_ID.test(value) ? value : undefined);

// Connected on its own, it is woken in its own session
// (server/codexWake.ts): `codex queue` hands a line to its thread through
// Codex's own app server, which takes it as a turn at once when the thread
// is idle, and once its turn is over when it is busy, never cutting it short
// (tried with 0.166.0, its TUI on the shared app server or on its own). Each
// MCP call names its thread and turn in _meta["x-codex-turn-metadata"]
// (thread_id, turn_id: seen with 0.166.0).
const codexQueue: QueueWakeTraits = {
  since: '0.166.0',
  sessionOf(meta) {
    const turn = meta?.['x-codex-turn-metadata'];
    if (!turn || typeof turn !== 'object') return undefined;
    const said = turn as Record<string, unknown>;
    const thread = idIn(said.thread_id);
    return thread ? { thread, turn: idIn(said.turn_id) } : undefined;
  },
  args: (thread, line) => ['queue', '--thread', thread, '--message', line],
};

export const server: AgentServerHalf = {
  hooks,
  // Its personal skills: $CODEX_HOME/skills/<name>/SKILL.md, ~/.codex/skills
  // when that is unset (its own skill installer writes there, and it reads
  // $HOME/.agents/skills too: learn.chatgpt.com/docs/build-skills; checked in
  // Codex 0.167). Codex has no command that brings an MCP server back into a
  // running session (/mcp only lists them): it loads its tools when a session
  // starts, and `codex resume` picks the conversation up in a new one.
  skill: {
    folder: (target) => path.join(codexFolder(target), 'skills'),
    reconnect: 'start a new Codex session, which loads its Tricot tools as it starts (codex resume goes on with this conversation)',
  },
  // A call gives up after tool_timeout_sec, 300 seconds unless set (60
  // before mid-2026), whatever progress comes: `codex mcp add` can't set it
  // (codex-rs/codex-mcp/src/rmcp_client.rs, DEFAULT_TOOL_TIMEOUT).
  mcpClient: { clientName: 'codex-mcp-client', callLimitSeconds: 300 },
  session: codexSession,
  // Tried with Codex 0.166.0: a line pasted, then Enter, is sent.
  wakes: { enterAfterMs: 150 },
  queueWakes: codexQueue,
  // `--model`, and the reasoning effort as an override of its config key, a
  // TOML string (codex --help: -c parses the value as TOML).
  ruleFlags: ({ model, effort }) => [...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])],
  // Codex takes hooks from its settings alone, so its come from live steps, once.
  sessionHooks({ target }) {
    return {
      said: installedHooks(codexHooksFile(target)).approvals
        ? 'Approvals come to the board, through the hook in your Codex settings.'
        : "Codex asks for approvals in the terminal: they come to the board once its live steps are on (tricot steps on --agent codex), as Codex can't take hooks for one session.",
    };
  },
  show({ out, url, token, shell }) {
    out('Run once; Codex then has the board in every session:');
    for (const line of codexLines(url, token, shell)) out(`  ${line}`);
    if (token) out(`Run ${tokenLineName(shell)} in the ${shellNoun(shell)} Codex runs from: it reads the token from ${TOKEN_ENV}.`);
  },
};
