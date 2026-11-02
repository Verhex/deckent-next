import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, parse, join, relative, sep } from 'node:path';
import { installationRegistrationSchema, projectAttachmentSchema, type InstallationRegistration, type ProjectAttachment, type AttachmentLocation } from '#domain/index.js';
import { attachmentFailure } from '#engine/index.js';
import { readInstallationFile } from '#adapters/core/installation-files/index.js';
import { inspectProductFile, prepareProductFile, prepareProductCompanionPath, productResourcePath, resolveGlobalConfigPaths, resolveProductLayout,
  serializeJsonDocument, withConfigWriteLock, writeJsonAtomic, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';

const heldRegistries = new AsyncLocalStorage<ReadonlySet<string>>();
/** No-follow ancestry, local owner and location evidence; reads create neither locks nor directories. */
export async function captureAttachmentLocation(root: string): Promise<AttachmentLocation> {
  if (process.platform === 'win32' || !process.getuid) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== resolve(root) || canonicalRoot === parse(canonicalRoot).root) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  let cursor = parse(canonicalRoot).root;
  for (const segment of relative(cursor, canonicalRoot).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment); const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  }
  const info = await lstat(canonicalRoot, { bigint: true });
  if (info.uid !== BigInt(process.getuid()) || (info.mode & 0o022n) !== 0n || info.ino === 0n) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
  return { canonicalRoot, device: String(info.dev), inode: String(info.ino) };
}
export class FileProjectAttachmentStore {
  constructor(readonly layout: ProductLayout, readonly options: ConfigLoadOptions, readonly maxBytes: number, readonly timeoutMs: number) {}
  get global(): ProductLayout {
    const options = this.options, config = resolveGlobalConfigPaths(options.env, options.platform).platformPath;
    return resolveProductLayout({ projectRoot: dirname(config), root: dirname(config), bootstrapConfigPath: config });
  }
  private async read(layout: ProductLayout, resource: 'installationRegistration' | 'projectAttachment') {
    const path = productResourcePath(layout, resource);
    return readInstallationFile({ root: resource === 'projectAttachment' ? dirname(path) : layout.root, path, maxBytes: this.maxBytes });
  }
  async registration(): Promise<InstallationRegistration | null> {
    if (process.platform === 'win32' || this.layout.platform === 'win32') return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
    const bytes = await this.read(this.global, 'installationRegistration');
    if (bytes === null) return null;
    let value: unknown; try { value = JSON.parse(bytes); } catch { return attachmentFailure('PROJECT_ATTACHMENT_INVALID'); }
    const parsed = installationRegistrationSchema.safeParse(value);
    return parsed.success ? parsed.data : attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  }
  async attachment(): Promise<ProjectAttachment | null> {
    if (process.platform === 'win32' || this.layout.platform === 'win32') return null;
    const present = await lstat(productResourcePath(this.layout, 'projectAttachment')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!present) return null;
    const bytes = await this.read(this.layout, 'projectAttachment');
    if (bytes === null) return null;
    let value: unknown; try { value = JSON.parse(bytes); } catch { return attachmentFailure('PROJECT_ATTACHMENT_INVALID'); }
    const parsed = projectAttachmentSchema.safeParse(value);
    return parsed.success ? parsed.data : attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  }
  /** Caller holds this one lock across inventory reservation, the local installer journal and settlement. */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    const key = productResourcePath(this.global, 'installationRegistration'), held = heldRegistries.getStore();
    if (held?.has(key)) return work();
    await prepareProductCompanionPath(this.global, 'installationRegistration', '-lock');
    return withConfigWriteLock(key, () => heldRegistries.run(new Set([...(held ?? []), key]), work), this.timeoutMs);
  }
  async write(expected: InstallationRegistration | null, next: InstallationRegistration): Promise<void> {
    if (JSON.stringify(await this.registration()) !== JSON.stringify(expected)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    const value = installationRegistrationSchema.parse(next);
    if (Buffer.byteLength(serializeJsonDocument(value)) > this.maxBytes) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    const path = await prepareProductFile(this.global, 'installationRegistration');
    await writeJsonAtomic(path, value);
    await inspectProductFile(this.global, 'installationRegistration');
  }
}
