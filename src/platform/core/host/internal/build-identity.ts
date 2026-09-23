import { readFileSync } from 'node:fs';
/** Identity of the compiled tree written by the build (`dist/build-identity.json`); null when running from source or when the file is
 * absent or malformed. Lets an operator see exactly which source tree and commit a running binary came from. */
export interface BuildIdentity { readonly sourceTreeSha256: string; readonly sourceCommit: string | null; readonly sourceDirty: boolean | null }
export function readBuildIdentity(): BuildIdentity | null {
  try {
    const value: unknown = JSON.parse(readFileSync(new URL('../../../../build-identity.json', import.meta.url), 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record['schemaVersion'] !== 1 || typeof record['sourceTreeSha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['sourceTreeSha256'])) return null;
    const commit = typeof record['sourceCommit'] === 'string' && /^[0-9a-f]{40,64}$/.test(record['sourceCommit']) ? record['sourceCommit'] : null;
    return { sourceTreeSha256: record['sourceTreeSha256'], sourceCommit: commit, sourceDirty: typeof record['sourceDirty'] === 'boolean' ? record['sourceDirty'] : null };
  } catch { return null; }
}
