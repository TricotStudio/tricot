import type { MermaidConfig } from 'mermaid';
import type { ThemeBase } from '../../../theme';

// What a label may hold. Mermaid's strict mode keeps HTML in labels (bold,
// line breaks, KaTeX) and only drops scripts and handlers, so a label could
// still show a picture from another site, fetched while the diagram is
// drawn. These tags never reach a label: `style` as Mermaid itself forbids
// it, and every tag that shows a picture or media by address.
export const LABEL_SANITIZER = {
  FORBID_TAGS: ['style', 'img', 'image', 'picture', 'source', 'video', 'audio', 'track', 'input'],
};

// Mermaid's own secure settings, which a diagram's %%{init}%% or front matter
// can't change, and the label sanitizer with them.
const SECURE = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'dompurifyConfig'];

// How the board draws diagrams: strict, in the UI's typeface. Mermaid's ELK
// layouts aren't in the web build (scripts/elkLeftOut.ts), so diagrams that
// would use one are laid out with dagre.
export function mermaidConfig(theme: ThemeBase, fontFamily: string): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    secure: SECURE,
    dompurifyConfig: LABEL_SANITIZER,
    theme: theme === 'dark' ? 'dark' : 'neutral',
    fontFamily,
  };
}
