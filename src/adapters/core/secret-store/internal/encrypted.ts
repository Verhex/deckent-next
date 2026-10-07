import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DeckentError, serializeJsonDocument } from '#platform/index.js';
import type { SecretStore, SecretStoreContext, SecretStoreErrorCode, SecretStoreFactory } from '#engine/index.js';
import { withPrivateKeyFile } from '#adapters/core/local-keyring/index.js';
import { FILE_SECRET_STORE_MAX_BYTES, createFileSecretStore, type FileSecretStoreOptions, type SecretDocumentCodec } from './file.js';

export const ENCRYPTED_FILE_SECRET_STORE_ID = 'core.secret-store.encrypted-file@1';
export const ENCRYPTED_FILE_SECRET_STORE_NAME = 'secrets.sealed.json';
export const ENCRYPTED_FILE_SECRET_STORE_KEY = 'secrets.key';
const ALGORITHM = 'aes-256-gcm';
/** AES-GCM nonce and tag lengths: versioned cryptographic invariants of envelope v1, not operational limits. */
const IV_LENGTH = 12, TAG_LENGTH = 16;
/** Authenticated data: the envelope cannot be replayed under another backend or envelope version. */
const AAD = Buffer.from(`deckent:${ENCRYPTED_FILE_SECRET_STORE_ID}:envelope-v1`, 'utf8');
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** Envelope v1: one AES-256-GCM sealing of the whole store document v1 (the plaintext backend's document), fresh IV per write. */
const envelopeSchema = z.object({ schemaVersion: z.literal(1), algorithm: z.literal(ALGORITHM), iv: base64, tag: base64, ciphertext: base64 }).strict();
/** Room for the envelope's fixed fields (names, algorithm, IV, tag) around the ciphertext. */
const ENVELOPE_FIELDS_LENGTH = 512;
/** The envelope length of a document: base64 of the ciphertext (same length as the document under GCM) plus the fixed fields. */
function envelopeLength(documentLength: number): number { return Math.ceil(documentLength / 3) * 4 + ENVELOPE_FIELDS_LENGTH; }
/** The reader's file bound follows from the document bound: no separate limit to tune. */
const MAX_FILE_BYTES = envelopeLength(FILE_SECRET_STORE_MAX_BYTES);

/** Types a key-file failure: a custody breach is unsafe, an absent key beside an existing store is unreadable, anything else unavailable. */
function keyFailure(error: unknown, fail: (code: SecretStoreErrorCode) => DeckentError): DeckentError {
  const code = (error as NodeJS.ErrnoException | null)?.code, message = (error as Error | null)?.message;
  if (code === 'ELOOP' || message === 'custody' || message === 'size') return fail('SECRET_STORE_UNSAFE');
  if (code === 'ENOENT') return fail('SECRET_STORE_CORRUPT');
  return fail('SECRET_STORE_UNAVAILABLE');
}

function sealedCodec(root: string, fail: (code: SecretStoreErrorCode) => DeckentError): SecretDocumentCodec {
  const withKey = async <T>(create: boolean, use: (key: Buffer) => T): Promise<T> => {
    try { return await withPrivateKeyFile(root, ENCRYPTED_FILE_SECRET_STORE_KEY, create, use); }
    catch (error) { throw error instanceof DeckentError ? error : keyFailure(error, fail); }
  };
  return Object.freeze({
    maxFileBytes: MAX_FILE_BYTES,
    async decode(fileText: string) {
      // A parse message can quote the text; the caller types any non-Deckent refusal as corrupt without a cause.
      const envelope = envelopeSchema.parse(JSON.parse(fileText));
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.byteLength !== IV_LENGTH || tag.byteLength !== TAG_LENGTH) throw fail('SECRET_STORE_CORRUPT');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      // Without `create`: an existing store never gets a new key, so a lost or replaced key is a typed refusal, not silent re-keying.
      return withKey(false, key => {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
        decipher.setAAD(AAD); decipher.setAuthTag(tag);
        // A wrong key or any changed byte fails the tag check here: nothing of the plaintext is returned, and the refusal is typed inside
        // the key's use so it is not mistaken for a key-file failure.
        try { return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'); } catch { throw fail('SECRET_STORE_CORRUPT'); }
      });
    },
    async encode(documentText: string) {
      // Reached only after the store read back cleanly under the write lock: an absent key here means there was no sealed document yet.
      const iv = randomBytes(IV_LENGTH);
      const sealed = await withKey(true, key => {
        const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
        cipher.setAAD(AAD);
        const ciphertext = Buffer.concat([cipher.update(documentText, 'utf8'), cipher.final()]);
        return { ciphertext, tag: cipher.getAuthTag() };
      });
      return serializeJsonDocument({ schemaVersion: 1, algorithm: ALGORITHM, iv: iv.toString('base64'), tag: sealed.tag.toString('base64'),
        ciphertext: sealed.ciphertext.toString('base64') });
    },
  });
}

/**
 * `core.secret-store.encrypted-file@1` (SECRET-AT-REST, owner 2026-10-08): the file backend's custody and document v1, sealed at rest with
 * AES-256-GCM in `<global root>/secrets.sealed.json` under a 256-bit key in `<global root>/secrets.key` (local-key custody: 0600, owner, one
 * link, no symlink, created exclusively on the first write). It opens without a passphrase. What it protects: a copied, synced, grepped,
 * printed or git-added store file reveals no value. What it does not: a process of the same user that reads both files, or a backup of the
 * whole root — the key sits beside the store until the OS keyring (K2) wraps it. Workers never see either file (sandbox and read floors).
 * A missing key beside an existing store, a wrong key or any changed byte is `SECRET_STORE_CORRUPT`; nothing is re-keyed or repaired.
 */
export function createEncryptedFileSecretStore(options: FileSecretStoreOptions): SecretStore {
  return createFileSecretStore(options, { id: ENCRYPTED_FILE_SECRET_STORE_ID, fileName: ENCRYPTED_FILE_SECRET_STORE_NAME, codec: sealedCodec });
}
export const encryptedFileSecretStoreFactory: SecretStoreFactory = Object.freeze({ id: ENCRYPTED_FILE_SECRET_STORE_ID,
  create: (context: SecretStoreContext) => createEncryptedFileSecretStore({ root: context.root, platform: context.platform }) });
