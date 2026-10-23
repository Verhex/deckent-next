import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSignerRevocationLog, localSignerKeyCustody } from '#adapters/index.js';
import { catalogActionBytes, SIGNATURE_LABELS, type CatalogAction } from '#domain/index.js';
import { createHmacIntegrity, ed25519KeyId, productResourcePath, resolveProductLayout, signatureMessage } from '#platform/index.js';

// S8-5 host custody and the revocation log (S8-DESIGN §8; N39, N45): one PKCS#8 DER Ed25519 key per `signers/<keyId>.p8` under the local-key
// rules; it signs only `catalog-action:1`; the HMAC-chained, append-only `signers/revocations.log` refuses any altered, removed or reordered line.
beforeEach(context => { if (process.platform === 'win32') context.skip('POSIX key custody'); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'dn-signer-custody-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data');
  await Promise.all([mkdir(project, { mode: 0o700 }), mkdir(data, { mode: 0o700 })]);
  return resolveProductLayout({ projectRoot: project, root: data });
}
const action = (commandId = 'c1'): CatalogAction => ({ scopeId: 's', action: 'define', target: { kind: 'skill', id: 'k', revision: 1 }, expectedRevision: null, contentDigest: 'a'.repeat(64),
  toStanding: null, suggestionId: null, commandId, principal: { issuer: 'local-os/mcp', subject: 'uid:1000' } });

describe('host key custody', () => {
  it('creates one 0600, single-linked, 48-byte PKCS#8 file named by the key id; signs exactly the catalog-action:1 bytes; returns only the public key', async () => {
    const product = await layout(), custody = localSignerKeyCustody(product);
    const made = await custody.create(), spki = Buffer.from(made.publicKey, 'base64'), file = join(productResourcePath(product, 'signers'), `${made.keyId}.p8`);
    expect(made.keyId).toBe(ed25519KeyId(spki)); expect(Object.keys(made).sort()).toEqual(['keyId', 'publicKey']);
    const info = await lstat(file), der = await readFile(file);
    expect([info.mode & 0o777, info.nlink, der.byteLength, der.subarray(0, 16).toString('hex')]).toEqual([0o600, 1, 48, '302e020100300506032b657004220420']);
    expect((await lstat(productResourcePath(product, 'signers'))).mode & 0o777).toBe(0o700);
    const signature = Buffer.from(await custody.signAction(made.keyId, action()), 'base64');
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(verify(null, signatureMessage(SIGNATURE_LABELS.catalogAction, catalogActionBytes(action())), key, signature)).toBe(true);
    expect(verify(null, signatureMessage(SIGNATURE_LABELS.skill, catalogActionBytes(action())), key, signature)).toBe(false);
  });
  it('negative: a missing key, a file holding another key, a widened mode, a symlink or a malformed id cannot sign (SIGNER_KEY_UNAVAILABLE)', async () => {
    const product = await layout(), custody = localSignerKeyCustody(product), dir = productResourcePath(product, 'signers');
    const first = await custody.create(), second = await custody.create();
    await expect(custody.signAction('f'.repeat(64), action())).rejects.toMatchObject({ code: 'SIGNER_KEY_UNAVAILABLE' });
    await expect(custody.signAction('../x', action())).rejects.toMatchObject({ code: 'SIGNER_KEY_UNAVAILABLE' });
    // The second key's file under the first key's name: the file's key is not the row's key.
    await rename(join(dir, `${first.keyId}.p8`), join(dir, 'kept.p8')); await rename(join(dir, `${second.keyId}.p8`), join(dir, `${first.keyId}.p8`));
    await expect(custody.signAction(first.keyId, action())).rejects.toMatchObject({ code: 'SIGNER_KEY_UNAVAILABLE' });
    await rename(join(dir, `${first.keyId}.p8`), join(dir, `${second.keyId}.p8`)); await rename(join(dir, 'kept.p8'), join(dir, `${first.keyId}.p8`));
    await chmod(join(dir, `${first.keyId}.p8`), 0o644);
    await expect(custody.signAction(first.keyId, action())).rejects.toMatchObject({ code: 'SIGNER_KEY_UNAVAILABLE' });
    await rm(join(dir, `${second.keyId}.p8`)); await symlink(join(dir, `${first.keyId}.p8`), join(dir, `${second.keyId}.p8`));
    await expect(custody.signAction(second.keyId, action())).rejects.toMatchObject({ code: 'SIGNER_KEY_UNAVAILABLE' });
  });
});

