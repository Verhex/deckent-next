import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';
import { ModelActivationApplication, modelActivationTargetId } from '#engine/core/model-activation/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { ModelActivationPolicyAuthorization } from '#engine/core/policy/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 1_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 2 };
const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 2, nativeId: 'native/model',
    protocols: [{ family: 'responses', version: '1', capabilities: [{ id: 'text', version: 1, state: 'supported' as const }] }] }] }] };
const principal = { id: 'operator', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['scope-a'] };

it('revokes a pinned activation after catalog removal and replays history without resurrection behind a fresh policy gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-activation-application-')); roots.push(root);
  const path = join(root, 'ledger.db'); let authored: typeof catalog | undefined = catalog;
  const bindings = new ModelBindingApplication({ async read() { return authored; } });
  const observed = await bindings.inspect(reference);
  if (observed.status !== 'declared') throw new Error('FIXTURE_BINDING_MISSING');
  const targetId = modelActivationTargetId(reference);
  const allow = { id: 'model-owner', effect: 'allow' as const, actions: ['activate', 'deactivate'], scopes: ['scope-a'],
    principals: [{ issuer: principal.issuer, subject: principal.subject }],
    resource: { kind: 'model-activation', ids: [targetId] } };
  let policy = { schemaVersion: 1 as const, revision: 'policy-1', grants: [allow], restrictions: [] as object[] };
  const authorization = new ModelActivationPolicyAuthorization({ async load() { return policy; } });
  let opens = 0, clock = 1_000;
  const app = new ModelActivationApplication({ async verify() { return principal; } }, authorization, bindings,
    async () => { opens++; return openSqliteModelActivationStore(path, options); }, () => clock++);
  const activate = { schemaVersion: 1 as const, action: 'activate' as const, commandId: 'activate-a', scopeId: 'scope-a',
    reference, expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: observed.binding };
  const activated = await app.admit(activate);
  expect(activated).toMatchObject({ replayed: false, receipt: { record: { state: 'active', revision: 1 } } });

  authored = undefined;
  const deactivate = { schemaVersion: 1 as const, action: 'deactivate' as const, commandId: 'deactivate-a', scopeId: 'scope-a',
    reference, expectedRevision: 1, expectedBinding: observed.binding };
  expect(await app.admit(deactivate)).toMatchObject({ replayed: false, receipt: { record: { state: 'inactive', revision: 2 } } });
  expect(await app.admit(activate)).toEqual({ replayed: true, receipt: activated.receipt });
  const inspect = await openSqliteModelActivationStore(path, options, 'forbid');
  try { expect(await inspect.loadRecord('scope-a', reference)).toMatchObject({ state: 'inactive', revision: 2 }); }
  finally { inspect.close(); }

  policy = { ...policy, revision: 'policy-2', grants: [] };
  const opensBeforeDeny = opens;
  await expect(app.admit(activate)).rejects.toThrow('POLICY_DENIED');
  expect(opens).toBe(opensBeforeDeny);
});
