import { describe, expect, it, vi } from 'vitest';
import { putMultipart } from '../../d1-backup-worker/src/index.js';

function body(chunks) {
  return new ReadableStream({ start(controller) { chunks.forEach(c => controller.enqueue(c)); controller.close(); } });
}
function bucket(fail = false) {
  const lengths = [];
  const upload = {
    uploadPart: vi.fn(async (partNumber, bytes) => {
      if (fail) throw new Error('simulated upload failure');
      lengths.push(bytes.byteLength);
      return { partNumber, etag: 'part-' + partNumber };
    }),
    complete: vi.fn(async parts => ({ parts })), abort: vi.fn(async () => {}),
  };
  return { createMultipartUpload: vi.fn(async () => upload), upload, lengths };
}
describe('backup upload safety', () => {
  it('streams arbitrary boundaries into valid 5 MiB multipart chunks', async () => {
    const b = bucket();
    const size = 5 * 1024 * 1024;
    await putMultipart(b, 'isolated/test.sql.gz', body([new Uint8Array(size - 1), new Uint8Array(2), new Uint8Array(size + 7)]), {});
    expect(b.lengths).toEqual([size, size, 8]);
    expect(b.upload.complete).toHaveBeenCalledOnce();
    expect(b.upload.abort).not.toHaveBeenCalled();
  });
  it('aborts unfinished uploads and never completes after failure', async () => {
    const b = bucket(true);
    await expect(putMultipart(b, 'isolated/failure', body([new Uint8Array(10)]), {})).rejects.toThrow('simulated upload failure');
    expect(b.upload.abort).toHaveBeenCalledOnce();
    expect(b.upload.complete).not.toHaveBeenCalled();
  });
  it('does not add an empty trailing part at an exact boundary', async () => {
    const b = bucket();
    await putMultipart(b, 'isolated/boundary', body([new Uint8Array(5 * 1024 * 1024)]), {});
    expect(b.lengths).toEqual([5 * 1024 * 1024]);
  });
});
