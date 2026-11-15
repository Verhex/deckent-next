import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { projectAttachmentSchema, readableProjectAttachmentSchema, isNewAttachment, isNewerAttachmentVersion, type ReadableProjectAttachment as ProjectAttachment } from '#domain/index.js';
import { attachmentFailure } from '#engine/index.js';
import { withInstallationJournal } from '#adapters/core/installation-journal/index.js';
import { readInstallationFile } from '#adapters/core/installation-files/index.js';
import { digestText, serializeJsonDocument, prepareProductFile, productResourcePath, writeJsonAtomic, type ResolvedConfig } from '#platform/index.js';
/** One conditional metadata publication in the existing installer journal. A pending journal withholds every session. */
export async function relocateProjectAttachment(config: ResolvedConfig, before: ProjectAttachment, after: ProjectAttachment, settle: () => Promise<void>) {
  if (isNewerAttachmentVersion(before, 2) || isNewerAttachmentVersion(after, 2) || isNewAttachment(before) || isNewAttachment(after)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
  const path = productResourcePath(config.productLayout, 'projectAttachment'), content = serializeJsonDocument(projectAttachmentSchema.parse(after));
  return withInstallationJournal(config.projectRoot, { timeoutMs: config.installation.writeLockTimeoutMs }, async journal => {
    const retained = await readInstallationFile({ root: dirname(path), path, maxBytes: config.installation.profileMaxBytes });
    if (retained !== null) readReference(retained);
    let observed = await journal.observe();
    const recovery = { operation: 'project-attachment-relocate.v1', before, after };
    if (observed.record?.phase === 'pending') {
      if (!isDeepStrictEqual(observed.record.recovery, recovery)) return attachmentFailure('PROJECT_ATTACHMENT_INCOMPLETE');
    } else {
      const previous = await readInstallationFile({ root: dirname(path), path, maxBytes: config.installation.profileMaxBytes });
      if (previous === null || JSON.stringify(readReference(previous)) !== JSON.stringify(before)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      const now = Date.now(), planDigest = digestText(JSON.stringify(recovery));
      observed = await journal.write(observed, { schemaVersion: 2, transactionId: randomUUID(), planDigest, profileDigest: planDigest,
        phase: 'pending', createdAtMs: now, updatedAtMs: now, blockers: ['PROJECT_ATTACHMENT_INCOMPLETE'], recovery,
        resources: [{ resource: 'projectAttachment', path, preimageDigest: digestText(previous), targetDigest: digestText(content), state: 'pending' }] });
    }
    const current = await readInstallationFile({ root: dirname(path), path, maxBytes: config.installation.profileMaxBytes });
    const resource = observed.record!.resources[0]!;
    if (current === null || ![resource.preimageDigest, resource.targetDigest].includes(digestText(current))) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    if (digestText(current) !== resource.targetDigest) await writeJsonAtomic(await prepareProductFile(config.productLayout, 'projectAttachment'), after);
    const written = await readInstallationFile({ root: dirname(path), path, maxBytes: config.installation.profileMaxBytes });
    if (written === null || JSON.stringify(readReference(written)) !== JSON.stringify(after)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    await settle();
    const { checksum: ignored, ...record } = observed.record!; void ignored;
    await journal.write(observed, { ...record, phase: 'committed', updatedAtMs: Math.max(Date.now(), record.updatedAtMs), blockers: [],
      resources: record.resources.map(item => ({ ...item, state: 'published' })) });
    return { schemaVersion: 1, status: 'relocated', projectId: after.projectId };
  });
}

function readReference(text: string) {
  let value: unknown; try { value = JSON.parse(text); } catch { return attachmentFailure('PROJECT_ATTACHMENT_INVALID'); }
  if (isNewerAttachmentVersion(value, 2)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
  const parsed = readableProjectAttachmentSchema.safeParse(value);
  if (!parsed.success) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  if (isNewAttachment(parsed.data)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
  return parsed.data;
}
