import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { adoptionTargetRefSchema, WorkspaceAdoptionError, type AdoptionTargetObservation, type IntegrationAdoptionTarget } from '#engine/index.js';
import { GitCommand } from './git-command.js';
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** Moves exactly one branch reference with a Git compare-and-swap. `git update-ref` does not refuse a branch checked out in
 * some worktree, so checkout is observed explicitly before each move; a checkout racing the move is outside this fence. */
export class GitIntegrationAdoption implements IntegrationAdoptionTarget {
  private readonly git: GitCommand;
  constructor(options: GitWorkspaceOptions) { this.git = new GitCommand(options); }
  async observe(targetRef: string): Promise<AdoptionTargetObservation> {
    const ref = adoptionTargetRefSchema.parse(targetRef);
    await this.git.custody();
    await this.git.run(['check-ref-format', ref]).catch(() => { throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED'); });
    // for-each-ref also matches `<ref>/...`; only the exact, non-symbolic reference counts.
    const rows = (await this.git.run(['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ref])).split('\n').filter(Boolean);
    const exact = rows.map(row => row.split(' ')).filter(([name]) => name === ref);
    if (exact.length > 1) throw new WorkspaceAdoptionError('ADOPTION_CONFLICT');
    const [, tip, symbolic] = exact[0] ?? [];
    if (exact.length === 1 && (symbolic || !tip || !oid.test(tip))) throw new WorkspaceAdoptionError('ADOPTION_TARGET_DENIED');
    const worktrees = await this.git.run(['worktree', 'list', '--porcelain']);
    const checkedOut = worktrees.split('\n').some(line => line === `branch ${ref}`);
    return Object.freeze({ tip: tip ?? null, checkedOut });
  }
  async move(targetRef: string, fromCommit: string, toCommit: string): Promise<void> {
    const ref = adoptionTargetRefSchema.parse(targetRef);
    if (!oid.test(fromCommit) || !oid.test(toCommit)) throw new WorkspaceAdoptionError('ADOPTION_CORRUPT');
    await this.git.custody();
    try { await this.git.run(['update-ref', '--stdin'], `start\nupdate ${ref} ${toCommit} ${fromCommit}\nprepare\ncommit\n`); }
    catch (error) {
      // The CAS failed or its outcome is unknown: only the observed tip decides.
      if ((await this.observe(ref)).tip === toCommit) return;
      throw new WorkspaceAdoptionError('ADOPTION_CONFLICT', { cause: error });
    }
  }
}
