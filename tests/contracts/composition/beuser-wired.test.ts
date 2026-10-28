import { expect, it } from 'vitest';
import { BeuserContractError, BeuserTransferError } from '#engine/index.js';
import { BeuserSurfaceError } from '#adapters/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

it('keeps BeUser target, surface and sealed-backup refusals typed and localized without exposing internal detail', () => {
  const errors = [new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'), new BeuserSurfaceError('BEUSER_SURFACE_INVALID'), new BeuserTransferError()];
  const codes = ['BEUSER_TARGET_NOT_SANDBOX', 'BEUSER_SURFACE_INVALID', 'BACKUP_REALM_SEALED'];
  errors.forEach((error, index) => {
    error.message += ' /private/target/raw-screen credential=hidden';
    const mapped = queryFailure(error);
    expect(mapped.code).toBe(codes[index]);
    expect(mapped.localize?.('tr').message).not.toBe(mapped.localize?.('en').message);
    expect(mapped.suggestion).toBeTruthy();
    expect(JSON.stringify(mapped)).not.toContain('/private'); expect(JSON.stringify(mapped)).not.toContain('hidden');
  });
});
