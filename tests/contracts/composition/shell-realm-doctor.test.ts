import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { inspectConfiguredShellRealm } from '#composition/core/agent-turn/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';

registerProviderConfig();
// REALM-NOTICE (live 2026-09-29): `doctor` reports the shell realm a call in this project gets — measured read-only with the state root
// the service uses (`DECKENT_GLOBAL_HOME` here) — and every sandbox provider passed over, so "probe available, provider refuses" is visible.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-realm-doctor-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true });
  // The live shape: the global state root inside the checkout.
  const stateDir = join(project, '.deckent', 'host', 'global');
  return { project, stateDir, env: { HOME: home, DECKENT_GLOBAL_HOME: stateDir, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { const lines: string[] = []; return { lines, sink: { write: (text: string) => { lines.push(text); return true; } } }; };

it('doctor --json carries the composed shell realm report from the service state root; the measurement writes nothing', async () => {
  const f = await fixture(), out = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: out.sink, inspectShellRealm: inspectConfiguredShellRealm });
  const report = JSON.parse(out.lines.join('')).shellRealm;
  expect(report).toMatchObject({ schemaVersion: 1, mode: 'prefer-sandbox', stateDir: f.stateDir, preferSandbox: null,
    bubblewrap: { status: expect.any(String), rejected: expect.any(Array) }, landlock: { status: expect.any(String) } });
  // Whatever this host measures, a realm that is not the first provider names what was passed over (never a silent fallback).
  if (report.selected !== 'bubblewrap' && report.selected !== null) expect(report.rejected.length).toBeGreaterThan(0);
  if (report.selected === 'landlock') expect(report.notice).toMatch(/^\[deckent\] sandbox: landlock instead of bubblewrap \(bubblewrap: /u);
  // Read-only: the bundled copy is not placed by doctor (the service places it), the state root is not even created.
  expect(existsSync(f.stateDir)).toBe(false);
});

it('doctor shows the realm in its human lines in the product\'s own sandbox words; null when unwired', async () => {
  const f = await fixture(), out = capture();
  const notice = '[deckent] sandbox: landlock instead of bubblewrap (bubblewrap: bwrap at /p/.deckent/host/global/bin/bwrap-917f is inside the project or scratch area, where a sandboxed command could replace it).';
  await runKernelCommand(['doctor'], { root: f.project, env: f.env, stdout: out.sink, inspectShellRealm: async () => ({ mode: 'prefer-sandbox', selected: 'landlock',
    marker: 'sandbox: landlock', notice, code: null, rejected: [{ kind: 'bubblewrap', reason: 'x' }], preferSandbox: null }) });
  const text = out.lines.join('');
  expect(text).toContain(`sandbox: landlock [terminal.shell.realm prefer-sandbox]\n${notice}`);
  const refused = capture();
  await runKernelCommand(['doctor'], { root: f.project, env: f.env, stdout: refused.sink, inspectShellRealm: async () => ({ mode: 'require-sandbox', selected: null, marker: null,
    notice: null, code: 'SHELL_SANDBOX_UNAVAILABLE', rejected: [{ kind: 'bubblewrap', reason: 'a' }, { kind: 'landlock', reason: 'landlock unavailable' }], preferSandbox: null }) });
  expect(refused.lines.join('')).toContain('sandbox: refused (SHELL_SANDBOX_UNAVAILABLE) [terminal.shell.realm require-sandbox]\nbubblewrap: a; landlock: landlock unavailable');
  const unwired = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: unwired.sink });
  expect(JSON.parse(unwired.lines.join(''))).toMatchObject({ shellRealm: null });
});
