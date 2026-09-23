import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { adoptionTargetRefSchema, WorkspaceAdoptionError, type AdoptionFence, type AdoptionTargetObservation, type IntegrationAdoptionTarget } from '#engine/index.js';
import { GitCommand } from './git-command.js';
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const fenceRef = (target: string) => `refs/deckent/adoption-fences/${createHash('sha256').update(target).digest('hex')}`;
/** Deterministic fence content (fixed key order): the same record always hashes to the same blob. */
const fenceText = (target: string, fence: AdoptionFence) => JSON.stringify({ schemaVersion: 1, kind: 'deckent-adoption-fence', target,
  sequence: fence.sequence, scopeId: fence.scopeId, commandId: fence.commandId }) + '\n';
const fenceSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('deckent-adoption-fence'), target: z.string(),
  sequence: z.number().int().positive().safe(), scopeId: identitySchema, commandId: identitySchema }).strict();
/** Moves exactly one branch reference together with its fence reference in one Git transaction. `git update-ref` does not refuse
 * a branch checked out in some worktree, so checkout is observed explicitly before each move; a checkout racing the move and
 * writers outside Deckent are not fenced. */
export class GitIntegrationAdoption implements IntegrationAdoptionTarget {
  private readonly git: GitCommand;
  constructor(options: GitWorkspaceOptions) { this.git = new GitCommand(options); }
  /** Exact, non-symbolic reference value; for-each-ref alone also matches `<ref>/...`. */
  private async exact(ref: string) {
    const rows = (await this.git.run(['for-each-ref', '--format=%(refname) %(objectname) %(objecttype) %(symref)', ref])).split('\n').filter(Boolean)
      .map(row => row.split(' ')).filter(([name]) => name === ref);
    if (rows.length > 1) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    const [, value, type, symbolic] = rows[0] ?? [];
    return rows.length === 0 ? null : { value: value ?? '', type: type ?? '', symbolic: symbolic ?? '' };
  }
  private async readFence(target: string): Promise<AdoptionFence | null> {
    const ref = await this.exact(fenceRef(target));
    if (!ref) return null;
    if (ref.symbolic || ref.type !== 'blob' || !oid.test(ref.value)) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    let parsed;
    try { parsed = fenceSchema.parse(JSON.parse(await this.git.run(['cat-file', 'blob', ref.value]))); }
    catch { throw new WorkspaceAdoptionError('ADOPTION_CORRUPT'); }
    if (parsed.target !== target) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    return Object.freeze({ sequence: parsed.sequence, scopeId: parsed.scopeId, commandId: parsed.commandId });
  }
  private async fenceObject(target: string, fence: AdoptionFence) {
    if (!fenceSchema.safeParse(JSON.parse(fenceText(target, fence))).success) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    const value = await this.git.run(['hash-object', '-w', '--stdin'], fenceText(target, fence));
    if (!oid.test(value)) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    return value;
  }
  async observe(targetRef: string): Promise<AdoptionTargetObservation> {
    const ref = adoptionTargetRefSchema.parse(targetRef);
    await this.git.custody();
    await this.git.run(['check-ref-format', ref]).catch(() => { throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED'); });
    const branch = await this.exact(ref);
    if (branch && (branch.symbolic || branch.type !== 'commit' || !oid.test(branch.value))) throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED');
    const worktrees = await this.git.run(['worktree', 'list', '--porcelain']);
    const checkedOut = worktrees.split('\n').some(line => line === `branch ${ref}`);
    return Object.freeze({ tip: branch?.value ?? null, checkedOut, fence: await this.readFence(ref) });
  }
  async move(targetRef: string, fromCommit: string, toCommit: string, expected: AdoptionFence | null, next: AdoptionFence): Promise<void> {
    const ref = adoptionTargetRefSchema.parse(targetRef);
    if (!oid.test(fromCommit) || !oid.test(toCommit)) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    await this.git.custody();
    const fence = fenceRef(ref), nextValue = await this.fenceObject(ref, next);
    const guard = expected ? `update ${fence} ${nextValue} ${await this.fenceObject(ref, expected)}` : `create ${fence} ${nextValue}`;
    try { await this.git.run(['update-ref', '--stdin'], `start\nupdate ${ref} ${toCommit} ${fromCommit}\n${guard}\nprepare\ncommit\n`); }
    catch (error) {
      // The transaction failed or its outcome is unknown: only this record's fence proves that its effect happened.
      const current = await this.readFence(ref);
      if (current && current.sequence === next.sequence && current.scopeId === next.scopeId && current.commandId === next.commandId) return;
      throw new WorkspaceAdoptionError('ADOPTION_CONFLICT', { cause: error });
    }
  }
}
