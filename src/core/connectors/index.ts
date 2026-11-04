// Connectors let Tricot read from services people already use. They are
// set once per machine and every board uses them. Tricot signs in to each
// service with OAuth and keeps the tokens on this machine, in the data folder;
// what the server and the UI share about one is its ConnectorStatus, which
// never carries a token or a client secret.
//
// What a connector is lives in connector.ts, and the connectors there are in
// registry.ts; this is what the rest of the app asks of all of them.

import { listNames } from '../format';
import type { ConnectorAccess, ConnectorStatus } from './connector';
import { connectorKinds, findConnector } from './registry';

export type { ConnectorAccess, ConnectorId, ConnectorKind, ConnectorState, ConnectorStatus } from './connector';
export { connectorKinds, connectorPinning, findConnector } from './registry';

// Plain words for the scopes any connector may ask for. Scopes are the
// services' own identifiers, so one table serves them all.
function scopeWords(scope: string): { label: string; agent: string } | undefined {
  for (const kind of connectorKinds()) {
    const words = kind.scopes[scope];
    if (words) return words;
  }
  return undefined;
}

// The scopes that say who is signed in collapse into one line: "openid" and
// "email" read the same to a person.
function identity() {
  const kinds = connectorKinds();
  return { scopes: new Set(kinds.flatMap((k) => k.identity.scopes)), email: new Set(kinds.flatMap((k) => k.identity.email)) };
}

export function scopeLabel(scope: string): string {
  return scopeWords(scope)?.label ?? scope;
}

// What a connector can see, one line per kind of access. Wanted scopes not in
// granted come back with granted: false, once there is a grant to compare.
export function describeAccess(wanted: string[], granted?: string[]): ConnectorAccess[] {
  const lines: ConnectorAccess[] = [];
  const who = identity();
  if (wanted.some((s) => who.scopes.has(s))) {
    const ok = granted ? granted.some((s) => who.email.has(s)) : undefined;
    lines.push({ scope: 'email', label: 'See your email address, to show which account is connected', granted: ok });
  }
  for (const scope of wanted) {
    if (who.scopes.has(scope)) continue;
    lines.push({ scope, label: scopeLabel(scope), granted: granted ? granted.includes(scope) : undefined });
  }
  return lines;
}

// One line for agents, about every connector: which are connected, as whom,
// and what they can read. Never a token.
export function connectorsLine(statuses: ConnectorStatus[]): string {
  const connected = statuses.filter((s) => s.state === 'connected' && s.account);
  if (connected.length === 0) {
    return `Connectors: none connected. People connect services such as ${listNames(connectorKinds().map((k) => k.name))} on the Connectors page; no connector tools yet.`;
  }
  const each = connected.map((s) => {
    const can = s.access.filter((a) => a.granted && a.scope !== 'email').map((a) => scopeWords(a.scope)?.agent ?? a.scope);
    return `${s.name}, connected as ${s.account!.email}${can.length ? ` (${can.join(', ')})` : ''}`;
  });
  const said = connected.flatMap((s) => findConnector(s.id)?.agent?.summary(s) ?? []);
  return `Connectors (app-wide): ${each.join('; ')}. People's link cards show ${said.map((s) => s.shows).join(' and ')}; ${said.map((s) => s.tools).join('; ')}.`;
}
