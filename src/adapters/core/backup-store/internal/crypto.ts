import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { z } from 'zod';
import { refuse } from './files.js';
/** Recovery envelope v1: fixed KDF costs cannot be supplied by an untrusted set. 64 MiB scrypt, AES-256-GCM, fresh salt and nonce. */
const SCRYPT_MEMORY_CEILING = 100663296;
const envelope = z.object({ schemaVersion: z.literal(1), kdf: z.literal('scrypt'), cipher: z.literal('aes-256-gcm'),
  salt: z.string().regex(/^[0-9a-f]{32}$/), iv: z.string().regex(/^[0-9a-f]{24}$/), tag: z.string().regex(/^[0-9a-f]{32}$/),
  ciphertext: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, { N: 65536, r: 8, p: 1, maxmem: SCRYPT_MEMORY_CEILING },
    (error, key) => error ? reject(error) : resolve(key)));
}
export async function encryptKey(material: Buffer, passphrase: string, aad: string): Promise<string> {
  if (material.length !== 32) return refuse('BACKUP_KEY_INVALID');
  const salt = randomBytes(16), iv = randomBytes(12), key = await derive(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(material), cipher.final()]);
    return JSON.stringify({ schemaVersion: 1, kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('hex'), iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') });
  } finally { key.fill(0); }
}
export async function decryptKey(text: string, passphrase: string, aad: string): Promise<Buffer> {
  let value;
  try { value = envelope.parse(JSON.parse(text)); } catch { return refuse('BACKUP_SET_INVALID'); }
  const key = await derive(passphrase, Buffer.from(value.salt, 'hex'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'hex')), decipher.final()]);
  } catch { return refuse('BACKUP_PASSPHRASE_INVALID'); } finally { key.fill(0); }
}
