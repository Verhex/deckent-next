import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { sep } from 'node:path';

/** Bounded kernel/sysfs text, never a secret. The caller owns the error vocabulary and byte budget. */
export async function readHostMetadata(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(maxBytes + 1); let offset = 0;
    while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > maxBytes) throw new Error('HOST_METADATA_LIMIT');
    return bytes.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
}
const unescapeMount = (value: string) => value.replace(/\\(040|011|012|134)/gu, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
function parseLinuxMounts(text: string) {
  return text.trim().split('\n').map(line => {
    const [left, right] = line.split(' - '), fields = left!.split(' '), type = right?.split(' ')[0];
    return { id: fields[0], device: fields[2], base: unescapeMount(fields[3] ?? ''), path: unescapeMount(fields[4] ?? ''), type };
  });
}
/** The same longest enclosing mount selection used by personal custody and installation identity. */
export function linuxMountsAt(root: string, text: string) {
  return parseLinuxMounts(text).filter(row => row.path && (root === row.path || root.startsWith(row.path === sep ? sep : `${row.path}${sep}`)))
    .sort((a, b) => b.path.length - a.path.length);
}
export function linuxDeviceNumber(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n), minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}
