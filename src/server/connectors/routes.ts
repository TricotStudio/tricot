// REST for connectors, under /api/connectors, behind the app's loopback Host
// check. Statuses and lookups never carry a token or the client secret. The
// sign-in steps are the same for every connector; what a connector adds (a
// Google Doc's draft) is its own router, mounted under its id.
//
// Every change here is a person's, from one of their seats (access.ts
// asPerson, tier B): signing in and out, a pasted token, the Picker's
// short-lived access token, a doc's draft, a frame or a diff brought onto
// the canvas, all with the person's own accounts. Agents use a connector through
// their MCP tools. Reads (a link card's file, a pull request's card, the
// statuses) and the service sending the person back to the callback pass.

import { randomBytes } from 'node:crypto';
import { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { ConnectorStatus } from '../../core/connectors';
import { linkTo } from '../../core/pages';
import { BoardError, type Store } from '../../core/store';
import { asPerson, peopleChange, type PersonGate } from '../access';
import { callbackPath } from './connector';
import { ConnectorError, type Connectors } from './index';
import { routes } from '../../core/routes';
import { routesOn } from '../routing';

const startBody = z.object({ permissions: z.array(z.string()).max(5).optional() });

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

function param(req: Request, name: string): string {
  return String(req.params[name]);
}

// Google sends a desktop app's sign-in back to a loopback address on any
// port, so the callback is on this server, at the host and port the person
// is using (which keeps it on the page's own origin).
export function callbackUri(host: string | undefined, id: string): string {
  let url: URL;
  try {
    url = new URL(`http://${host ?? ''}`);
  } catch {
    throw new ConnectorError('Open Tricot at http://127.0.0.1 to connect.', 400);
  }
  if (!LOOPBACK.includes(url.hostname)) {
    throw new ConnectorError(
      `Connect from this computer, at http://127.0.0.1:${url.port || 80}: a desktop sign-in only comes back to a loopback address.`,
      400,
    );
  }
  return `http://${url.hostname}:${url.port || 80}${callbackPath(id)}`;
}

// `person`: who is a person (access.ts); the app's, with its terminals, unless given.
export function createConnectorsRouter(connectors: Connectors, store: Store, person: PersonGate = (req, tier) => asPerson(req, tier)): Router {
  const router = Router();
  const on = routesOn(router, '/api/connectors');
  router.use(peopleChange(person, 'B'));

  on(routes.connectors, (_req, res) => {
    res.json(connectors.list());
  });

  // The service's consent page, which the UI opens in a new tab. `permissions`
  // asks for more than the connector has, such as "docs" for Google Docs.
  on(routes.startConnector, (req, res) => {
    const id = param(req, 'id');
    connectors.get(id); // an unknown connector is a 404, before the host is checked
    const { permissions } = startBody.parse(req.body ?? {});
    res.json({ url: connectors.start(id, callbackUri(req.headers.host, id), permissions) });
  });

  // Where the service sends the person back. Answers with a page, not JSON,
  // that tells the board's tab how it went.
  on(routes.connectorCallback, async (req, res) => {
    const id = param(req, 'id');
    try {
      const status = await connectors.finish(id, req.query as Record<string, unknown>);
      callbackPage(res, 200, { ok: true, status, note: connectors.get(id).connectedNote?.(status) ?? '' });
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : 'The sign-in failed. Try again.';
      if (!(error instanceof ConnectorError)) console.error('Connector sign-in failed:', (error as Error)?.message);
      const status = error instanceof ConnectorError && error.status < 500 ? error.status : 502;
      callbackPage(res, status, { ok: false, id, name: nameOf(connectors, id), message });
    }
  });

  on(routes.disconnectConnector, async (req, res) => {
    const id = param(req, 'id');
    const { revoked } = await connectors.disconnect(id);
    res.json({ connector: connectors.get(id).status(), revoked });
  });

  // What a connector adds, under its id: /api/connectors/google/files/:fileId…
  for (const { id, router: own } of connectors.routes(store, person)) router.use(`/${id}`, own);

  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ConnectorError) {
      res.status(error.status).json({ error: error.message, code: error.code });
    } else if (error instanceof BoardError) {
      res.status(error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400).json({ error: error.message });
    } else if (error instanceof ZodError) {
      res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    } else if (typeof error?.status === 'number' && error.status < 500) {
      res.status(error.status).json({ error: error.message });
    } else {
      // Only the message: a request or response could carry a token.
      console.error('Connector error:', (error as Error)?.message);
      res.status(500).json({ error: 'Internal error' });
    }
  };
  router.use(errors);

  return router;
}

