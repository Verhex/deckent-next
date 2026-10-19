import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { DOCTOR_BACKUP_PASSPHRASE_SECRET, DOCTOR_FIXES, doctorChecks, renderDoctorChecks, type DoctorCheckFacts } from '#surfaces/core/doctor/index.js';

// C-DOCTOR (alpha.48, CLI review 2026-10-19 §doctor): grouped rows, word markers, one next step per warning, internals behind --verbose,
// the --json report unchanged, and the interactive fix offer only on a person's terminal through an existing operation.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(config: unknown = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-doctor-human-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true });
  await writeFile(join(root, '.deckent/config.json'), typeof config === 'string' ? config : JSON.stringify({ layout: { root: join(root, 'd') }, ...config as object }));
  return root;
}
const facts = (extra: Partial<DoctorCheckFacts> = {}): DoctorCheckFacts => ({ scopeId: 'live', toolchainsRequested: false, identityProfile: { state: 'missing' },
  backupPassphraseStored: true, retiringModels: [{ modelId: 'model-x', channelId: 'codex-cli', state: 'deprecated', date: '2026-12-01' }], poolStatus: 'ready',
  toolchainUpdateEnabled: true, ...extra });
const report = {
  platform: 'wsl', status: 'ready' as const, node: { version: 'v26.10.0', floor: '24.22.0', status: 'supported' as const },
  host: { cpuCores: 16, totalMemMB: 36081, recommendedMaxWorkers: 15 }, company: { companyId: 'default' }, principal: { id: 'me' },
  secretStore: { backend: 'core.secret-store.encrypted-file@1', status: 'ready' }, imageRefresh: { status: 'failed', reason: 'BUILD_FAILED', imageVersion: null },
  installationBinding: { capability: 'supported' as const, strength: 'machine' as const, source: 'platform' },
  shellRealm: { mode: 'prefer-sandbox', selected: 'landlock', marker: 'sandbox: landlock', notice: '[deckent] internal realm notice', code: null, rejected: [], preferSandbox: null,
    selfTest: { status: 'ok' as const, detail: null, durationMs: 4 } },
  recoveryFiles: { leftovers: [], installationDirectory: { path: '/home/me/.deckent', mode: '0755' } },
  startability: { status: 'ready' as const, endpoint: '/tmp/dk-1000-secret/s', checks: [] },
  policyAdministration: { usableAdminCount: 1, bootstrapRequired: false, recoveryRequired: false },
};

