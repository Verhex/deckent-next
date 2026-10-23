import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

/**
 * S8-5 Ed25519 signer primitives (S8-DESIGN §8). Sources (read 2026-10-23): Node.js v24.22.1 and v26.12.1 `doc/api/crypto.md`
 * (https://nodejs.org/docs/latest-v24.x/api/crypto.md line 6632, https://nodejs.org/docs/latest-v26.x/api/crypto.md line 6655): "`algorithm` is
 * required to be `null` or `undefined` for Ed25519, Ed448, and ML-DSA"; DER input needs an explicit `type` (`'spki'`/`'pkcs8'`). The raw key formats
 * are Stability 1.1 on both majors, so keys are stored only as SPKI DER (public) and PKCS#8 DER (private). The fixed DER prefixes and lengths below
 * (OID 1.3.101.112) are versioned cryptographic invariants, never configuration.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'), PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** An Ed25519 key is 32 bytes (RFC 8032); its DER forms are the fixed prefix + the key; a signature is two key lengths. */
const KEY = 32;
export const ED25519_SPKI_BYTES = SPKI_PREFIX.length + KEY, ED25519_PKCS8_BYTES = PKCS8_PREFIX.length + KEY;
/** A Buffer view over the same memory (never a copy, so zeroing the caller's bytes zeroes it). */
const view = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const exact = (der: Uint8Array, prefix: Buffer, length: number) => der.byteLength === length && Buffer.from(der.buffer, der.byteOffset, prefix.length).equals(prefix);
/** One versioned domain-separation prefix for every Deckent signature: `deckent-sig/<label>\n` + canonical bytes (sign and verify both use it). */
export const signatureMessage = (label: string, canonical: string) => {
  if (!/^[a-z][a-z0-9-]*:[1-9][0-9]*$/.test(label)) throw new Error('SIGNATURE_LABEL_INVALID');
  return Buffer.from(`deckent-sig/${label}\n${canonical}`, 'utf8');
};
/** The key id of a public key: SHA-256 (hex) of its SPKI DER. */
export function ed25519KeyId(spki: Uint8Array): string {
  if (!exact(spki, SPKI_PREFIX, ED25519_SPKI_BYTES)) throw new Error('ED25519_KEY_INVALID');
  return createHash('sha256').update(spki).digest('hex');
}
/** True only for a valid Ed25519 signature of exactly `message` under `spki`; any malformed input is false, never an exception. */
export function verifyEd25519(spki: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try { return exact(spki, SPKI_PREFIX, ED25519_SPKI_BYTES) && signature.byteLength === 2 * KEY && verify(null, message, createPublicKey({ key: view(spki), format: 'der', type: 'spki' }), signature); }
  catch { return false; }
}
/** A fresh pair: the SPKI DER (public, recorded) and the PKCS#8 DER (private; the caller writes it to custody and zeroes it). */
export function generateEd25519Pair(): { readonly spki: Buffer; readonly pkcs8: Buffer } {
  const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  return { spki: pair.publicKey, pkcs8: pair.privateKey };
}
/** A signing handle over one PKCS#8 DER Ed25519 key: the key lives only in this closure's KeyObject (never exported); `spki` names it. */
export interface Ed25519Signer { readonly keyId: string; readonly spki: Buffer; sign(message: Uint8Array): Buffer }
export function ed25519Signer(pkcs8: Uint8Array): Ed25519Signer {
  if (!exact(pkcs8, PKCS8_PREFIX, ED25519_PKCS8_BYTES)) throw new Error('ED25519_KEY_INVALID');
  const key: KeyObject = createPrivateKey({ key: view(pkcs8), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ED25519_KEY_INVALID');
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return Object.freeze({ keyId: ed25519KeyId(spki), spki, sign: (message: Uint8Array) => sign(null, message, key) });
}