type Outcome = { ok: true; status: ConnectorStatus; note: string } | { ok: false; id: string; name: string; message: string };

// A connector's name for a page, or the id it was asked for when there is no such connector.
function nameOf(connectors: Connectors, id: string): string {
  try {
    return connectors.get(id).name;
  } catch {
    return id;
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// A small page in the tab the service sent back: what happened, and a message to
// the board's tab (same origin: a BroadcastChannel; or its opener, when
// the service's pages left that link in place) so it updates without a reload.
function callbackPage(res: Response, code: number, outcome: Outcome): void {
  const nonce = randomBytes(16).toString('base64');
  const name = outcome.ok ? outcome.status.name : outcome.name;
  const title = outcome.ok ? `Connected to ${name}` : `Not connected to ${name}`;
  const detail = outcome.ok
    ? [`Signed in as <strong>${escape(outcome.status.account?.email ?? 'your account')}</strong>.`, outcome.note].filter(Boolean).join(' ')
    : escape(outcome.message);
  const message = JSON.stringify({
    type: 'tricot:connector',
    id: outcome.ok ? outcome.status.id : outcome.id,
    ok: outcome.ok,
    message: outcome.ok ? undefined : outcome.message,
  }).replace(/</g, '\\u003c');
  res
    .status(code)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    })
    .send(`<!doctype html>
<html lang="en"${outcome.ok ? '' : ' class="is-failed"'}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Tricot</title>
<style>
:root { --bg: #edeae4; --surface: #f8f6f2; --border: #dcd7ce; --text: #1d1828; --muted: #5d5866; --mark: #2f8a57; --mark-bg: #e2f2e8; --primary: #1d1828; --primary-text: #fff; color-scheme: light; }
:root.is-failed { --mark: #b03a26; --mark-bg: #fbe7e2; }
@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { --bg: #121211; --surface: #1a1a19; --border: #2e2e2b; --text: #ececea; --muted: #a6a6a0; --mark: #5cc08a; --mark-bg: #17301f; --primary: #ececea; --primary-text: #121211; color-scheme: dark; } :root.is-failed:not([data-theme='light']) { --mark: #ec8a77; --mark-bg: #381f19; } }
:root[data-theme='dark'] { --bg: #121211; --surface: #1a1a19; --border: #2e2e2b; --text: #ececea; --muted: #a6a6a0; --mark: #5cc08a; --mark-bg: #17301f; --primary: #ececea; --primary-text: #121211; color-scheme: dark; }
:root[data-theme='dark'].is-failed { --mark: #ec8a77; --mark-bg: #381f19; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
main { width: min(420px, 100%); display: grid; gap: 12px; padding: 28px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; }
.mark { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 6px; background: var(--mark-bg); color: var(--mark); }
h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; }
p { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
p strong { color: var(--text); font-weight: 500; }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.btn { display: inline-flex; align-items: center; font: inherit; font-weight: 500; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; cursor: pointer; }
.btn-primary { background: var(--primary); border-color: var(--primary); color: var(--primary-text); }
.btn:focus-visible { outline: 2px solid #2c58b8; outline-offset: 1px; }
</style>
</head>
<body>
<main>
<span class="mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${outcome.ok ? '<path d="m3.5 8.5 3 3 6-7"/>' : '<path d="m4.5 4.5 7 7m0-7-7 7"/>'}</svg></span>
<h1>${escape(title)}</h1>
<p>${detail}</p>
<p>${outcome.ok ? 'You can close this tab.' : 'Close this tab and try again from Connectors.'}</p>
<div class="row">
<button class="btn btn-primary" id="close" type="button">Close tab</button>
<a class="btn" href="/${linkTo.connectors()}">Go to Connectors</a>
</div>
</main>
<script type="application/json" id="outcome">${message}</script>
<script nonce="${nonce}">
(function () {
  var outcome = JSON.parse(document.getElementById('outcome').textContent);
  try { var theme = localStorage.getItem('tricot:theme'); if (theme) document.documentElement.dataset.theme = theme; } catch (e) {}
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  try { var channel = new BroadcastChannel('tricot:connectors'); channel.postMessage(outcome); channel.close(); } catch (e) {}
  try { if (window.opener) window.opener.postMessage(outcome, location.origin); } catch (e) {}
  document.getElementById('close').addEventListener('click', function () { window.close(); });
})();
</script>
</body>
</html>`);
}
