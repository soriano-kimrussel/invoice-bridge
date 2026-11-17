import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStorageConfig } from '../src/config.js';
import {
  createStorage,
  FileNotFoundError,
  LocalFileStorage,
  MemoryFileStorage,
  type FileStorage,
} from '../src/storage/index.js';

const KEY = `${'a'.repeat(64)}.pdf`;

const suites: [string, () => Promise<{ storage: FileStorage; cleanup: () => Promise<void> }>][] = [
  [
    'LocalFileStorage',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ib-storage-'));
      return { storage: new LocalFileStorage(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  ],
  ['MemoryFileStorage', async () => ({ storage: new MemoryFileStorage(), cleanup: async () => {} })],
];

describe.each(suites)('%s', (_name, make) => {
  let storage: FileStorage;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ storage, cleanup } = await make());
  });
  afterEach(() => cleanup());

  it('round-trips bytes', async () => {
    await storage.put(KEY, Buffer.from('hello'), 'application/pdf');
    expect(await storage.exists(KEY)).toBe(true);
    expect((await storage.get(KEY)).toString()).toBe('hello');
  });

  it('is idempotent: a second put of the same key is a no-op', async () => {
    await storage.put(KEY, Buffer.from('first'), 'application/pdf');
    await storage.put(KEY, Buffer.from('first'), 'application/pdf');
    expect((await storage.get(KEY)).toString()).toBe('first');
  });

  it('throws FileNotFoundError for a missing key', async () => {
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(FileNotFoundError);
    expect(await storage.exists(KEY)).toBe(false);
  });

  it.each(['../../etc/passwd', '..\\..\\boot.ini', 'abc.pdf', `${'a'.repeat(64)}/x.pdf`, ''])(
    'rejects unsafe key %j',
    async (bad) => {
      await expect(storage.put(bad, Buffer.from('x'), 'application/pdf')).rejects.toThrow(/invalid storage key/);
      await expect(storage.get(bad)).rejects.toThrow(/invalid storage key/);
    },
  );
});

describe('LocalFileStorage specifics', () => {
  it('leaves no temp files behind after concurrent writes of the same key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ib-storage-'));
    try {
      const s = new LocalFileStorage(dir);
      await Promise.all(Array.from({ length: 5 }, () => s.put(KEY, Buffer.from('same'), 'application/pdf')));
      expect(await readdir(dir)).toEqual([KEY]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createStorage', () => {
  it('defaults to local storage', () => {
    expect(createStorage(loadStorageConfig({})).driver).toBe('local');
  });

  it('builds the Azure adapter from a connection string without network calls', () => {
    const cfg = loadStorageConfig({
      STORAGE_DRIVER: 'azure',
      AZURE_STORAGE_CONNECTION_STRING:
        'DefaultEndpointsProtocol=https;AccountName=devaccount;AccountKey=ZmFrZWtleQ==;EndpointSuffix=core.windows.net',
    });
    expect(createStorage(cfg).driver).toBe('azure');
  });

  it('fails clearly when Azure is selected without a connection string', () => {
    expect(() => loadStorageConfig({ STORAGE_DRIVER: 'azure' })).toThrow(/AZURE_STORAGE_CONNECTION_STRING/);
  });
});
