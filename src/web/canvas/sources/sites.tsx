// The icons on the cards of links to the sites people link most, matched by
// the link's host; a link to any other site shows a plain link icon. Every
// icon is drawn here, in the bundle: nothing is fetched from a site for its
// card, and a page of the UI shows pictures only from Tricot itself
// (server/headers.ts, #78). A link the board recognises (core/sources) shows
// its source's mark instead, which says more (a pull request, a Google Doc).
//
// A new site is a line in SITES, with its mark: the services' own marks are
// reused from their sources and connectors, and the others are the brand's
// logo from Simple Icons (simple-icons.org, CC0), its path copied from
// github.com/simple-icons/simple-icons, icons/<slug>.svg, in November 2026.
// Slack is a plain sign: Simple Icons no longer carries its logo.

import type { ReactNode } from 'react';
import { googleMarks } from '../../connectors/google/marks';
import { figma } from './figma';
import { github } from './github';
import { loom } from './loom';
import { WHITE, type Mark } from './mark';
import { youtube } from './youtube';

// A Simple Icons path, drawn on its 24px grid, at `size` px in the middle of the tile.
function logo(d: string, fill: string, size: number): ReactNode {
  const at = (32 - size) / 2;
  return <path d={d} fill={fill} transform={`translate(${at} ${at}) scale(${size / 24})`} />;
}

// Each brand's logo in its colour, on a tile of its colour or on the light
// tile, whichever is how the brand shows itself, so it reads the same on a
// light or a dark board. Near-black tiles are `dark`, for their edge.
const LIGHT = 'var(--mark-tile)';

const GITLAB: Mark = {
  tile: LIGHT,
  glyph: logo(
    'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
    '#fc6d26',
    18,
  ),
};

const NOTION: Mark = {
  tile: LIGHT,
  glyph: logo(
    'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
    '#000',
    18,
  ),
};

const LINEAR: Mark = {
  tile: '#5e6ad2',
  glyph: logo(
    'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
    '#fff',
    16,
  ),
};

// A hash, Slack's sign, on its aubergine.
const SLACK: Mark = {
  tile: '#4a154b',
  dark: true,
  glyph: <path d="M13.5 9v14M18.5 9v14M9 13.5h14M9 18.5h14" {...WHITE} strokeWidth={2.25} />,
};

const JIRA: Mark = {
  tile: '#0052cc',
  glyph: logo(
    'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
    '#fff',
    16,
  ),
};

const CONFLUENCE: Mark = {
  tile: '#172b4d',
  dark: true,
  glyph: logo(
    'M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.337a.764.764 0 0 0 1.028-.382l2.364-5.346a.764.764 0 0 0-.382-1 599.851 599.851 0 0 1-4.965-2.361C10.911 10.97 5.224 11.185.87 18.257zM23.131 5.743c.249-.405.531-.875.764-1.25a.764.764 0 0 0-.256-1.034L18.675.404a.764.764 0 0 0-1.058.26c-.195.335-.451.763-.734 1.225-1.966 3.246-3.945 2.85-7.508 1.146L4.437.694a.764.764 0 0 0-1.027.382L1.046 6.422a.764.764 0 0 0 .382 1c1.039.49 3.105 1.467 4.965 2.361 6.698 3.246 12.392 3.029 16.738-4.04z',
    '#fff',
    16,
  ),
};

const VERCEL: Mark = { tile: '#000', dark: true, glyph: logo('m12 1.608 12 20.784H0Z', '#fff', 15) };

// npm's square is the tile, and the n in it is white: the logo's own cut-out, alone.
const NPM: Mark = {
  tile: '#cb3837',
  glyph: logo('M5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z', '#fff', 28),
};

const STACK_OVERFLOW: Mark = {
  tile: LIGHT,
  glyph: logo(
    'M15.725 0l-1.72 1.277 6.39 8.588 1.716-1.277L15.725 0zm-3.94 3.418l-1.369 1.644 8.225 6.85 1.369-1.644-8.225-6.85zm-3.15 4.465l-.905 1.94 9.702 4.517.904-1.94-9.701-4.517zm-1.85 4.86l-.44 2.093 10.473 2.201.44-2.092-10.473-2.203zM1.89 15.47V24h19.19v-8.53h-2.133v6.397H4.021v-6.396H1.89zm4.265 2.133v2.13h10.66v-2.13H6.154Z',
    '#f58025',
    18,
  ),
};

const MDN: Mark = {
  tile: '#000',
  dark: true,
  glyph: logo('m21.538 1.1-6.745 21.8h-2.77L18.77 1.1ZM24 1.1v21.8h-2.462V1.1Zm-12 0v21.8H9.538V1.1Zm-2.462 0L2.77 22.9H0L6.746 1.1Z', '#fff', 16),
};

