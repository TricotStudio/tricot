import { WHITE, type Mark } from '../../canvas/sources/mark';

// Google's Drive, from Simple Icons (simple-icons.org, CC0; icons/googledrive.svg),
// its three parts apart so each takes its colour, on a 24px grid.
const DRIVE_PARTS: [string, string][] = [
  ['#0f9d58', 'M7.25 3.215a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214z'],
  ['#f4b400', 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574z'],
  ['#4285f4', 'M9.509 15.868l-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z'],
];

// The marks of the Google links: Docs, Sheets, Slides and Forms; Drive; and
// Google's G for its other pages (web/canvas/sources/sites.tsx). The G and
// Drive keep Google's four colours, on the light tile the connector's mark
// sits on.
export const googleMarks: Record<string, Mark> = {
  'google-docs': {
    tile: '#1a73e8',
    glyph: <path d="M10.5 11h11M10.5 15h11M10.5 19h11M10.5 23h6.5" {...WHITE} strokeWidth={2} />,
  },
  'google-sheets': {
    tile: '#188038',
    glyph: <path d="M9.5 9.5h13v13h-13ZM9.5 14h13M9.5 18.25h13M14.25 9.5v13" {...WHITE} />,
  },
  'google-slides': { tile: '#f4b400', glyph: <rect x="9" y="11" width="14" height="10" rx="1.5" fill="#fff" /> },
  'google-forms': {
    tile: '#7248b9',
    glyph: (
      <>
        <path d="M14.5 11h7.5M14.5 16h7.5M14.5 21h7.5" {...WHITE} strokeWidth={2} />
        <circle cx="10.5" cy="11" r="1.5" fill="#fff" />
        <circle cx="10.5" cy="16" r="1.5" fill="#fff" />
        <circle cx="10.5" cy="21" r="1.5" fill="#fff" />
      </>
    ),
  },
  'google-drive': {
    tile: 'var(--mark-tile)',
    glyph: (
      <g transform="translate(7 7) scale(0.75)">
        {DRIVE_PARTS.map(([fill, d]) => (
          <path key={fill} d={d} fill={fill} />
        ))}
      </g>
    ),
  },
  google: {
    tile: 'var(--mark-tile)',
    glyph: (
      <g fill="none" strokeWidth="3">
        <path d="M23 16a7 7 0 0 1-2.5 5.36" stroke="#4285f4" />
        <path d="M16.5 16H23" stroke="#4285f4" />
        <path d="M20.5 21.36A7 7 0 0 1 10.64 20.5" stroke="#34a853" />
        <path d="M10.64 20.5a7 7 0 0 1 0-9" stroke="#fbbc05" />
        <path d="M10.64 11.5a7 7 0 0 1 10.72 0" stroke="#ea4335" />
      </g>
    ),
  },
};

// The connector's mark: Google's four colours round a G, on a light tile.
export function GoogleMark() {
  const { tile, glyph } = googleMarks.google;
  return (
    <span className="connector-mark" aria-hidden>
      <svg viewBox="0 0 32 32" width="32" height="32">
        <rect width="32" height="32" rx="6" fill={tile} />
        {glyph}
      </svg>
    </span>
  );
}
