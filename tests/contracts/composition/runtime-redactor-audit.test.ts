import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { agentToolArgumentsDigest } from '#engine/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// Security verification: approve this original destructive card, then assert both the effect and its masked audit. No safe-command swap.
afterEach(closeModeRuntimes);
it.skipIf(process.platform !== 'linux')('W12 masks the original shell command before the audit head cut after approval, without substituting its effect', async () => {
  const grants = [rule('shell-tools', 'agent-tool', ['run_shell'], 'require-approval'), rule('shell-run', 'operation', ['host.shell.run'], 'allow'),
    rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set'])];
  const f = await modeRuntime({ shell: { schemaVersion: 1, realm: 'host' }, grants, mode: null });
  const canary = 'sk-w12FictitiousCanaryQ7x8Y9z0';
  // The canary straddles the old 200-character cut; a post-cut redaction would leak its prefix.
  const command = `printf '%s' '${'x'.repeat(174)} ${canary}'; rm src/a.ts`, args = { command };
  const result = await f.call('run_shell', args, 'allow', { fullAccess: true });
  expect(result).toMatchObject({ card: true, status: 'ok' });
  await expect(readFile(join(f.project, 'src/a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  // The same original command is also exercised with its eligible full-access grant to reach the production audit producer.
  // Recreate exactly the file removed by the approved call; never replace the command with a harmless alternative.
  await writeFile(join(f.project, 'src/a.ts'), 'export const a = 1;\n');
  await f.writeAuthority([rule('shell-tools', 'agent-tool', ['run_shell'], 'require-approval', true), ...grants.slice(1)], null);
  expect(await f.call('run_shell', args, 'allow', { fullAccess: true })).toMatchObject({ status: 'ok' });
  await expect(readFile(join(f.project, 'src/a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  const subject = f.audit().map(row => row.event.subject).find(item => item.kind === 'full-access-call');
  expect(subject).toBeDefined();
  const summary = subject!['summary'] as { head: string; argsDigest: string };
  expect(summary.head).toContain('[REDACTED]'); expect(summary.head).not.toContain('w12Fictitious');
  expect(summary.argsDigest).toBe(agentToolArgumentsDigest('run_shell', args));
  const card = result.events.find(event => event.kind === 'approval.requested');
  expect(card).toBeDefined();
});
