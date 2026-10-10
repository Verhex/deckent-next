import { expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { auditCheckpointVerifyCommandSchema } from '#domain/index.js';
import type { AuditCheckpointVerification } from '#engine/index.js';
const result: AuditCheckpointVerification = { schemaVersion: 1, scopeId: 'scope', status: 'verified', records: 0,
  checkpoints: 0, pendingRecords: 0, latestCheckpoint: null, anchor: null };
async function run(args: readonly string[], status: AuditCheckpointVerification['status'] = 'verified') {
  let out = '', err = '', calls = 0, command: unknown;
  const code = await main(['audit', ...args], { root: '/tmp/deckent-audit-cli-nonexistent',
    env: { HOME: '/tmp/deckent-audit-cli-nonexistent', USERPROFILE: '/tmp/deckent-audit-cli-nonexistent', XDG_CONFIG_HOME: '/tmp/deckent-audit-cli-nonexistent' },
    stdout: { write(value) { out += value; } }, stderr: { write(value) { err += value; } },
    verifyAuditCheckpoints: async (_root, input) => { calls++; command = input; return { ...result, status }; } });
  return { code, out, err, calls, command };
}
it('dispatches the real typed audit verify command and exports JSON evidence', async () => {
  const r = await run(['verify', '--scope', 'scope', '--json']);
  expect(r.code).toBe(0); expect(r.calls).toBe(1); expect(JSON.parse(r.out)).toEqual(result);
  expect(auditCheckpointVerifyCommandSchema.parse(r.command)).toEqual({ schemaVersion: 1, scopeId: 'scope' });
});
it('passes both external anchor fields and fails malformed input before invoking the host', async () => {
  const r = await run(['verify', '--scope', 'scope', '--anchor-sequence', '3', '--anchor-digest', 'a'.repeat(64), '--json']);
  expect(r.code).toBe(0); expect(r.command).toMatchObject({ anchor: { sequence: 3, digest: 'a'.repeat(64) } });
  for (const args of [[], ['verify'], ['verify', '--scope', 'scope', '--anchor-sequence', '3'],
    ['verify', '--scope', 'scope', '--anchor-sequence', '1.5', '--anchor-digest', 'a'.repeat(64)], ['verify', '--scope', 'scope', '--unknown']]) {
    const invalid = await run(args); expect(invalid.code).not.toBe(0); expect(invalid.calls).toBe(0);
  }
});
it('reports a missing checkpoint as structured output with a nonzero exit', async () => {
  const r = await run(['verify', '--scope', 'scope', '--json'], 'missing-checkpoint');
  expect(r.code).not.toBe(0); expect(JSON.parse(r.out).status).toBe('missing-checkpoint'); expect(r.err).toContain('AUDIT_CHECKPOINT_MISSING');
});
it.each(['en', 'tr'])('renders localized help and verification through the shared renderer (%s)', async lang => {
  const r = await run(['verify', '--scope', 'scope', '--lang', lang]);
  expect(r.code).toBe(0); expect(r.out).toContain(lang === 'en' ? 'checkpoint chain verified' : 'checkpoint zinciri doğrulandı');
  const help = await run(['verify', '--help', '--lang', lang]); expect(help.code).toBe(0); expect(help.out).toContain('--anchor-digest'); expect(help.calls).toBe(0);
});