describe('doctor rows (pure)', () => {
  it('groups rows under Kurulum / Güvenlik / Çalışma / Araçlar with word markers, a summary first and one next step per warning', () => {
    const checks = doctorChecks(report, facts(), 'tr');
    for (const check of checks.filter(row => row.state === 'warning' || row.state === 'error')) expect(check.next, check.id).toBeTruthy();
    const text = renderDoctorChecks(checks, 'tr');
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Durum: hazır · \d+ uyarı · \d+ sınanmadı$/);
    expect(lines.indexOf('Kurulum')).toBeLessThan(lines.indexOf('Güvenlik'));
    expect(lines.indexOf('Güvenlik')).toBeLessThan(lines.indexOf('Çalışma'));
    expect(lines.indexOf('Çalışma')).toBeLessThan(lines.indexOf('Araçlar'));
    expect(text).toContain('tamam      Node.js v26.10.0 (en az 24.22.0)');
    expect(text).toContain('uyarı      Kimlik profili seçilmemiş');
    // Lead J3 (I-S3 Q2): the next step is the command that writes the fact, never a bare `deckent init` that cannot (no loop).
    expect(checks.find(row => row.id === 'setup.identity')?.next).toBe('deckent config set identity.profile --global');
    // I-S7: no registry yet → the first missing first-job step (the registry, which also names the pool), never `init pool` without --preview|--apply (CLI_USAGE).
    expect(doctorChecks(report, facts({ poolStatus: 'unconfigured' }), 'tr').find(row => row.id === 'work.pool')?.next).toMatch(/^İlk iş türünü ve worker havuzunu tanımlayın: .*; komut: deckent init registry --scope live --provider /u);
    expect(text).toContain('uyarı      Kurulum klasörü başka kullanıcılara açık (mod 0755)');
    expect(text).toContain('sonraki adım: chmod 700 /home/me/.deckent');
    expect(text).toContain('Yedek parolası bu kurulumun içinde saklanıyor'); // J2e: owner wording, joined with C-ADMIN's backup line
    expect(text).toContain('Etkin model model-x (codex-cli) emekliye ayrılıyor (tarih 2026-12-01)');
    expect(text).toContain('sınanmadı  Docker bu sürümde doctor tarafından sınanmıyor');
    expect(text).toContain('sonraki adım: deckent doctor --toolchains');
    // Internals stay out of the default view (CLI review §doctor findings 1, 2): no socket path, backend id, realm marker or "(-)".
    for (const internal of ['/tmp/dk-', 'core.secret-store', 'terminal.shell.realm', '[deckent]', '(-)', 'ready', 'degraded']) expect(text).not.toContain(internal);
    const en = renderDoctorChecks(doctorChecks(report, facts(), 'en'), 'en');
    expect(en.split('\n')[0]).toMatch(/^Status: ready · \d+ warning\(s\) · \d+ not tested$/);
    expect(en).toContain('Installation\n  ok          Node.js v26.10.0 (minimum 24.22.0)');
  });
  it('an error row reads as needing attention; a new installation without an audit checkpoint is not tested, not a problem', () => {
    const fresh = doctorChecks({ ...report, auditIntegrity: { schemaVersion: 1, scopeId: 'live', status: 'unknown', reason: 'no-checkpoint-yet', head: null, checkpoint: null } } as never, facts(), 'en');
    expect(fresh.find(row => row.id === 'security.audit')).toMatchObject({ state: 'untested' });
    expect(fresh.find(row => row.id === 'security.audit')?.next).toBeUndefined();
    const blocked = { ...report, startability: { status: 'blocked' as const, endpoint: null, checks: [{ code: 'X', message: 'ledger missing' }] } };
    expect(renderDoctorChecks(doctorChecks(blocked, facts(), 'en'), 'en').split('\n')[0]).toMatch(/^Status: needs attention · 1 error\(s\)/);
    const clean = doctorChecks({ ...report, imageRefresh: null, recoveryFiles: null }, facts({ identityProfile: { state: 'selected', id: 'solo' }, backupPassphraseStored: false, retiringModels: [] }), 'en')
      .filter(row => row.state !== 'untested');
    expect(renderDoctorChecks(clean, 'en').split('\n')[0]).toBe('Status: ready · no warnings');
  });
  it('tool rows: stale offers the update fix, not-admitted and offline are "not tested" in words (no raw status code)', () => {
    const toolchains = { mode: 'report', registryEndpoint: 'https://registry.npmjs.org', providers: [
      { provider: 'claude', status: 'stale', admitted: [], latest: { version: '2.9.0' } }, { provider: 'codex', status: 'not-admitted', admitted: [], latest: null },
      { provider: 'cursor', status: 'unknown-offline', reason: 'CURRENCY_UNKNOWN_OFFLINE', admitted: [], latest: null }] };
    const rows = doctorChecks({ ...report, toolchains } as never, facts({ toolchainsRequested: true }), 'tr').filter(row => row.group === 'tools');
    expect(rows.map(row => [row.state, row.fix ?? null])).toEqual([['warning', 'toolchain-update'], ['untested', null], ['untested', null]]);
    expect(rows[1]!.text).toBe('codex: bu kurulumda kabul edilmiş sürüm yok, karşılaştırılacak bir şey yok');
    expect(rows.map(row => row.text).join('\n')).not.toContain('not-admitted');
    expect(doctorChecks({ ...report, toolchains } as never, facts({ toolchainsRequested: true, toolchainUpdateEnabled: false }), 'en').find(row => row.id === 'tools.toolchains')?.fix).toBeUndefined();
  });
  it('fixes come from the registry: the hard-floor item is listed and never offered, chmod waits for its policy action', async () => {
    expect(DOCTOR_FIXES.find(fix => fix.id === 'audit-rebaseline')?.hardFloor).toBe(true);
    expect(DOCTOR_FIXES.find(fix => fix.id === 'installation-directory-private')?.policyAction).toBe('installation/repair');
    // The backup passphrase name is the backup schedule's own secret name (one source; a rename fails here).
    expect(await readFile(join(process.cwd(), 'src/composition/core/backup/internal/schedule.ts'), 'utf8')).toContain(`BACKUP_SCHEDULE_SECRET = '${DOCTOR_BACKUP_PASSPHRASE_SECRET}'`);
  });
});

