import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { ErrorRegistry, DeckentError } from '#platform/index.js';

/** CLI input only: a bounded JSON document, never policy or an executable profile. */
export async function readGraphInput(source: string, maxBytes: number, stdin: Readable & { isTTY?: boolean } = process.stdin): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !source) throw ErrorRegistry.createError('CLI_USAGE');
  async function consume(stream: AsyncIterable<Uint8Array | string>) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) throw ErrorRegistry.createError('CLI_GRAPH_INPUT_LIMIT', { params: { limit: maxBytes } });
      chunks.push(buffer);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw ErrorRegistry.createError('CLI_GRAPH_INPUT_INVALID'); }
  }
  try {
    if (source === '-') {
      if (stdin.isTTY) throw ErrorRegistry.createError('CLI_GRAPH_INPUT_TTY');
      return await consume(stdin);
    }
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw ErrorRegistry.createError('CLI_GRAPH_INPUT_INVALID');
      if (info.size > maxBytes) throw ErrorRegistry.createError('CLI_GRAPH_INPUT_LIMIT', { params: { limit: maxBytes } });
      return await consume(file.createReadStream({ autoClose: false }));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof DeckentError) throw error;
    throw ErrorRegistry.createError('CLI_GRAPH_INPUT_UNAVAILABLE');
  }
}
