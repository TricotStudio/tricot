// What only the server uses of Google in core: what agents are told, how it
// words and anchors pins on a doc's paragraphs, what its links carry, and its
// part of the store. The web build leaves this file out (see vite.config.ts).

import type { ConnectorServerHalf } from '../connector';
import { docAsksDigest, googleSummary } from './agent';
import { docFileId } from './doc';
import { googlePins } from './pins';
import { DocDraftStore } from './store';

export const server: ConnectorServerHalf = {
  agent: { summary: googleSummary, asks: docAsksDigest },
  pins: googlePins,
  link: {
    // A link to a Google Doc says when it has a draft of edits.
    note(block) {
      const draft = block.type === 'link' ? block.docDraft : undefined;
      if (!draft) return undefined;
      const changes = draft.edits.length;
      return `draft: ${changes} paragraph${changes === 1 ? '' : 's'} changed${draft.conflicts?.length ? `, ${draft.conflicts.length} waiting for a person to choose` : ''}, not saved; read_google_doc`;
    },
    // A draft is of the doc the link pointed to.
    retarget(block) {
      if (block.type === 'link' && block.docDraft && docFileId(block.url) !== block.docDraft.fileId) delete block.docDraft;
    },
  },
  store: (repo) => new DocDraftStore(repo),
};
