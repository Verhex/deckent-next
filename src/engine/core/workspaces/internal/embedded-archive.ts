import { constants, crc32, inflateRawSync } from 'node:zlib';
import BINARIES from './dependency-binaries.json' with { type: 'json' };

/** Reads `length` bytes of the open file at `offset`; fewer bytes than asked (inside the file) means it changed. */
export type EmbeddedArchiveRead = (offset: number, length: number) => Promise<Buffer>;
const ARCHIVES = BINARIES.embeddedArchives, methods = new Set(ARCHIVES.zipMethods);
const flush = { finishFlush: constants.Z_SYNC_FLUSH, info: true } as const;
/** A raw deflate prefix: output length and whether the stream ended inside the input; null when it errors. */
function inflated(bytes: Buffer): Readonly<{ output: number; ended: boolean }> | null {
  try { const { buffer, engine } = inflateRawSync(bytes, flush) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }; return { output: buffer.length, ended: engine.bytesWritten < bytes.length }; }
  catch { return null; }
}
/**
 * A gzip member a worker can extract (method 8; the reserved flag bits GNU gzip and zlib refuse are ignored by Python's gzip, so they never
 * clear a candidate): its deflate stream yields output before any error, or runs error-free past the probe (padding cannot hide a member).
 * A stream that errors, or ends, before its first output byte gives a worker nothing and is not an archive.
 */
