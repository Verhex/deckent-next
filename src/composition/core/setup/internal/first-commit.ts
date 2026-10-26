import { firstCommitTarget, FIRST_COMMIT_OPERATION } from '#adapters/index.js';
import { assertAuthorityWitness } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel } from '#adapters/index.js';
import { sha256, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { applyConfirmedEffects } from '#composition/core/approvals/index.js';
/** The confirmed preview uses the existing scope, operation approval, effect intent and durable settlement owners. */
export async function applyConfiguredFirstCommit(root: string, folder: string, scopeId: string,
  input: Readonly<{ message: string; digest: string; include?: readonly string[] }>, options: ConfigLoadOptions, signal?: AbortSignal) {
  await assertAuthorityWitness('coding.first-commit', localPrincipalChannel(), { attest: () => attestLocalInteractiveTerminal() });
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'write'), { principal } = context;
  const target = await firstCommitTarget(folder, options.env ?? process.env, input, signal), descriptor = FIRST_COMMIT_OPERATION;
  const commandId = sha256(JSON.stringify(['coding.first-commit', target.identity(), scopeId, principal.issuer, principal.subject, input]));
  const command = { schemaVersion: 1 as const, commandId, scopeId, operation: descriptor.operation, target: { kind: target.kind, id: 'HEAD' },
    idempotencyKey: commandId, expectedVersion: input.digest, input };
  return (await applyConfirmedEffects(root, context, descriptor, target, [command], input.digest, options))[0]!;
}
