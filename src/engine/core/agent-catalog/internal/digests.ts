import { encodeCommandProjection, executionRegistrySchema, mergeWorkClassRegistries, CORE_WORK_CLASSES, SIGNATURE_LABELS, type SkillContent, type SkillRef, type WorkClassRegistry } from '#domain/index.js';
import { sha256, signatureMessage } from '#platform/index.js';

/** The pin of a skill revision: the canonical projection of its content (name and text). A publisher computes the same value. */
export const skillContentDigest = (content: SkillContent) => sha256(encodeCommandProjection('skill-content:1', content));
export const personaDigest = (persona: string) => sha256(encodeCommandProjection('agent-persona:1', persona));
/**
 * The content-addressed identity of an agent's skill set (metrics v2 `skillSetDigest`, S8 aggregation): the exact (id, revision, digest) refs,
 * ordered by skill id, so the same set always has the same digest and any change of a pin changes it. An empty set has a digest too.
 */
export const skillSetDigest = (refs: readonly SkillRef[]) => sha256(encodeCommandProjection('skill-set:1',
  [...refs].sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0).map(ref => ({ skillId: ref.skillId, revision: ref.revision, digest: ref.digest }))));
/** The exact bytes a skill signature covers: `deckent-sig/skill-signature:1\n` + the skill id and its content digest (never the mere presence of a signature). */
export const skillSignatureMessage = (input: { readonly skillId: string; readonly contentDigest: string }) => signatureMessage(SIGNATURE_LABELS.skill,
  encodeCommandProjection(SIGNATURE_LABELS.skill, { skillId: input.skillId, contentDigest: input.contentDigest }));
/** The fingerprint of one catalog command and its principal (receipt digest and `catalog-action:1` `contentDigest`); a carried signature is not part of it. */
export const catalogCommandDigest = (kind: 'agent' | 'skill', command: { readonly signed?: unknown }, principal: { readonly issuer: string; readonly subject: string }) => {
  // `undefined` fields are left out of the projection, so a person's unsigned command keeps its pre-S8-5 receipt digest.
  return sha256(encodeCommandProjection(`agent-catalog-${kind}:1`, { command: { ...command, signed: undefined }, principal: { issuer: principal.issuer, subject: principal.subject } }));
};
/** The WorkClass ids an agent may bind: the Core seed plus the installation registry's overlay (the same merge assignment uses). */
export const registeredWorkClassIds = (overlay: WorkClassRegistry | undefined): readonly string[] =>
  mergeWorkClassRegistries(CORE_WORK_CLASSES, overlay ? [overlay] : []).classes.map(row => row.id);
/** BeUser E-02: the same ids from an installation's raw `admission.registry` (absent or unreadable: the Core seed), for examples and refusals. */
export const configuredWorkClassIds = (registry: unknown): readonly string[] => {
  const parsed = executionRegistrySchema.safeParse(registry); return registeredWorkClassIds(parsed.success ? parsed.data.workClasses : undefined);
};
