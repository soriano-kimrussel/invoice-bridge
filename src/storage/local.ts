import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertValidKey, FileNotFoundError, type FileStorage } from './types.js';

/** Local-disk storage for development. Writes atomically via temp file + rename. */
export class LocalFileStorage implements FileStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
    const target = this.pathFor(key);
    if (await this.exists(key)) return; // content-addressed: same key ⇒ same bytes
    await mkdir(this.root, { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    try {
      await rename(tmp, target);
    } catch (err) {
      // On Windows, renaming onto a file another writer just created fails with EPERM/EEXIST/EBUSY.
      // Content-addressed keys mean the winner wrote identical bytes, so losing the race is fine.
      await rm(tmp, { force: true });
      const code = (err as NodeJS.ErrnoException).code;
      if (!(code && ['EPERM', 'EEXIST', 'EBUSY', 'EACCES'].includes(code) && (await this.exists(key)))) {
        throw err;
      }
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}