function gzipMember(head: Buffer, capped: boolean): boolean {
  const flags = head[3]!;
  let at = 10;
  if (flags & 4) at = at + 2 > head.length ? head.length : at + 2 + head.readUInt16LE(at);
  for (const bit of [8, 16]) if (flags & bit && at < head.length) { const end = head.indexOf(0, at); at = end < 0 ? head.length : end + 1; }
  if (flags & 2) at += 2;
  if (at >= head.length) return true;
  const body = head.subarray(at), whole = inflated(body);
  if (whole) return whole.output > 0 || (!whole.ended && capped);
  // The longest error-free prefix is what a worker's gunzip emits before it stops.
  let low = 0, high = body.length;
  while (high - low > 1) { const middle = (low + high) >> 1; if (inflated(body.subarray(0, middle))) low = middle; else high = middle; }
  return (inflated(body.subarray(0, low))?.output ?? 0) > 0;
}
/** A ustar header: the checksum tar verifies (the 512 header bytes, the checksum field counted as spaces), unsigned or signed-char (GNU tar takes either). */
function tarHeader(head: Buffer): boolean {
  if (head.length < 512) return false;
  const want = Number.parseInt(head.subarray(148, 156).toString('latin1').replace(/[\0 ]+/gu, ' ').trim(), 8);
  let sum = 0, signed = 0; for (let index = 0; index < 512; index++) { const byte = index >= 148 && index < 156 ? 32 : head[index]!; sum += byte; signed += byte > 127 ? byte - 256 : byte; }
  return sum === want || signed === want;
}
const vint = (head: Buffer, at: number) => { let value = 0, shift = 0; for (; at < head.length && shift < 35; at++, shift += 7) { value += (head[at]! & 0x7f) * 2 ** shift; if (!(head[at]! & 0x80)) return { value, next: at + 1 }; } return null; };
/** RAR 4: the main archive header (type 0x73) follows the marker; RAR 5: a non-empty main header (type 1) follows the signature. */
function rarHeader(head: Buffer): boolean {
  if (head[6] === 0) return head[9] === 0x73;
  if (head[6] !== 1 || head[7] !== 0) return false;
  const size = vint(head, 12), type = size && size.value > 0 ? vint(head, size.next) : null;
  return type?.value === 1;
}
/** Whether a record at `position` lies where central-directory readers look for a zip end record: the last `zipEndSearchBytes` of the file. */
const searchedEnd = (position: number, size: number) => size - position <= ARCHIVES.zipEndSearchBytes;
const CENTRAL = Buffer.from('504b0102', 'hex'), LOCATOR = Buffer.from('504b0607', 'hex');
/** Whether the file holds `signature` at `at`: a record a reader finds by arithmetic from another record's position, never by its own offsets. */
async function recordAt(read: EmbeddedArchiveRead, at: number, signature: Buffer): Promise<boolean> {
  if (at < 0) return false;
  const bytes = await read(at, signature.length); if (bytes.length !== signature.length) throw new Error('WORKER_TREE_ENTRY_CHANGED');
  return bytes.equals(signature);
}
/** Each format's structural rule — what its most lenient common extractor enforces — so a chance signature in machine code is not an archive and a real member always is. */
const RULES: readonly Readonly<{ kind: string; signature: Buffer; at: number; length: number; valid: (head: Buffer, position: number, size: number, read: EmbeddedArchiveRead) => boolean | Promise<boolean> }>[] = [
  { kind: 'zip', hex: '504b0304', at: 0, length: 30, valid: (head: Buffer) => head.length >= 30 && methods.has(head.readUInt16LE(8)) },
  // A central entry names its local header, which precedes it (relative to the archive start, never after its own position).
  { kind: 'zip', hex: '504b0102', at: 0, length: 46, valid: (head: Buffer, position: number) => head.length >= 46 && methods.has(head.readUInt16LE(10)) && head.readUInt32LE(42) < position },
  // An end record is judged without its stated offsets, at any distance from the file's end (a worker can cut an embedded zip's range out,
  // Astra 2629 F2): Python zipfile and Info-ZIP re-base every stated offset (either sign) from where the record is, finding the directory
  // `size` bytes before it (or a zip64 locator right before it) and taking each method from the central entry. Also an archive: an end record
  // where central-directory readers search (`zipEndSearchBytes` from the end), zip64 sentinels, or a directory that fits before it as stated.
  { kind: 'zip', hex: '504b0506', at: 0, length: 22, valid: async (head: Buffer, position: number, size: number, read: EmbeddedArchiveRead) => head.length >= 22 && (searchedEnd(position, size)
    || head.readUInt32LE(12) === 0xffffffff || head.readUInt32LE(16) === 0xffffffff || head.readUInt32LE(12) + head.readUInt32LE(16) <= position
    || await recordAt(read, position - head.readUInt32LE(12), CENTRAL) || await recordAt(read, position - LOCATOR.length - 16, LOCATOR)) },
  { kind: 'gzip', hex: '1f8b08', at: 0, length: ARCHIVES.probeBytes, valid: (head: Buffer, position: number, size: number) => gzipMember(head, position + head.length < size) },
  { kind: 'bzip2', hex: '425a68', at: 0, length: 10, valid: (head: Buffer) => head.length >= 10 && head[3]! >= 0x31 && head[3]! <= 0x39 && ARCHIVES.bzip2Blocks.includes(head.subarray(4, 10).toString('hex')) },
  { kind: 'xz', hex: 'fd377a585a00', at: 0, length: 12, valid: (head: Buffer) => head.length >= 12 && head[6] === 0 && (head[7]! & 0xf0) === 0 && crc32(head.subarray(6, 8)) === head.readUInt32LE(8) },
  { kind: 'zstd', hex: '28b52ffd', at: 0, length: 5, valid: (head: Buffer) => head.length >= 5 && (head[4]! & 8) === 0 },
  { kind: '7z', hex: '377abcaf271c', at: 0, length: 8, valid: (head: Buffer) => head.length >= 8 && head[6] === 0 },
  { kind: 'rar', hex: '526172211a07', at: 0, length: 32, valid: (head: Buffer) => head.length >= 10 && rarHeader(head) },
  { kind: 'tar', hex: '7573746172', at: 257, length: 512, valid: (head: Buffer) => tarHeader(head) },
].map(rule => ({ ...rule, signature: Buffer.from(rule.hex, 'hex') }));

/**
 * S6 dependency class (Astra 2626 follow-up): an archive start or end anywhere in an oversized native-claimed body — an appended zip, an
 * embedded gzip member, xz/7z/rar/bzip2/zstd/tar — makes the file unclassifiable (the caller fails closed), never a digest exception.
 * `window` holds the file's bytes from `base`; signatures starting at or after `from` are judged, each by reading its structure from the file.
 * Returns the first archive kind found, or null.
 */
export async function embeddedArchive(window: Buffer, base: number, from: number, size: number, read: EmbeddedArchiveRead, tick: () => void): Promise<string | null> {
  for (const rule of RULES) {
    for (let index = window.indexOf(rule.signature, from); index !== -1; index = window.indexOf(rule.signature, index + 1)) {
      const position = base + index - rule.at; if (position < 0) continue;
      tick();
      const length = Math.min(rule.length, size - position), head = await read(position, length);
      if (head.length !== length) throw new Error('WORKER_TREE_ENTRY_CHANGED');
      if (await rule.valid(head, position, size, read)) return rule.kind;
    }
  }
  return null;
}
