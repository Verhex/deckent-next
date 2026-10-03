import { createHash } from 'node:crypto';
import type { EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization } from '#engine/index.js';
import { prepareProductDirectory, SystemTrustedClock } from '#platform/index.js';
import { applySandboxWriteSet, classifySandboxWritePath, createLocalPeerSession, ensureWorkspaceParents, openSqliteAttemptStore, EMPTY_DIRECTORY_VERSION,
  removeSandboxWriteSetDirectory, scanSandboxWriteSet, WORKSPACE_FILE_TARGET_KIND, WORKSPACE_FILE_WRITE_OPERATION, WorkspaceFileTarget,
  type LocalPeerIdentity, type SandboxWriteDecider, type SandboxWriteSetDirectory, type SandboxWriteSetReport, type WorkspaceScope } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Settles one finished call's write set (design §5–§6): scan, then every entry through the edit path rules (`writablePath` → denied; the
 * configuration file → `edit-authority`; the static floor → `edit-floor`; the self-source floor → `edit-self-source`; else `edit`), the edit decision (`decider`) and its own C11 effect of
 * `workspace.file.write@1` on `workspace-file` (the path's busy check, journal and evidence-based settlement). The directory is removed
 * whatever happened.
 */
export async function settleSandboxWriteSet(input: { readonly directory: SandboxWriteSetDirectory; readonly scope: WorkspaceScope; readonly decider: SandboxWriteDecider;
  readonly authority: (rel: string) => boolean; readonly selfSource?: boolean; readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly peer: LocalPeerIdentity;
  readonly scopeId: string; readonly shellCommandId: string; readonly signal: AbortSignal }): Promise<SandboxWriteSetReport> {
  const { scope, context } = input;
  type Store = Awaited<ReturnType<typeof openSqliteAttemptStore>>;
  let store: Store | null = null;
  try {
    const scan = await scanSandboxWriteSet(input.directory.upper, scope.root, input.directory.mark);
    const clock = new SystemTrustedClock();
    const target = new WorkspaceFileTarget(scope, await prepareProductDirectory(context.layout, 'fileEffects'), { maxFileBytes: 16 * 1024 * 1024, writeSet: { upper: input.directory.upper } });
    // Opened once, on the first entry that reaches its effect (a set with nothing to apply opens nothing).
    let opened: Promise<{ sessions: Awaited<ReturnType<typeof createLocalPeerSession>>; store: Store }> | null = null;
    const lazy = () => opened ??= (async () => {
      const sessions = await createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
      const attempts = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, { now: Date.now, timeoutMs: context.config.runRuntime.parking.timeoutMs }, 'forbid');
      store = attempts;
      return { sessions, store: attempts };
    })();
    return await applySandboxWriteSet({ scan, decider: input.decider, signal: input.signal,
      classify: (rel, kind) => classifySandboxWritePath(scope, input.authority, rel, kind, input.selfSource),
      ensureParents: (rel, modeOf, admit) => ensureWorkspaceParents(scope, rel, modeOf, admit),
      async execute(change, gate) {
        const expectedVersion = change.kind === 'rmdir' ? EMPTY_DIRECTORY_VERSION : change.lowerVersion;
        const commandId = sha256(`agent-sandbox-write:1\0${input.shellCommandId}\0${change.rel}\0${change.kind}\0${expectedVersion}\0${change.kind === 'write' ? `${change.digest}\0${change.mode}` : ''}`);
        const command: EffectCommand = { schemaVersion: 1, commandId, scopeId: input.scopeId, operation: WORKSPACE_FILE_WRITE_OPERATION.operation,
          target: { kind: WORKSPACE_FILE_TARGET_KIND, id: change.rel }, idempotencyKey: commandId, expectedVersion,
          input: { writeSet: change.kind === 'write' ? { change: 'write', digest: change.digest, mode: change.mode } : { change: change.kind } } };
        const { sessions, store: attempts } = await lazy();
        await new EffectApplication({ async resolve(ref) {
          return ref.id === WORKSPACE_FILE_WRITE_OPERATION.operation.id && ref.version === WORKSPACE_FILE_WRITE_OPERATION.operation.version ? WORKSPACE_FILE_WRITE_OPERATION : null;
        } }, { resolve: kind => kind === WORKSPACE_FILE_TARGET_KIND ? target : null }, attempts, gate, sessions, new OperationPolicyAuthorization(context.policy), clock).execute(command);
      } });
  } finally {
    (store as { close(): void } | null)?.close();
    await removeSandboxWriteSetDirectory(input.directory.dir);
  }
}
