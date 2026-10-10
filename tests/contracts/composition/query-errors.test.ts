import { OpenRouterChatError, OpenRouterPricingError } from '#adapters/index.js';
import { expect, it } from 'vitest';
import { queryFailure } from '../../../src/composition/core/query-errors/index.js';
import { SupervisorError, DispatchError, ProviderSpendError, RunWorkspaceCustodyError, WorkspaceError, CancellationDeliveryError, RunStoreError, PolicyAuthorizationError } from '#engine/index.js';
import { ErrorRegistry, ManagedFileError } from '#platform/index.js';
import { TaskEvaluationError } from '#domain/index.js';
import { TaskEvidenceError } from '#engine/index.js';
import { EvaluationEvidenceError } from '#capabilities/index.js';
it('preserves registered errors and redacts unknown native/storage details through one shared mapper', () => {
  const known = ErrorRegistry.createError('POLICY_DENIED'); expect(queryFailure(known)).toBe(known);
  expect(queryFailure(new PolicyAuthorizationError('POLICY_DENIED')).code).toBe('POLICY_DENIED');
  const raw = new Error('SQL /private/customer/ledger secret=credential');
  const safe = queryFailure(raw); expect(safe.code).toBe('QUERY_UNEXPECTED_FAILURE'); expect(String(safe)).not.toContain('credential'); expect(String(safe)).not.toContain('/private');
  expect(queryFailure(new RunStoreError('RUN_STORE_CORRUPT')).code).toBe('RUN_STORE_CORRUPT');
});
it('preserves the registered unsupported execution-host failure with localized guidance', () => {
  const failure = ErrorRegistry.createError('EXECUTION_HOST_UNSUPPORTED');
  expect(queryFailure(failure)).toBe(failure);
  expect(failure.code).toBe('EXECUTION_HOST_UNSUPPORTED');
  expect(failure.localize?.('en').message).toContain('non-root host user');
  expect(failure.localize?.('tr').message).toContain('root olmayan');
});
it.each([
  new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT'),
  new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CORRUPT'),
  new WorkspaceError('WORKSPACE_CUSTODY_UNCONVERTIBLE'),
  new WorkspaceError('WORKSPACE_IDENTITY_CONFLICT'),
  new CancellationDeliveryError('CANCELLATION_DELIVERY_CONFLICT'),
  new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'),
  new TaskEvaluationError('TASK_EVALUATION_STALE'),
  new TaskEvaluationError('TASK_EVALUATION_NOT_READY'),
  new TaskEvidenceError('TASK_EVIDENCE_UNLINKED'),
  new EvaluationEvidenceError('EVALUATION_EVIDENCE_CORRUPT'),
  new EvaluationEvidenceError('EVALUATION_EVIDENCE_LIMIT'),
])('preserves evaluation failure identity with localized text and no internal details: $code', error => {
  error.message += ' /private/evidence credential=secret';
  const safe = queryFailure(error);
  expect(safe.code).toBe(error.code);
  expect(String(safe)).not.toContain('/private'); expect(String(safe)).not.toContain('secret');
  expect(safe.localize?.('tr').message).not.toBe(safe.localize?.('en').message);
});

it('exposes only the bounded adapter-version conflict reason', () => {
  const error = new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT', 'adapter-version-mismatch');
  Object.assign(error, { sourceFingerprint: 'private', path: '/private/repository', credential: 'secret' });
  const safe = queryFailure(error);
  expect(safe.params).toEqual({ reason: 'adapter-version-mismatch' });
  expect(JSON.stringify(safe)).not.toContain('/private');
  expect(JSON.stringify(safe)).not.toContain('secret');
});

it('exposes only bounded managed-file failure metadata, without path, UID or raw stat objects', () => {
  const metadata = { resource: 'ledger' as const, companion: '-shm', stage: 'path' as const, reason: 'link-count' as const,
    mode: 0o600, links: 0, path: '/private/customer/ledger.db-shm', uid: 1234, secret: 'private-key' };
  const safe = queryFailure(new ManagedFileError('MANAGED_FILE_UNSAFE', metadata));
  expect(safe.params).toEqual({ resource: 'ledger', companion: '-shm', stage: 'path', reason: 'link-count', mode: 0o600, links: 0 });
  expect(JSON.stringify(safe)).not.toContain('/private'); expect(JSON.stringify(safe)).not.toContain('private-key');
  expect(safe.params).not.toHaveProperty('uid');
});

it.each(['PROVIDER_SPEND_INVALID', 'PROVIDER_SPEND_CONFLICT', 'PROVIDER_SPEND_EXHAUSTED', 'PROVIDER_SPEND_FROZEN', 'PROVIDER_SPEND_UNAVAILABLE'] as const)(
  'preserves monetary failure identity without raw record details: %s', code => {
    const failure = new ProviderSpendError(code); failure.message += ' /private/ledger credential=secret';
    const safe = queryFailure(failure); expect(safe.code).toBe(code);
    expect(String(safe)).not.toContain('/private'); expect(String(safe)).not.toContain('secret');
    expect(safe.localize?.('tr').message).not.toBe(safe.localize?.('en').message);
  });

