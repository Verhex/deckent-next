import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization } from '#engine/index.js';
import { normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath, resolveGlobalScopePaths, resolveProductLayout, SystemTrustedClock,
  type ProductLayout } from '#platform/index.js';
import { applySandboxWriteSet, createLocalPeerSession, ensureWorkspaceParents, isWriteApprovalFloored, openSqliteAttemptStore, removeEmptyWorkspaceDirectory,
  removeSandboxWriteSetDirectory, scanSandboxWriteSet, writablePath, WORKSPACE_FILE_TARGET_KIND, WORKSPACE_FILE_WRITE_OPERATION, WorkspaceFileTarget,
  type LocalPeerIdentity, type SandboxWriteDecider, type SandboxWriteSetDirectory, type SandboxWriteSetReport, type WorkspaceScope } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Where a call's write-set directories may live (SHELL-OVERLAY design §0.1, §3): the project data root's `fileEffects`, then the global state
 * root's — the first private one whose real path neither holds nor sits inside the project (overlay layers may not nest). None → no write set.
 */
export async function sandboxWriteSetRoot(projectRoot: string, layout: ProductLayout, environment: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const project = await realpath(projectRoot);
  const outside = (path: string) => { const down = relative(project, path), up = relative(path, project);
    return down !== '' && (down.startsWith('..') || isAbsolute(down)) && (up.startsWith('..') || isAbsolute(up)); };
  const candidates: (() => Promise<string>)[] = [
    async () => join(await prepareProductDirectory(layout, 'fileEffects'), 'sandbox-writes'),
    async () => {
      const global = resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, environment), environment).stateDir;
      return join(productResourcePath(resolveProductLayout({ projectRoot: global, root: global }), 'fileEffects'), 'sandbox-writes', sha256(project).slice(0, 16));
    },
  ];
  for (const candidate of candidates) {
    try {
      const path = await candidate();
      await mkdir(path, { recursive: true, mode: 0o700 });
      const real = await realpath(path), info = await stat(real);
      if (real === path && info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid!() && outside(real)) return real;
    } catch { /* the next candidate */ }
  }
  return null;
}

/**
 * Settles one finished call's write set (design §5–§6): scan, then every entry through the edit path rules (`writablePath` → denied; the
 * configuration file → `edit-authority`; the write floor → `edit-floor`; else `edit`), the edit decision (`decider`) and its own C11 effect of
 * `workspace.file.write@1` on `workspace-file` (the path's busy check, journal and evidence-based settlement). The directory is removed
 * whatever happened.
 */
export async function settleSandboxWriteSet(input: { readonly directory: SandboxWriteSetDirectory; readonly scope: WorkspaceScope; readonly decider: SandboxWriteDecider;
  readonly authority: (rel: string) => boolean; readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly peer: LocalPeerIdentity;
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
      const attempts = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, 'forbid');
      store = attempts;
      return { sessions, store: attempts };
    })();
    return await applySandboxWriteSet({ scan, decider: input.decider, signal: input.signal,
      classify: rel => { const lexical = writablePath(scope, rel); return !lexical.ok || lexical.rel !== rel ? 'denied' : input.authority(rel) ? 'edit-authority' : isWriteApprovalFloored(rel) ? 'edit-floor' : 'edit'; },
      ensureParents: (rel, modeOf) => ensureWorkspaceParents(scope, rel, modeOf), removeDirectory: rel => removeEmptyWorkspaceDirectory(scope, rel),
      async execute(change, gate) {
        const commandId = sha256(`agent-sandbox-write:1\0${input.shellCommandId}\0${change.rel}\0${change.kind}\0${change.lowerVersion}\0${change.kind === 'write' ? `${change.digest}\0${change.mode}` : ''}`);
        const command: EffectCommand = { schemaVersion: 1, commandId, scopeId: input.scopeId, operation: WORKSPACE_FILE_WRITE_OPERATION.operation,
          target: { kind: WORKSPACE_FILE_TARGET_KIND, id: change.rel }, idempotencyKey: commandId, expectedVersion: change.lowerVersion,
          input: { writeSet: change.kind === 'write' ? { change: 'write', digest: change.digest, mode: change.mode } : { change: 'delete' } } };
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
