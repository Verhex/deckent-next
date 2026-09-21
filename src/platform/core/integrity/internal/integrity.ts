import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface IntegrityAuthority {
  readonly keyId: string;
  sign(encoded: string): string;
  verify(encoded: string, mac: string, keyId: string): boolean;
}
export function sha256(encoded: string): string { return createHash('sha256').update(encoded).digest('hex'); }
export function constantTimeDigestEqual(left: string, right: string): boolean {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
/** Material is supplied by a trusted custody adapter, never configuration text or a client request. */
export function createHmacIntegrity(keyId: string, material: Uint8Array): IntegrityAuthority {
  if (!keyId.trim() || keyId.trim() !== keyId || material.byteLength !== 32) throw new Error('INTEGRITY_KEY_INVALID');
  const key = Buffer.from(material);
  const sign = (encoded: string) => createHmac('sha256', key).update(encoded).digest('hex');
  return Object.freeze({ keyId, sign, verify: (encoded: string, mac: string, claimedKeyId: string) =>
    claimedKeyId === keyId && constantTimeDigestEqual(sign(encoded), mac) });
}
