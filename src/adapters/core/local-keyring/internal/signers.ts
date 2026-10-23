import { constants } from 'node:fs';
import { open, rename, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { catalogActionBytes, encodeCommandProjection, identitySchema, SIGNATURE_LABELS } from '#domain/index.js';
import { AgentCatalogStoreError, type SignerKeyCustody, type SignerRevocation, type SignerRevocationLog } from '#engine/index.js';
import { ED25519_PKCS8_BYTES, ed25519KeyId, ed25519Signer, generateEd25519Pair, inspectProductDirectory, prepareProductDirectory, signatureMessage, withConfigWriteLock,
  type IntegrityAuthority, type ProductLayout } from '#platform/index.js';
import { withPrivateKeyFile } from './keyring.js';
import limits from './signer-limits.json' with { type: 'json' };

const unavailable = () => new AgentCatalogStoreError('SIGNER_KEY_UNAVAILABLE'), broken = () => new AgentCatalogStoreError('SIGNER_REVOCATION_LOG_BROKEN');
const shape = (generate: () => Buffer) => ({ length: ED25519_PKCS8_BYTES, generate });
/**
 * S8-5 host custody (S8-DESIGN §8): one `<keyId>.p8` file per enrolled key in the product's own `signers` resource — outside every backup
 * resource and worker mount — holding exactly the PKCS#8 DER of one Ed25519 key under the local-key rules (0600, this user, one link, no link
 * followed, fixed length). The key is read into one KeyObject per signature and the read buffer zeroed; it is never returned, printed or logged,
 * and signs only `catalog-action:1` bytes. After a restore or on a new host the file is absent: the principal cannot sign until a person re-enrols.
 */
export function localSignerKeyCustody(layout: ProductLayout): SignerKeyCustody {
  return Object.freeze({
    async create() {
      const pair = generateEd25519Pair();
      try {
        const keyId = ed25519KeyId(pair.spki), directory = await prepareProductDirectory(layout, 'signers');
        await withPrivateKeyFile(directory, `${keyId}.p8`, true, () => undefined, shape(() => pair.pkcs8));
        return { keyId, publicKey: pair.spki.toString('base64') };
      } catch { throw unavailable(); } finally { pair.pkcs8.fill(0); }
    },
    async signAction(keyId: string, action: Parameters<SignerKeyCustody['signAction']>[1]) {
      if (!/^[a-f0-9]{64}$/.test(keyId)) throw unavailable();
      const message = signatureMessage(SIGNATURE_LABELS.catalogAction, catalogActionBytes(action));
      try {
        return await withPrivateKeyFile(await inspectProductDirectory(layout, 'signers'), `${keyId}.p8`, false, material => {
          const signer = ed25519Signer(material);
          if (signer.keyId !== keyId) throw new Error('key');
          return signer.sign(message).toString('base64');
        }, shape(() => { throw new Error('read-only'); }));
      } catch { throw unavailable(); }
    },
  });
}

const entrySchema = z.object({ scopeId: identitySchema, keyId: z.string().regex(/^[a-f0-9]{64}$/), by: z.object({ issuer: identitySchema, subject: identitySchema }).strict(),
  atMs: z.number().int().nonnegative().safe(), commandId: identitySchema }).strict();
const lineSchema = z.object({ entry: z.unknown(), prev: z.string().regex(/^[a-f0-9]{64}$/), keyId: z.string().min(1), mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const GENESIS = '0'.repeat(64), SEAL = 'signer-revocations:1';
/**
 * S8-5 revocation log `signers/revocations.log`: append-only JSONL, each line sealed with the installation integrity key over (entry, MAC of the
 * previous line), so a removed, reordered or altered line breaks the chain. It lives beside the ledger and is never backed up or restored over: a
 * restore can only add revocations. A torn final line (an append that never returned) is not a record and is closed by the next append. A broken
 * chain refuses `list` and `append` (all AI/system signing stops) until a person's `repair` keeps the broken file aside and starts a new chain.
 */
export class FileSignerRevocationLog implements SignerRevocationLog {
  constructor(private readonly layout: ProductLayout, private readonly integrity: () => Promise<IntegrityAuthority>) {}
  private async path(create: boolean) {
    try { return join(create ? await prepareProductDirectory(this.layout, 'signers') : await inspectProductDirectory(this.layout, 'signers'), limits.revocationLogFile); }
    catch (error) { if (!create && (error as { code?: string }).code === 'MANAGED_FILE_MISSING') return null; throw unavailable(); }
  }
  private async read(path: string, lenient = false): Promise<{ entries: SignerRevocation[]; last: string; torn: boolean }> {
    let handle: FileHandle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], last: GENESIS, torn: false }; throw broken(); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limits.revocationLogMaxBytes) throw broken();
      const text = (await handle.readFile()).toString('utf8'), torn = text !== '' && !text.endsWith('\n'), entries: SignerRevocation[] = [];
      const integrity = text ? await this.integrity() : null;
      let last = GENESIS;
      for (const line of (torn ? text.split('\n').slice(0, -1) : text.split('\n')).filter(Boolean)) {
        try {
          const row = lineSchema.parse(JSON.parse(line)), entry = entrySchema.parse(row.entry);
          if (!lenient && (row.prev !== last || !integrity!.verify(encodeCommandProjection(SEAL, { entry, prev: row.prev }), row.mac, row.keyId))) throw broken();
          entries.push(entry); last = row.mac;
        } catch (error) { if (!lenient) throw broken(); void error; }
      }
      if (entries.length > limits.revocationLogMaxEntries) throw broken();
      return { entries, last, torn };
    } finally { await handle.close(); }
  }
  private async write(path: string, lines: readonly SignerRevocation[], prev: string, flags: number, prefix = '') {
    const integrity = await this.integrity();
    let text = prefix;
    for (const entry of lines) {
      const mac = integrity.sign(encodeCommandProjection(SEAL, { entry, prev }));
      text += `${JSON.stringify({ entry, prev, keyId: integrity.keyId, mac })}\n`; prev = mac;
    }
    const handle = await open(path, flags | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { if ((await handle.stat()).size + Buffer.byteLength(text) > limits.revocationLogMaxBytes) throw unavailable(); await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
  }
  async list() { const path = await this.path(false); return path ? Object.freeze((await this.read(path)).entries) : []; }
  async append(input: SignerRevocation) {
    const entry = entrySchema.parse(input), path = (await this.path(true))!;
    await withConfigWriteLock(path, async () => {
      const current = await this.read(path);
      if (current.entries.length >= limits.revocationLogMaxEntries) throw unavailable();
      await this.write(path, [entry], current.last, constants.O_APPEND, current.torn ? '\n' : '');
    }, limits.lockTimeoutMs, { onWarning() { /* the revoke card prints its own outcome */ } });
  }
  async repair(add: readonly SignerRevocation[]) {
    const path = (await this.path(true))!;
    return withConfigWriteLock(path, async () => {
      const kept = (await this.read(path, true)).entries, all: SignerRevocation[] = [];
      for (const entry of [...kept, ...add.map(row => entrySchema.parse(row))]) if (!all.some(row => row.scopeId === entry.scopeId && row.keyId === entry.keyId)) all.push(entry);
      if (all.length > limits.revocationLogMaxEntries) throw unavailable();
      await rename(path, `${path}.broken-${Date.now()}`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await this.write(path, all, GENESIS, constants.O_EXCL);
      return Object.freeze(all);
    }, limits.lockTimeoutMs, { onWarning() { /* the repair card prints its own outcome */ } });
  }
}
