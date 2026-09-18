import { expect, it } from 'vitest';
import { queryFailure } from '../../../src/composition/core/query-errors/index.js';
import { RunStoreError, PolicyAuthorizationError } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
it('preserves registered errors and redacts unknown native/storage details through one shared mapper', () => {
  const known = ErrorRegistry.createError('POLICY_DENIED'); expect(queryFailure(known)).toBe(known);
  expect(queryFailure(new PolicyAuthorizationError('POLICY_DENIED')).code).toBe('POLICY_DENIED');
  const raw = new Error('SQL /private/customer/ledger secret=credential');
  const safe = queryFailure(raw); expect(safe.code).toBe('INVENTORY_UNAVAILABLE'); expect(String(safe)).not.toContain('credential'); expect(String(safe)).not.toContain('/private');
  expect(queryFailure(new RunStoreError('RUN_STORE_CORRUPT')).code).toBe('RUN_STORE_CORRUPT');
});
