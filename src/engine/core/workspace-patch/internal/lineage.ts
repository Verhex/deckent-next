import { WorkspacePatchError, type PatchFile, type WorkspacePatch } from './contract.js';
import { assertDisjointHistory } from './path-history.js';
/** A predecessor whose accepted output this patch started from (`startFrom: 'accepted-patch'`), and the version its target recorded when a
 * human adopted that output. Both come from trusted stores (handoff receipts, the adoption journal), never from the patch or the ticket.
 * `adoptedVersion` is the target adapter's exact version identity (Git: the delivery commit id); it is compared for equality only. */
export interface AdoptedPredecessor { readonly adoptedVersion: string; readonly changes: WorkspacePatch['changes'] }
type Change = WorkspacePatch['changes'][number];
const same = (a: PatchFile | null | undefined, b: PatchFile | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** R1-a. A patch that started from its predecessors' accepted output carries their changes against the original base. Intervening target
 * history is accepted only when one version is exactly a predecessor's recorded adopted version, every path it changed is that predecessor's,
 * and this patch holds each predecessor change with the same `before` (it really started from it). The caller then expects the predecessor's
 * `after` on those paths. Every other version stays the disjoint-history rule; no lineage is exactly today's rule. Textual merge is never done. */
export function predecessorLineage(patch: WorkspacePatch, lineage: readonly AdoptedPredecessor[]) {
  const own = new Map<string, Change>(patch.changes.map(change => [change.path, change]));
  const byVersion = new Map<string, AdoptedPredecessor>(), claimed = new Set<string>();
  for (const predecessor of lineage) {
    if (byVersion.has(predecessor.adoptedVersion) || predecessor.changes.some(change => claimed.has(change.path))) throw new WorkspacePatchError('PATCH_CORRUPT');
    byVersion.set(predecessor.adoptedVersion, predecessor); predecessor.changes.forEach(change => claimed.add(change.path));
  }
  const reached = new Map<string, PatchFile | null>();
  return Object.freeze({
    /** One intervening target version and the paths it changed (all parents), in history order. */
    step(version: string, paths: readonly string[]): void {
      const predecessor = byVersion.get(version);
      if (!predecessor) { assertDisjointHistory(paths, patch.changes.map(change => change.path)); return; }
      const changed = new Map(predecessor.changes.map(change => [change.path, change]));
      if (paths.some(path => !changed.has(path)) || predecessor.changes.some(change => !own.has(change.path) || !same(own.get(change.path)!.before, change.before)))
        throw new WorkspacePatchError('PATCH_BASE_ADVANCED');
      byVersion.delete(version);
      for (const change of predecessor.changes) reached.set(change.path, change.after);
    },
    /** The identity the target must hold now for one of this patch's paths. */
    expected(change: Change): PatchFile | null { return reached.has(change.path) ? reached.get(change.path)! : change.before; },
  });
}
