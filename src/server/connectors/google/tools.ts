// Google's MCP tools: read a Google Doc a link block points to, and change
// its draft. Agents never save to Google; people do.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { docDigest, type DocChange } from '../../../core/connectors/google/doc';
import { docPinLines } from '../../../core/connectors/google/agent';
import { clip } from '../../../core/format';
import { BoardError, type Store } from '../../../core/store';
import type { Actor } from '../../../core/types';
import type { ConnectorTool } from '../connector';
import { ConnectorError } from '../oauth';
import type { DocDrafts } from './docs';

const docEditShape = z.object({
  paragraph_id: z.string().optional().describe('Reword this paragraph (pN from the doc, or nN added in the draft): pass its whole new text'),
  text: z.string().optional().describe("The paragraph's whole text. A \\n in it is a line break inside the paragraph; add paragraphs with after"),
  after: z.string().optional().describe('Add a new paragraph after this paragraph id ("start" for the top of the doc), with text'),
  style: z.string().optional().describe("A new paragraph's style: normal (default), title, subtitle, heading1 to heading6"),
  list: z.enum(['bullet', 'numbered', 'none']).optional().describe('Make a new paragraph a list item'),
  delete: z.string().optional().describe('Remove this paragraph (pN or nN)'),
});

type DocEditArgs = z.infer<typeof docEditShape>;

const inputs = {
  read_google_doc: { block_id: z.string().describe('A link block whose address is a Google Doc') },
  edit_google_doc: {
    block_id: z.string(),
    revision: z.string().optional().describe('The revision read_google_doc showed: the edit is refused if the draft has moved on since'),
    edits: z.array(docEditShape).min(1).max(100),
  },
};

const text = (body: string): CallToolResult => ({ content: [{ type: 'text' as const, text: body }] });

// Why a Google Doc can't be read, said for an agent: what a person has to do.
const DOC_ACCESS: Record<string, string> = {
  not_set_up: "Google isn't set up in Tricot, so agents can't read Google Docs. A person sets it up on the Connectors page.",
  not_connected: "Google isn't connected, so agents can't read Google Docs. A person connects it on the Connectors page.",
  needs_sign_in: 'Google needs a person to sign in again (on the Connectors page) before agents can read Google Docs.',
  no_docs_permission:
    "The Google connector can't open Google Docs with the sign-in it has. A person connects Google again on the Connectors page. Ask them (comment or ask_people) if you need it; don't retry until they have.",
  not_picked:
    "Tricot hasn't been let into this Google Doc yet: a person has to choose it in Google once (Edit in Tricot on the doc's card, then Choose in Google). Ask them (comment or ask_people) if you need it; don't retry until they have.",
};

