import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ErrorRegistry, sha256, uninstallHoldPath, PRIVATE_PERMISSION_MASK, removeEmptyPinnedDirectory, type IntegrityAuthority } from '#platform/index.js';
import type { UninstallPlan, UninstallResult } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
const fail = (): never => { throw ErrorRegistry.createError('UNINSTALL_RECOVERY_INVALID'); };
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** Immutable authenticated plan and append-only outcome companion. Generic effect states stay exclusively in FileEffectStore. */
export class UninstallRecovery {
  readonly directory: string;
  private readonly hold: string;
  constructor(private readonly root: string, private readonly installationId: string, private readonly principal: VerifiedPrincipal,
    private readonly integrity: IntegrityAuthority, private readonly maxBytes: number, externalDirectory?: string, private readonly custody?: { readonly path: string; remove(): void }) {
    this.directory = externalDirectory ?? join(root, 'uninstall-recovery'); this.hold = uninstallHoldPath(root);
  }
  private async safeDirectory(path: string) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & PRIVATE_PERMISSION_MASK) || await realpath(path) !== path) fail();
  }
  private async read(path: string): Promise<unknown | null> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (absent(error)) return null; throw error; });
    if (!file) return null;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & PRIVATE_PERMISSION_MASK) || info.size > this.maxBytes) fail();
      const bytes = Buffer.alloc(info.size + 1), read = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
      if (read.bytesRead !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.size !== info.size) fail();
      const sealed = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')) as { body: unknown; keyId: string; mac: string };
      if (!this.integrity.verify(JSON.stringify(sealed.body), sealed.mac, sealed.keyId)) fail();
      return sealed.body;
    } finally { await file.close(); }
  }
  private async publish(path: string, body: unknown) {
    await this.safeDirectory(dirname(path));
    const encoded = JSON.stringify({ body, keyId: this.integrity.keyId, mac: this.integrity.sign(JSON.stringify(body)) });
    if (Buffer.byteLength(encoded) > this.maxBytes) fail();
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private actor() { return { issuer: this.principal.issuer, subject: this.principal.subject }; }
  async retained(digest: string): Promise<UninstallPlan | null> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) return fail();
    if (!await lstat(this.directory).catch(error => { if (absent(error)) return null; throw error; })) return null;
    await this.safeDirectory(this.directory);
    const body = await this.read(join(this.directory, `${digest}.json`)) as { schemaVersion: number; installationId: string; actor: unknown; plan: UninstallPlan } | null;
    if (!body) return null;
    const { planDigest, ...planBody } = body.plan;
    if (body.schemaVersion !== 1 || body.installationId !== this.installationId || body.plan.installation.id !== this.installationId
      || body.plan.installation.root !== this.root || JSON.stringify(body.actor) !== JSON.stringify(this.actor())
      || planDigest !== digest || sha256(JSON.stringify(planBody)) !== digest) fail();
    return body.plan;
  }
  async admit(plan: UninstallPlan) {
    await this.safeDirectory(this.root);
    if (dirname(this.directory) !== this.root) { await mkdir(dirname(this.directory), { mode: 0o700, recursive: true }); await this.safeDirectory(dirname(this.directory)); }
    await mkdir(this.directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await this.safeDirectory(this.directory);
    const retained = await this.retained(plan.planDigest);
    if (retained && JSON.stringify(retained) !== JSON.stringify(plan)) fail();
    if (!retained) await this.publish(join(this.directory, `${plan.planDigest}.json`), {
      schemaVersion: 1, installationId: this.installationId, actor: this.actor(), plan,
    });
    const hold = await this.read(this.hold);
    const expected = { schemaVersion: 1, installationId: this.installationId, actor: this.actor(), planDigest: plan.planDigest };
    if (hold && JSON.stringify(hold) !== JSON.stringify(expected)) fail();
    if (!hold) await this.publish(this.hold, expected);
    return join(this.directory, plan.planDigest);
  }
  async finish(result: UninstallResult) {
    // Exclusive ledger custody is held by the application. Each outcome is immutable, including cancelled/unknown/partial.
    const body = { schemaVersion: 1, installationId: this.installationId, actor: this.actor(), result };
    const path = join(this.directory, `${result.planDigest}.${sha256(JSON.stringify(body))}.result.json`);
    if (!await this.read(path)) await this.publish(path, body);
    if (result.status === 'completed' || result.status === 'noop' || result.status === 'cancelled' && result.items.every(item => item.state === null || item.state === 'refused')) {
      const hold = await this.read(this.hold) as { planDigest?: string } | null;
      if (hold?.planDigest !== result.planDigest) fail();
      await unlink(this.hold);
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
      // B4: a completed project-folder deletion removes only its own custody file (the exact lock it holds, by identity); every other file
      // stays, and each folder goes only when empty, the installation's own last.
      if (result.status === 'completed' && this.custody) {
        this.custody.remove();
        for (const folder of [dirname(this.custody.path), this.root]) await removeEmptyPinnedDirectory(folder);
      }
    }
  }
}
