import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Store } from '../src/core/store';
import type { Actor } from '../src/core/types';
import type { CanvasServer } from './canvasEdition';

// What the two files about what an agent is told by a server of Tricot Canvas share: test/canvasAgent.test.ts, which reads the
// server as the entry builds it (src/server/canvasEdition.ts), and its counterpart for a part, which holds what that server
// tells to the words of a part's. The server, the agents that connect to it, and the board it is read over.

// The 26 tools of the board, as a server with a part registered lists them with its 16 left out.
export const BOARD_TOOLS = [
  'list_boards', 'create_board', 'set_project_folder', 'get_board', 'search', 'take_request', 'finish_request',
  'comment', 'react', 'get_thread', 'reply_in_thread', 'start_thread',
  'get_canvas', 'get_block', 'add_block', 'update_block', 'add_group', 'add_page', 'update_page', 'link', 'remove_item', 'restore_item',
  'get_updates', 'wait_for_updates', 'report_skills', 'read_guide',
];
export const CONNECTOR_TOOLS = ['edit_google_doc', 'read_figma_frame', 'read_github', 'read_google_doc', 'read_linear_issue', 'read_slack', 'search_linear_issues'];

export type Listed = Awaited<ReturnType<Client['listTools']>>['tools'];

const sam: Actor = { kind: 'human', name: 'Sam' };

// A board as a part leaves it: a note on the board context, a comment thread on it waiting for a reply, a sync of it that
// a person asked for, and a request asked on it. Canvas leaves the data alone, and tells an agent none of it.
export function seedContext(store: Store): { boardId: string; pinId: string; requestId: string } {
  const board = store.createBoard({ title: 'Left by a part' }, sam);
  const block = store.addBlock({ boardId: board.id }, { title: 'Goal', content: { type: 'note', text: 'Ship it this week' } }, sam);
  const { pin } = store.pinComment(block.id, { kind: 'text', quote: 'Ship it', occurrence: undefined }, 'Hosted or our own domain?', sam);
  store.requestSync(board.id, undefined, sam);
  const request = store.askAgents(board.id, 'Get me an architecture view of the project', sam);
  return { boardId: board.id, pinId: pin.id, requestId: request.id };
}

export interface Read {
  isError: boolean;
  text: string;
}

export async function readOf(client: Client, name: string, args: Record<string, unknown>): Promise<Read> {
  const result = (await client.callTool({ name, arguments: args }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }))) as { isError?: boolean; content: { text?: string }[] };
  return { isError: result.isError === true, text: result.content.map((part) => part.text ?? '').join('\n') };
}

// What an agent reads of a board with that on its board context, through the tools that bring a board's state back: its
// new board, its board, its updates since the seeding, a reply on the pin of the thread, and an attempt to take the request.
export async function readsOfSeeded(server: CanvasServer): Promise<Record<'create_board' | 'get_board' | 'get_updates' | 'comment' | 'take_request', Read>> {
  const { boardId, pinId, requestId } = seedContext(server.store);
  const since = server.store.getBoard(boardId).seq;
  const connected = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await connected.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp?agent=Planner`)));
    return {
      create_board: await readOf(connected, 'create_board', { title: 'Made by an agent' }),
      get_board: await readOf(connected, 'get_board', { board_id: boardId }),
      get_updates: await readOf(connected, 'get_updates', { board_id: boardId, since }),
      comment: await readOf(connected, 'comment', { pin_id: pinId, body: 'Hosted: it ships this week.' }),
      take_request: await readOf(connected, 'take_request', { request_id: requestId }),
    };
  } finally {
    await connected.close();
  }
}

// What a connector's refusal says when its service is not connected, as an agent reads it: Slack, Linear, GitHub and Figma
// each answer a call about a link or an issue before they ask their service for anything.
export const CONNECTOR_CALLS: [string, Record<string, unknown>][] = [
  ['read_slack', { url: 'https://acme.slack.com/archives/C0123ABCD/p1700000000000100' }],
  ['read_linear_issue', { issue: 'ENG-123' }],
  ['search_linear_issues', { query: 'login' }],
  ['read_github', { url: 'https://github.com/acme/widgets/pull/7' }],
  ['read_figma_frame', { url: 'https://www.figma.com/design/AbCdEf/Name?node-id=1-2' }],
];

// A refusal's text, from a call that is answered as an error result or thrown.
export async function refusedWith(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args }).catch((error: Error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }))) as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true, name);
  return result.content.map((part) => part.text).join('\n');
}
