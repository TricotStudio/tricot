import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { agentKind } from '../../core/blocks/agent';
import type { AgentIo } from '../../core/blocks/kind';
import { kinds } from '../../core/blocks/registry';
import type { BlockArgs } from '../../core/schemas';
import { BoardError, checkImage, type Store } from '../../core/store';
import type { Block } from '../../core/types';

// What a block's kind reads of what an agent sent, checked now; the function
// it returns saves what is pending (an image's file) and gives its content.
// A type a kind still answers to (a checklist) makes a block of that kind.
export function blockReader(store: Store, allowFilePaths: boolean) {
  // What kinds need of this server: images from files, saved assets, and
  // whether what is on this computer may be read.
  const io: AgentIo = {
    readImage: (imagePath?: string, base64?: string) => readImage(imagePath, base64),
    saveAsset: (data: Uint8Array) => store.saveAsset(data),
    localFiles: allowFilePaths,
  };

  function readImage(imagePath?: string, base64?: string): Buffer {
    if (!imagePath === !base64) throw new BoardError('An image block needs image_path or image_base64 (exactly one).');
    let data: Buffer;
    if (base64) {
      data = Buffer.from(base64, 'base64');
    } else {
      if (!allowFilePaths) {
        throw new BoardError('This server is reachable from other machines, so image_path is disabled. Send image_base64.');
      }
      const file = path.resolve(imagePath!);
      try {
        if (statSync(file).size > 8 * 1024 * 1024) throw new BoardError('Images must be 8 MB or smaller.');
        data = readFileSync(file);
      } catch (error) {
        if (error instanceof BoardError) throw error;
        throw new BoardError(`Cannot read "${file}" (${(error as NodeJS.ErrnoException).code ?? 'unreadable'}).`);
      }
    }
    checkImage(data);
    return data;
  }

  return {
    io,
    // What an agent named on this computer instead of sending it (a
    // repository's diff, a file's lines), read by the block's kind into the
    // fields it would have sent, before readContent.
    async fill<T extends BlockArgs>(args: T): Promise<T> {
      const filled = await agentKind(args.type)?.agent.fill?.(args, io);
      return (filled as T | undefined) ?? args;
    },
    // The same for a change to a block: each kind reads its own fields, and
    // refuses them for a block of another kind.
    async fillChange<T extends object>(args: T, block: Block): Promise<T> {
      let filled = args as Record<string, unknown>;
      for (const kind of kinds()) filled = (await kind.agent.fill?.(filled, io, block)) ?? filled;
      return filled as T;
    },
    readContent(args: BlockArgs) {
      const kind = agentKind(args.type);
      if (!kind) throw new BoardError(`Unknown block type "${args.type}".`);
      return kind.agent.read(args, io);
    },
  };
}

export type BlockReader = ReturnType<typeof blockReader>;
