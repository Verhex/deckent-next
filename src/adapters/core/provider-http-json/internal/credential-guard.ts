class RollingToken {
  private readonly prefix: Uint32Array;
  private matched = 0;
  constructor(private readonly token: Buffer) {
    this.prefix = new Uint32Array(token.length);
    for (let index = 1, length = 0; index < token.length;) {
      if (token[index] === token[length]) this.prefix[index++] = ++length;
      else if (length > 0) length = this.prefix[length - 1]!;
      else this.prefix[index++] = 0;
    }
  }
  push(bytes: Uint8Array): boolean {
    for (const byte of bytes) if (this.pushByte(byte)) return true;
    return false;
  }
  pushByte(byte: number): boolean {
    while (this.matched > 0 && byte !== this.token[this.matched]) this.matched = this.prefix[this.matched - 1]!;
    if (byte === this.token[this.matched]) this.matched++;
    return this.matched === this.token.length;
  }
  hasPrefix(): boolean { return this.matched > 0; }
}

/** Detects one exact known ASCII bearer value in raw bytes or JSON string escapes.
 * This deliberately does not claim to recognize encoded or transformed secrets. */
export class CredentialEchoGuard {
  private readonly raw: RollingToken;
  private readonly decoded: RollingToken;
  private escape: number[] = [];
  constructor(secret: Buffer) { this.raw = new RollingToken(secret); this.decoded = new RollingToken(secret); }
  push(chunk: Uint8Array): boolean {
    if (this.raw.push(chunk)) return true;
    for (const byte of chunk) if (this.decode(byte)) return true;
    return false;
  }
  hasPartialPrefix(): boolean { return this.raw.hasPrefix() || this.decoded.hasPrefix(); }
  private decode(byte: number): boolean {
    if (this.escape.length === 0) {
      if (byte === 0x5c) { this.escape.push(byte); return false; }
      return this.decoded.pushByte(byte);
    }
    this.escape.push(byte);
    if (this.escape.length === 2 && byte !== 0x75) {
      const simple: Record<number, number> = { 0x22: 0x22, 0x2f: 0x2f, 0x5c: 0x5c, 0x62: 0x08, 0x66: 0x0c,
        0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09 };
      const output = simple[byte] === undefined ? Uint8Array.from(this.escape) : Uint8Array.of(simple[byte]);
      this.escape = []; return this.decoded.push(output);
    }
    if (this.escape[1] === 0x75 && this.escape.length < 6) return false;
    const pending = this.escape; this.escape = [];
    const hex = Buffer.from(pending.slice(2)).toString('ascii');
    const code = /^[0-9A-Fa-f]{4}$/.test(hex) ? Number.parseInt(hex, 16) : -1;
    return code >= 0 && code <= 0x7f ? this.decoded.pushByte(code) : this.decoded.push(Uint8Array.from(pending));
  }
}
