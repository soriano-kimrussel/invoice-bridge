import { BlobServiceClient, RestError, type ContainerClient } from '@azure/storage-blob';
import { assertValidKey, FileNotFoundError, type FileStorage } from './types.js';

/** Azure Blob Storage for production. The container is private; files are only served through the API. */
export class AzureBlobFileStorage implements FileStorage {
  readonly driver = 'azure' as const;
  private ready: Promise<unknown> | undefined;

  /** Accepts any ContainerClient, e.g. one built with a managed identity credential. */
  constructor(private readonly container: ContainerClient) {}

  static fromConnectionString(connectionString: string, containerName: string) {
    return new AzureBlobFileStorage(
      BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName),
    );
  }

  private ensureContainer(): Promise<unknown> {
    this.ready ??= this.container.createIfNotExists();
    return this.ready;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertValidKey(key);
    await this.ensureContainer();
    const blob = this.container.getBlockBlobClient(key);
    try {
      // If-None-Match: * makes the write create-only: content-addressed, so an existing blob is already correct.
      await blob.uploadData(data, {
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: { ifNoneMatch: '*' },
      });
    } catch (err) {
      if (err instanceof RestError && (err.statusCode === 409 || err.statusCode === 412)) return;
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    assertValidKey(key);
    try {
      return await this.container.getBlockBlobClient(key).downloadToBuffer();
    } catch (err) {
      if (err instanceof RestError && err.statusCode === 404) throw new FileNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    return this.container.getBlockBlobClient(key).exists();
  }
}
