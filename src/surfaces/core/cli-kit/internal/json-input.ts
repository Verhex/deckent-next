import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { ErrorRegistry, DeckentError } from '#platform/index.js';

export interface JsonInputErrors { readonly subject?: string; readonly limit: string; readonly invalid: string; readonly tty: string; readonly unavailable: string }
/** Bounded transport parsing only; the caller validates its operation schema. */
export async function readJsonInput(source: string, maxBytes: number, errors: JsonInputErrors, stdin: Readable & { isTTY?: boolean } = process.stdin): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !source) throw ErrorRegistry.createError('CLI_USAGE');
  const inputError = (code: string, params = {}) => ErrorRegistry.createError(code, { params: { ...params, ...(errors.subject ? { subject: errors.subject } : {}) } });
  async function consume(stream: AsyncIterable<Uint8Array | string>) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) throw inputError(errors.limit, { limit: maxBytes });
      chunks.push(buffer);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw inputError(errors.invalid); }
  }
  try {
    if (source === '-') {
      if (stdin.isTTY) throw inputError(errors.tty);
      return await consume(stdin);
    }
    if (process.platform === 'win32' || !(constants.O_NOFOLLOW > 0) || !(constants.O_NONBLOCK > 0)) throw inputError(errors.unavailable);
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw inputError(errors.invalid, { reason: 'not-regular-file' });
      if (info.size > maxBytes) throw inputError(errors.limit, { limit: maxBytes });
      return await consume(file.createReadStream({ autoClose: false }));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof DeckentError) throw error;
    throw inputError(errors.unavailable);
  }
}