function docRefusal(error: unknown): CallToolResult {
  if (!(error instanceof Error)) throw error;
  const message = error instanceof ConnectorError && error.code ? (DOC_ACCESS[error.code] ?? error.message) : error.message;
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function docChanges(edits: DocEditArgs[]): DocChange[] {
  return edits.flatMap((edit, i): DocChange[] => {
    const at = `Edit ${i + 1}:`;
    const list = edit.list === undefined ? undefined : edit.list === 'none' ? null : edit.list;
    if (edit.delete !== undefined) {
      if (edit.paragraph_id !== undefined || edit.after !== undefined || edit.text !== undefined) throw new BoardError(`${at} pass delete on its own.`);
      return [{ kind: 'delete', id: edit.delete }];
    }
    if (edit.after !== undefined) {
      if (edit.paragraph_id !== undefined) throw new BoardError(`${at} pass after (a new paragraph) or paragraph_id (reword one), not both.`);
      return [{ kind: 'add', after: edit.after, text: edit.text ?? '', style: edit.style, list }];
    }
    if (edit.paragraph_id !== undefined) {
      const changes: DocChange[] = [];
      if (edit.text !== undefined) changes.push({ kind: 'text', id: edit.paragraph_id, text: edit.text });
      if (edit.style !== undefined || list !== undefined) changes.push({ kind: 'format', id: edit.paragraph_id, style: edit.style, list });
      if (!changes.length) throw new BoardError(`${at} pass the paragraph's new text.`);
      return changes;
    }
    throw new BoardError(`${at} each edit is {paragraph_id, text}, {after, text} or {delete}.`);
  });
}

export function googleTools(store: Store, docs: DocDrafts): ConnectorTool[] {
  return [
    {
      name: 'read_google_doc',
      config: {
        title: 'Read Google Doc',
        description:
          "Read the Google Doc a link block points to, through the people's Google connector: its paragraphs in order with ids (pN), their styles (headings, list items), read-only parts such as tables and images, and the draft of edits people and agents are making in Tricot (changed, added nN and removed paragraphs, and who made each change). A link block to a Google Doc can carry that draft once a person has chosen that doc in Google for Tricot (the editor asks them the first time they open it); until then this is refused. It also names people's requests to edit a paragraph: act on them with edit_google_doc.",
        inputSchema: inputs.read_google_doc,
        annotations: { readOnlyHint: true },
      },
      async run(args, actor: Actor) {
        try {
          const blockId = args.block_id as string;
          const view = await docs.open(blockId, actor);
          const pinned = docPinLines(store.canvasOf(blockId).board, blockId);
          return text(docDigest(view.doc, view.draft, blockId, docs.name(blockId, view.doc), pinned));
        } catch (error) {
          return docRefusal(error);
        }
      },
    },
    {
      name: 'edit_google_doc',
      config: {
        title: 'Edit Google Doc draft',
        description: [
          'Change the Tricot draft of a Google Doc (a link block): reword a paragraph ({paragraph_id, text}, its whole new text), add one ({after, text}, after a paragraph id or "start"; several after the same id go in the order given), or remove one ({delete}).',
          'Only the draft changes, never the doc in Google. You never save to Google: a person reviews the draft, where your changes are marked with your name, and presses Save. Read the doc with read_google_doc first for the ids. Read-only parts (tables, images, smart chips) can\'t be changed in Tricot.',
          'People select words in a doc\'s paragraph and ask agents to edit it ("make this shorter"); your updates and read_google_doc name each request. Change the draft here, then reply in the request\'s thread with comment(pin_id), saying what you changed. A person resolves it. Words they only commented on are a note, not a request.',
        ].join(' '),
        inputSchema: inputs.edit_google_doc,
      },
      async run(args, actor: Actor) {
        try {
          const { block_id, revision, edits } = args as { block_id: string; revision?: string; edits: DocEditArgs[] };
          const changes = docChanges(edits);
          const { draft, added, doc } = await docs.edit(block_id, revision, changes, actor);
          // A paragraph reworded to what the doc already says is no change.
          const inDraft = new Set(draft?.edits.map((e) => e.id));
          const texts = changes.filter((c) => c.kind === 'text');
          const reworded = texts.filter((c) => inDraft.has(c.id)).length;
          const same = texts.length - reworded;
          const removed = changes.filter((c) => c.kind === 'delete').length;
          const did = [
            reworded && `reworded ${reworded}`,
            added.length && `added ${added.join(', ')}`,
            removed && `removed ${removed}`,
            same && `${same} already read as the doc has ${same === 1 ? 'it' : 'them'}, so ${same === 1 ? "it's" : "they're"} not a change`,
          ].filter(Boolean);
          const total = draft?.edits.length ?? 0;
          return text(
            `Changed the draft of Google Doc "${clip(docs.name(block_id, doc), 60)}" [block id: ${block_id}]: ${did.join(', ') || 'no change'}. The draft has ${total} paragraph${total === 1 ? '' : 's'} changed. Nothing was sent to Google: a person reviews the draft on the board and saves it.`,
          );
        } catch (error) {
          return docRefusal(error);
        }
      },
    },
  ];
}
