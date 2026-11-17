// A website block's source, its pages, and how its elements are named.
// Shared by the server and the web UI: nothing here reads the disk.

import { clip } from '../../format';

export const SITE_SIZE = { w: 520, h: 420 };
export const MAX_PAGES = 30; // the pages people have seen, kept on the block
export const MAX_PAGE = 300; // a page's path, with its query
export const MAX_TEXT = 160; // an element's text, as a pin keeps it

// A page people have seen: its path in the site, and the title it had.
export interface SitePage {
  path: string;
  title?: string;
}

// Hosts a site may be served from: this computer, as a browser writes it.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// A local dev server's address as it is kept: http, on this computer, with
// its path; or null for anything else (another computer, https, a file).
export function localAddress(value: string): { url: string; origin: string; port: number } | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.includes(url.hostname) || url.username || url.password) return null;
  const port = Number(url.port || 80);
  url.hash = '';
  return { url: url.href, origin: url.origin, port };
}

// A page's path as it is kept: from the site's root, with its query, without
// a fragment. "privacy.html" reads as "/privacy.html". Null when it isn't one.
export function sitePage(value: string): string | null {
  const text = value.trim();
  if (!text || /^[a-z][a-z\d+.-]*:/i.test(text) || text.startsWith('//') || /[\0\r\n]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text.startsWith('/') ? text : `/${text}`, 'http://site.invalid');
  } catch {
    return null;
  }
  const page = `${url.pathname}${url.search}`;
  return page.length <= MAX_PAGE ? page : null;
}

// The fields a site block names its source with: a folder, or a local address.
export interface SiteFields {
  title?: string;
  folder?: string;
  url?: string;
  page: string;
  pages?: SitePage[];
}

// How a site is called when it has no title: its folder's name, or its host and port.
export function siteName(block: SiteFields): string {
  if (block.title) return block.title;
  if (block.folder) return block.folder.split(/[\\/]/).filter(Boolean).at(-1) ?? block.folder;
  try {
    return new URL(block.url ?? '').host;
  } catch {
    return 'website';
  }
}

// Where it comes from, in a few words: "folder ~/site", "dev server localhost:3000".
export function siteSourceWords(block: SiteFields): string {
  if (block.folder) return `folder ${block.folder}`;
  try {
    return `dev server ${new URL(block.url ?? '').host}`;
  } catch {
    return 'no source';
  }
}

// The title a page had when someone last saw it.
export function pageTitle(block: SiteFields, page: string): string | undefined {
  return block.pages?.find((p) => p.path === page)?.title;
}

// ---- its elements ------------------------------------------------------------------

// What an element is, in the words a person uses: a heading, a button.
const WORDS: Record<string, string> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  a: 'link',
  button: 'button',
  img: 'image',
  picture: 'image',
  svg: 'picture',
  video: 'video',
  li: 'list item',
  ul: 'list',
  ol: 'list',
  dl: 'list',
  nav: 'navigation',
  header: 'header',
  footer: 'footer',
  section: 'section',
  article: 'article',
  aside: 'aside',
  main: 'main content',
  form: 'form',
  input: 'field',
  textarea: 'field',
  select: 'field',
  label: 'label',
  blockquote: 'quote',
  figure: 'figure',
  figcaption: 'caption',
  table: 'table',
  tr: 'table row',
  td: 'table cell',
  th: 'table cell',
  code: 'code',
  pre: 'code',
};

export function elementWord(tag: string): string {
  return WORDS[tag.toLowerCase()] ?? 'element';
}

// Words that come from a site's page (an element's text, a page's title), as
// the board keeps them: on one line, without control characters, and with
// double quote marks made single, so that quoted where agents read them they
// can't close the quote and read as words of the board's own.
export function pageText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/["“”„‟«»〝〞＂]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// An element's text as a pin keeps it: as pageText, clipped.
export function elementText(text: string): string {
  return clip(pageText(text), MAX_TEXT);
}

// A selector as the frame script writes one: an id (#hero, one that needs
// no escaping) or a tag, with :nth-of-type(n) when it has siblings of its
// kind, joined by " > ". Nothing else is taken, so a selector says nothing
// but where the element is.
const SEGMENT = '(?:#[A-Za-z][\\w-]{0,99}|[a-z][a-z\\d-]{0,40}(?::nth-of-type\\([1-9]\\d{0,4}\\))?)';
const SELECTOR = new RegExp(`^${SEGMENT}(?: > ${SEGMENT}){0,40}$`);
export function isSelector(value: string): boolean {
  return value.length <= 400 && SELECTOR.test(value);
}

// An element as it is quoted: heading “One shared layer for you and your
// agents.”, or by its selector when it shows no words (an image).
export function elementQuote(tag: string, text: string, selector: string): string {
  const words = elementText(text);
  return words ? `${elementWord(tag)} “${clip(words, 80)}”` : `${elementWord(tag)} ${clip(selector, 80)}`;
}

// A file and line in a site's folder, as a pin names them: "index.html, line 54".
export function fileLine(file: string | undefined, line: number | undefined): string {
  if (!file) return '';
  return line ? `${file}, line ${line}` : file;
}
