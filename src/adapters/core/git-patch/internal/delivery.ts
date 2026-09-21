import { execFile } from 'node:child_process';
import { mkdtemp, rm, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { patchDigest, WorkspacePatchError, type IntegrationDeliveryTarget, type IntegrationDeliveryCommand,
  type IntegrationDeliveryPlan, type IntegrationManifest, type WorkspacePatch } from '#engine/index.js';
import format from './delivery-format.json' with { type: 'json' };
/** Writes Git objects and one create-only dedicated reference, never the source index/checkout. */
export class GitIntegrationDelivery implements IntegrationDeliveryTarget {
  constructor(private readonly options: GitWorkspaceOptions) {}
  private async git(args: string[], input = '', index?: string, deadline = Date.now() + this.options.timeoutMs) {
    if (Date.now() >= deadline) throw new WorkspacePatchError('PATCH_LIMIT');
    return new Promise<string>((resolve, reject) => {
      const child = execFile(this.options.gitExecutable, ['--no-replace-objects', '-C', this.options.sourceRoot,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], {
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
          ...(index ? { GIT_INDEX_FILE: index } : {}), GIT_AUTHOR_NAME: format.authorName, GIT_AUTHOR_EMAIL: format.authorEmail,
          GIT_COMMITTER_NAME: format.authorName, GIT_COMMITTER_EMAIL: format.authorEmail, GIT_AUTHOR_DATE: format.date, GIT_COMMITTER_DATE: format.date },
        timeout: Math.max(1, deadline - Date.now()), maxBuffer: this.options.outputBytes, encoding: 'utf8',
      }, (error, stdout) => error ? reject(new WorkspacePatchError('PATCH_UNAVAILABLE')) : resolve(stdout.trim()));
      child.stdin?.on('error', () => undefined); child.stdin?.end(input);
    });
  }
  private async custody() {
    for (const path of [this.options.sourceRoot, this.options.workspaceRoot, await this.git(['rev-parse', '--absolute-git-dir'])]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) || await realpath(path) !== path) throw new WorkspacePatchError('PATCH_UNSAFE');
    }
  }
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
