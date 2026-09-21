import type { Socket } from 'node:net';

/** Inspect only the plaintext TLS routing header. No TLS termination or certificate replacement. */
export function inspectNativeClientHello(bytes: Buffer, expectedHost: string, maxBytes: number): 'pending' | 'accepted' | 'rejected' {
  try {
    if (bytes.length > maxBytes) return 'rejected';
    const parts: Buffer[] = []; let offset = 0; let size = 0;
    while (offset < bytes.length) {
      if (bytes.length - offset < 5) return 'pending';
      if (bytes[offset] !== 22 || bytes[offset + 1] !== 3) return 'rejected';
      const length = bytes.readUInt16BE(offset + 3);
      if (!length || length > 16384 || length + offset + 5 > maxBytes) return 'rejected';
      if (bytes.length < offset + 5 + length) return 'pending';
      parts.push(bytes.subarray(offset + 5, offset + 5 + length)); size += length; offset += 5 + length;
      const hello = Buffer.concat(parts, size);
      if (hello.length < 4) continue;
      if (hello[0] !== 1) return 'rejected';
      const end = 4 + hello.readUIntBE(1, 3); if (end > maxBytes) return 'rejected';
      if (hello.length < end) continue;
      let pos = 38;
      const take = (length: number) => { if (!Number.isInteger(length) || length < 0 || pos + length > end) throw new Error(); const start = pos; pos += length; return start; };
      take(hello[take(1)]!);
      const ciphers = hello.readUInt16BE(take(2)); if (ciphers < 2 || ciphers % 2) return 'rejected'; take(ciphers);
      const compression = hello[take(1)]!; if (!compression) return 'rejected'; take(compression);
      const extensions = hello.readUInt16BE(take(2)); if (pos + extensions !== end) return 'rejected';
      let name: string | undefined; const seen = new Set<number>();
      while (pos < end) {
        const kind = hello.readUInt16BE(take(2)); const length = hello.readUInt16BE(take(2));
        const start = take(length); if (seen.has(kind) || kind === 0xfe0d) return 'rejected'; seen.add(kind);
        if (kind !== 0) continue;
        if (length < 5 || hello.readUInt16BE(start) !== length - 2 || hello[start + 2] !== 0
          || hello.readUInt16BE(start + 3) !== length - 5) return 'rejected';
        const host = hello.subarray(start + 5, start + length);
        if (host.some(byte => byte > 127)) return 'rejected'; name = host.toString('ascii');
      }
      return name === expectedHost ? 'accepted' : 'rejected';
    }
    return 'pending';
  } catch { return 'rejected'; }
}

export function readNativeClientHello(socket: Socket, head: Buffer, expectedHost: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let bytes: Buffer = Buffer.alloc(0);
    const cleanup = () => { socket.off('data', data); socket.off('close', fail); socket.off('error', fail); };
    const fail = () => { cleanup(); reject(new Error('NATIVE_TLS_REJECTED')); };
    const data = (part: Buffer) => {
      if (bytes.length + part.length > maxBytes) { fail(); return; }
      bytes = Buffer.concat([bytes, part]); const result = inspectNativeClientHello(bytes, expectedHost, maxBytes);
      if (result === 'rejected') fail();
      else if (result === 'accepted') { socket.pause(); cleanup(); resolve(bytes); }
    };
    socket.on('data', data); socket.on('close', fail); socket.on('error', fail);
    if (head.length) data(head);
  });
}
