// Figma's web half: its panel on the Connectors page (where a token is
// pasted), the real names and thumbnails on its link cards, "Bring in this
// frame", and Refresh on the images that came from it. What it is and what a
// token may do is core/connectors/figma/.

import { figma as figmaSource } from '../../canvas/sources/figma';
import type { WebConnector } from '../connector';
import { figmaApi } from './api';
import { FigmaImageTools, FigmaLinkCard } from './card';
import { FigmaSignIn } from './signIn';
import './figma.css';

// The mark of Figma's links, on a light tile like the other services' marks.
function FigmaMark() {
  const { tile, glyph } = figmaSource.marks.figma;
  return (
    <span className="connector-mark" aria-hidden>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <rect width="32" height="32" rx="6" fill={tile} />
        {glyph}
      </svg>
    </span>
  );
}

export const figma: WebConnector = {
  id: 'figma',
  Mark: FigmaMark,
  serves: 'Figma files and frames',
  setup: { intro: 'Figma needs nothing set up: paste a token.', files: [] },
  signOutHint: 'you can delete the token in Figma, under Settings → Security.',
  removedNote:
    'Disconnected here. The token still works until you delete it in Figma, under Settings → Security → Personal access tokens.',
  accessNote: () => 'Read-only: Tricot never changes a Figma file. It can open what your token allows; make a new token in Figma to change that.',
  SignIn: FigmaSignIn,
  fileInfo: async (fileId) => {
    const { file } = await figmaApi.card(fileId);
    return file && { name: file.name, modifiedTime: file.modifiedTime };
  },
  LinkCard: FigmaLinkCard,
  ImageTools: FigmaImageTools,
};
