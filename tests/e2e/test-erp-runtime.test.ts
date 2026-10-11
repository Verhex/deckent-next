import { expect, it } from 'vitest';
import { testErpFixture } from '../fixtures/test-erp/fixture.js';
import { checkFixtureAvailability, recordFixtureAvailability, FixtureUnavailableError } from '../fixtures/test-erp/availability.js';
import { runtimeBinaryAvailability } from '../fixtures/test-erp/runtime.js';

it('reopens the installed runtime and preserves exact settlement, approval and replay bytes with one target write', async context => {
  let availability = await checkFixtureAvailability();
  if (availability.status === 'available') availability = await runtimeBinaryAvailability();
  if (availability.status === 'verify-not-run') {
    await recordFixtureAvailability('runtime', availability); context.skip(JSON.stringify(availability));
  }
  const f = await testErpFixture({ surface: 'runtime' }).catch(async error => {
    if (!(error instanceof FixtureUnavailableError)) throw error;
    await recordFixtureAvailability('runtime', error.availability); return context.skip(JSON.stringify(error.availability));
  });
  try {
    const command = f.command('restart'); const { pending } = await f.approve(command);
    const first = await f.execute(command);
    expect(first.status).toBe('settled'); expect(f.server.writes).toHaveLength(1);
    const before = JSON.stringify(await f.checkpoint('before-runtime-restart', command.commandId));
    const approval = JSON.stringify(await f.inspectApproval(pending.approval.approvalId));
    await f.restart();
    expect(JSON.stringify(await f.checkpoint('after-runtime-restart', command.commandId))).toBe(before);
    expect(JSON.stringify(await f.inspectApproval(pending.approval.approvalId))).toBe(approval);
    expect(JSON.stringify(await f.execute(command))).toBe(JSON.stringify(first));
    expect(f.server.writes).toHaveLength(1);
  } finally { await f.close('runtime-restart'); }
});
