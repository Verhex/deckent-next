import { expect, it } from 'vitest';
import { HUB_LIMITS, HUB_TRUST_POLICIES, HUB_REVIEW_LEVELS, HUB_PACKAGE_FIELDS, HUB_FILE_TYPES, canonicalHubJson, hubLimitsSchema,
  hubTrustPoliciesSchema, hubReviewLevelsSchema, hubPackageFieldsSchema, hubFileTypesSchema, hubFilePathSchema, hubFilesSchema,
  readableSkillDefinitionSchema, hubSkillDefinitionSchema, requireBoundedHubJson } from '#domain/core/hub/index.js';
import { defineSkillRevision } from '#domain/core/agent-catalog/index.js';

const file = { path: 'SKILL.md', mediaType: 'text/markdown', size: 3, digest: 'a'.repeat(64) };
it('loads versioned registry data, refusing unknown versions, bad limits and duplicate identities', () => {
  expect(HUB_LIMITS).toMatchObject({ schemaVersion: 1, packageMaxBytes: 4194304, packageMaxFiles: 128, fetchRetries: 0 });
  expect(Object.isFrozen(HUB_LIMITS)).toBe(true);
  expect(hubLimitsSchema.safeParse({ ...HUB_LIMITS, packageMaxBytes: -1 }).success).toBe(false);
  expect(hubLimitsSchema.safeParse({ ...HUB_LIMITS, schemaVersion: 2 }).success).toBe(false);
  expect(HUB_TRUST_POLICIES.addedSourceDefault).toBe('publisher-pinned');
  expect(hubTrustPoliciesSchema.safeParse({ ...HUB_TRUST_POLICIES, policies: [...HUB_TRUST_POLICIES.policies, HUB_TRUST_POLICIES.policies[0]] }).success).toBe(false);
  expect(hubReviewLevelsSchema.safeParse({ ...HUB_REVIEW_LEVELS, levels: [...HUB_REVIEW_LEVELS.levels, HUB_REVIEW_LEVELS.levels[0]] }).success).toBe(false);
  expect(hubPackageFieldsSchema.safeParse({ ...HUB_PACKAGE_FIELDS, optionalFields: [...HUB_PACKAGE_FIELDS.optionalFields, HUB_PACKAGE_FIELDS.optionalFields[0]] }).success).toBe(false);
  expect(hubFileTypesSchema.safeParse({ ...HUB_FILE_TYPES, schemaVersion: 2 }).success).toBe(false);
});

it('refuses traversal, portable-name aliases, duplicate paths and disallowed file metadata (G8/G30)', () => {
  expect(hubFilePathSchema.safeParse('references/invoice.json').success).toBe(true);
  for (const path of ['../key', '/root', 'a//b', 'C:/key', 'a\\b', '%2e%2e/key', 'refs/CON.txt', 'refs/a.', 'refs/a\0', 'refs/a?'])
    expect(hubFilePathSchema.safeParse(path).success, path).toBe(false);
  expect(hubFilesSchema.safeParse([file, { ...file, path: 'skill.md' }]).success).toBe(false);
  expect(hubFilesSchema.safeParse([{ ...file, mode: 0o755 }]).success).toBe(false);
  expect(hubFilesSchema.safeParse([{ ...file, mediaType: 'text/html' }]).success).toBe(false);
  expect(hubFilesSchema.safeParse([{ ...file, path: 'image.svg', mediaType: 'image/svg+xml' }]).success).toBe(false);
  expect(hubFilesSchema.safeParse([{ ...file, path: 'notes.md' }]).success).toBe(false);
  expect(hubFilesSchema.safeParse([file, { ...file, path: 'SKILL.md/child' }]).success).toBe(false);
});

it('adds a v2 reader without altering v1 rows or the signed-import and provenance floors', () => {
  const v1 = defineSkillRevision(null, { scopeId: 's', skillId: 'invoice', commandId: 'c', content: { name: 'Invoice', text: 'Match.' },
    contentDigest: 'a'.repeat(64), source: { kind: 'local' }, signature: { status: 'unsigned' }, author: { issuer: 'local-os', subject: 'person', assurance: 'os-user' }, atMs: 1 });
  expect(readableSkillDefinitionSchema.parse(v1)).toEqual(v1);
  const v2 = { ...v1, schemaVersion: 2, content: { name: 'invoice', description: 'Match invoices.', text: 'Match.', files: [file] } };
  expect(hubSkillDefinitionSchema.parse(v2)).toMatchObject({ schemaVersion: 2, content: { description: 'Match invoices.' } });
  expect(readableSkillDefinitionSchema.safeParse({ ...v2, source: { kind: 'import', ref: 'file:invoice' } }).success).toBe(false);
  expect(hubSkillDefinitionSchema.safeParse({ ...v2, content: { ...v2.content, 'allowed-tools': 'shell' } }).success).toBe(false);
  expect(readableSkillDefinitionSchema.safeParse({ ...v2, schemaVersion: 3 }).success).toBe(false);
  expect(hubSkillDefinitionSchema.safeParse({ ...v2, provenance: { ...v1.provenance, author: { ...v1.provenance.author, ai: true } } }).success).toBe(false);
});

it('encodes exact canonical JSON and bounds hostile inputs before schema or canonical traversal', () => {
  expect(canonicalHubJson({ z: ['é', 1], a: true })).toBe('{"a":true,"z":["é",1]}');
  expect(() => requireBoundedHubJson({ text: 'é'.repeat(20) }, 30)).toThrow(expect.objectContaining({ code: 'HUB_LIMIT_EXCEEDED' }));
  const cycle: { next?: unknown } = {}; cycle.next = cycle;
  expect(() => canonicalHubJson(cycle)).toThrow(expect.objectContaining({ code: 'HUB_PACKAGE_INVALID' }));
  let deep: unknown = null; for (let n = 0; n < 34; n++) deep = { deep };
  expect(() => canonicalHubJson(deep)).toThrow(expect.objectContaining({ code: 'HUB_LIMIT_EXCEEDED' }));
  expect(() => canonicalHubJson(new Array(2))).toThrow(expect.objectContaining({ code: 'HUB_PACKAGE_INVALID' }));
  expect(() => canonicalHubJson({ value: undefined })).toThrow(expect.objectContaining({ code: 'HUB_PACKAGE_INVALID' }));
});
