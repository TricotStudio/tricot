import type { DocChange, PulledDoc } from '../../../core/connectors/google/doc';
import type { Comment, DocDraft, Pin } from '../../../core/types';
import { routes } from '../../../core/routes';
import { get, post } from '../../shared/api';
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

export const googleApi = {
  // A Google file's real name, for link cards.
  driveFile: (fileId: string) =>
    get(routes.googleFile)<{ file: { name: string; modifiedTime?: string } | null }>({ fileId }),

  // What the Picker needs, to let a person choose docs; and telling the server
  // docs were chosen, so what it knew of them is looked up again.
  pickerConfig: () => post(routes.googlePicker)<PickerConfig>({}),
  chosen: (fileIds: string[]) => post(routes.googleChosen)<{ ok: true }>({ fileIds }),

  // A Google Doc's draft, on its link block: the doc and draft, changes to the
  // draft (against the revision shown), discarding it, saving it to Google,
  // and choosing between versions when the doc changed in Google meanwhile.
  googleDoc: (blockId: string, actor: string) => get(routes.googleDoc)<DocView>({ blockId }, { actor }),
  editDocDraft: (blockId: string, actor: string, revision: string, changes: DocChange[]) =>
    post(routes.googleDocDraft)<{ draft?: DocDraft; added: string[]; doc: PulledDoc }>({ actor, revision, changes }, { blockId }),
  discardDocDraft: (blockId: string, actor: string) => post(routes.googleDocDiscard)<{ ok: true }>({ actor }, { blockId }),
  saveDocDraft: (blockId: string, actor: string) => post(routes.googleDocSave)<DocSaveOutcome>({ actor }, { blockId }),
  resolveDocConflict: (blockId: string, actor: string, conflict: string, keep: 'mine' | 'theirs') =>
    post(routes.googleDocResolve)<{ draft: DocDraft | null }>({ actor, conflict, keep }, { blockId }),
  // Words selected in a paragraph (its id in the version shown), pinned with
  // a request for agents to edit it, or a comment.
  pinDocWords: (blockId: string, actor: string, input: DocWords & { body: string; ask: boolean }) =>
    post(routes.googleDocPins)<{ pin: Pin; comment: Comment }>({ actor, ...input }, { blockId }),
};