const failedImage = { inspectToolchainRefresh: async () => ({ status: 'failed', reason: 'BUILD_FAILED', imageVersion: null }) };
describe('deckent doctor (command)', () => {
  it('default output is grouped text; --verbose adds the old details; --json keeps the collected report contract', async () => {
    const root = await project();
    const run = async (args: string[]) => { const out: string[] = [];
      await runKernelCommand(['doctor', '--lang', 'en', ...args], { root, env: { HOME: join(root, 'h') }, stdout: { write: (v: string) => { out.push(v); } }, stderr: { write() {} } })
        .catch((error: unknown) => out.push(`[${(error as { code?: string }).code}]`));
      return out.join(''); };
    const grouped = await run([]);
    expect(grouped.split('\n')[0]).toMatch(/^Status: /);
    expect(grouped).toContain('\nInstallation\n');
    expect(grouped).not.toContain('Details (--verbose):');
    const verbose = await run(['--verbose']);
    expect(verbose).toContain('Details (--verbose):');
    expect(verbose).toContain('Platform: ');
    const json = JSON.parse((await run(['--json'])).replace(/\[[A-Z_]+\]$/u, ''));
    expect(json.schemaVersion).toBe(2);
    expect(Object.keys(json)).not.toContain('checks');
    for (const key of ['platform', 'host', 'node', 'status', 'poolReadiness', 'secretStore', 'shellRealm', 'imageRefresh', 'recoveryFiles']) expect(Object.keys(json)).toContain(key);
  });
  // J2e join (delta C-MODELS-for-C-DOCTOR): the retirement row follows the same rule as `deckent models`: a switched-on model whose retirement
  // day is within models.retirementWarningDays (config field) is warned about, even while its catalog lifecycle still reads `active`.
  it('the retirement row uses models.retirementWarningDays: 30 days warns about a model 20 days away, 10 days does not', async () => {
    registerProviderConfig();
    const day = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const catalog = { schemaVersion: 1, scopeId: 'live', channels: [{ channelId: 'api-b', access: 'allowed', revision: 1, providerVersion: 1, catalogRevision: 'r1',
      channel: { kind: 'http-api', cli: null, aliases: [] }, activation: { state: 'active', revision: 1 },
      models: [{ modelId: 'model-later', revision: 1, activation: { state: 'active', revision: 1 }, model: { id: 'model-later', version: 1, nativeId: 'model-later', protocols: [],
        lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: day, retiredOn: null, source: null }, minCliVersion: null, efforts: [], aliases: [] } }] }] };
    for (const [days, warned] of [[30, true], [10, false]] as const) {
      clearConfigCache();
      const root = await project({ terminal: { scopeId: 'live' }, models: { retirementWarningDays: days } }), out: string[] = [];
      await runKernelCommand(['doctor', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, inspectModelCatalog: async () => catalog,
        stdout: { write: (v: string) => { out.push(v); } }, stderr: { write() {} } } as never).catch((error: unknown) => out.push(`[${(error as { code?: string }).code}: ${(error as Error).message}]`));
      const text = out.join('');
      if (warned) expect(text).toContain(`model-later (api-b)`); else expect(text).not.toContain('model-later');
      expect(text).toContain(warned ? 'warning' : 'No active model is being retired');
    }
  });
  it('negative: doctor never heals (rewrites) a corrupt project config; it fails typed and the bytes stay', async () => {
    const root = await project('{broken');
    const before = await readFile(join(root, '.deckent/config.json'));
    const error = await runKernelCommand(['doctor'], { root, env: { HOME: join(root, 'h') }, stdout: { write() {} }, stderr: { write() {} } }).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'CONFIG_FILE_INVALID' });
    expect(await readFile(join(root, '.deckent/config.json'))).toEqual(before);
  });
  it('negative: a pipe, an AI agent or --json is never asked and nothing is applied', async () => {
    const root = await project();
    let applied = 0;
    const tty = { isTTY: true, setRawMode: () => undefined };
    for (const [env, stdin, json] of [[{}, { isTTY: false }, false], [{ CLAUDECODE: '1' }, tty, false], [{}, tty, true]] as const) {
      const out: string[] = [];
      await runKernelCommand(['doctor', '--lang', 'en', ...(json ? ['--json'] : [])], { root, env: { HOME: join(root, 'h'), ...env }, stdin: stdin as never,
        stdout: Object.assign({ write: (v: string) => { out.push(v); } }, { isTTY: true }) as never, stderr: { write() {} }, ...failedImage,
        updateToolchains: async () => { applied++; return { decision: 'built', plan: null, build: null, proposalPath: null }; } } as never).catch(() => undefined);
      expect(out.join('')).not.toContain('Update the worker tools?');
    }
    expect(applied).toBe(0);
  });
});

