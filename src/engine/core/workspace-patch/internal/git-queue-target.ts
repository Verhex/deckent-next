import { createHash } from 'node:crypto';
import { targetBindingSchema, TargetQueueError, type EffectTargetRef } from '#domain/index.js';
import { assertQueueGitTarget, queueGenerationRef, queueGenerationSchema, type GitQueueFence } from './queue-git.js';
interface QueueGitPort { custody(): Promise<void>; run(args: string[], input?: string): Promise<string>; common(): Promise<{ path: string; device: number; inode: number }> }
export const GIT_QUEUE_DISPLAY = Object.freeze({ schemaVersion: 1 as const, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' });
/** Physical identity and protection producer. A config allow-list never overrides the security floor. */
export class GitQueueTargetApplication {
  constructor(private readonly options: { readonly baseRef?: string | undefined }, private readonly installationId: string, private readonly registeredId: string,
    private readonly targets: readonly string[], private readonly protectedRefs: readonly string[], private readonly git: QueueGitPort) {}
  async binding(ref: string) {
    await this.git.custody();
    const common = await this.git.common();
    const worktrees = await this.git.run(['worktree', 'list', '--porcelain']);
    const remoteDefaults = (await this.git.run(['for-each-ref', '--format=%(symref)', 'refs/remotes'])).split('\n')
      .filter(Boolean).map(value => `refs/heads/${value.split('/').slice(3).join('/')}`);
    // `main` is a product security invariant. The local default and remote HEADs extend it, even when allow-listed.
    const defaultBranch = await this.git.run(['config', '--get', 'init.defaultBranch']).catch(() => '');
    assertQueueGitTarget(ref, this.options.baseRef, this.targets, ['refs/heads/main', 'refs/heads/master', ...(defaultBranch ? [`refs/heads/${defaultBranch}`] : []),
      ...remoteDefaults, ...this.protectedRefs], worktrees.split('\n').includes(`branch ${ref}`));
    await this.git.run(['check-ref-format', ref]);
    const exact = await this.git.run(['for-each-ref', '--format=%(refname) %(objecttype) %(symref)', ref]);
    if (exact !== `${ref} commit`) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    return targetBindingSchema.parse({ schemaVersion: 1, installationId: this.installationId, adapter: { id: 'git', version: 1 },
      resourceBinding: createHash('sha256').update(JSON.stringify(common)).digest('hex'), target: { kind: 'git-ref', id: ref } });
  }
  async resolveTarget(target: EffectTargetRef) {
    if (target.kind !== 'git-ref') throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    return this.binding(target.id);
  }
  async describe() { return GIT_QUEUE_DISPLAY; }
  async fence(key: string, owner: string, epoch: number): Promise<GitQueueFence> {
    await this.binding(this.options.baseRef ?? '');
    const ref = queueGenerationRef(this.options.baseRef ?? ''), payload = queueGenerationSchema.parse({ schemaVersion: 1, key, owner, epoch });
    const rows = await this.git.run(['for-each-ref', '--format=%(refname) %(objectname) %(objecttype) %(symref)', ref]);
    let previous: string | null = null;
    if (rows) {
      const [name, value, type, symbolic] = rows.split(' ');
      if (name !== ref || !value || type !== 'blob' || symbolic) throw new TargetQueueError('QUEUE_CORRUPT');
      const old = queueGenerationSchema.parse(JSON.parse(await this.git.run(['cat-file', 'blob', value])));
      if (old.key !== key || old.epoch > epoch || old.epoch === epoch && old.owner !== owner) throw new TargetQueueError('QUEUE_CONFLICT');
      if (old.epoch === epoch) return { ref, value };
      previous = value;
    }
    const value = await this.git.run(['hash-object', '-w', '--stdin'], JSON.stringify(payload) + '\n');
    await this.git.run(['update-ref', '--stdin'], `start\noption no-deref\n${previous ? `update ${ref} ${value} ${previous}` : `create ${ref} ${value}`}\nprepare\ncommit\n`);
    return { ref, value };
  }
  get registrationId() { return this.registeredId; }
}
