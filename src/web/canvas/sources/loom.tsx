import { WHITE, type WebSource } from './mark';

const LOOM_RAYS =
  'M16 8v4.5M16 19.5V24M8 16h4.5M19.5 16H24M10.3 10.3l3.2 3.2M18.5 18.5l3.2 3.2M10.3 21.7l3.2-3.2M18.5 13.5l3.2-3.2';

export const loom: WebSource = {
  id: 'loom',
  marks: { loom: { tile: '#625df5', glyph: <path d={LOOM_RAYS} {...WHITE} strokeWidth={2.25} /> } },
};
