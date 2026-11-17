/**
 * Detect file type from magic bytes rather than trusting the client's
 * Content-Type or filename. Only formats Azure Document Intelligence accepts.
 */
export type SupportedFile = { mimeType: string; ext: string };

const SIGNATURES: { bytes: number[]; offset?: number; type: SupportedFile }[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], type: { mimeType: 'application/pdf', ext: 'pdf' } }, // %PDF-
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: { mimeType: 'image/png', ext: 'png' } },
  { bytes: [0xff, 0xd8, 0xff], type: { mimeType: 'image/jpeg', ext: 'jpg' } },
  { bytes: [0x49, 0x49, 0x2a, 0x00], type: { mimeType: 'image/tiff', ext: 'tiff' } }, // little-endian
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], type: { mimeType: 'image/tiff', ext: 'tiff' } }, // big-endian
  { bytes: [0x42, 0x4d], type: { mimeType: 'image/bmp', ext: 'bmp' } },
];

export function detectFileType(data: Buffer): SupportedFile | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (data.length < offset + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => data[offset + i] === b)) return sig.type;
  }
  return null;
}

export const SUPPORTED_DESCRIPTION = 'PDF, PNG, JPEG, TIFF or BMP';
