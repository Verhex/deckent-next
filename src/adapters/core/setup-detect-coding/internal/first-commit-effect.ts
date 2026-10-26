import registry from './coding.json' with { type: 'json' };
import { realpath } from 'node:fs/promises';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
import { firstCommitGit, previewFirstCommit, applyFirstCommit } from './first-commit.js';
import type { DetectEnvironment } from '#adapters/core/setup-detect-execution/index.js';
export const FIRST_COMMIT_OPERATION = Object.freeze({ schemaVersion: 1 as const, operation: { id: 'coding.first-commit', version: 1 },
  targetKind: 'coding-repository', effectClass: 'write' as const, approval: 'required' as const, precondition: 'record-version' as const,
  compensation: null, inputMaxBytes: registry.firstCommit.inputMaxBytes });
/** Git adapter of the general effect contract. The first commit's trailer is the target's idempotency evidence. */
export async function firstCommitTarget(root: string, env: DetectEnvironment, input: Readonly<{ message: string; digest: string; include?: readonly string[] }>, signal?: AbortSignal): Promise<EffectTarget> {
  const git = await firstCommitGit(root, env, signal), top = await git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
  const canonical = await realpath(top.stdout.trim());
  return { kind: FIRST_COMMIT_OPERATION.targetKind, identity: () => canonical,
    async observe() { const seen = await previewFirstCommit({ root: canonical, env, ...input, git }); return { version: seen.state === 'offered' ? seen.digest : seen.state }; },
    async lookup(_target, key) {
      const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
      if (head.code === 1) return { status: 'absent' };
      if (head.code !== 0) return null;
      const message = await git(['show', '-s', '--format=%B', head.stdout.trim()]);
      return message.code === 0 && message.stdout.split('\n').includes(`Deckent-Effect: ${key}`) ? { status: 'applied', version: head.stdout.trim() } : null;
    },
    async apply(request: EffectApplyRequest) {
      if (request.expectedVersion !== input.digest || JSON.stringify(request.input) !== JSON.stringify(input)) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
      try {
        const result = await applyFirstCommit({ root: canonical, env, ...input, git, effectKey: request.idempotencyKey });
        return { version: result.commit };
      } catch (error) {
        const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        throw new EffectTargetError(head.code === 1 ? 'EFFECT_TARGET_REJECTED' : 'EFFECT_TARGET_UNKNOWN', { cause: error });
      }
    } };
}
