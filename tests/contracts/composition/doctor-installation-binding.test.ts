import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { inspectConfiguredInstallationBinding } from '#composition/core/scoped-request/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { hostBindingStrength } from '../support/binding-capability.js';

registerProviderConfig();
// W1-VERIFY-ENV: a host without a usable machine identity (container without /etc/machine-id) silently lost relocation/copy detection.
// `doctor` says so; binding v2 adds strength and source (identity behavior has its own typed adapter and composition tests).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-binding-doctor-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'); await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true });
  return { project, env: { HOME: home, DECKENT_GLOBAL_HOME: join(root, 'global'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { const lines: string[] = []; return { lines, sink: { write: (text: string) => { lines.push(text); return true; } } }; };

it('doctor says installation binding is not supported and relocation detection is off when the capability is absent (EN and TR)', async () => {
  const f = await fixture();
  for (const [language, text] of [['en', 'Installation binding: not supported on this host'], ['tr', 'Kurulum bağı: bu ortamda desteklenmiyor']] as const) {
    const out = capture();
    await runKernelCommand(['doctor', '--lang', language], { root: f.project, env: f.env, stdout: out.sink, inspectInstallationBinding: async () => ({ capability: 'unsupported' }) });
    expect(out.lines.join('')).toContain(text);
    expect(out.lines.join('')).toMatch(language === 'en' ? /relocation and copy detection is off/u : /taşınma ve kopya tespiti kapalı/u);
  }
  const json = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: json.sink, inspectInstallationBinding: async () => ({ capability: 'unsupported' }) });
  expect(JSON.parse(json.lines.join(''))).toMatchObject({ installationBinding: { capability: 'unsupported' } });
});

// IDENTITY-BINDING-V2: strength and source kind (machine via platform or configured source, weak, unusable configured source) and the
// requireMachineBinding consequence, in EN and TR. Never a machine value, digest or configured path value.
it.each([
  [{ capability: 'supported', strength: 'machine', source: 'platform', required: false }, 'Installation binding: machine (platform machine identity)', 'Kurulum bağı: makine (platform makine kimliği)'],
  [{ capability: 'supported', strength: 'machine', source: 'configured', required: true }, 'machine (configured source installation.machineIdentity.source)', 'makine (yapılandırılmış kaynak installation.machineIdentity.source)'],
  [{ capability: 'supported', strength: 'weak', source: 'location', required: false }, 'Installation binding: weak (path, device and inode', 'Kurulum bağı: zayıf (yol, cihaz ve inode'],
  [{ capability: 'source-invalid', strength: null, source: 'configured', required: false }, 'INSTALLATION_IDENTITY_SOURCE_INVALID; no fallback', 'INSTALLATION_IDENTITY_SOURCE_INVALID ile durur; daha zayıf bağa düşülmez'],
] as const)('doctor renders binding %j in EN and TR', async (report, en, tr) => {
  const f = await fixture();
  for (const [language, text] of [['en', en], ['tr', tr]] as const) {
    const out = capture();
    await runKernelCommand(['doctor', '--lang', language], { root: f.project, env: f.env, stdout: out.sink, inspectInstallationBinding: async () => report });
    expect(out.lines.join('')).toContain(text);
    expect(out.lines.join('')).not.toMatch(/requireMachineBinding (is on|açık)/u); // required is satisfied or off in these rows
  }
});

it('doctor states that required machine binding refuses writes when only a weak binding is possible (EN and TR)', async () => {
  const f = await fixture(), report = { capability: 'supported', strength: 'weak', source: 'location', required: true } as const;
  for (const [language, text] of [['en', 'installation.requireMachineBinding is on and no machine identity is available: installation-bound writes are refused'],
    ['tr', 'installation.requireMachineBinding açık ve makine kimliği yok: kuruluma bağlı yazmalar reddedilir']] as const) {
    const out = capture();
    await runKernelCommand(['doctor', '--lang', language], { root: f.project, env: f.env, stdout: out.sink, inspectInstallationBinding: async () => report });
    expect(out.lines.join('')).toContain(text);
  }
});

it('doctor omits the line when unwired', async () => {
  const f = await fixture(), unwired = capture();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: unwired.sink });
  expect(JSON.parse(unwired.lines.join(''))).toMatchObject({ installationBinding: null });
});

it('the composed doctor reading follows the product capture on this host and writes nothing', async () => {
  const f = await fixture(), out = capture(), strength = await hostBindingStrength();
  await runKernelCommand(['doctor', '--json'], { root: f.project, env: f.env, stdout: out.sink, inspectInstallationBinding: inspectConfiguredInstallationBinding });
  expect(JSON.parse(out.lines.join('')).installationBinding).toEqual(strength === 'machine' ? { capability: 'supported', strength: 'machine', source: 'platform', required: false }
    : strength === 'weak' ? { capability: 'supported', strength: 'weak', source: 'location', required: false } : { capability: 'unsupported', strength: null, source: null, required: false });
  expect(await readdir(f.project)).toEqual([]);
});