it('maps native pricing and request failures to safe product errors without backend details', () => {
  for (const [error, code] of [
    [new OpenRouterPricingError('INCOMPLETE_PRICING'), 'PROVIDER_SPEND_UNAVAILABLE'],
    [new OpenRouterPricingError('INVALID_REQUEST'), 'MODEL_INVOCATION_INVALID'],
    [new OpenRouterChatError('INVALID_PROFILE'), 'MODEL_INVOCATION_PROFILE_CONFLICT'],
    [new OpenRouterChatError('TARIFF_CONFLICT'), 'PROVIDER_SPEND_CONFLICT'],
  ] as const) {
    error.message += ' https://private/credential=secret';
    const safe = queryFailure(error); expect(safe.code).toBe(code);
    expect(String(safe)).not.toContain('private'); expect(String(safe)).not.toContain('credential=secret');
  }
});
it('carries a reservation diagnostic as RUN_CAPACITY_OR_ORDER parameters in the fixed field order, an absent gap left out (COMPOSITION-RELIEF)', () => {
  const diagnostic = { reconciliationCount: 0, terminalCount: 1, occupiedCount: 2, delayedCount: 0, blockedCount: 0, waitingCount: 3, readyCount: 4,
    requestedCount: 5, selectedCount: 0, inFlightOccupied: 1, executionOccupied: 2, inFlightSlots: 3, executionSlots: 2, now: 1_000, reason: 'capacity-exhausted' as const,
    site: 'application-empty' as const };
  const order = ['site', 'reason', 'now', 'executionSlots', 'inFlightSlots', 'executionOccupied', 'inFlightOccupied', 'selectedCount', 'requestedCount', 'readyCount',
    'waitingCount', 'blockedCount', 'delayedCount', 'occupiedCount', 'terminalCount', 'reconciliationCount'];
  const plain = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', diagnostic));
  expect(plain.code).toBe('RUN_CAPACITY_OR_ORDER');
  expect(Object.keys(plain.params ?? {})).toEqual(order);
  expect(plain.params).toEqual(diagnostic);
  const delayed = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', { ...diagnostic, reason: 'delayed', eligibilityGapMs: 250 }));
  expect(Object.keys(delayed.params ?? {})).toEqual([...order.slice(0, 3), 'eligibilityGapMs', ...order.slice(3)]);
  expect(delayed.params?.['eligibilityGapMs']).toBe(250);
});

it.each(['DISPATCH_ARTIFACT_REQUIRED', 'DISPATCH_CONFLICT', 'DISPATCH_NOT_ADMITTED', 'DISPATCH_CORRUPT', 'DISPATCH_PROFILE_VALIDATION_REQUIRED'] as const)(
  'preserves the typed dispatch failure code with EN/TR text and no internal details: %s', code => {
    const error = new DispatchError(code); error.message += ' /private/ledger credential=secret';
    const safe = queryFailure(error);
    expect(safe.code).toBe(code);
    expect(safe.localize?.('en').message).not.toMatch(/^error\./); expect(safe.localize?.('tr').message).not.toMatch(/^error\./);
    expect(safe.localize?.('tr').message).not.toBe(safe.localize?.('en').message);
    expect(String(safe)).not.toContain('/private'); expect(String(safe)).not.toContain('secret');
  });

it('keeps unrelated error classes as QUERY_UNEXPECTED_FAILURE (no over-generalisation of dispatch codes)', () => {
  const plain = new Error('DISPATCH_CONFLICT'); expect(queryFailure(plain).code).toBe('QUERY_UNEXPECTED_FAILURE');
  const spoof = Object.assign(new Error('x'), { code: 'DISPATCH_CONFLICT' }); expect(queryFailure(spoof).code).toBe('QUERY_UNEXPECTED_FAILURE');
});


it.each(['SUPERVISOR_OPTIONS_INVALID', 'SUPERVISOR_REQUEST_INVALID', 'SUPERVISOR_WORKSPACE_INVALID',
  'SUPERVISOR_CONTROL_FAILED', 'SUPERVISOR_IDENTITY_CONFLICT', 'SUPERVISOR_CANCELLED', 'SUPERVISOR_NOT_TERMINAL',
  'SUPERVISOR_PROFILE_INVALID', 'SUPERVISOR_PROFILE_ORIGIN_MISMATCH', 'SUPERVISOR_RELEASE_UNCONFIRMED'] as const)(
  'preserves supervisor failure %s through the shared mapper', code => {
    const error = new SupervisorError(code); error.message += ' /private/customer token=credential';
    const safe = queryFailure(error); expect(safe.code).toBe(code);
    expect(safe.localize?.('en').message).not.toBe(safe.localize?.('tr').message);
    expect(JSON.stringify(safe)).not.toContain('credential'); expect(String(safe)).not.toContain('/private');
  });
it('retains bounded redacted unknown details and cause without raw paths, credentials or terminal controls', () => {
  const error = new Error('adapter broke at /private/workspace secret=credential\n\x1b[31m', { cause: new Error('socket failed C:\\private\\worker') });
  const safe = queryFailure(error);
  expect(safe.code).toBe('QUERY_UNEXPECTED_FAILURE'); expect(safe.params?.['detail']).toContain('adapter broke');
  expect(safe.params?.['detail']).toContain('socket failed');
  expect(JSON.stringify(safe)).not.toMatch(/credential|private|\\u001b/);
  expect(safe).not.toHaveProperty('cause');
  expect(String(queryFailure(new Error('x'.repeat(10000)))).length).toBeLessThan(2200);
});
