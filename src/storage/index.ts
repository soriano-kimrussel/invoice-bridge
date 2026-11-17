import type { StorageConfig } from '../config.js';
import { AzureBlobFileStorage } from './azureBlob.js';
import { LocalFileStorage } from './local.js';
import type { FileStorage } from './types.js';

export function createStorage(config: StorageConfig): FileStorage {
  switch (config.STORAGE_DRIVER) {
    case 'local':
      return new LocalFileStorage(config.LOCAL_STORAGE_DIR);
    case 'azure':
      return AzureBlobFileStorage.fromConnectionString(
        config.AZURE_STORAGE_CONNECTION_STRING,
        config.AZURE_STORAGE_CONTAINER,
      );
  }
}

export * from './types.js';
export { LocalFileStorage } from './local.js';
export { AzureBlobFileStorage } from './azureBlob.js';
export { MemoryFileStorage } from './memory.js';
