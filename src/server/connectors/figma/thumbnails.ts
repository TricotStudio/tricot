// The thumbnails on Figma link cards, kept as assets (the data folder's
// assets, served like any picture) and remembered by which version of the file
// they show, so a restart or a second look doesn't draw them again. A
// thumbnail a newer one replaces is removed with its file.

import { rmSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../../../core/store';
import { readSecretFile, writeSecretFile } from '../oauth';

interface Entry {
  assetId: string;
  modified: string; // the file's lastModified, when the thumbnail was drawn
}

const MAX_KEPT = 100;

export class Thumbnails {
  private index?: Record<string, Entry>;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly store: Store,
  ) {
    this.file = path.join(dataDir, 'connectors', 'figma-thumbnails.json');
  }

  // The asset of a link's thumbnail as the file was at `modified`, if there is one.
  find(fileId: string, modified: string): string | undefined {
    const entry = this.entries()[fileId];
    if (!entry || entry.modified !== modified || !this.exists(entry.assetId)) return undefined;
    return entry.assetId;
  }

  save(fileId: string, modified: string, picture: Buffer): string {
    const assetId = this.store.saveAsset(picture);
    const entries = this.entries();
    const old = entries[fileId];
    delete entries[fileId]; // so it is the newest key
    entries[fileId] = { assetId, modified };
    if (old) this.remove(old.assetId);
    for (const key of Object.keys(entries).slice(0, Math.max(0, Object.keys(entries).length - MAX_KEPT))) {
      this.remove(entries[key].assetId);
      delete entries[key];
    }
    writeSecretFile(this.file, entries);
    return assetId;
  }

  private entries(): Record<string, Entry> {
    if (!this.index) {
      try {
        this.index = readSecretFile<Record<string, Entry>>(this.file) ?? {};
      } catch {
        this.index = {};
      }
    }
    return this.index;
  }

  private exists(assetId: string): boolean {
    try {
      this.store.assetFile(assetId);
      return true;
    } catch {
      return false;
    }
  }

  private remove(assetId: string): void {
    try {
      rmSync(this.store.assetFile(assetId).file, { force: true });
    } catch {
      // Already gone.
    }
  }
}
