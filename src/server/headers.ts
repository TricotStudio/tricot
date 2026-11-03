// What every response tells the browser, whatever sends it: a page of the UI,
// the API, MCP, an asset or an error.
//
// Tricot is never shown inside another site's frame: a page that framed the
// board could steer a person's clicks on it. The browser takes no guesses at a
// file's type from its bytes. Other sites learn only Tricot's origin, never a
// path: a Google API key restricted to Tricot's address is checked against
// that origin, and boards live after the #, which is never sent anyway.
//
// The UI's pages carry a Content-Security-Policy that allows only what Tricot
// uses (pagePolicy, below). Everything else carries one that says only who may
// frame it. A route that sends its own policy (an asset, a connector's sign-in
// page) keeps it, with frame-ancestors 'none' added if that policy lacks it,
// so a response carries one policy and it always refuses framing.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { RequestHandler, Response } from 'express';
import { isPageRequest } from './access';

const POLICY = 'Content-Security-Policy';
const FRAME_ANCESTORS = "frame-ancestors 'none'";

// A policy that says who may frame the page, or that one with the rule added.
export function refusingFrames(policy: string): string {
  if (/(^|;)\s*frame-ancestors\s/i.test(policy)) return policy;
  return policy.trim() ? `${policy.trim().replace(/;$/, '')}; ${FRAME_ANCESTORS}` : FRAME_ANCESTORS;
}

// Google's Picker loads from here (web/connectors/google/picker.ts).
const GOOGLE_SCRIPTS = 'https://apis.google.com';

// What a page may show in a frame: the players and viewers a link card opens
// in place (core/sources, and the connectors' sources), and Google's Picker,
// which Google draws from docs.google.com.
export const FRAMED_SITES = ['https://www.youtube-nocookie.com', 'https://www.loom.com', 'https://www.figma.com', 'https://docs.google.com'];

// The policy of a page of the UI: only what Tricot itself uses.
// - Scripts: Tricot's own (the app, and what it loads when first needed:
//   Mermaid with its ELK layout, KaTeX, three.js), the script in index.html
//   that applies the theme before first paint (by its hash, `scripts`), and
//   Google's Picker. No eval, and no other script written into a page.
// - Styles: Tricot's own, and inline: Mermaid writes a <style> into each
//   diagram and style attributes on its labels.
// - Pictures: Tricot's own (uploads and Figma thumbnails, under /api/assets)
//   and data: URLs (the tab's icon, a 3D scene's textures). No other site's:
//   showing one would tell that site who opened the board, and when. A link
//   card's icon is drawn by Tricot (web/canvas/sources/sites.tsx), Markdown
//   shows another site's picture as a link to it (web/markdown.tsx), and a
//   picture a diagram asks for anyway (an image shape, a background in a
//   label's style) is refused here. So is any address on this computer or
//   the local network.
// - Fonts and connections: Tricot's own (the API and live updates, and in
//   development Vite's reload socket).
// - Frames: FRAMED_SITES. No plugins, no <base>, and forms go only to Tricot.
export function pagePolicy(scripts: string[]): string {
  return [
    "default-src 'self'",
    ['script-src', "'self'", ...scripts, GOOGLE_SCRIPTS].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    ['frame-src', ...FRAMED_SITES].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    FRAME_ANCESTORS,
  ].join('; ');
}

// Each script written into a page rather than loaded by its src, as a policy
// allows it: by the hash of its text, which the browser takes with line
// endings made \n, as it parsed them.
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const [, attributes, text] of html.replace(/\r\n?/g, '\n').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attributes)) continue;
    hashes.add(`'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

// The policy of the built UI's page (dist/web/index.html), from that page as
// it is: read again whenever the file changes, so a rebuild with the theme
// script edited never meets a policy that refuses it.
export function builtPagePolicy(file: string): () => string {
  let known: { stamp: string; policy: string } | undefined;
  return () => {
    try {
      const { mtimeMs, size } = statSync(file);
      const stamp = `${mtimeMs}:${size}`;
      if (known?.stamp !== stamp) known = { stamp, policy: pagePolicy(inlineScriptHashes(readFileSync(file, 'utf8'))) };
      return known.policy;
    } catch {
      return pagePolicy([]); // not built: there is no page to allow scripts in
    }
  };
}

// In development Vite serves the page and writes scripts of its own into it
// (its client, React's refresh), so the scripts written into a page are
// allowed whatever they are. The rest of the policy holds, so a feature that
// needs more is refused there first.
export const devPagePolicy = (): string => pagePolicy(["'unsafe-inline'"]);

// `page`: the policy for the UI's pages, given to every GET outside the API
// and MCP (on the files a page loads, a policy does nothing). Without it, the
// UI too carries only frame-ancestors.
export function securityHeaders(page?: () => string): RequestHandler {
  return (req, res, next) => {
    res.setHeader(POLICY, page && isPageRequest(req) ? page() : FRAME_ANCESTORS);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    refuseFramesOnSend(res);
    next();
  };
}

// Just before the headers go out (writeHead runs then, also when a response
// is ended without calling it), a route's own policy gains frame-ancestors.
function refuseFramesOnSend(res: Response): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: unknown[]) {
    const policy = res.getHeader(POLICY);
    if (typeof policy === 'string') res.setHeader(POLICY, refusingFrames(policy));
    return (writeHead as (...a: unknown[]) => Response).apply(this, args);
  } as Response['writeHead'];
}
