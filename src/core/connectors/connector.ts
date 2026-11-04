// What a connector is, in one contract: a service Tricot signs in to (OAuth,
// once per machine) and reads from, and what that means everywhere else. The
// rest of the app asks the registry (registry.ts) and none of it names a
// service. A connector is a folder on each side:
//
//   core/connectors/<id>/    this file's half: who it is, the links it
//                            recognises, how pins on its content are found
//                            (index.ts, browser-safe) and what only the server
//                            needs (server.ts: what agents are told, its part
//                            of the store; swapped for an empty stub in the
//                            browser build, see vite.config.ts)
//   server/connectors/<id>/  signing in, token storage in the data folder,
//                            reading and writing its documents, its REST
//                            routes and its MCP tools (server/connectors/connector.ts)
//   web/connectors/<id>/     its panel on the Connectors page and its pieces
//                            on the canvas (web/connectors/connector.ts)
//
// Each side has a registry that lists them, one line each. Internal: connectors
// are code in this repository, not something third parties load (#67); the
// shape leaves room for a public API later, and none is built.

import type { LinkSourceKind } from '../sources/types';
import type { PinPlace } from '../pins';
import type { PinPart } from '../store/inputs';
import type { BoardRepository } from '../store/repository';
import type { Block, Board, Pin, PinAnchor } from '../types';

export type ConnectorId = string;

// not_set_up: no OAuth client to sign in with yet (the setup steps say how).
// ready: a client is there; nobody has signed in.
// connected: signed in, as account.email.
// needs_sign_in: the service refused the saved sign-in (revoked or expired).
// error: something else is wrong, said in message.
export type ConnectorState = 'not_set_up' | 'ready' | 'connected' | 'needs_sign_in' | 'error';

export interface ConnectorAccess {
  scope: string;
  label: string; // in plain words: "See the names of your Drive files"
  granted?: boolean; // once connected: whether the person allowed it on the consent screen
}

// What the server and the UI share about a connector. Never a token or a client secret.
export interface ConnectorStatus {
  id: ConnectorId;
  name: string;
  state: ConnectorState;
  message?: string; // why it isn't set up, why it needs signing in again, or the error
  access: ConnectorAccess[]; // what it asks for, or what it was given once connected
  account?: { email: string; scopes: string[]; connectedAt: string };
  clientSource?: 'built-in' | 'file'; // which OAuth client signs in: the one shipped with Tricot, or a person's own file
  clientFile?: string; // the person's own OAuth client file, by name only
  setup?: { folder: string; steps: string[] }; // when not set up: where the client file goes, and how to get one
  notice?: string; // connected, and still working, but there is something a person may want to do (sign in again for narrower access)
  lastFailure?: string; // the last sign-in that didn't finish, for a few minutes after
}

// ---- pins on its content ---------------------------------------------------------

// A connector whose documents people pin parts of (words in a Google Doc's
// paragraph) says how. `kind` is the pin anchor's kind; a pin whose anchor has
// it is the connector's to place, name and explain.
export interface ConnectorPins {
  readonly kind: string;
  // Where a pin's part is now: null once it has changed past finding.
  place(block: Block, pin: Pin): PinPlace | null | undefined;

  // The rest is only what the server uses.
  // The anchor and quote for a part, checked against the block (throws if it isn't a block the part is on).
  anchor?(block: Block, part: PinPart): { anchor: PinAnchor; quote: string } | undefined;
  // What agents read after a pinned part to find it: " (paragraph p3; read_google_doc)".
  where?(pin: Pin): string;
  // What a pinned part is in, by name: the doc's title.
  label?(block: Block, pin?: Pin): string;
  // Said when a block isn't one that has its parts.
  missing?(block: Block): string;
  // Where people see an agent's reply on one of its parts: "People see it by the paragraph, in the doc".
  seen?: string;
  // People may ask agents to act on its parts, rather than only comment.
  ask?: ConnectorAsk;
}

// The words around a request for agents to act on a pinned part, said where
// agents read the board and its updates. A kind of block whose parts take
// requests (a website's elements) says them too (core/parts.ts).
export interface ConnectorAsk {
  verb?: string; // what agents are asked to do to it, in the activity: "change"; "edit" if not said
  asking: string; // after a comment's pin: "asking agents to edit it in the doc"
  doing: string; // an update about one: "Edit the draft with edit_google_doc, then reply"
  act: string; // under a pin: "change the draft with edit_google_doc, then "
  request: string; // under a pin: "request to edit the paragraph, "
  what: string; // the parts it takes requests on, when a comment on another part asks: "the paragraphs of a Google Doc"
}

// ---- the server's half in core -----------------------------------------------------

export interface ConnectorAgentText {
  // For list_boards, about a connected one: what its links show, and what agents can do with it.
  summary(status: ConnectorStatus): { shows: string; tools: string };
  // Requests people have pinned to its content, waiting on an agent, for get_board and its updates.
  asks?(board: Board, viewer?: string): string | undefined;
}

export interface ConnectorLinkHooks {
  // What agents are told of a link block that carries something of this connector's (a draft).
  note?(block: Block): string | undefined;
  // A link block's address changed: drop what was of the old address.
  retarget?(block: Block): void;
}

// ---- the kind ----------------------------------------------------------------------

export interface ConnectorKind {
  readonly id: ConnectorId;
  readonly name: string; // "Google"
  // Plain words for the scopes it may ask for: for people, and in short for agents.
  readonly scopes: Readonly<Record<string, { label: string; agent: string }>>;
  // The scopes that only say who is signed in: they read as one line. `email` is the ones that grant seeing it.
  readonly identity: { readonly scopes: readonly string[]; readonly email: readonly string[] };
  // The links it recognises (Docs, Sheets and Slides), tried before the others.
  readonly sources?: readonly LinkSourceKind[];
  readonly pins?: ConnectorPins;

  readonly agent?: ConnectorAgentText;
  readonly link?: ConnectorLinkHooks;
  // Its part of the store (where its drafts and the pins on them are kept):
  // made once per Store, over the board repository. Reached with Store.connectorStore(id).
  readonly store?: (repo: BoardRepository) => object;
}

// What of a connector only the server uses, in its server.ts.
export type ConnectorServerHalf = Pick<ConnectorKind, 'agent' | 'link' | 'store'> & {
  pins?: Pick<ConnectorPins, 'anchor' | 'where' | 'label' | 'missing' | 'seen' | 'ask'>;
};
