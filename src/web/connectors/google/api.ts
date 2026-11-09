import type { DocChange, PulledDoc } from '../../../core/connectors/google/doc';
import type { Comment, DocDraft, Pin } from '../../../core/types';
import { googleRoutes } from '../../../core/connectors/google/routes';
import { get, post } from '../../shared/api';
import type { PickerConfig } from './picker';

// Google's calls to the server: its routes (core/connectors/google/routes.ts), served
// by server/connectors/google/routes.ts.

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

export const googleApi = {
  // A Google file's real name, for link cards.
  driveFile: (fileId: string) =>
    get(googleRoutes.file)<{ file: { name: string; modifiedTime?: string } | null }>({ fileId }),

  // What the Picker needs, to let a person choose docs; and telling the server
  // docs were chosen, so what it knew of them is looked up again.
  pickerConfig: () => post(googleRoutes.picker)<PickerConfig>({}),
  chosen: (fileIds: string[]) => post(googleRoutes.chosen)<{ ok: true }>({ fileIds }),

  // A Google Doc's draft, on its link block: the doc and draft, changes to the
  // draft (against the revision shown), discarding it, saving it to Google,
  // and choosing between versions when the doc changed in Google meanwhile.
  googleDoc: (blockId: string, actor: string) => get(googleRoutes.doc)<DocView>({ blockId }, { actor }),
  editDocDraft: (blockId: string, actor: string, revision: string, changes: DocChange[]) =>
    post(googleRoutes.docDraft)<{ draft?: DocDraft; added: string[]; doc: PulledDoc }>({ actor, revision, changes }, { blockId }),
  discardDocDraft: (blockId: string, actor: string) => post(googleRoutes.docDiscard)<{ ok: true }>({ actor }, { blockId }),
  saveDocDraft: (blockId: string, actor: string) => post(googleRoutes.docSave)<DocSaveOutcome>({ actor }, { blockId }),
  resolveDocConflict: (blockId: string, actor: string, conflict: string, keep: 'mine' | 'theirs') =>
    post(googleRoutes.docResolve)<{ draft: DocDraft | null }>({ actor, conflict, keep }, { blockId }),
  // Words selected in a paragraph (its id in the version shown), pinned with
  // a request for agents to edit it, or a comment.
  pinDocWords: (blockId: string, actor: string, input: DocWords & { body: string; ask: boolean }) =>
    post(googleRoutes.docPins)<{ pin: Pin; comment: Comment }>({ actor, ...input }, { blockId }),
};
