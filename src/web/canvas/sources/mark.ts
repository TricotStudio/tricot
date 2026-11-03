import type { ReactNode } from 'react';

// A source's mark, drawn on a 32px tile in the service's own colours: a
// plain sign of where the link goes, not the service's logo file. The marks
// of the other sites people link most are their logos (./sites.tsx). This
// file has no imports from the registry, so each source's file can use it as
// it loads (the glyphs are made then).
export interface Mark {
  tile: string;
  dark?: boolean;
  glyph: ReactNode;
}

export const WHITE = { stroke: '#fff', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

// What a source's web half is: the marks its links draw, by the name its
// recogniser gives them (core/sources).
export interface WebSource {
  readonly id: string;
  readonly marks: Record<string, Mark>;
}
