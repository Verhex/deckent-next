import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { patchDigest, WorkspacePatchError, type IntegrationDeliveryTarget, type IntegrationDeliveryCommand,
  type IntegrationDeliveryPlan, type IntegrationManifest, type WorkspacePatch } from '#engine/index.js';
import format from './delivery-format.json' with { type: 'json' };
import { GitCommand } from './git-command.js';
/** Writes Git objects and one create-only dedicated reference, never the source index/checkout. */
export class GitIntegrationDelivery implements IntegrationDeliveryTarget {
  private readonly command: GitCommand;
  constructor(private readonly options: GitWorkspaceOptions) { this.command = new GitCommand(options); }
  private git(args: string[], input = '', index?: string, deadline?: number) { return this.command.run(args, input, index, deadline); }
  private custody() { return this.command.custody(); }
  async plan(command: IntegrationDeliveryCommand, manifest: IntegrationManifest, patch: WorkspacePatch): Promise<IntegrationDeliveryPlan> {
    await this.custody();
    const deadline = Date.now() + this.options.timeoutMs;
    const directory = await mkdtemp(join(this.options.workspaceRoot, '.delivery-index-'));
    const index = join(directory, 'index');
    const identity = patchDigest(JSON.stringify(command));
    try {
      await this.git(['read-tree', patch.baseCommit], '', index, deadline);
      for (const change of patch.changes) {
        const oid = change.after ? await this.git(['hash-object', '-w', '--stdin'], change.after.text, index, deadline) : '0'.repeat(patch.baseCommit.length);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new WorkspacePatchError('PATCH_CORRUPT');
        await this.git(['update-index', '-z', '--index-info'], `${change.after?.mode ?? '0'} ${oid}\t${change.path}\0`, index, deadline);
      }
      const tree = await this.git(['write-tree'], '', index, deadline);
      const commit = await this.git(['commit-tree', tree, '-p', patch.baseCommit], `${format.messagePrefix}${identity}\n`, index, deadline);
      return { schemaVersion: 1, baseCommit: patch.baseCommit, commit,
        ref: `refs/deckent/deliveries/${patchDigest(JSON.stringify({ scopeId: command.identity.scopeId, commandId: command.commandId }))}`,
        snapshotDigest: manifest.snapshotDigest };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async delivered(plan: IntegrationDeliveryPlan) {
    await this.custody();
    const refs = await this.git(['for-each-ref', '--format=%(refname) %(objectname) %(symref)', plan.ref]);
    if (!refs) return false;
    if (refs !== `${plan.ref} ${plan.commit}`) throw new WorkspacePatchError('PATCH_CONFLICT');
    return true;
  }
  async publish(plan: IntegrationDeliveryPlan) {
    if (await this.delivered(plan)) return;
    try { await this.git(['update-ref', '--stdin'], `start\nverify HEAD ${plan.baseCommit}\ncreate ${plan.ref} ${plan.commit}\nprepare\ncommit\n`); }
    catch (error) {
      // A concurrent identical command may have won. Exact ref/commit custody is the only recovery evidence.
      if (await this.delivered(plan)) return;
      if (await this.git(['rev-parse', '--verify', 'HEAD^{commit}']) !== plan.baseCommit) throw new WorkspacePatchError('PATCH_CONFLICT');
      throw error;
    }
  }
}
