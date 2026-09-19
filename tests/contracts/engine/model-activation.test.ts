import { expect, it } from 'vitest';
import { AuthenticationError } from '#engine/index.js';
import { ModelBindingApplication } from '../../../src/engine/core/provider-catalog/index.js';
import { ModelActivationApplication, ModelActivationStoreError, type ModelActivationAdmission, type ModelActivationStore } from '../../../src/engine/core/model-activation/index.js';
import { parseModelActivationReceipt, transitionModelActivation, type ModelActivationReceipt } from '../../../src/domain/core/model-activation/index.js';

const reference = Object.freeze({ providerId: 'provider', providerVersion: 2, modelId: 'model', modelVersion: 3 });
const catalog = Object.freeze({ schemaVersion: 1 as const, revision: 'catalog-1', providers: Object.freeze([{ id: 'provider', version: 2,
  models: Object.freeze([{ id: 'model', version: 3, nativeId: 'native/model', protocols: Object.freeze([{ family: 'native', version: 'v1', capabilities: Object.freeze([]) }]) }]),
}]) });
const principal = Object.freeze({ id: 'operator', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: Object.freeze(['scope-a']) });
const actor = Object.freeze({ id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance });
const authorization = Object.freeze({ revision: 'policy-1', ruleId: 'activate-model' });

async function bindingFor(source: () => unknown | undefined = () => catalog) {
  const bindings = new ModelBindingApplication({ async read() { return source(); } });
  const observed = await bindings.inspect(reference);
  if (observed.status !== 'declared') throw new Error('fixture binding missing');
  return { bindings, observed };
}
function activate(binding: { readonly encodingVersion: 1; readonly algorithm: 'sha256'; readonly digest: string }, commandId = 'activation-1') {
  return Object.freeze({ schemaVersion: 1 as const, commandId, scopeId: 'scope-a', action: 'activate' as const, reference,
    expectedRevision: 0, catalogRevision: 'catalog-1', expectedBinding: binding });
}
function deactivate(binding: { readonly encodingVersion: 1; readonly algorithm: 'sha256'; readonly digest: string }) {
  return Object.freeze({ schemaVersion: 1 as const, commandId: 'deactivation-1', scopeId: 'scope-a', action: 'deactivate' as const,
    reference, expectedRevision: 1, expectedBinding: binding });
}
function receipt(command: ReturnType<typeof activate> | ReturnType<typeof deactivate>, recordedActor = actor): ModelActivationReceipt {
  const definition = catalog.providers[0]!.models[0]!;
  const full = { encodingVersion: 1 as const, provider: { id: 'provider', version: 2 }, model: definition };
  const record = command.action === 'activate' ? transitionModelActivation(null, command, full)
    : transitionModelActivation(transitionModelActivation(null, { ...command, action: 'activate', commandId: 'prior-activation', expectedRevision: 0, catalogRevision: 'catalog-1' }, full), command);
  return parseModelActivationReceipt({ schemaVersion: 1, command, actor: recordedActor, authorization,
    previousRevision: command.expectedRevision === 0 ? null : command.expectedRevision, record, admittedAtMs: 10 });
}
function store(receiptValue: ModelActivationReceipt | null, admit?: (input: ModelActivationAdmission) => Promise<{ replayed: boolean; receipt: ModelActivationReceipt }>): ModelActivationStore & { admitted: number; closed: number } {
  let admitted = 0, closed = 0;
  return {
    get admitted() { return admitted; }, get closed() { return closed; },
    async loadReceipt() { return receiptValue; }, async loadRecord() { return null; },
    async admit(input) { admitted++; return admit ? admit(input) : { replayed: false, receipt: receiptValue ?? receipt(input.command as ReturnType<typeof activate>) }; },
    close() { closed++; },
  };
}

it('rejects failed authentication and a revoked policy before opening store or reading a binding, including replay', async () => {
  const { bindings, observed } = await bindingFor(); const command = activate(observed.binding);
  let opens = 0, reads = 0;
  const app = new ModelActivationApplication({ async verify() { throw new Error('untrusted'); } }, { async authorize() { throw new Error('not reached'); } },
    { async inspect(input) { reads++; return bindings.inspect(input); } }, async () => { opens++; throw new Error('not reached'); }, () => 10);
  await expect(app.admit(command)).rejects.toBeInstanceOf(AuthenticationError);
  expect({ opens, reads }).toEqual({ opens: 0, reads: 0 });

  const replay = receipt(command); const journal = store(replay); let denied = true;
  const revoked = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() {
    if (denied) throw new Error('revoked'); return authorization;
  } }, bindings, async () => { opens++; return journal; }, () => 10);
  await expect(revoked.admit(command)).rejects.toThrow('revoked');
  expect({ opens, reads, admitted: journal.admitted, closed: journal.closed }).toEqual({ opens: 0, reads: 0, admitted: 0, closed: 0 });
  denied = false;
  await expect(revoked.admit(command)).resolves.toMatchObject({ replayed: true, receipt: replay });
});

