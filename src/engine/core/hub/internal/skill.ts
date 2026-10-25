import { encodeCommandProjection, SIGNATURE_LABELS, HUB_LIMITS, HubError, hubSkillContentSchema, requireBoundedHubJson, type HubSkillContent } from '#domain/index.js';
import { sha256, signatureMessage } from '#platform/index.js';

const orderedFiles = (content: HubSkillContent) => [...content.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
export function skillContentV2Digest(input: HubSkillContent): string {
  requireBoundedHubJson(input, HUB_LIMITS.skillReadMaxBytes * 2);
  const content = hubSkillContentSchema.safeParse(input);
  if (!content.success) throw new HubError('HUB_SKILL_INVALID');
  return sha256(encodeCommandProjection('skill-content:2', { ...content.data, files: orderedFiles(content.data) }));
}
export const skillSignatureV2Message = (input: { readonly skillId: string; readonly contentDigest: string }) => signatureMessage(SIGNATURE_LABELS.skillV2,
  encodeCommandProjection(SIGNATURE_LABELS.skillV2, input));
/** JSON-quoted scalars are YAML scalars too; no permission field is generated. The text is the catalog's SKILL.md body. */
export function buildHubSkillDocument(input: Pick<HubSkillContent, 'name' | 'description' | 'text'>): string {
  const parsed = hubSkillContentSchema.unwrap().omit({ files: true }).safeParse(input);
  if (!parsed.success) throw new HubError('HUB_SKILL_INVALID');
  return `---\nname: ${JSON.stringify(parsed.data.name)}\ndescription: ${JSON.stringify(parsed.data.description)}\n---\n${parsed.data.text}`;
}
/** Package builders emit this exact frontmatter. Refuse other YAML forms rather than interpreting permission-bearing metadata. */
export function hubSkillDocumentBody(document: string, name: string, description: string): string {
  const prefix = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n`;
  if (!document.startsWith(prefix)) throw new HubError('HUB_SKILL_INVALID');
  const text = document.slice(prefix.length);
  if (!text.trim()) throw new HubError('HUB_SKILL_INVALID');
  return text;
}
