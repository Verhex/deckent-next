import { HUB_LIMITS } from '#domain/index.js';
/** Bounds a caller-provided stream before a request or effect input is constructed. */
export async function readHubHttpBody(request: Request, signal: AbortSignal): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > HUB_LIMITS.httpMaxBytes) throw new RangeError();
      chunks.push(chunk.value);
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