it('records a scope actor without mutable membership in a new durable admission', async () => {
  const { bindings, observed } = await bindingFor(); const command = activate(observed.binding);
  const mutable = { ...principal, scopeIds: ['scope-a', 'later-scope'] }; let captured: ModelActivationAdmission | undefined;
  const journal = store(null, async input => {
    captured = input;
    const record = transitionModelActivation(null, input.command, input.definition);
    return { replayed: false, receipt: parseModelActivationReceipt({ schemaVersion: 1, command: input.command, actor: input.actor,
      authorization: input.authorization, previousRevision: null, record, admittedAtMs: input.admittedAtMs }) };
  });
  const app = new ModelActivationApplication({ async verify() { return mutable; } }, { async authorize() { return authorization; } }, bindings, async () => journal, () => 99);
  const result = await app.admit(command);
  expect(captured?.actor).toEqual(actor); expect(captured?.actor).not.toHaveProperty('scopeIds');
  expect(result.receipt.actor).toEqual(actor); expect(journal.closed).toBe(1);
});

it('replays historical evidence after catalog deletion without a binding lookup or activation transition', async () => {
  const { observed } = await bindingFor(); const command = activate(observed.binding); const historical = receipt(command); let bindingReads = 0;
  const journal = store(historical);
  const app = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'policy-2', ruleId: 'new-grant' }; } },
    { async inspect() { bindingReads++; return { schemaVersion: 1 as const, reference, availability: 'not-observed' as const, status: 'not-configured' as const, catalogRevision: null, definition: null, binding: null }; } },
    async () => journal, () => 99);
  const result = await app.admit(command);
  expect(result).toEqual({ replayed: true, receipt: historical });
  expect({ bindingReads, admitted: journal.admitted, closed: journal.closed }).toEqual({ bindingReads: 0, admitted: 0, closed: 1 });
});

it('does not resolve a catalog binding for deactivate and admits only the explicit inactive transition', async () => {
  const { observed } = await bindingFor(); const command = deactivate(observed.binding); let lookups = 0;
  const inactive = receipt(command); const journal = store(null, async () => ({ replayed: false, receipt: inactive }));
  const app = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize(action) { expect(action).toBe('deactivate'); return authorization; } },
    { async inspect() { lookups++; throw new Error('deactivate must not inspect'); } }, async () => journal, () => 10);
  await expect(app.admit(command)).resolves.toEqual({ replayed: false, receipt: inactive });
  expect({ lookups, admitted: journal.admitted, closed: journal.closed }).toEqual({ lookups: 0, admitted: 1, closed: 1 });
});

it('rejects a new activation whose current exact binding disagrees and rejects a corrupt store return', async () => {
  const { bindings, observed } = await bindingFor(); const command = activate(observed.binding); const journal = store(null); let bindingReads = 0;
  const mismatch = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } },
    { async inspect(input) { bindingReads++; const value = await bindings.inspect(input); return value.status === 'declared' ? { ...value, binding: { ...value.binding, digest: 'e'.repeat(64) } } : value; } }, async () => journal, () => 10);
  await expect(mismatch.admit(command)).rejects.toMatchObject({ code: 'MODEL_ACTIVATION_CATALOG_CONFLICT' } satisfies Partial<ModelActivationStoreError>);
  expect({ bindingReads, admitted: journal.admitted, closed: journal.closed }).toEqual({ bindingReads: 1, admitted: 0, closed: 1 });

  const forged = receipt({ ...command, commandId: 'forged' });
  const corruptStore = store(null, async () => ({ replayed: false, receipt: forged }));
  const corrupt = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } }, bindings, async () => corruptStore, () => 10);
  await expect(corrupt.admit(command)).rejects.toMatchObject({ code: 'MODEL_ACTIVATION_CORRUPT' } satisfies Partial<ModelActivationStoreError>);
  expect(corruptStore.closed).toBe(1);
});

it('rejects a replay command whose authenticated actor differs from the historical actor', async () => {
  const { bindings, observed } = await bindingFor(); const command = activate(observed.binding);
  const otherActor = { ...actor, subject: '2000', id: 'other' } as const; const journal = store(receipt(command, otherActor));
  const app = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } }, bindings, async () => journal, () => 10);
  await expect(app.admit(command)).rejects.toMatchObject({ code: 'MODEL_ACTIVATION_COMMAND_CONFLICT' } satisfies Partial<ModelActivationStoreError>);
  expect({ admitted: journal.admitted, closed: journal.closed }).toEqual({ admitted: 0, closed: 1 });
});
