import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';
import { ErrorRegistry, t, clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { poolReadinessLines } from '#surfaces/core/cli-admin/index.js';
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
    expect(checks.find(row => row.id === 'setup.identity')?.next).toBe('deckent config');
    // alpha.56 U3: the first work kind is an onboarding step — doctor points to the terminal (/setup), never back to `deckent init`.
    expect(doctorChecks(report, facts({ poolStatus: 'unconfigured' }), 'tr').find(row => row.id === 'work.pool')?.next).toBe("İlk iş türü: deckent'i açın, ilk açılışta ayarlanır (terminalde: /setup)");
    expect(text).toContain('uyarı      Kurulum klasörü başka kullanıcılara açık (mod 0755)');
    expect(text).toContain('sonraki adım: chmod 700 /home/me/.deckent');
    expect(text).toContain('Yedek parolası bu kurulumun içinde saklanıyor'); // J2e: owner wording, joined with C-ADMIN's backup line
    expect(text).toContain('Etkin model model-x (codex-cli) emekliye ayrılıyor (tarih 2026-12-01)');
    expect(text).toContain('sınanmadı  Docker durumu okunamadı'); // PRE-34: unwired/unanswered detection is "not tested", never a guess
    expect(text).toContain('sonraki adım: deckent doctor --toolchains');
    // Internals stay out of the default view (CLI review §doctor findings 1, 2): no socket path, backend id, realm marker or "(-)".
    for (const internal of ['/tmp/dk-', 'core.secret-store', 'terminal.shell.realm', '[deckent]', '(-)', 'ready', 'degraded']) expect(text).not.toContain(internal);
    const en = renderDoctorChecks(doctorChecks(report, facts(), 'en'), 'en');
    expect(en.split('\n')[0]).toMatch(/^Status: ready · \d+ warning\(s\) · \d+ not tested$/);
    expect(en).toContain('Installation\n  ok          Node.js v26.10.0 (minimum 24.22.0)');
  });
  it('PRE-34: the Docker row is the setup decision in the setup\'s words; not reachable is an error only when work is configured to run there', () => {
    const docker = (state: string, code: string, extra: Partial<DoctorCheckFacts> = {}) => doctorChecks(report, facts({ executionEnvironment: { state, reason: { code, params: { runtime: 'Docker', version: '27.3.1' } } }, ...extra }), 'tr')
      .find(row => row.id === 'work.docker')!;
    expect(docker('done', 'setup.execution.ready')).toEqual({ group: 'work', id: 'work.docker', state: 'ok', text: 'Docker 27.3.1 hazır: iş, /do ve teslim onu kullanabilir.' });
    const onboarding = "Çalıştırma ortamı: deckent'i açın, ilk açılışta ayarlanır (terminalde: /setup)";
    expect(docker('blocked', 'setup.execution.stopped')).toMatchObject({ state: 'warning', next: onboarding, text: expect.stringContaining('Docker kurulu ama hizmeti çalışmıyor') });
    expect(docker('blocked', 'setup.execution.stopped', { firstJob: { execution: true, registry: true } })).toMatchObject({ state: 'error', next: onboarding });
    expect(docker('blocked', 'setup.execution.none')).toMatchObject({ state: 'warning', text: expect.stringContaining('Kurulu çalıştırma ortamı yok') });
    expect(docker('blocked', 'setup.execution.noPermission', { firstJob: { execution: true, registry: true } })).toMatchObject({ state: 'error' });
    expect(docker('blocked', 'setup.execution.unknown')).toMatchObject({ state: 'untested' });
    expect(docker('blocked', 'setup.execution.unknown').next).toBeUndefined();
    const en = doctorChecks(report, facts({ executionEnvironment: { state: 'blocked', reason: { code: 'setup.execution.none', params: {} } } }), 'en').find(row => row.id === 'work.docker')!;
    expect(en.text).toBe('No execution environment is installed: work, /do and delivery cannot run. Chat, MCP and governed tools work. Open /setup in the Deckent terminal to set up execution.');
  });
  it('PRE-34: a current worker image without a version names the configured image instead of nothing', () => {
    const image = { ...report, imageRefresh: { status: 'current', reason: null, imageVersion: null } };
    const id = 'sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe';
    expect(doctorChecks(image, facts({ imageId: id }), 'en').find(row => row.id === 'work.image')?.text).toBe('Worker image is current (sha256:8ec5d7557396)');
    expect(doctorChecks(image, facts(), 'en').find(row => row.id === 'work.image')?.text).toBe('Worker image is current');
    expect(doctorChecks({ ...image, imageRefresh: { status: 'current', reason: null, imageVersion: 'v7' } }, facts({ imageId: id }), 'en').find(row => row.id === 'work.image')?.text)
      .toBe('Worker image is current (v7)');
  });
  it('PRE-34: the verbose pool line names the pool row and capacity it read, never a bare "(-)"', () => {
    const pool = { schemaVersion: 1, poolId: 'live', capacity: { executionSlots: 4, inFlightSlots: 6 } } as never;
    expect(poolReadinessLines({ status: 'ready', drift: null, pool }, 'tr')).toEqual(['Havuz hazırlığı: hazır (havuz live, kapasite 4/6: çalışan / değerlendirme dahil)']);
    expect(poolReadinessLines({ status: 'unconfigured', drift: null }, 'en')).toEqual(['Pool readiness: not configured']);
    expect(poolReadinessLines({ status: 'missing', code: 'RUN_POOL_REQUIRED', drift: null }, 'en')[0]).toContain('(RUN_POOL_REQUIRED)');
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
  it('M2: a catalog model with no tier/role row is a warning "new model: role pending" with its exact set command, bounded by the registry', () => {
    const pending = Array.from({ length: 7 }, (_, index) => ({ modelId: `model-new-${index}`, channelId: 'anthropic-api' }));
    const en = doctorChecks(report, facts({ pendingRoleModels: pending }), 'en').filter(row => row.id === 'work.modelRoles');
    expect(en).toHaveLength(6);
    expect(en[0]).toMatchObject({ state: 'warning', text: 'New model: role pending — model-new-0 (anthropic-api); no role may use it until a person assigns one',
      next: 'deckent models roles set --channel anthropic-api --model model-new-0 --tier <tier> --roles <roles> --scope live' });
    expect(en[5]).toMatchObject({ state: 'warning', text: 'New model: role pending — 2 more catalog models; see deckent models roles', next: 'deckent models roles --scope live' });
    expect(doctorChecks(report, facts({ pendingRoleModels: pending.slice(0, 1) }), 'tr').find(row => row.id === 'work.modelRoles')?.text).toContain('Yeni model: rol bekliyor');
    for (const value of [[], null, undefined]) expect(doctorChecks(report, facts({ pendingRoleModels: value }), 'en').some(row => row.id === 'work.modelRoles')).toBe(false);
  });
  it('S3-3 "Brain girişi": each subscription login with its kind, plan, directory, channel state and consent; no check yet is "not tested"', () => {
    const logins = [{ state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.claude', consent: ['ai', 'system'] },
      { state: 'closed' as const, authMethod: null, subscriptionType: null, configDir: '/home/p/.claude-team', consent: [] },
      { state: 'unknown' as const, authMethod: null, subscriptionType: null, configDir: '/home/p/.other', consent: [] }];
    const rows = doctorChecks(report, facts({ headlessLogins: logins }), 'tr').filter(row => row.id === 'work.brainLogin');
    expect(rows.map(row => [row.state, row.text, row.next])).toEqual([
      ['ok', 'Brain girişi: claude.ai (max), dizin /home/p/.claude, kanal açık, onay ai, system', undefined],
      ['warning', 'Brain girişi: -, dizin /home/p/.claude-team, kanal kapalı, onay yok (yalnız siz)', 'deckent models connect --scope live'],
      ['untested', 'Brain girişi: henüz denetlenmedi (dizin /home/p/.other); ilk çağrı ya da yeniden bağlama denetimi koşar', undefined]]);
    expect(doctorChecks(report, facts({ headlessLogins: logins.slice(0, 1) }), 'en').find(row => row.id === 'work.brainLogin')?.text)
      .toBe('Brain login: claude.ai (max), directory /home/p/.claude, channel open, consent ai, system');
    for (const value of [[], null, undefined]) expect(doctorChecks(report, facts({ headlessLogins: value }), 'en').some(row => row.id === 'work.brainLogin')).toBe(false);
  });
  it('s3c "Brain girişi" names the Brain\'s own login dir; a connection sealed to another dir keeps working and the next step is the move', () => {
    const logins = [{ state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.deckent/headless/logins/claude', owned: true, consent: [] },
      { state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.claude', owned: false, consent: [] }];
    expect(doctorChecks(report, facts({ headlessLogins: logins }), 'en').filter(row => row.id === 'work.brainLogin').map(row => [row.state, row.text, row.next])).toEqual([
      ['ok', 'Brain login: claude.ai (max), directory /home/p/.deckent/headless/logins/claude, channel open, consent none (you only); the Brain\'s own login directory', undefined],
      ['ok', 'Brain login: claude.ai (max), directory /home/p/.claude, channel open, consent none (you only); not the Brain\'s own login directory (it keeps working): sign the '
        + 'Brain\'s own in, then connect again', 'deckent models login --connection claude-cli-subscription']]);
    expect(doctorChecks(report, facts({ headlessLogins: logins.slice(1) }), 'tr').find(row => row.id === 'work.brainLogin')?.text).toContain("Brain'in kendi giriş dizini değil");
  });
  it('S3-5 "Brain girişi" names the isolation realm of the last passing check, or that the realm closed the channel', () => {
    const logins = [{ state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.claude', consent: [], isolation: { launcher: 'bundled', version: '0.13.0' } },
      { state: 'closed' as const, authMethod: null, subscriptionType: null, configDir: '/home/p/.claude', consent: [], isolation: 'unavailable' as const }];
    expect(doctorChecks(report, facts({ headlessLogins: logins }), 'en').filter(row => row.id === 'work.brainLogin').map(row => [row.state, row.text])).toEqual([
      ['ok', 'Brain login: claude.ai (max), directory /home/p/.claude, channel open, consent none (you only); isolated by bubblewrap 0.13.0 (bundled)'],
      ['warning', 'Brain login: -, directory /home/p/.claude, channel closed, consent none (you only); isolation unavailable (no usable bubblewrap: see the sandbox rows)']]);
    expect(doctorChecks(report, facts({ headlessLogins: logins.slice(0, 1) }), 'tr').find(row => row.id === 'work.brainLogin')?.text).toContain('bubblewrap 0.13.0 (bundled) ile yalıtılmış');
  });
  it('f5 "Brain girişi" names the realm gateway refusals: counts and host names (most refused first, bounded), never a payload', () => {
    const egress = { refused: 9, hosts: ['h1.example', 'h2.example', 'h3.example', 'h4.example', 'h5.example', 'h6.example', 'h7.example'], other: 1 };
    const login = { state: 'open' as const, authMethod: 'claude.ai', subscriptionType: null, configDir: '/home/p/.claude', consent: [], isolation: null, egress };
    expect(doctorChecks(report, facts({ headlessLogins: [login] }), 'en').find(row => row.id === 'work.brainLogin')?.text).toBe('Brain login: claude.ai, directory '
      + '/home/p/.claude, channel open, consent none (you only); network: 9 connection(s) outside the provider allowlist refused (hosts: h1.example, h2.example, h3.example, '
      + 'h4.example, h5.example and 2 more)');
    expect(doctorChecks(report, facts({ headlessLogins: [{ ...login, egress: { refused: 1, hosts: [], other: 1 } }] }), 'tr').find(row => row.id === 'work.brainLogin')?.text)
      .toContain('; ağ: sağlayıcı izin listesi dışında 1 bağlantı reddedildi (adresler: -)');
    expect(doctorChecks(report, facts({ headlessLogins: [{ ...login, egress: null }] }), 'en').find(row => row.id === 'work.brainLogin')?.text).not.toContain('network');
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
    // C-DOCTOR follow-up (J3): one status only — the grouped summary; the old report's ready/degraded line is not repeated.
    expect(verbose.match(/^Status: /gmu)).toHaveLength(1);
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

describe('PRE-8 v2: doctor names the keys a model here cannot use, with the exact next command (lead 2026-10-21)', () => {
  it('pure rows EN/TR: no grant, undeclared project key, declared but not stored, granted but not stored', () => {
    const secretUse = [{ kind: 'grant-required' as const, name: 'DECKENT_ANTHROPIC_KEY' }, { kind: 'undeclared-project-key' as const, name: 'OWN_KEY' },
      { kind: 'declared-missing' as const, name: 'GLM_KEY' }, { kind: 'not-stored' as const, name: 'OPENAI_API_KEY' }];
    for (const locale of ['en', 'tr'] as const) {
      const rows = doctorChecks(report, facts({ secretUse }), locale).filter(row => row.id === 'security.secretUse');
      expect(rows.map(row => [row.state, row.next])).toEqual([['warning', 'deckent secret grant DECKENT_ANTHROPIC_KEY --scope live'], ['warning', expect.stringContaining('OWN_KEY=project')],
        ['warning', 'deckent secret set GLM_KEY --project --scope live'], ['warning', 'deckent secret set OPENAI_API_KEY --main --scope live']]);
      for (const row of rows) expect(row.text).not.toMatch(/\{\w+\}/u);
    }
    expect(doctorChecks(report, facts({ secretUse: [] }), 'en').some(row => row.id === 'security.secretUse')).toBe(false);
  });
  it('the shipped doctor reads the one inventory (names only) for the terminal scope and prints the rows', async () => {
    const root = await project({ terminal: { scopeId: 'live' } }), out: string[] = [], asked: unknown[] = [];
    await runKernelCommand(['doctor', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, stdout: { write: (v: string) => { out.push(v); } }, stderr: { write() {} },
      inspectSecretInventory: async (_root: string, input: unknown) => { asked.push(input); return { schemaVersion: 1, project: root, mainStore: 'core.secret-store.env@1', all: false,
        rows: [{ name: 'DECKENT_ANTHROPIC_KEY', vault: 'main', project: root, usedBy: ['claude@1'], deck: 'undeclared', grant: { state: 'none' }, presence: 'unverified' }],
        findings: [{ kind: 'grant-required', name: 'DECKENT_ANTHROPIC_KEY', project: root }] }; } } as never).catch((error: unknown) => out.push(`[${(error as { code?: string }).code}]`));
    expect(asked).toEqual([{ scopeId: 'live', all: false }]);
    expect(out.join('')).toContain('Key DECKENT_ANTHROPIC_KEY is used by a model here but not granted to this project');
    expect(out.join('')).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope live');
  });
});

it('reports an unreadable catalog monitor as not tested and no row when the monitor has nothing to say (HAF-37)', () => {
  expect(doctorChecks(report, facts({ catalogDiagnostics: null }), 'tr').find(row => row.id === 'security.catalogSigner')).toMatchObject({ state: 'untested' });
  expect(doctorChecks(report, facts({ catalogDiagnostics: [] }), 'en').some(row => row.id === 'security.catalogSigner')).toBe(false);
});

it('doctor shares the catalog signer warning and uses the observed aggregator identity in its next command', () => {
  const checks = doctorChecks(report, facts({ catalogDiagnostics: ['catalog-aggregator-unsigned:["live","local/catalog-aggregator","person"]'] }), 'tr');
  const warning = checks.find(row => row.id === 'security.catalogSigner')!;
  expect(warning.state).toBe('warning'); expect(warning.next).toContain("--principal 'local/catalog-aggregator:person'");
  expect(warning.next).toContain("--scope 'live'"); expect(warning.next).not.toContain('<issuer>');
});

it('parses every doctor next-step command from the generated warning rows through the real CLI, including subscription and model guidance', async () => {
  const root = await project(), stopped = async () => { throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE'); };
  const variants = [facts({ catalogDiagnostics: ['catalog-aggregator-unsigned:["live","local/catalog-aggregator","person"]'],
    headlessLogins: [{ state: 'closed', authMethod: null, subscriptionType: null, configDir: '/tmp/login', consent: [] }] }),
    facts({ headlessLogins: [{ state: 'closed', authMethod: null, subscriptionType: null, configDir: '/tmp/login', owned: false, consent: [] }], poolStatus: 'missing' })];
  variants.push(facts({ poolStatus: 'drift', pendingRoleModels: [{ channelId: 'fixture-channel', modelId: 'fixture-model' }],
    secretUse: [{ kind: 'grant-required', name: 'FIXTURE_KEY' }, { kind: 'declared-missing', name: 'FIXTURE_KEY' }, { kind: 'not-stored', name: 'FIXTURE_KEY' }] }));
  const reports = [report, { ...report, serviceConfig: 'stale', policyAdministration: { usableAdminCount: 0, bootstrapRequired: false, recoveryRequired: true },
    installationBinding: { capability: 'source-invalid', strength: null, source: 'platform' }, auditIntegrity: { status: 'unknown', reason: 'unavailable' },
    modelInvocationDelivery: [{ profileId: 'fixture', reference: { modelId: 'fixture' }, surface: 'mcp' }, { profileId: 'fixture', reference: { modelId: 'fixture' }, surface: 'service' }] }];
  const commands = new Set(reports.flatMap(r => variants.flatMap(f => doctorChecks(r as never, f, 'en'))).flatMap(row => row.next?.match(/deckent [^;\n]+/gu) ?? []));
  commands.add(t('error.HEADLESS_DELEGATION_REFUSED', {}, 'en').match(/`(deckent [^`]+)`/u)![1]!);
  for (const command of commands) {
    const errors: string[] = [];
    const words = command.match(/'[^']*'|"[^"]*"|\S+/gu)!.map(word => word.replace(/^['"]|['"]$/gu, ''));
    const argv = words.slice(1).map(word => word.startsWith('<') ? word === '<n>' ? '2' : word === '<tier>' ? 'frontier' : word.includes('disabled') ? 'disabled' : word.includes('claude') ? 'claude' : 'fixture' : word);
    const context = { root, env: { DECKENT_GLOBAL_HOME: join(root, 'global'), TERM: 'xterm' }, locale: 'en' as const,
      stdin: { isTTY: true } as never, stdout: { isTTY: true, write() {} }, stderr: { write: (s: string) => { errors.push(s); } },
      configApplication: () => ({ inspect: stopped, explain: stopped }) as never, openConfigPanel: async () => [], restartRuntimeService: stopped,
      inspectModelCatalog: stopped, inspectModelRoles: stopped, assignModelRole: stopped, setSecret: stopped, setProjectSecret: stopped, changeSecretGrant: stopped, listSecretStores: stopped, inspectPolicyAdministration: stopped, listSecretNames: stopped, inspectSecretStore: stopped, initializeNativeCodingRegistry: stopped,
      installConfiguredExecutionPool: stopped, inspectPoolCapacity: stopped, verifyAudit: stopped, loginHeadless: stopped, connectModel: stopped, updateToolchains: stopped, inspectToolchainCurrency: stopped };
    await main(argv, context as never);
    expect(errors.join(''), command).not.toMatch(/CLI_USAGE|CLI_ARGUMENT_MISSING|CLI_CONFIG_VALUE_MISSING/u);
  }
});


it('shows scoped ChatGPT custody refusals without account labels, tokens or host paths', () => {
  const reference = { providerId: 'fixture-subscription', providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 };
  const rows = doctorChecks(report, facts({ siwcConnections: [{ reference, connection: 'fixture-subscription', state: 'unavailable', planUse: false,
    code: 'SIWC_STORE_NOT_PERSONAL', reason: 'profile-unresolved' }] }), 'tr').filter(row => row.id === 'work.chatgptConnection');
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ state: 'warning', next: 'deckent models connect --connection fixture-subscription --scope live' });
  expect(rows[0]!.text).toContain('kimlik profili');
  expect(JSON.stringify(rows)).not.toContain('/home/');
});

it('names an open secret folder ssh-style with chmod 700 and says when ChatGPT sign-in custody would refuse (FIX8b E01, R22)', () => {
  const store = (extra: object) => ({ ...report, secretStore: { ...report.secretStore, ...extra } }) as typeof report;
  const custody = (extra: object, locale: 'en' | 'tr' = 'en') => doctorChecks(store(extra), facts(), locale).filter(row => row.id.startsWith('security.secretsRoot') || row.id === 'security.siwcCustody');
  const open = custody({ globalRoot: { path: '/fixture/global', mode: '0755' }, personalCustody: { status: 'refused', reason: 'unsafe-root', path: '/fixture/global', mode: '0755', folder: 'root' } });
  // One fix for one folder: the root row carries the exact command; the custody row would only repeat it.
  expect(open).toEqual([expect.objectContaining({ id: 'security.secretsRoot', state: 'warning', next: 'chmod 700 /fixture/global' })]);
  expect(open[0]!.text).toContain('0755');
  const parent = custody({ personalCustody: { status: 'refused', reason: 'unsafe-root', path: '/tmp', mode: '1777', folder: 'parent' } }, 'tr');
  expect(parent).toHaveLength(1); expect(parent[0]!.text).toContain('/tmp'); expect(parent[0]!.next).toBeUndefined();
  expect(custody({ personalCustody: { status: 'refused', reason: 'unknown-locality' } })[0]!.text).toContain('local disk');
  expect(custody({ backend: 'core.secret-store.env@1', personalCustody: { status: 'store' } })[0]).toMatchObject({ state: 'warning', next: 'deckent secret store --to core.secret-store.encrypted-file@1' });
  expect(custody({ personalCustody: { status: 'ready' } })[0]).toMatchObject({ state: 'ok' });
});

it('BeUser D-01: doctor never prescribes `runtime restart` while a worker image build runs in the service; it says to let the build finish', async () => {
  const row = (extra: object) => doctorChecks({ ...report, serviceConfig: 'stale', ...extra } as never, facts(), 'en').find(item => item.id === 'setup.service')!;
  expect(row({})).toMatchObject({ next: 'deckent runtime restart' });
  const building = row({ imageBuilding: true });
  expect(building.next).toBe('/setup'); expect(building.text).toContain('a worker image build is running');
});