describe('revocation log', () => {
  const integrity = createHmacIntegrity('installation-key', randomBytes(32));
  const entry = (keyId: string, scopeId = 's') => ({ scopeId, keyId, by: { issuer: 'local-os', subject: 'uid:1000' }, atMs: 1, commandId: `r-${keyId.slice(0, 4)}` });
  const k = (c: string) => c.repeat(64);
  it('appends a chained line per revocation; absent means none; a torn final line is no record and the next append closes it', async () => {
    const product = await layout(), log = new FileSignerRevocationLog(product, async () => integrity);
    expect(await log.list()).toEqual([]);
    await log.append(entry(k('a'))); await log.append(entry(k('b')));
    expect((await log.list()).map(row => row.keyId)).toEqual([k('a'), k('b')]);
    const path = join(productResourcePath(product, 'signers'), 'revocations.log');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, '{"entry":', { flag: 'a' });
    expect((await log.list()).length).toBe(2);
    await log.append(entry(k('c')));
    expect((await log.list()).map(row => row.keyId)).toEqual([k('a'), k('b'), k('c')]);
  });
  it('negative: an altered, removed or reordered line, or another integrity key, breaks the chain; repair keeps the broken file and only adds', async () => {
    const product = await layout(), log = new FileSignerRevocationLog(product, async () => integrity);
    for (const c of ['a', 'b', 'c']) await log.append(entry(k(c)));
    const path = join(productResourcePath(product, 'signers'), 'revocations.log'), lines = (await readFile(path, 'utf8')).trim().split('\n');
    for (const broken of [[lines[0], lines[2]], [lines[1], lines[0], lines[2]], [lines[0], lines[1]!.replace(k('b'), k('d')), lines[2]]]) {
      await writeFile(path, `${broken.join('\n')}\n`);
      await expect(log.list()).rejects.toMatchObject({ code: 'SIGNER_REVOCATION_LOG_BROKEN' });
      await expect(log.append(entry(k('e')))).rejects.toMatchObject({ code: 'SIGNER_REVOCATION_LOG_BROKEN' });
    }
    await writeFile(path, `${lines.join('\n')}\n`);
    await expect(new FileSignerRevocationLog(product, async () => createHmacIntegrity('installation-key', randomBytes(32))).list()).rejects.toMatchObject({ code: 'SIGNER_REVOCATION_LOG_BROKEN' });
    await writeFile(path, `${[lines[0], lines[2]].join('\n')}\n`);
    const repaired = await log.repair([entry(k('f'))]);
    expect(repaired.map(row => row.keyId)).toEqual([k('a'), k('c'), k('f')]);
    expect((await log.list()).map(row => row.keyId)).toEqual([k('a'), k('c'), k('f')]);
    expect((await readdir(productResourcePath(product, 'signers'))).filter(name => name.startsWith('revocations.log.broken-'))).toHaveLength(1);
  });
  it('N39: the log and the key files hold no private key text in any encoding readable from the log', async () => {
    const product = await layout(), custody = localSignerKeyCustody(product), made = await custody.create();
    const log = new FileSignerRevocationLog(product, async () => integrity);
    await log.append(entry(made.keyId));
    const der = await readFile(join(productResourcePath(product, 'signers'), `${made.keyId}.p8`)), text = await readFile(join(productResourcePath(product, 'signers'), 'revocations.log'), 'utf8');
    for (const secret of [der.toString('base64'), der.toString('hex'), der.subarray(16).toString('base64'), der.subarray(16).toString('hex')]) expect(text).not.toContain(secret);
  });
});
