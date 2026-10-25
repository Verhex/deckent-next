import { HUB_LIMITS, HubError, canonicalHubJson, hubFilePathSchema, hubPackageSchema, parseHubContract, type HubPackage, type HubFile } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

export interface HubPackageFile { readonly path: string; readonly bytes: Uint8Array }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** A skill's manifest paths are relative to its own directory; the bundle paths are relative to the package root. */
export function hubPackageFileManifest(manifest: HubPackage): readonly HubFile[] {
  return manifest.items.flatMap(item => item.kind === 'skill'
    ? item.files.map(file => ({ ...file, path: `skills/${item.name}/${file.path}` }))
    : [{ path: `agents/${item.agentId}/AGENT.json`, mediaType: 'application/json', ...agentFile(item) }]);
}
function agentFile(item: Extract<HubPackage['items'][number], { kind: 'agent' }>) {
  const bytes = new TextEncoder().encode(canonicalHubJson(item));
  return { size: bytes.length, digest: sha256(bytes) };
}
/** Builder canonicalises set order once; verifiers cover the manifest's actual array order, never silently repair signed input. */
export function buildHubPackage(input: unknown): { readonly manifest: HubPackage; readonly canonical: string; readonly digest: string } {
  const row = parseHubContract(hubPackageSchema, input, 'HUB_PACKAGE_INVALID', 'HUB_PACKAGE_SCHEMA_UNSUPPORTED');
  const manifest = hubPackageSchema.parse({ ...row, dependencies: [...row.dependencies].sort((a, b) => compare(`${a.hubId ?? ''}/${a.packageId}`, `${b.hubId ?? ''}/${b.packageId}`)),
    items: row.items.map(item => item.kind === 'skill' ? { ...item, files: [...item.files].sort((a, b) => compare(a.path, b.path)) }
      : { ...item, workClassHints: [...item.workClassHints].sort(compare), skills: [...item.skills].sort((a, b) => compare(`${a.packageId}/${a.skillId}`, `${b.packageId}/${b.skillId}`)) })
      .sort((a, b) => compare(a.kind === 'skill' ? `skill/${a.skillId}` : `agent/${a.agentId}`, b.kind === 'skill' ? `skill/${b.skillId}` : `agent/${b.agentId}`)) });
  const canonical = canonicalHubManifest(manifest);
  return Object.freeze({ manifest, canonical, digest: sha256(canonical) });
}
export function canonicalHubManifest(input: unknown): string {
  const manifest = parseHubContract(hubPackageSchema, input, 'HUB_PACKAGE_INVALID', 'HUB_PACKAGE_SCHEMA_UNSUPPORTED');
  const files = hubPackageFileManifest(manifest), canonical = canonicalHubJson(manifest);
  if (files.some(file => !hubFilePathSchema.safeParse(file.path).success) || new Set(files.map(file => file.path.toLowerCase())).size !== files.length)
    throw new HubError('HUB_PACKAGE_INVALID');
  if (files.length + 2 > HUB_LIMITS.packageMaxFiles || files.reduce((sum, file) => sum + file.size, 0) + new TextEncoder().encode(canonical).length > HUB_LIMITS.packageMaxBytes)
    throw new HubError('HUB_LIMIT_EXCEEDED');
  return canonical;
}
/** Raw-byte completeness, size and digest check. No path is opened; all bytes are supplied by the adapter. No extras, links or modes in this contract. */
export function verifyHubPackageFiles(manifest: HubPackage, files: readonly HubPackageFile[]): void {
  canonicalHubManifest(manifest);
  const expected = hubPackageFileManifest(manifest);
  if (files.length + 2 > HUB_LIMITS.packageMaxFiles) throw new HubError('HUB_LIMIT_EXCEEDED');
  if (files.length !== expected.length || new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new HubError('HUB_PACKAGE_INVALID');
  const supplied = new Map(files.map(file => [file.path, file.bytes]));
  for (const file of expected) {
    const bytes = supplied.get(file.path);
    if (!(bytes instanceof Uint8Array)) throw new HubError('HUB_PACKAGE_INVALID');
    if (bytes.byteLength > HUB_LIMITS.skillFilesMaxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.digest) throw new HubError('HUB_DIGEST_MISMATCH');
  }
}
