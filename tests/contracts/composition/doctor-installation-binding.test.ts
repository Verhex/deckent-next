import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { inspectConfiguredInstallationBinding } from '#composition/core/scoped-request/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { machineBindingNotRunReason } from '../support/binding-capability.js';

registerProviderConfig();
// W1-VERIFY-ENV: a host without a usable machine identity (container without /etc/machine-id) silently lost relocation/copy detection.
// `doctor` now says so; identity and authority behavior is unchanged (typed adapter tests own that).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-binding-doctor-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true });
  return { project, env: { HOME: home, DECKENT_GLOBAL_HOME: join(root, 'global'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { const lines: string[] = []; return { lines, sink: { write: (text: string) => { lines.push(text); return true; } } }; };

it('doctor says machine binding is not supported and relocation detection is off when the capability is absent (EN and TR)', async () => {
  const f = await fixture();
  for (const [language, text] of [['en', 'Machine binding: not supported on this host'], ['tr', 'Makine bağı: bu ortamda desteklenmiyor']] as const) {
    const out = capture();
    await runKernelCommand(['doctor', '--lang', language], { root: f.project, env: f.env, stdout: out.sink, inspectInstallationBinding: async () => ({ capability: 'unsupported' }) });
    expect(out.lines.join('')).toContain(text);
    expect(out.lines.join('')).toMatch(language === 'en' ? /relocation and copy detection is off/u : /taşınma ve kopya tespiti kapalı/u);
  }
  const json = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: json.sink, inspectInstallationBinding: async () => ({ capability: 'unsupported' }) });
  expect(JSON.parse(json.lines.join(''))).toMatchObject({ installationBinding: { capability: 'unsupported' } });
});

it('doctor reports an available binding, and omits the line when unwired', async () => {
  const f = await fixture(), ok = capture(), unwired = capture();
  await runKernelCommand(['doctor'], { root: f.project, env: f.env, stdout: ok.sink, inspectInstallationBinding: async () => ({ capability: 'supported' }) });
  expect(ok.lines.join('')).toContain('Machine binding: available');
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: unwired.sink });
  expect(JSON.parse(unwired.lines.join(''))).toMatchObject({ installationBinding: null });
});

it('the composed doctor reading follows the product capture on this host and writes nothing', async () => {
  const f = await fixture(), out = capture(), notRun = await machineBindingNotRunReason();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: out.sink, inspectInstallationBinding: inspectConfiguredInstallationBinding });
  expect(JSON.parse(out.lines.join('')).installationBinding).toEqual({ capability: notRun ? 'unsupported' : 'supported' });
});
