import { assertValidKey, FileNotFoundError, type FileStorage } from './types.js';

/** In-memory storage for tests. */
export class MemoryFileStorage implements FileStorage {
  readonly driver = 'memory' as const;
  readonly files = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertValidKey(key);
    if (!this.files.has(key)) this.files.set(key, { data: Buffer.from(data), contentType });
  }

  async get(key: string): Promise<Buffer> {
    assertValidKey(key);
    const f = this.files.get(key);
    if (!f) throw new FileNotFoundError(key);
    return f.data;
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    return this.files.has(key);
  }
}
