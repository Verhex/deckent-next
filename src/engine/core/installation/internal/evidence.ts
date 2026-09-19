import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema, immutableJsonObjectSchema } from '#domain/index.js';
import type { InstallationPreview } from './application.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const packageSchema = z.object({
  name: identitySchema, version: identitySchema, measurementDigest: hex,
  fileCount: z.number().int().positive().safe(), totalBytes: z.number().int().nonnegative().safe(),
  missingDeclarations: z.array(z.string().min(1).max(4096)).max(256).readonly(),
  source: z.literal('installed-bytes'), dependencyCoverage: z.literal('excluded'),
}).strict().readonly();
const imageSchema = z.object({
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), endpoint: z.string().min(1).max(4096),
  daemonId: identitySchema, status: z.literal('locally-available'),
}).strict().readonly();
const previewEvidenceSchema = z.object({ schemaVersion: z.literal(1), status: z.literal('preview'), planDigest: hex,
  images: z.array(z.object({ profileId: identitySchema, version: z.number().int().positive().safe(),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()),
  blockers: z.tuple([z.literal('INSTALL_PACKAGE_TRUST_UNVERIFIED'), z.literal('INSTALL_IMAGE_PROVENANCE_UNVERIFIED'),
    z.literal('INSTALL_IMAGE_AVAILABILITY_UNCHECKED')]),
}).passthrough();
export type InstallationPackageEvidence = z.infer<typeof packageSchema>;
export type InstallationImageEvidence = z.infer<typeof imageSchema>;
export class InstallationEvidenceError extends Error {
  constructor(readonly code: 'INSTALLATION_EVIDENCE_INVALID' | 'INSTALLATION_EVIDENCE_IMAGES' | 'INSTALLATION_EVIDENCE_CHANGED') {
    super(code); this.name = 'InstallationEvidenceError';
  }
}

/** Observation identity only: neither operator consent nor publisher verification.
 * Composition supplies a fresh profile preview and measurements from installed adapters.
 * Future apply must compare this displayed proposal digest after fresh measurements, not
 * reuse the profile plan digest while silently accepting different package bytes or daemons.
 */
export function createInstallationEvidencePreview(preview: InstallationPreview,
  suppliedPackage: InstallationPackageEvidence, suppliedImages: readonly InstallationImageEvidence[]) {
  const safe = immutableJsonObjectSchema.safeParse({ preview, package: suppliedPackage, images: suppliedImages });
  if (!safe.success) throw new InstallationEvidenceError('INSTALLATION_EVIDENCE_INVALID');
  const copied = safe.data['preview'] as unknown as InstallationPreview;
  const parsedPackage = packageSchema.safeParse(safe.data['package']);
  const parsedImages = z.array(imageSchema).safeParse(safe.data['images']);
  if (!previewEvidenceSchema.safeParse(copied).success || !parsedPackage.success || !parsedImages.success) {
    throw new InstallationEvidenceError('INSTALLATION_EVIDENCE_INVALID');
  }
  const expected = new Set(copied.images.map(image => image.imageId));
  const measured = new Set(parsedImages.data.map(image => image.imageId));
  if (expected.size === 0 || measured.size !== parsedImages.data.length || expected.size !== measured.size
    || [...expected].some(image => !measured.has(image))) throw new InstallationEvidenceError('INSTALLATION_EVIDENCE_IMAGES');
  if (new Set(parsedImages.data.map(image => JSON.stringify([image.endpoint, image.daemonId]))).size !== 1) {
    throw new InstallationEvidenceError('INSTALLATION_EVIDENCE_IMAGES');
  }
  const images = parsedImages.data.slice().sort((a, b) => a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0);
  const payload = immutableJsonObjectSchema.parse({ schemaVersion: 1, profilePlanDigest: copied.planDigest,
    package: parsedPackage.data, images });
  const proposalDigest = createHash('sha256').update(`deckent.installation-evidence.v1\n${JSON.stringify(payload)}`, 'utf8').digest('hex');
  return Object.freeze({ schemaVersion: 1 as const, status: 'evidence-preview' as const, proposalDigest,
    preview: Object.freeze({ ...copied, blockers: Object.freeze(copied.blockers.filter(code => code !== 'INSTALL_IMAGE_AVAILABILITY_UNCHECKED')) }),
    package: parsedPackage.data, images: Object.freeze(images),
    operatorApproval: 'not-recorded' as const, publisherVerification: 'unverified' as const });
}
export type InstallationEvidencePreview = ReturnType<typeof createInstallationEvidencePreview>;

export interface InstallationEvidencePorts {
  preview(): Promise<InstallationPreview>;
  measurePackage(): Promise<InstallationPackageEvidence>;
  inspectImage(imageId: string): Promise<InstallationImageEvidence>;
}
export class InstallationEvidenceApplication {
  constructor(private readonly ports: InstallationEvidencePorts) {}
  async inspect(): Promise<InstallationEvidencePreview> {
    const preview = await this.ports.preview();
    const before = await this.ports.measurePackage();
    const images: InstallationImageEvidence[] = [];
    for (const imageId of [...new Set(preview.images.map(image => image.imageId))]) {
      images.push(await this.ports.inspectImage(imageId));
    }
    const after = await this.ports.measurePackage();
    if (before.measurementDigest !== after.measurementDigest) throw new InstallationEvidenceError('INSTALLATION_EVIDENCE_CHANGED');
    return createInstallationEvidencePreview(preview, after, images);
  }
}
