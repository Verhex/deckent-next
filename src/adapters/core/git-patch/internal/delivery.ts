import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { parseIntegrationDiffStats, patchDigest, WorkspacePatchError, type IntegrationDeliveryTarget, type IntegrationDeliveryCommand,
  type IntegrationDeliveryPlan, type IntegrationManifest, type WorkspacePatch } from '#engine/index.js';
import { SystemTrustedClock, t, redactForRecord } from '#platform/index.js';
import { queueGenerationRef, type IntegrationCommitMetadata, type GitQueueFence } from '#engine/index.js';
import { GitCommand } from './git-command.js';
/** Writes Git objects and one create-only dedicated reference, never the source index/checkout. */
export class GitIntegrationDelivery implements IntegrationDeliveryTarget {
  private readonly command: GitCommand;
  constructor(private readonly options: GitWorkspaceOptions, private readonly queueFence?: GitQueueFence) { this.command = new GitCommand(options); }
  private git(args: string[], input = '', index?: string, deadline?: number, deliveredAtMs?: number) { return this.command.run(args, input, index, deadline, deliveredAtMs); }
  private custody() { return this.command.custody(); }
  async plan(command: IntegrationDeliveryCommand, manifest: IntegrationManifest, patch: WorkspacePatch, metadata: IntegrationCommitMetadata = { title: command.identity.taskId, acceptance: { phase: 'unknown', criteria: 0, runRevision: 0, modelUnverified: false }, deliveredAtMs: new SystemTrustedClock().sample().wallMs }): Promise<IntegrationDeliveryPlan> {
    await this.custody();
    const deadline = Date.now() + this.options.timeoutMs;
    const candidate = new GitCommand({ ...this.options, sourceRoot: manifest.workspace });
    await candidate.custody();
    const baseCommit = manifest.schemaVersion === 2 ? manifest.effectiveBaseCommit : patch.baseCommit;
    const tree = await this.tree(candidate, patch, baseCommit, deadline);
    const commit = await candidate.run(['commit-tree', '--no-gpg-sign', tree, '-p', baseCommit], t('git.delivery.message', { title: redactForRecord(metadata.title).replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 256),
        run: command.identity.runId, task: command.identity.taskId, phase: metadata.acceptance.phase, criteria: metadata.acceptance.criteria,
        revision: metadata.acceptance.runRevision, unverified: metadata.acceptance.modelUnverified ? ' (model-unverified)' : '' }, 'en'), undefined, deadline, metadata.deliveredAtMs);
      return { schemaVersion: 2, baseCommit: patch.baseCommit, effectiveBaseCommit: baseCommit, commit,
        ref: `refs/deckent/deliveries/${patchDigest(JSON.stringify({ scopeId: command.identity.scopeId, commandId: command.commandId }))}`,
        snapshotDigest: manifest.snapshotDigest };
  }
  private async tree(git: GitCommand, patch: WorkspacePatch, baseCommit: string, deadline: number) {
    const directory = await mkdtemp(join(this.options.workspaceRoot, '.delivery-index-')), index = join(directory, 'index');
    try {
      await git.run(['read-tree', baseCommit], '', index, deadline);
      for (const change of patch.changes) {
        const oid = change.after ? await git.run(['hash-object', '-w', '--stdin'], change.after.text, index, deadline) : '0'.repeat(patch.baseCommit.length);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new WorkspacePatchError('PATCH_CORRUPT');
        await git.run(['update-index', '-z', '--index-info'], `${change.after?.mode ?? '0'} ${oid}\t${change.path}\0`, index, deadline);
      }
      return await git.run(['write-tree'], '', index, deadline);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  /** Read-only bounded diff statistics, with no external diff/textconv and no rename policy. */
  async describe(from: string, to: string) {
    const output = await this.git(['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', from, to, '--']);
    return parseIntegrationDiffStats(output);
  }
  async delivered(plan: IntegrationDeliveryPlan) {
    await this.custody();
    const refs = await this.git(['for-each-ref', '--format=%(refname) %(objectname) %(symref)', plan.ref]);
    if (!refs) return false;
    if (refs !== `${plan.ref} ${plan.commit}`) throw new WorkspacePatchError('PATCH_CONFLICT');
    return true;
  }
  /** Publish only against the candidate's pinned effective parent; a later base move requires a fresh candidate. */
  async publish(plan: IntegrationDeliveryPlan, manifest: IntegrationManifest, patch: WorkspacePatch) {
    if (await this.delivered(plan)) return;
    const base = this.options.baseRef ?? 'HEAD';
    const baseCommit = plan.schemaVersion === 2 ? plan.effectiveBaseCommit : plan.baseCommit;
    if (await this.git(['rev-parse', '--verify', `${base}^{commit}`]) !== baseCommit) throw new WorkspacePatchError('PATCH_BASE_ADVANCED');
    // The exact preview commit lives in the candidate until consent. Copy bounded verified objects, never fetch or hooks.
    const deadline = Date.now() + this.options.timeoutMs;
    const present = await this.git(['cat-file', '--batch-check'], `${plan.commit}\n`, undefined, deadline);
    if (present.includes(' missing')) {
      const candidate = new GitCommand({ ...this.options, sourceRoot: manifest.workspace }); await candidate.custody();
      const raw = await candidate.run(['cat-file', 'commit', plan.commit], '', undefined, deadline);
      const tree = await this.tree(this.command, patch, baseCommit, deadline);
      if (!raw.startsWith(`tree ${tree}\nparent ${baseCommit}\n`)) throw new WorkspacePatchError('PATCH_CORRUPT');
      const commit = await this.git(['hash-object', '-w', '-t', 'commit', '--stdin'], raw + '\n', undefined, deadline);
      if (commit !== plan.commit) throw new WorkspacePatchError('PATCH_CORRUPT');
    }
    const generation = this.queueFence ?? { ref: queueGenerationRef(base), value: '0'.repeat(baseCommit.length) };
    try { await this.git(['update-ref', '--stdin'], `start\noption no-deref\nverify ${generation.ref} ${generation.value}\nverify ${base} ${baseCommit}\ncreate ${plan.ref} ${plan.commit}\nprepare\ncommit\n`); }
    catch (error) {
      // A concurrent identical command may have won. Exact ref/commit custody is the only recovery evidence.
      if (await this.delivered(plan)) return;
      if (await this.git(['rev-parse', '--verify', `${base}^{commit}`]) !== baseCommit) {
        throw new WorkspacePatchError('PATCH_BASE_ADVANCED');
      }
      throw error;
    }
  }
}
