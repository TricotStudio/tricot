// Reading Figma frames as the connected account: a link card's name and
// thumbnail, a frame as a picture, its comments, and the two things a frame
// becomes on the board: an image block ("Bring in this frame") and the same
// image rendered again ("Refresh").

import { readFileSync } from 'node:fs';
import { figmaTarget, parseFigmaFileId, type FigmaTarget } from '../../../core/connectors/figma/frame';
import { clip } from '../../../core/format';
import { BoardError, type Store } from '../../../core/store';
import { refOf } from '../../../core/store/repository';
import type { Actor, Block } from '../../../core/types';
import { ConnectorError } from '../oauth';
import { FIGMA_CODES, type FigmaClient } from './client';
import type { FigmaConnector } from './connector';
import { Thumbnails } from './thumbnails';

type ImageBlock = Extract<Block, { type: 'image' }>;

interface FigmaNode {
  id: string;
  name: string;
  children?: FigmaNode[];
}

interface NodesAnswer {
  name?: string; // the file's
  lastModified?: string;
  nodes?: Record<string, { document?: FigmaNode } | null>;
}

interface FileAnswer {
  name?: string;
  lastModified?: string;
  thumbnailUrl?: string;
}

interface ImagesAnswer {
  images?: Record<string, string | null>;
}

export interface FigmaComment {
  id: string;
  parent_id?: string;
  message?: string;
  created_at?: string;
  resolved_at?: string | null;
  user?: { handle?: string };
  client_meta?: { node_id?: string } | null;
}

// What a link card shows of a file or frame.
export interface FigmaCard {
  name: string; // the frame's, or the file's for a link to a file
  fileName: string;
  frame: boolean;
  modifiedTime?: string;
  thumbnail?: string; // an asset id
}

export interface FrameRead {
  name: string;
  fileName: string;
  modifiedTime?: string;
  picture: Buffer;
  comments: FigmaComment[];
  commentsProblem?: string; // why they couldn't be read, when the picture could
}

const CARD_TTL = 2 * 60_000;
const PICTURE_LIMIT = 8 * 1024 * 1024 - 1024; // what an image block holds, with a little to spare
const BRING_IN_SCALES = [2, 1, 0.5]; // 2x first; a frame too big for that comes over smaller
const THUMBNAIL_SCALE = 0.5;
const AGENT_SCALES = [1, 0.5, 0.25];
const AGENT_PICTURE_LIMIT = 3 * 1024 * 1024;

export class FigmaFrames {
  private readonly thumbnails: Thumbnails;
  private readonly cards = new Map<string, { at: number; card?: FigmaCard; error?: ConnectorError }>();
  private readonly looking = new Map<string, Promise<FigmaCard>>();
  private session?: string;

  constructor(
    private readonly figma: FigmaConnector,
    private readonly store: Store,
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.thumbnails = new Thumbnails(dataDir, store);
  }

  // ---- a link card ----------------------------------------------------------

  // Its name and thumbnail, kept for two minutes (and a refusal for one) so
  // a board of cards doesn't ask Figma on every look.
  card(fileId: string): Promise<FigmaCard> {
    // Only while connected, and only what the token now connected saw.
    let session: string | undefined;
    try {
      session = this.figma.client().session;
    } catch (error) {
      return Promise.reject(error);
    }
    if (session !== this.session) {
      this.cards.clear();
      this.session = session;
    }
    const known = this.cards.get(fileId);
    if (known && this.now() - known.at < (known.card ? CARD_TTL : CARD_TTL / 2)) {
      return known.card ? Promise.resolve(known.card) : Promise.reject(known.error);
    }
    let looking = this.looking.get(fileId);
    if (!looking) {
      looking = this.lookUp(fileId).then(
        (card) => {
          this.cards.set(fileId, { at: this.now(), card });
          return card;
        },
        (error) => {
          // A refusal about this file is kept; one about the connection (not connected, a rest from Figma) is asked again.
          if (error instanceof ConnectorError && error.code === FIGMA_CODES.noAccess) this.cards.set(fileId, { at: this.now(), error });
          throw error;
        },
      );
      this.looking.set(fileId, looking);
      void looking.then(() => this.looking.delete(fileId), () => this.looking.delete(fileId));
    }
    return looking;
  }

  private async lookUp(fileId: string): Promise<FigmaCard> {
    const target = parseFigmaFileId(fileId);
    if (!target) throw new ConnectorError("That isn't a Figma file Tricot can look up.", 400, FIGMA_CODES.noFrame);
    const client = this.figma.client();
    if (target.nodeId) {
      const node = await this.node(client, target, false);
      const card = { name: node.name, fileName: node.fileName, frame: true, modifiedTime: node.lastModified };
      return { ...card, thumbnail: await this.thumbnail(fileId, node.lastModified, () => this.render(client, target, [THUMBNAIL_SCALE])) };
    }
    const file = await client.json<FileAnswer>(`/v1/files/${target.fileKey}?depth=1`);
    const name = file.name || 'Figma file';
    const thumbnailUrl = file.thumbnailUrl;
    return {
      name,
      fileName: name,
      frame: false,
      modifiedTime: file.lastModified,
      thumbnail: thumbnailUrl ? await this.thumbnail(fileId, file.lastModified, () => client.picture(thumbnailUrl)) : undefined,
    };
  }

