// Google's web half: its panel on the Connectors page, the real names of its
// files on link cards, the marks of its links, and the doc editor (a Google
// Doc's text edited over the canvas, saved to Google as the paragraphs that
// changed). What it is and what it signs in for is core/connectors/google/.

import { DOCS_SCOPE, DRIVE_FILE, DRIVE_METADATA } from '../../../core/connectors/google/scopes';
import type { WebConnector } from '../connector';
import { googleApi } from './api';
import { chooseGoogleDocs, GooglePanel } from './choose';
import { DocEditor } from './docEditor';
import { DocThreadsChip } from './docPins';
import { GoogleMark, googleMarks } from './marks';

export const google: WebConnector = {
  id: 'google',
  Mark: GoogleMark,
  serves: 'Google Docs you choose',
  setup: {
    intro: 'Tricot signs in with an OAuth client from your own Google Cloud project, so your sign-in stays between you and Google.',
    files: ['client_secret_….json', 'google-client.json'],
  },
  signOutHint: 'you can remove it in your Google account, under third-party connections.',
  Panel: GooglePanel,
  chooser: {
    label: 'Choose a Google Doc',
    async choose() {
      const [doc] = await chooseGoogleDocs({ title: 'Choose a Google Doc to link' });
      return doc ? { url: doc.url } : null;
    },
  },
  accessNote: ({ access }) => {
    const granted = (scope: string) => access.find((a) => a.scope === scope)?.granted;
    if (granted(DRIVE_FILE) !== false) {
      return 'It opens only the Google Docs you choose, and changes one only when someone presses Save: just the paragraphs edited. The rest of your Drive stays out of sight.';
    }
    return granted(DOCS_SCOPE) || granted(DRIVE_METADATA)
      ? 'This sign-in is the earlier kind: it sees the names of all your Drive files and can edit any of your Google Docs. Connect again to switch to only the docs you choose.'
      : "It can't open any Google Docs yet. Connect again and allow the docs you choose.";
  },
  fileInfo: async (fileId) => (await googleApi.driveFile(fileId)).file,
  marks: googleMarks,
  editor: {
    title: "Edit this doc's text here, then save the changes to Google",
    Editor: DocEditor,
    Threads: DocThreadsChip,
    draft(block) {
      const { docDraft } = block;
      if (!docDraft) return null;
      const changes = docDraft.edits.length;
      return docDraft.conflicts?.length ? 'draft waiting on a choice' : `draft, ${changes} change${changes === 1 ? '' : 's'}`;
    },
    opensPin: (pin) => pin.anchor.kind === 'doc',
  },
};
