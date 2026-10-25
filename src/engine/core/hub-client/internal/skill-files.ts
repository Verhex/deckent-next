import { HUB_LIMITS, HubError, taskAgentSealSchema, type TaskAgentSeal } from '#domain/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import { sha256 } from '#platform/index.js';
import { skillContentV2Digest, verifyHubPackageFiles } from '#engine/core/hub/index.js';
import { HubClientError, type HubClientStore } from './contract.js';
import { decodeHubBundle } from './bundle.js';
export interface SelectedSkillFile { readonly path: string; readonly bytes: Uint8Array; readonly digest: string; readonly entry: boolean }
/** Only the admitted task's frozen pins, never current selection or an eager catalog scan. No network and no standing change. */
export async function selectedHubSkillFiles(store: Pick<HubClientStore, 'loadSkill' | 'skillBundle'>, artifacts: Pick<ArtifactStore, 'read'>,
  scopeId: string, input: TaskAgentSeal | undefined): Promise<readonly SelectedSkillFile[]> {
  if (!input) return [];
  const seal = taskAgentSealSchema.parse(input), out: SelectedSkillFile[] = [];
  let total = 0;
  for (const ref of seal.skills) {
    const row = await store.loadSkill(scopeId, ref.skillId, ref.revision);
    if (!row || row.scopeId !== scopeId || row.skillId !== ref.skillId || row.revision !== ref.revision || row.contentDigest !== ref.digest) throw new HubClientError('HUB_STORE_CORRUPT');
    if (row.schemaVersion === 1) continue;
    if (skillContentV2Digest(row.content) !== ref.digest) throw new HubClientError('HUB_STORE_CORRUPT');
    if ((total += row.content.files.reduce((n, file) => n + file.size, 0)) > HUB_LIMITS.skillFilesMaxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
    const receipt = await store.skillBundle(scopeId, ref.skillId, ref.revision, ref.digest);
    if (!receipt) throw new HubClientError('HUB_STORE_CORRUPT');
    const bundle = decodeHubBundle(await artifacts.read(scopeId, receipt));
    verifyHubPackageFiles(bundle.manifest, bundle.files);
    const item = bundle.manifest.items.find(item => item.kind === 'skill' && item.skillId === ref.skillId);
    if (!item || item.kind !== 'skill' || item.name !== row.content.name || item.description !== row.content.description
      || skillContentV2Digest({ ...row.content, files: item.files }) !== ref.digest) throw new HubClientError('HUB_STORE_CORRUPT');
    // The id/revision namespace avoids two selected skills with the same portable name colliding.
    for (const file of row.content.files) {
      const bytes = bundle.files.find(candidate => candidate.path === `skills/${item.name}/${file.path}`)?.bytes;
      if (!bytes || bytes.byteLength !== file.size || sha256(bytes) !== file.digest) throw new HubError('HUB_DIGEST_MISMATCH');
      out.push({ path: `${row.skillId}/${row.revision}/${item.name}/${file.path}`, bytes, digest: file.digest, entry: file.path === 'SKILL.md' });
    }
  }
  return out;
}
