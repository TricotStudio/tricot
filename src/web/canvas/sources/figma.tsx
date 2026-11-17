import type { WebSource } from './mark';

export const figma: WebSource = {
  id: 'figma',
  marks: {
    figma: {
      tile: '#1e1e1e',
      dark: true,
      glyph: (
        <>
          <path d="M16 7h-3a3 3 0 0 0 0 6h3Z" fill="#f24e1e" />
          <path d="M16 7h3a3 3 0 0 1 0 6h-3Z" fill="#ff7262" />
          <path d="M16 13h-3a3 3 0 0 0 0 6h3Z" fill="#a259ff" />
          <circle cx="19" cy="16" r="3" fill="#1abcfe" />
          <path d="M13 19h3v3a3 3 0 1 1-3-3Z" fill="#0acf83" />
        </>
      ),
    },
  },
};
