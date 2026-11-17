// The connectors' web halves, one line each: a new connector is a folder
// (web/connectors/<id>/) and an import and an entry here, with its core half
// (core/connectors/registry.ts) and its server half
// (server/connectors/registry.ts). The Connectors page and the canvas ask this
// list, and neither names a service. Internal: nothing is loaded from outside
// this repository.

import type { LinkSource } from '../../core/sources';
import type { ConnectorShare, WebConnector } from './connector';
import { figma } from './figma';
import { github } from './github';
import { google } from './google';
import { linear } from './linear';
import { slack } from './slack';

// A function so the connectors are read once they have all loaded.
const registered = (): readonly WebConnector[] => [google, figma, github, slack, linear];

let all: readonly WebConnector[] | undefined;

export function webConnectors(): readonly WebConnector[] {
  return (all ??= registered());
}

export function webConnector(id: string): WebConnector | undefined {
  return webConnectors().find((c) => c.id === id);
}

// The connector a recognised link belongs to, if it comes from one.
export function connectorOfLink(source: LinkSource | null): WebConnector | undefined {
  return source?.connector ? webConnector(source.connector) : undefined;
}

let shares: Readonly<Record<string, ConnectorShare>> = {};

// Adds what a part of Tricot lets a person do with its cards through a connector (its Share to Slack), by the connector's
// id, for the page that registers them where it starts: a page that registers none has none (Canvas's). It returns what
// puts back the ones that were there before.
export function useConnectorShares(added: Readonly<Record<string, ConnectorShare<never>>>): () => void {
  const before = shares;
  shares = { ...before, ...added };
  return () => {
    shares = before;
  };
}

// The shares the page has for the connectors there are, each with the connector's id; the card that asks says what its card is.
export function connectorShares<Card>(): { id: string; share: ConnectorShare<Card> }[] {
  return webConnectors().flatMap((c) => (Object.hasOwn(shares, c.id) ? [{ id: c.id, share: shares[c.id] as ConnectorShare<Card> }] : []));
}