/**
 * A raw-mode terminal pair: the doctor writes the report and the card to `stdout`. Once the card's key hints are drawn (the window is armed
 * then), `answer` is typed every 300 ms until the doctor reports the outcome, so a slow machine never drops the only key press.
 */
function terminal(answer: string) {
  const written: string[] = [];
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
  let typing: ReturnType<typeof setInterval> | null = null, tries = 0;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) {
    written.push(String(chunk));
    const text = written.join('');
    if (!typing && text.includes('↑↓ choose · Enter confirm · Esc cancel')) {
      typing = setInterval(() => {
        const now = written.join('');
        if (++tries > 30 || now.includes('Not applied') || now.includes('Applying')) { clearInterval(typing!); return; }
        stdin.write(answer);
      }, 300);
      typing.unref();
    }
    done();
  } }), { isTTY: true, columns: 120, rows: 40 });
  return { stdin, stdout, written };
}
describe('interactive doctor (person on a terminal)', () => {
  it('negative: a declined fix changes nothing and the operation is never called', async () => {
    const root = await project(), io = terminal('n');
    let applied = 0;
    await runKernelCommand(['doctor', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, stdin: io.stdin as never, stdout: io.stdout as never, stderr: { write() {} }, ...failedImage,
      updateToolchains: async () => { applied++; return { decision: 'built', plan: null, build: null, proposalPath: null }; } } as never);
    expect(applied).toBe(0);
    expect(io.written.join('')).toContain('Not applied: nothing was changed.');
  });
  it('an accepted fix runs the existing operation once, then measures again', async () => {
    const root = await project(), io = terminal('y');
    const calls: unknown[] = [];
    await runKernelCommand(['doctor', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, stdin: io.stdin as never, stdout: io.stdout as never, stderr: { write() {} }, ...failedImage,
      updateToolchains: async (_root: string, input: unknown) => { calls.push(input); return { decision: 'built', plan: { next: { imageVersion: 'r9-20261019' } }, build: null, proposalPath: '/p.json' }; } } as never);
    expect(calls).toEqual([{ apply: true }]);
    const text = io.written.join('');
    expect(text).toContain('New worker image r9-20261019 built; profile proposal: /p.json');
    // Measured again: the summary line appears twice (before and after); the same fix is not offered a second time in one call.
    expect(text.split('Status: ').length - 1).toBe(2);
  });
  it('negative: a hard-floor row (audit chain) is never offered, even with its operation wired', async () => {
    registerProviderConfig(); // the host registers the `terminal` section (terminal.scopeId) at ingress
    const root = await project({ terminal: { scopeId: 'live' } }), io = terminal('y');
    let rebaselined = 0;
    await runKernelCommand(['doctor', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, stdin: io.stdin as never, stdout: io.stdout as never, stderr: { write() {} },
      verifyAudit: async () => ({ schemaVersion: 1, scopeId: 'live', status: 'chain-broken', reason: 'integrity', head: null, checkpoint: null }),
      rebaselineAudit: async () => { rebaselined++; return {}; } } as never);
    const text = io.written.join('');
    expect(text).toContain('Audit chain: ');
    expect(text).toContain('next: deckent audit verify --scope live');
    expect(text).not.toContain('Apply now');
    expect(rebaselined).toBe(0);
  });
  it('negative: a fix the operation refuses (for example a missing grant) ends with that typed error, after the report', async () => {
    const root = await project(), io = terminal('y');
    const error = await runKernelCommand(['doctor', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, stdin: io.stdin as never, stdout: io.stdout as never, stderr: { write() {} },
      ...failedImage, updateToolchains: async () => { throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); } } as never).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'POLICY_DENIED' });
    expect(io.written.join('')).toContain('Status: ');
  });
});
