import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// One consumer fixture serves both the compiled process contract and the offline package smoke gate.
it.skipIf(process.platform !== 'linux')('distribution registrations reach runtime serve, MCP and detached restart; Core-only processes refuse the overlay', async () => {
  // Any non-zero exit, timeout or signal still fails; the failure now carries pack-smoke's JSON report (it prints one even when a check fails),
  // so a hosted red names the failed part instead of a bare "Command failed" (CI-104; review 2681 N1: the exit-0 requirement stays).
  const { stdout } = await promisify(execFile)(process.execPath,
    ['scripts/pack-smoke.mjs', '--root', resolve('.'), '--only', 'extensions'], { timeout: 90_000 })
    .catch((error: { stdout?: string; stderr?: string; message?: string }) => {
      throw new Error(`${error.message ?? 'pack-smoke failed'}\nreport: ${error.stdout?.slice(-4000) ?? ''}\nstderr: ${error.stderr?.slice(-2000) ?? ''}`);
    });
  const report = JSON.parse(stdout);
  expect(report.checks.extensions).toMatchObject({ ok: true, service: { status: 'settled' }, mcp: { status: 'settled' },
    afterRestart: { status: 'settled' }, denied: { code: 'POLICY_DENIED' }, absentService: { code: 'EFFECT_OPERATION_UNKNOWN' },
    absentMcp: { code: 'EFFECT_OPERATION_UNKNOWN' }, restart: { replaced: true, registered: true } });
  expect(report.checks.extensions.writes).toHaveLength(3);
}, 100_000);
