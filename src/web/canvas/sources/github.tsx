import { WHITE, type WebSource } from './mark';

const GITHUB_BOOK = 'M12 9h9.5v14H12a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 12 9ZM10.5 20.5A1.5 1.5 0 0 1 12 19h9.5';

export const github: WebSource = {
  id: 'github',
  marks: {
    // GitHub itself, a branching line: the connector's mark, and the mark of
    // any other page on GitHub (./sites.tsx).
    github: {
      tile: '#1f2328',
      dark: true,
      glyph: (
        <g {...WHITE}>
          <circle cx="12" cy="10" r="2" />
          <circle cx="12" cy="22" r="2" />
          <circle cx="21" cy="14" r="2" />
          <path d="M12 12v8M21 16c0 3-4 3-9 4" />
        </g>
      ),
    },
    'github-pull': {
      tile: '#1f2328',
      dark: true,
      glyph: (
        <g {...WHITE}>
          <circle cx="11" cy="10" r="2" />
          <circle cx="11" cy="22" r="2" />
          <circle cx="21" cy="22" r="2" />
          <path d="M11 12v8M21 20v-6a3 3 0 0 0-3-3h-3.5M16 9l-1.75 2L16 13" />
        </g>
      ),
    },
    'github-issue': {
      tile: '#1f2328',
      dark: true,
      glyph: (
        <>
          <circle cx="16" cy="16" r="6.5" {...WHITE} />
          <circle cx="16" cy="16" r="1.6" fill="#fff" />
        </>
      ),
    },
    'github-repo': {
      tile: '#1f2328',
      dark: true,
      glyph: <path d={GITHUB_BOOK} {...WHITE} />,
    },
  },
};
