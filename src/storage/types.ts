/**
 * Where uploaded invoice files live. Keys are content-addressed
 * (`<sha256>.<ext>`), so writing the same file twice is a harmless no-op.
 */
export interface FileStorage {
  readonly driver: 'local' | 'azure' | 'memory';
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

export class FileNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`file not found: ${key}`);
    this.name = 'FileNotFoundError';
  }
}

const KEY_PATTERN = /^[a-f0-9]{64}\.[a-z0-9]{2,5}$/;

/** Rejects anything that is not a content-addressed key, so a key can never escape the storage root. */
export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
}
