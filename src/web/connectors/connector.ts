// A connector's web half (see core/connectors/connector.ts for the whole
// contract): its panel on the Connectors page and its pieces on the canvas. The
// page and the canvas ask the registry (registry.ts) and neither names a
// service. A connector's web folder (web/connectors/<id>/) is the whole of it
// here. Internal: connectors are code in this repository (#67).

import type { ComponentType } from 'react';
import type { ConnectorStatus } from '../../core/connectors';
import type { LinkSource } from '../../core/sources';
import type { Block, BlockVersion, Pin } from '../../core/types';
import type { Mark } from '../canvas/sources/mark';

type LinkBlock = Extract<Block, { type: 'link' }>;
type ImageBlock = Extract<Block, { type: 'image' }>;

// What a connector's page may name of the service's own words: the real name
// of a file on a link card.
export interface FileInfo {
  name: string;
  modifiedTime?: string;
}

// An optional permission a person can allow once signed in, which signs in
// again asking for it (Google Docs editing).
export interface ConnectorPermission {
  name: string; // as the server knows it
  scope: string; // the access line that shows whether it was granted
  button: string; // "Allow editing Google Docs"
  title: string;
}

// How a person chooses what Tricot may use of the service, when it only sees
// what they choose (Google's Picker): offered when adding a link.
export interface ConnectorChooser {
  label: string; // "Choose a Google Doc"
  choose(): Promise<{ url: string } | null>; // null when they close it without choosing
}

// How a connector's documents are edited in Tricot, over the canvas: its
// editor, and what its card says about them.
export interface ConnectorEditor {
  title: string; // the card's Edit in Tricot button
  Editor: ComponentType<{ block: LinkBlock; name: string; pinId?: string; onClose(): void }>;
  Threads: ComponentType<{ block: LinkBlock }>; // on the card: how many threads on its parts are open
  draft(block: LinkBlock): string | null; // what the card says of a draft of edits: "draft, 2 changes"
  opensPin(pin: Pin): boolean; // whether showing this pin's comment opens the editor there
}

export interface WebConnector {
  readonly id: string;
  Mark: ComponentType; // its mark on its card
  readonly serves?: string; // what it reads: "Drive, Docs, Sheets and Slides"
  readonly setup: { intro: string; files: readonly string[] }; // what its set-up steps say, and the file names in them to show as code
  readonly signOutHint: string; // where else to remove Tricot's access, when it couldn't be reached
  // What Disconnect says once done, when the service can't be reached at all because its access is a token the person keeps (so signOutHint doesn't fit).
  readonly removedNote?: string;
  // How a person gives it access when there is no sign-in page to go to (a token pasted once): shown in place of the Connect button, until it is connected.
  SignIn?: ComponentType<{ status: ConnectorStatus; onChange(next: ConnectorStatus): void }>;
  readonly permission?: ConnectorPermission;
  accessNote(status: ConnectorStatus): string; // under what it can see and do, given how it is signed in
  readonly chooser?: ConnectorChooser;
  Panel?: ComponentType<{ status: ConnectorStatus }>; // more on its card on the Connectors page, once connected
  // The real name of a file on a link card, looked up through the server; null when not known.
  fileInfo?(fileId: string): Promise<FileInfo | null>;
  readonly marks?: Record<string, Mark>; // the marks of the links it recognises
  readonly editor?: ConnectorEditor;
  // More on the card of a link it recognises, under its title (a frame's thumbnail and what to do with it).
  LinkCard?: ComponentType<{ block: LinkBlock; source: LinkSource }>;
  // In the toolbar of an image block that came from it (see ImageOrigin in core/blocks/image).
  ImageTools?: ComponentType<{ block: ImageBlock; viewing: BlockVersion | null }>;
}
