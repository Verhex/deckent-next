import { z } from 'zod';
import { HUB_FILE_TYPES, HUB_LIMITS } from './registry.js';

export const hubDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const hubTimeSchema = z.number().int().safe().nonnegative();
export const hubText = (max: number) => z.string().min(1).max(max).refine(v => v.trim() === v && !v.includes('\0') && new TextEncoder().encode(v).length <= max);
/** Agent Skills spec invariants, independent of the catalog's display name. */
export const hubSkillNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const hubSkillDescriptionSchema = hubText(1024);
export const hubPackageIdSchema = z.string().max(129).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine(v => v.split('/').every(part => part.length <= 64));
export const hubVersionSchema = z.string().max(50).regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
  .refine(v => v.split('.').every(n => Number.isSafeInteger(Number(n))));
/** Portable, relative, exact path. Reject encoded aliases, drives, traversal, Windows devices and trailing-dot/space aliases. */
export const hubFilePathSchema = z.string().min(1).max(1024).refine(path => !/[\\:%<>"|?*]/.test(path) && ![...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && path.split('/').every(segment =>
  segment !== '' && segment !== '.' && segment !== '..' && !/[. ]$/.test(segment) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)));
export const hubFileSchema = z.object({ path: hubFilePathSchema, mediaType: z.string().refine(type => HUB_FILE_TYPES.mediaTypes.includes(type)),
  size: hubTimeSchema.max(HUB_LIMITS.skillReadMaxBytes), digest: hubDigestSchema }).strict().readonly();
export type HubFile = z.infer<typeof hubFileSchema>;
export const hubFilesSchema = z.array(hubFileSchema).min(1).max(HUB_LIMITS.skillReadMaxFiles)
  .refine(files => new Set(files.map(f => f.path.toLowerCase())).size === files.length
    && !files.some(file => files.some(other => other.path.toLowerCase().startsWith(`${file.path.toLowerCase()}/`)))
    && files.some(f => f.path === 'SKILL.md' && f.mediaType === 'text/markdown')
    && files.reduce((sum, f) => sum + f.size, 0) <= HUB_LIMITS.skillReadMaxBytes).readonly();
export const hubSignatureValueSchema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
export const hubPublicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
