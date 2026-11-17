import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from './errors';
import type { PictureRow } from './pictureRows';
import type { BoardRepository } from './repository';
import { randomId } from './validate';
import { IMAGE_TYPES, type ImageExt, checkImage } from '../blocks/image/check';
import { type PixelSize, imageDimensions } from '../blocks/image/image';
import { findKind } from '../blocks/registry';
import type { Deletion, Kept } from '../deletions';
import { canvasesOf } from '../pins';
import type { Block, BlockVersion, Board, Canvas } from '../types';

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
  // version on any board, nor anything deleted that is kept to restore. What
  // the boards in memory show is not all: a store that does not read a list
  // (a part's cards) holds none of that list's canvases, so a
  // last look at the stored rows of every board and owner says which pictures
  // they still name. A backup holds only the database, so a file removed
  // while a row names it cannot be recovered.
  removeUnusedAssets(assetIds: string[]): void {
    const used = new Set(this.repo.allBoards().flatMap((board) => this.shownOn(board)));
    const unused = [...new Set(assetIds)].filter((assetId) => !used.has(assetId) && ASSET_ID.test(assetId) && !this.repo.versionShows(assetId));
    const stored = unused.length ? this.namedByRows(unused) : new Set<string>();
    for (const assetId of unused) {
      if (stored.has(assetId)) continue;
      rmSync(path.join(this.assetDir, assetId), { force: true });
      this.assetSizes.delete(assetId);
    }
  }

  // Which of these pictures a stored row names, on any board, of any owner. Every row of a kind that can show a picture
  // is looked at as text for names like a picture's, and only a row that holds one of these is read; a row that cannot
  // be read keeps the pictures its text names, since a file removed wrongly is lost for good.
  private namedByRows(assetIds: string[]): Set<string> {
    const wanted = new Set(assetIds);
    const named = new Set<string>();
    for (const row of this.repo.allPictureRows()) {
      const held = assetNamesIn(row.body).filter((assetId) => wanted.has(assetId));
      if (held.length === 0) continue;
      const shown = rowPictures(row);
      for (const assetId of held) if (!shown || shown.includes(assetId)) named.add(assetId);
    }
    return named;
  }

  // The pictures a board shows or keeps in memory: on its canvases, and in
  // what was deleted from it that can be restored. Its earlier versions are in
  // a table of their own.
  private shownOn(board: Board): string[] {
    const kept = (board.deleted ?? []).flatMap((d) => (d.kept ? [d.kept] : []));
    return [...picturesOf(canvasesOf(board).flatMap(({ canvas }) => canvas.blocks)), ...keptPictures(kept)];
  }

  // Every picture a board uses, for a board about to be deleted: remove it
  // from the repository, then hand these to removeUnusedAssets, which leaves
  // the ones another board or version still shows. Its stored rows count as
  // well as what is in memory, so the canvases of cards the store does not
  // read are included, and go with the board if nothing else shows them.
  usedBy(board: Board): string[] {
    const stored = this.repo.pictureRows(board).flatMap((row) => rowPictures(row) ?? []);
    return [...new Set([...this.shownOn(board), ...stored, ...this.repo.versionAssets(board)])];
  }

  // Every picture a card's canvas uses, for a card about to be deleted: its
  // blocks, their earlier versions, and what was deleted from it and kept to
  // restore (`kept`). Once it's gone, hand these to removeUnusedAssets.
  usedByCanvas(board: Board, canvas: Canvas, kept: readonly Deletion[]): string[] {
    const held = kept.flatMap((d) => (d.kept ? [d.kept] : []));
    const blocks = [...canvas.blocks, ...held.flatMap((k) => (k.block ? [k.block] : []))];
    const versions = [...blocks.flatMap((b) => this.repo.versionsOf(board, b.id)), ...held.flatMap((k) => k.versions ?? [])];
    return [...new Set(picturesOf([...blocks, ...versions]))];
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

const EXTENSIONS = 'png|jpg|gif|webp';
const ASSET_ID = new RegExp(`^[a-z2-9]{12}\\.(${EXTENSIONS})$`); // as saveAsset names them
const ASSET_DOT_EXT = new RegExp(`\\.(?:${EXTENSIONS})`, 'g'); // where a name like that ends, which is quick to find in text

// The names like a picture's in a row's text: twelve letters before each extension.
function assetNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const { index, 0: ext } of text.matchAll(ASSET_DOT_EXT)) {
    const name = text.slice(Math.max(0, index - 12), index + ext.length);
    if (ASSET_ID.test(name)) names.push(name);
  }
  return names;
}

// The pictures blocks or earlier versions of blocks show.
const picturesOf = (shown: readonly (Block | BlockVersion)[]): string[] => shown.flatMap((one) => findKind(one.type)?.assets?.(one) ?? []);

// The pictures of what deletions kept to restore: a removed block, and versions deleted from one.
const keptPictures = (kept: readonly Kept[]): string[] => picturesOf([...kept.flatMap((k) => (k.block ? [k.block] : [])), ...kept.flatMap((k) => k.versions ?? [])]);

// The pictures a stored row of a block or a deletion names, or none if it cannot be read.
function rowPictures({ kind, body }: PictureRow): string[] | undefined {
  try {
    const item = JSON.parse(body) as Block | Deletion;
    return kind === 'deletion' ? keptPictures((item as Deletion).kept ? [(item as Deletion).kept!] : []) : picturesOf([item as Block]);
  } catch {
    return undefined;
  }
}
