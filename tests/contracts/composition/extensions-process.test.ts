import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// One consumer fixture serves both the compiled process contract and the offline package smoke gate.
it.skipIf(process.platform !== 'linux')('distribution registrations reach runtime serve, MCP and detached restart; Core-only processes refuse the overlay', async () => {
  // pack-smoke exits non-zero when a check fails but still prints its JSON report: read it either way, so the assertion below names the failed
  // part instead of a bare "Command failed" (CI-104: a hosted red without its reason). A run without a report still fails.
  const { stdout } = await promisify(execFile)(process.execPath,
    ['scripts/pack-smoke.mjs', '--root', resolve('.'), '--only', 'extensions'], { timeout: 90_000 })
    .catch((error: { stdout?: string; stderr?: string; message?: string }) => {
      if (!error.stdout?.trim()) throw new Error(`${error.message ?? 'pack-smoke failed'}\n${error.stderr ?? ''}`);
      return { stdout: error.stdout };
    });
  const report = JSON.parse(stdout);
  expect(report.checks.extensions).toMatchObject({ ok: true, service: { status: 'settled' }, mcp: { status: 'settled' },
    afterRestart: { status: 'settled' }, denied: { code: 'POLICY_DENIED' }, absentService: { code: 'EFFECT_OPERATION_UNKNOWN' },
    absentMcp: { code: 'EFFECT_OPERATION_UNKNOWN' }, restart: { replaced: true, registered: true } });
  expect(report.checks.extensions.writes).toHaveLength(3);
}, 100_000);