const WIKIPEDIA: Mark = {
  tile: LIGHT,
  glyph: logo(
    'M12.09 13.119c-.936 1.932-2.217 4.548-2.853 5.728-.616 1.074-1.127.931-1.532.029-1.406-3.321-4.293-9.144-5.651-12.409-.251-.601-.441-.987-.619-1.139-.181-.15-.554-.24-1.122-.271C.103 5.033 0 4.982 0 4.898v-.455l.052-.045c.924-.005 5.401 0 5.401 0l.051.045v.434c0 .119-.075.176-.225.176l-.564.031c-.485.029-.727.164-.727.436 0 .135.053.33.166.601 1.082 2.646 4.818 10.521 4.818 10.521l.136.046 2.411-4.81-.482-1.067-1.658-3.264s-.318-.654-.428-.872c-.728-1.443-.712-1.518-1.447-1.617-.207-.023-.313-.05-.313-.149v-.468l.06-.045h4.292l.113.037v.451c0 .105-.076.15-.227.15l-.308.047c-.792.061-.661.381-.136 1.422l1.582 3.252 1.758-3.504c.293-.64.233-.801.111-.947-.07-.084-.305-.22-.812-.24l-.201-.021c-.052 0-.098-.015-.145-.051-.045-.031-.067-.076-.067-.129v-.427l.061-.045c1.247-.008 4.043 0 4.043 0l.059.045v.436c0 .121-.059.178-.193.178-.646.03-.782.095-1.023.439-.12.186-.375.589-.646 1.039l-2.301 4.273-.065.135 2.792 5.712.17.048 4.396-10.438c.154-.422.129-.722-.064-.895-.197-.172-.346-.273-.857-.295l-.42-.016c-.061 0-.105-.014-.152-.045-.043-.029-.072-.075-.072-.119v-.436l.059-.045h4.961l.041.045v.437c0 .119-.074.18-.209.18-.648.03-1.127.18-1.443.421-.314.255-.557.616-.736 1.067 0 0-4.043 9.258-5.426 12.339-.525 1.007-1.053.917-1.503-.031-.571-1.171-1.773-3.786-2.646-5.71l.053-.036z',
    '#000',
    20,
  ),
};

// The logos drawn here, by name.
export const LOGOS = {
  gitlab: GITLAB,
  notion: NOTION,
  linear: LINEAR,
  slack: SLACK,
  jira: JIRA,
  confluence: CONFLUENCE,
  vercel: VERCEL,
  npm: NPM,
  stackOverflow: STACK_OVERFLOW,
  mdn: MDN,
  wikipedia: WIKIPEDIA,
} as const satisfies Record<string, Mark>;

// Google's apps at docs.google.com, by the first part of the path: Drive's
// own files show there too (/file/d/…), and its other pages show Google's G.
const GOOGLE_DOCS_APPS: Record<string, Mark> = {
  document: googleMarks['google-docs'],
  spreadsheets: googleMarks['google-sheets'],
  presentation: googleMarks['google-slides'],
  forms: googleMarks['google-forms'],
  file: googleMarks['google-drive'],
};

type SiteIcon = Mark | ((url: URL) => Mark);

// The sites, by the domain their pages are on, lower case and without www.
// Each also matches its subdomains (en.m.wikipedia.org is wikipedia.org), and
// the longest match wins (docs.google.com before google.com). Only a brand's
// own domains are here, not one where it serves other people's own sites
// (github.io, vercel.app), whose pages aren't the brand's.
export const SITES: Readonly<Record<string, SiteIcon>> = {
  'github.com': github.marks.github,
  'githubusercontent.com': github.marks.github,
  'gitlab.com': GITLAB,
  'figma.com': figma.marks.figma,
  'google.com': googleMarks.google,
  'docs.google.com': (url) => {
    const app = url.pathname.split('/')[1] ?? '';
    return Object.hasOwn(GOOGLE_DOCS_APPS, app) ? GOOGLE_DOCS_APPS[app] : googleMarks.google;
  },
  'drive.google.com': googleMarks['google-drive'],
  'sheets.google.com': googleMarks['google-sheets'],
  'slides.google.com': googleMarks['google-slides'],
  'forms.google.com': googleMarks['google-forms'],
  'forms.gle': googleMarks['google-forms'],
  'youtube.com': youtube.marks.youtube,
  'youtu.be': youtube.marks.youtube,
  'youtube-nocookie.com': youtube.marks.youtube,
  'loom.com': loom.marks.loom,
  'notion.so': NOTION,
  'notion.com': NOTION,
  'notion.site': NOTION, // pages published from Notion
  'linear.app': LINEAR,
  'slack.com': SLACK,
  // Jira and Confluence on a team's Atlassian site: Confluence under /wiki.
  'atlassian.net': (url) => (/^\/wiki(\/|$)/i.test(url.pathname) ? CONFLUENCE : JIRA),
  'vercel.com': VERCEL,
  'npmjs.com': NPM,
  'npmjs.org': NPM,
  'stackoverflow.com': STACK_OVERFLOW,
  'developer.mozilla.org': MDN,
  'wikipedia.org': WIKIPEDIA,
};

// The icon of the site a link goes to, or null for a site that has none here
// (or an address that isn't a web page).
export function siteMark(address: string): Mark | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // The URL has made the host lower case; "github.com." is the same host as github.com.
  const labels = url.hostname.replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length; i++) {
    const domain = labels.slice(i).join('.');
    if (!Object.hasOwn(SITES, domain)) continue;
    const icon = SITES[domain];
    return typeof icon === 'function' ? icon(url) : icon;
  }
  return null;
}
