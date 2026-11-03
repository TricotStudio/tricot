import type { DocChange, PulledDoc } from '../../../core/connectors/google/doc';
import type { Comment, DocDraft, Pin } from '../../../core/types';
import { request } from '../../api';
import type { PickerConfig } from './picker';

// Google's calls to the server (server/connectors/google/routes.ts).

// A Google Doc in Tricot: the version the draft applies to, and the draft.
export interface DocView {
  doc: PulledDoc;
  draft?: DocDraft;
}

// Words selected in a doc's paragraph, as they're pinned.
export interface DocWords {
  paragraph: string;
  revision: string;
  quote: string;
  prefix: string;
  suffix: string;
}

export type DocSaveOutcome =
  | { outcome: 'saved'; paragraphs: number; revision?: string }
  | { outcome: 'conflict'; conflicts: number; theirs: number; draft: DocDraft };

const docRoute = (blockId: string, action = '') => `/api/connectors/google/docs/${encodeURIComponent(blockId)}${action && `/${action}`}`;

export const googleApi = {
  // A Google file's real name, for link cards.
  driveFile: (fileId: string) =>
    request<{ file: { name: string; modifiedTime?: string } | null }>('GET', `/api/connectors/google/files/${encodeURIComponent(fileId)}`),

  // What the Picker needs, to let a person choose docs; and telling the server
  // docs were chosen, so what it knew of them is looked up again.
  pickerConfig: () => request<PickerConfig>('POST', '/api/connectors/google/picker', {}),
  chosen: (fileIds: string[]) => request<{ ok: true }>('POST', '/api/connectors/google/chosen', { fileIds }),

  // A Google Doc's draft, on its link block: the doc and draft, changes to the
  // draft (against the revision shown), discarding it, saving it to Google,
  // and choosing between versions when the doc changed in Google meanwhile.
  googleDoc: (blockId: string, actor: string) => request<DocView>('GET', `${docRoute(blockId)}?actor=${encodeURIComponent(actor)}`),
  editDocDraft: (blockId: string, actor: string, revision: string, changes: DocChange[]) =>
    request<{ draft?: DocDraft; added: string[]; doc: PulledDoc }>('POST', docRoute(blockId, 'draft'), { actor, revision, changes }),
  discardDocDraft: (blockId: string, actor: string) => request<{ ok: true }>('POST', docRoute(blockId, 'discard'), { actor }),
  saveDocDraft: (blockId: string, actor: string) => request<DocSaveOutcome>('POST', docRoute(blockId, 'save'), { actor }),
  resolveDocConflict: (blockId: string, actor: string, conflict: string, keep: 'mine' | 'theirs') =>
    request<{ draft: DocDraft | null }>('POST', docRoute(blockId, 'resolve'), { actor, conflict, keep }),
  // Words selected in a paragraph (its id in the version shown), pinned with
  // a request for agents to edit it, or a comment.
  pinDocWords: (blockId: string, actor: string, input: DocWords & { body: string; ask: boolean }) =>
    request<{ pin: Pin; comment: Comment }>('POST', docRoute(blockId, 'pins'), { actor, ...input }),
};
