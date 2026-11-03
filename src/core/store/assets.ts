import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors';
import type { BoardRepository } from './repository';
import { randomId } from './validate';
import { IMAGE_TYPES, type ImageExt, checkImage } from '../blocks/image/check';
import { type PixelSize, imageDimensions } from '../blocks/image/image';
import { findKind } from '../blocks/registry';
import type { Deletion } from '../deletions';
import type { Block, Board, Canvas } from '../types';

// The files of pictures on image blocks, in the data folder's assets.
export class Assets {
  private readonly assetSizes = new Map<string, PixelSize | null>(); // asset id -> its picture's size; assets never change

  constructor(
    private readonly dataDir: string,
    private readonly repo: BoardRepository,
  ) {}

  saveAsset(data: Uint8Array): string {
    const ext = checkImage(data);
    const assetId = `${randomId(12)}.${ext}`;
    mkdirSync(this.assetDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(this.assetDir, assetId), data, { mode: 0o600 });
    this.assetSizes.set(assetId, imageDimensions(data));
    return assetId;
  }

  // An asset's picture size in pixels, from its header: read when it was saved,
  // or from its file the first time it's asked for. Null if unreadable.
  assetSize(assetId: string): PixelSize | null {
    const known = this.assetSizes.get(assetId);
    if (known !== undefined) return known;
    const { file } = this.assetFile(assetId);
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      return null; // unreadable now; asked again next time
    }
    const size = imageDimensions(data);
    this.assetSizes.set(assetId, size);
    return size;
  }

  // An image block's picture size, as the block keeps it.
  naturalSize(assetId: string): { naturalWidth?: number; naturalHeight?: number } {
    const size = this.assetSize(assetId);
    return size ? { naturalWidth: size.width, naturalHeight: size.height } : {};
  }

  setNaturalSize(block: Extract<Block, { type: 'image' }>): void {
    delete block.naturalWidth;
    delete block.naturalHeight;
    Object.assign(block, this.naturalSize(block.assetId));
  }

  // Removes the files of pictures nothing has any more: no block or earlier
  // version on any board, nor anything deleted that is kept to restore.
  removeUnusedAssets(assetIds: string[]): void {
    const used = new Set(this.repo.allBoards().flatMap((board) => this.shownOn(board)));
    for (const assetId of new Set(assetIds)) {
      if (used.has(assetId) || !ASSET_ID.test(assetId) || this.repo.versionShows(assetId)) continue;
      rmSync(path.join(this.assetDir, assetId), { force: true });
      this.assetSizes.delete(assetId);
    }
  }

  // The pictures a board shows or keeps in memory: on its canvases, and in
  // what was deleted from it that can be restored. Its earlier versions are in
  // a table of their own.
  private shownOn(board: Board): string[] {
    const canvases = [board.canvas, ...board.decisions.map((d) => d.canvas), ...board.tasks.map((t) => t.canvas)];
    const kept = (board.deleted ?? []).flatMap((d) => (d.kept ? [d.kept] : []));
    const blocks = [...canvases.flatMap((c) => c.blocks), ...kept.flatMap((k) => (k.block ? [k.block] : []))];
    const versions = kept.flatMap((k) => k.versions ?? []);
    return [...blocks, ...versions].flatMap((shown) => findKind(shown.type)?.assets?.(shown) ?? []);
  }

  // Every picture a board uses, for a board about to be deleted: remove it
  // from the repository, then hand these to removeUnusedAssets, which leaves
  // the ones another board or version still shows.
  usedBy(board: Board): string[] {
    return [...new Set([...this.shownOn(board), ...this.repo.versionAssets(board)])];
  }

  // Every picture a card's canvas uses, for a card about to be deleted: its
  // blocks, their earlier versions, and what was deleted from it and kept to
  // restore (`kept`). Once it's gone, hand these to removeUnusedAssets.
  usedByCanvas(board: Board, canvas: Canvas, kept: readonly Deletion[]): string[] {
    const held = kept.flatMap((d) => (d.kept ? [d.kept] : []));
    const blocks = [...canvas.blocks, ...held.flatMap((k) => (k.block ? [k.block] : []))];
    const versions = [...blocks.flatMap((b) => this.repo.versionsOf(board, b.id)), ...held.flatMap((k) => k.versions ?? [])];
    return [...new Set([...blocks, ...versions].flatMap((shown) => findKind(shown.type)?.assets?.(shown) ?? []))];
  }

  assetFile(assetId: string): { file: string; mimeType: string } {
    const match = ASSET_ID.exec(assetId);
    const file = match ? path.join(this.assetDir, assetId) : '';
    if (!match || !existsSync(file)) throw new BoardError(`No image "${assetId}".`, 'not_found');
    return { file, mimeType: IMAGE_TYPES[match[1] as ImageExt] };
  }

  private get assetDir(): string {
    return path.join(this.dataDir, 'assets');
  }
}

const ASSET_ID = /^[a-z2-9]{12}\.(png|jpg|gif|webp)$/; // as saveAsset names them
