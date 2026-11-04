// What the site server adds to a site's HTML pages: Tricot's frame script
// (frame.ts), first in the page, and on a page from a folder, the line each
// element starts on in its file (data-tricot-line), so a request on an
// element names the file and line to change. The page is read as the
// browser tokenizes it, near enough: comments, doctypes and closing tags are
// passed over, attribute values may hold a ">", and the text of script,
// style, textarea and title is never read as tags.

export const FRAME_SCRIPT_PATH = '/__tricot/frame.js';
export const LINE_ATTRIBUTE = 'data-tricot-line';

// Elements whose text is raw: what's in them is never a tag.
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'plaintext']);
// Elements nobody pins: the page's frame, and what isn't shown.
const UNSHOWN = new Set(['html', 'head', 'meta', 'link', 'script', 'style', 'title', 'base', 'noscript', 'template', 'source', 'track']);

const lines = (text: string, from: number, to: number) => {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

// The page with each shown element marked with the line it starts on.
export function withSourceLines(html: string): string {
  let out = '';
  let copied = 0; // what of html is in out
  let line = 1;
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    line += lines(html, at, open);
    // Comments, a doctype, processing instructions and closing tags: passed over.
    let skipTo = -1;
    if (html.startsWith('<!--', open)) skipTo = ((end) => (end === -1 ? html.length : end + 3))(html.indexOf('-->', open + 4));
    else if (html[open + 1] === '!' || html[open + 1] === '?' || html[open + 1] === '/') skipTo = ((end) => (end === -1 ? html.length : end + 1))(html.indexOf('>', open));
    if (skipTo !== -1) {
      line += lines(html, open, skipTo);
      at = skipTo;
      continue;
    }
    const name = /^<([a-zA-Z][a-zA-Z\d:-]*)/.exec(html.slice(open, open + 80))?.[1].toLowerCase();
    if (!name) {
      at = open + 1;
      continue;
    }
    // The tag ends at the first > outside a quoted attribute value.
    let end = open + name.length + 1;
    let quote = '';
    for (; end < html.length; end++) {
      const c = html[end];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (end >= html.length) break;
    if (!UNSHOWN.has(name) && !html.slice(open, end).includes(LINE_ATTRIBUTE)) {
      out += `${html.slice(copied, end)} ${LINE_ATTRIBUTE}="${line}"`;
      copied = end;
    }
    line += lines(html, open, end + 1);
    at = end + 1;
    if (RAW.has(name)) {
      // Found from here on, whatever its case: each page is read once through.
      const closing = new RegExp(`</${name}`, 'gi');
      closing.lastIndex = at;
      const close = closing.exec(html)?.index ?? -1;
      const to = close === -1 ? html.length : close;
      line += lines(html, at, to);
      at = to;
    }
  }
  return out + html.slice(copied);
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The page with Tricot's frame script first in it: after <head>, else after
// <html>, else after the doctype, else at the start. `file` is the page's
// file in the site's folder, which the script names with an element's line.
export function withFrameScript(html: string, file?: string): string {
  const tag = `<script src="${FRAME_SCRIPT_PATH}"${file ? ` data-tricot-file="${escapeAttribute(file)}"` : ''}></script>`;
  for (const opening of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /^\s*<!doctype[^>]*>/i]) {
    const match = opening.exec(html);
    if (match) return `${html.slice(0, match.index + match[0].length)}${tag}${html.slice(match.index + match[0].length)}`;
  }
  return `${tag}${html}`;
}
