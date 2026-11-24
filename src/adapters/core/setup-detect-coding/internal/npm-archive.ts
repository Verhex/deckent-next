import { createHash } from 'node:crypto';
import { constants as bufferBounds } from 'node:buffer';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { ErrorRegistry, redactForRecord } from '#platform/index.js';
import { readPreparedInputFile, type WorkerTreeKnownSecrets } from '#adapters/core/worker-tree-gate/index.js';

const unzip = promisify(gunzip);
const BLOCK = 512;
const refuse = (): never => { throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED'); };
export const archiveDigest = (integrity: string) => {
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/u.exec(integrity);
  return match ? Buffer.from(match[1]!, 'base64').toString('hex') : refuse();
};
const field = (record: Buffer, at: number, length: number) => {
  const bytes = record.subarray(at, at + length), nul = bytes.indexOf(0);
  const value = nul === -1 ? bytes : bytes.subarray(0, nul), name = value.toString('utf8');
  if (!Buffer.from(name).equals(value)) return refuse();
  return name;
};
function paxPath(data: Buffer) {
  let path: string | undefined;
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(' ', offset), digits = data.subarray(offset, space).toString('ascii');
    if (space <= offset || !/^[1-9][0-9]*$/u.test(digits)) return refuse();
    const end = offset + Number(digits);
    if (end <= space || end > data.length || data[end - 1] !== 10) return refuse();
    const value = field(data, space + 1, end - space - 2);
    if (value.startsWith('path=')) { if (path !== undefined) return refuse(); path = value.slice(5); }
    else if (value.startsWith('size=') || value.startsWith('linkpath=')) return refuse();
    offset = end;
  }
  return path;
}

/** Verify the locked archive before trusting its regular-file inventory. No archive entry is extracted. */
export function npmArchiveInventory(read: (hex: string, limit: number) => Promise<Buffer | null>,
  limits: Readonly<{ maxFiles: number; maxTotalBytes: number; timeoutMs: number }>) {
  const started = performance.now();
  let remaining = limits.maxTotalBytes, count = 0;
  const tick = () => { if (performance.now() - started >= limits.timeoutMs) return refuse(); };
  return async (integrity: string) => {
    const hex = archiveDigest(integrity);
    tick();
    const raw = await read(hex, remaining);
    if (!raw || raw.length >= remaining || createHash('sha512').update(raw).digest('hex') !== hex) return refuse();
    remaining -= raw.length;
    const tar = await unzip(raw, { maxOutputLength: Math.min(remaining, bufferBounds.MAX_LENGTH) });
    remaining -= tar.length;
    const files = new Map<string, string>(), occupied = new Set<string>();
    let longPath: string | undefined, root: string | undefined;
    for (let offset = 0; offset + BLOCK <= tar.length;) {
      tick();
      const record = tar.subarray(offset, offset + BLOCK);
      if (!record.some(byte => byte !== 0)) {
        if (longPath !== undefined || tar.subarray(offset).some(byte => byte !== 0)) return refuse();
        return files;
      }
      if (++count > limits.maxFiles) return refuse();
      const sizeText = field(record, 124, 12).trim();
      if (!/^[0-7]+$/u.test(sizeText)) return refuse();
      const size = parseInt(sizeText, 8), start = offset + BLOCK;
      offset = start + Math.ceil(size / BLOCK) * BLOCK;
      if (!Number.isSafeInteger(size) || offset > tar.length) return refuse();
      const data = tar.subarray(start, start + size), type = record[156];
      if (type === 120) { if (longPath !== undefined) return refuse(); longPath = paxPath(data); continue; }
      const prefix = field(record, 345, 155), name = (longPath ?? [prefix, field(record, 0, 100)].filter(Boolean).join('/')).replace(/\/$/u, '');
      longPath = undefined;
      const [first, ...relative] = name.split('/');
      if (!first || name.split('/').some(part => !part || part === '.' || part === '..') || occupied.has(name)) return refuse();
      root ??= first;
      if (first !== root) return refuse();
      occupied.add(name);
      if ((type === 0 || type === 48) && relative.length) files.set(relative.join('/'), createHash('sha256').update(data).digest('hex'));
      else if (type !== 53) return refuse();
    }
    return refuse();
  };
}

/** npm content-v2 addressing. No index lookup, directory enumeration, fallback or execution. */
export function cachedNpmInventory(cache: string, limits: Parameters<typeof npmArchiveInventory>[1], known: WorkerTreeKnownSecrets) {
  const read = npmArchiveInventory((hex, limit) =>
    readPreparedInputFile(join(cache, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), limit), limits);
  const verified = new Map<string, Map<string, string>>();
  return async (integrity: string, packagePath: string) => {
    const found = verified.get(integrity);
    if (found) return found;
    try {
      const contents = await read(integrity);
      verified.set(integrity, contents);
      return contents;
    } catch {
      const safe = known.matchesPackageValue?.([packagePath]) ? '-' : redactForRecord(packagePath, known);
      throw ErrorRegistry.createError('NATIVE_WORKER_DEPENDENCIES_REFUSED', { params: {
        package: /[\p{Cc}\p{Cf}]/u.test(safe) ? '-' : safe.slice(0, 512),
      } });
    }
  };
}