  // A thumbnail the card can do without: Figma not drawing it just leaves it out.
  private async thumbnail(fileId: string, modified: string | undefined, draw: () => Promise<Buffer>): Promise<string | undefined> {
    const version = modified ?? '';
    const kept = this.thumbnails.find(fileId, version);
    if (kept) return kept;
    try {
      return this.thumbnails.save(fileId, version, await draw());
    } catch (error) {
      if (error instanceof ConnectorError && error.code === FIGMA_CODES.tokenRefused) throw error;
      return undefined;
    }
  }

  // ---- a frame, as the API has it -----------------------------------------------

  // The frame's name, its file's, and (with `deep`) every node id inside it.
  private async node(client: FigmaClient, target: FigmaTarget, deep: boolean) {
    const nodeId = target.nodeId!;
    const answer = await client.json<NodesAnswer>(`/v1/files/${target.fileKey}/nodes?ids=${encodeURIComponent(nodeId)}${deep ? '' : '&depth=1'}`);
    const document = answer.nodes?.[nodeId]?.document;
    if (!document) {
      throw new ConnectorError("Figma can't find that frame in the file: it may have been deleted, or the link is from before it moved.", 404, FIGMA_CODES.noFrame);
    }
    const ids = new Set<string>();
    if (deep) {
      for (const stack = [document]; stack.length; ) {
        const next = stack.pop()!;
        ids.add(next.id);
        stack.push(...(next.children ?? []));
      }
    }
    return { name: document.name || 'Frame', fileName: answer.name || 'Figma file', lastModified: answer.lastModified, ids };
  }

  // The frame as a PNG at the first of these scales that fits `limit`.
  private async render(client: FigmaClient, target: FigmaTarget, scales: number[], limit = PICTURE_LIMIT): Promise<Buffer> {
    const nodeId = target.nodeId!;
    for (const scale of scales) {
      const answer = await client.json<ImagesAnswer>(`/v1/images/${target.fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`);
      const address = answer.images?.[nodeId];
      if (!address) throw new ConnectorError("Figma couldn't draw that frame as a picture. It may be empty, or hidden.", 422, FIGMA_CODES.noFrame);
      const picture = await client.picture(address);
      if (picture.length <= limit) return picture;
    }
    throw new ConnectorError('That frame is too big to bring over as a picture, even at half size. Use a smaller frame.', 413, 'too_big');
  }

  // ---- for agents -----------------------------------------------------------------

  // A frame as a picture, with its comments: those pinned to it or to anything inside it.
  async read(target: FigmaTarget): Promise<FrameRead> {
    const client = this.figma.client();
    const node = await this.node(client, target, true);
    const picture = await this.render(client, target, AGENT_SCALES, AGENT_PICTURE_LIMIT);
    try {
      const answer = await client.json<{ comments?: FigmaComment[] }>(`/v1/files/${target.fileKey}/comments`);
      const comments = (answer.comments ?? []).filter((c) => c.client_meta?.node_id && node.ids.has(c.client_meta.node_id));
      return { name: node.name, fileName: node.fileName, modifiedTime: node.lastModified, picture, comments };
    } catch (error) {
      if (!(error instanceof ConnectorError) || ![FIGMA_CODES.noScope, FIGMA_CODES.rateLimited, FIGMA_CODES.noAccess].includes(error.code as never)) throw error;
      return { name: node.name, fileName: node.fileName, modifiedTime: node.lastModified, picture, comments: [], commentsProblem: error.message };
    }
  }

  // ---- onto the board ----------------------------------------------------------------

  // "Bring in this frame": an image block of the frame a link card points to,
  // in the card's canvas and group, remembering where it came from.
  async bringIn(linkBlockId: string, actor: Actor): Promise<Block> {
    const located = this.store.canvasOf(linkBlockId);
    const link = located.canvas.blocks.find((b) => b.id === linkBlockId);
    const target = link?.type === 'link' ? figmaTarget(link.url) : null;
    if (!link || !target?.nodeId) {
      throw new BoardError('That card is not a link to a Figma frame. In Figma, select a frame, then Copy link to selection.');
    }
    const client = this.figma.client();
    const node = await this.node(client, target, false);
    const assetId = this.store.saveAsset(await this.render(client, target, BRING_IN_SCALES));
    return this.store.addBlock(
      refOf(located),
      {
        content: {
          type: 'image',
          assetId,
          caption: clip(`${node.fileName} on Figma`, 200),
          origin: { connector: 'figma', fileId: target.fileKey, nodeId: target.nodeId },
        },
        title: clip(node.name, 120),
        groupId: link.groupId,
      },
      actor,
    );
  }

  // "Refresh": the frame drawn again, in place. If Figma's picture is the one
  // the block shows, nothing changes; otherwise it is a new version of the block
  // and the one it replaces is kept as an earlier version.
  async refresh(imageBlockId: string, actor: Actor): Promise<{ block: Block; changed: boolean }> {
    const block = this.store.blockOf(imageBlockId);
    const origin = block.type === 'image' ? block.origin : undefined;
    if (block.type !== 'image' || origin?.connector !== 'figma') throw new BoardError('That picture did not come from Figma, so there is nothing to refresh it from.');
    const picture = await this.render(this.figma.client(), { fileKey: origin.fileId, nodeId: origin.nodeId }, BRING_IN_SCALES);
    if (picture.equals(readFileSync(this.store.assetFile((block as ImageBlock).assetId).file))) return { block, changed: false };
    return { block: this.store.updateBlock(imageBlockId, { image: picture }, actor), changed: true };
  }
}
