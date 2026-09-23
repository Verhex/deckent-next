import { userInfo } from 'node:os';
import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { DispatchPolicyAuthorization, WorkerTranscriptApplication } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Local SDK/CLI producer for the sealed worker transcript of one attempt. */
export async function inspectConfiguredWorkerTranscript(root: string, input: AttemptIdentity, options: ConfigLoadOptions = {}) {
  try {
    const identity = attemptIdentitySchema.parse(input);
    const c = await loadConfiguredScopeContext(root, identity.scopeId, options);
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, 'forbid');
    try {
      const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(c.layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes });
      return await new WorkerTranscriptApplication(store, artifacts,
        new DispatchPolicyAuthorization(createLayoutPolicySource(c.layout, userInfo().uid, c.config.inspection.policyMaxBytes))).inspect(identity, c.principal);
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
