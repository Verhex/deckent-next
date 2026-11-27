import fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as surface from '#surfaces/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { ErrorRegistry, t, clearConfigCache, loadConfig, productResourcePath, readHeadlessDiagnosticRecord, serializeJsonDocument } from '#platform/index.js';
import { registerProviderConfig, captureAttachmentLocation } from '#adapters/index.js';
import { evaluatePolicy, firstRunExecutionRules, mcpPrincipalRef, readableInstallationRegistrationSchema, resolvePolicyBindings } from '#domain/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { configuredAttachmentStore } from '#composition/core/scoped-request/index.js';
import { main as cliMain } from '#composition/core/cli/index.js';
import { runKernelCommand } from '#surfaces/core/cli/index.js';
import { doctorVerdict } from '#surfaces/core/cli-observe/index.js';
import { executionPermissionCoverage, planSetup, SetupStageRegistry, type SetupObservation } from '#engine/index.js';
import { renderSetupLines } from '#surfaces/core/setup/index.js';
import { poolReadinessLines } from '#surfaces/core/cli-admin/index.js';
import { terminalAdminPorts } from '#surfaces/core/terminal-admin/index.js';
import { EMPTY_SESSION_USAGE } from '#surfaces/core/terminal-kit/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { closedPreflightRefusal } from '#adapters/core/native-cli-headless/index.js';
import { argumentCountRefusal } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { producedSandboxRefusal, UNPRODUCIBLE_SANDBOX_REFUSAL } from '../../fixtures/native-headless/sandbox-refusal.js';
import { DOCTOR_BACKUP_PASSPHRASE_SECRET, DOCTOR_FIXES, doctorChecks, doctorReadinessChecks, firstJobKind, renderDoctorChecks, renderDoctorReport, type DoctorCheckFacts } from '#surfaces/core/doctor/index.js';

// C-DOCTOR (alpha.48, CLI review 2026-10-19 §doctor): grouped rows, word markers, one next step per warning, internals behind --verbose,
// the schema-2 --json report with additive health counts, and the interactive fix offer only on a person's terminal through an existing operation.
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
  it('describes a parked run without inferring a failure count (EN/TR)', () => {
    for (const [locale, expected] of [
      ['en', 'Run run-fixture is parked (HEADLESS_PREFLIGHT_FAILED__CHECK_LOCK_DIRECTORY_CREATE). The sign-in lock directory could not be created.'],
      ['tr', 'run-fixture işi beklemede (HEADLESS_PREFLIGHT_FAILED__CHECK_LOCK_DIRECTORY_CREATE). Giriş kilidi dizini oluşturulamadı.'],
    ] as const) {
      const checks = doctorChecks(report, facts({ stuckRuns: [{ runId: 'run-fixture', code: 'HEADLESS_PREFLIGHT_FAILED__CHECK_LOCK_DIRECTORY_CREATE' }] }), locale);
      expect.soft(checks.find(row => row.id === 'work.stuckRun')?.text).toBe(expected);
    }
    // C3: a registered short code outside the reason allowlist is named as the recorded code, its cause not determined.
    expect(doctorChecks(report, facts({ stuckRuns: [{ runId: 'run-fixture', code: 'HEADLESS_CREDITS_REQUIRED' }] }), 'en').find(row => row.id === 'work.stuckRun')?.text)
      .toBe('Run run-fixture is parked (HEADLESS_CREDITS_REQUIRED). The record contains the error code HEADLESS_CREDITS_REQUIRED. The specific cause could not be determined.');
  });
  it('the Doctor command accepts a validated dotted version identifier without exposing malformed details', async () => {
    const root = await project();
    const code = 'HEADLESS_PREFLIGHT_FAILED__CHECK_VERSION__REASON_TOO_OLD__2.0.0__1.0.0';
    const snapshot = { installs: [{ runs: [
      { runId: 'fixture-run', blocker: { code: 'parked', detail: code } },
      { runId: 'private-run', blocker: { code: 'parked', detail: code.replace(/1\.0\.0$/u, '/private/fixture') } },
    ] }] };
    for (const [locale, expected] of [
      ['en', 'Run fixture-run is parked'],
      ['tr', 'fixture-run işi beklemede'],
    ] as const) {
      let output = '';
      await runKernelCommand(['doctor', '--lang', locale], { root, env: { HOME: join(root, 'h') },
        inspectMonitor: (async () => snapshot) as never, stdout: { write: chunk => { output += chunk; } } });
      expect(output).toContain(expected);
      expect(output).toContain(code);
      expect(output).not.toMatch(/private-run|\/private\/fixture/u);
    }
  });
  // BeUser S-11: "Where your data can go" lists the configured outbound routes as facts, last, and says plainly that no telemetry is sent.
  it('lists where data can go: local and remote models, web fetch, MCP servers, the toolchain check, workers, Hub and no telemetry (EN/TR)', () => {
    const egress = { models: [{ name: 'openai-chat-http', host: '127.0.0.1', local: true }, { name: 'anthropic', host: 'api.anthropic.com', local: false }],
      fetch: { mode: 'allowlist', hosts: ['docs.example.com'] }, toolchainCheck: 'registry.npmjs.org', mcp: [{ name: 'gh', host: 'api.github.com', realm: null }] };
    const en = renderDoctorChecks(doctorChecks(report, facts({ egress }), 'en'), 'en');
    for (const locale of ['en', 'tr'] as const) {
      const checks = doctorChecks(report, facts({ egress: { ...egress, models: [...Array.from({ length: 7 }, () => egress.models[1]!), egress.models[0]!] } }), locale).filter(row => row.id === 'data.egress');
      expect(checks.filter(row => row.text.includes('Model anthropic:'))).toHaveLength(7);
      expect(renderDoctorChecks(checks, locale).match(/Model anthropic:/gu)).toHaveLength(1);
      expect(renderDoctorChecks(checks, locale)).toContain(`${checks[0]!.text} × 7`);
      expect(renderDoctorChecks(checks, locale)).toContain('Model openai-chat-http: 127.0.0.1');
    }
    expect(en.split('\n').indexOf('Where your data can go')).toBeGreaterThan(en.split('\n').indexOf('Tools'));
    for (const text of ['Model openai-chat-http: 127.0.0.1, on this machine', 'Model anthropic: api.anthropic.com, a remote service', 'only these hosts: docs.example.com',
      'MCP server gh: api.github.com', 'Toolchain version check: registry.npmjs.org', 'deckent sends no telemetry or usage data']) expect(en).toContain(text);
    expect(renderDoctorChecks(doctorChecks(report, facts({ egress: { ...egress, models: [] } }), 'tr'), 'tr')).toContain('Yapılandırılmış model bağlantısı yok');
  });
  it('groups rows under Kurulum / Güvenlik / Çalışma / Araçlar with word markers, a summary first and one next step per warning', () => {
    for (const locale of ['en', 'tr'] as const) {
      const unavailable = doctorChecks(report, facts({ workerKinds: [{ kind: 'missing-code', reason: 'image-missing', rebind: true }, { kind: 'prepared-code', reason: 'image-unverified', rebind: false }, // owner 114 below: the true reason wins
        { kind: 'probe-a', reason: 'image-missing', rebind: false, notRunnable: 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' }, { kind: 'docker-t', reason: null, rebind: true, notRunnable: 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' }] }), locale).filter(row => row.id === 'work.kind');
      expect(unavailable).toHaveLength(4);
      expect(unavailable[0]).toMatchObject({ group: 'work', state: 'warning' });
      expect(unavailable[0]!.text).toContain(locale === 'en' ? 'worker image is missing' : 'işçi imajı eksik');
      expect(unavailable[0]!.next).toContain('deckent coding template --kind missing-code --connection <id>');
      expect(unavailable[1]!.next).toContain('deckent coding --json'); expect(unavailable[1]!.next).not.toContain('--connection');
      expect(unavailable.slice(2).map(row => [row.state, row.next])).toEqual([['warning', undefined], ['warning', expect.stringContaining('template --kind docker-t --connection <id>')]]); // a prepared profile: no step
      expect(unavailable[2]!.text).toBe(locale === 'en' ? "Task kind probe-a cannot run: it runs its CLI in Docker, and deckent does not use this CLI's login in Docker." : "probe-a iş türü çalıştırılamaz: CLI'sini Docker içinde çalıştırır ve deckent bu CLI'nin oturumunu Docker'da kullanmaz.");
    }
    expect(renderDoctorReport(report, [], 'tr')).toContain("deckent'in işçileri ve yalıtım alanı bu anahtarları okuyamaz; sizin hesabınızla çalışan diğer programlar okuyabilir.");
    expect(renderDoctorReport(report, [], 'en')).toContain("deckent's workers and sandbox cannot read them; other programs running as your user can.");
    const checks = doctorChecks(report, facts(), 'tr');
    for (const check of checks.filter(row => row.state === 'warning' || row.state === 'error')) expect(check.next, check.id).toBeTruthy();
    const budget = doctorChecks(report, facts({ budgetPeriodText: 'No API budget yet' }), 'en').find(row => row.id === 'work.budgetPeriod');
    expect(budget).toMatchObject({ state: 'warning', next: 'deckent models create-budget --usd <amount> --scope live' });
    const text = renderDoctorChecks(checks, 'tr');
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Durum: ilgi bekliyor · \d+ uyarı · \d+ sınanmadı$/); // owner 114: the report's failed image refresh is never "ready"
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
    expect(en.split('\n')[0]).toMatch(/^Status: needs attention · \d+ warning\(s\) · \d+ not tested$/);
    expect(renderDoctorChecks(doctorChecks({ ...report, imageRefresh: null }, facts(), 'en'), 'en').split('\n')[0]).toMatch(/^Status: ready · /u);
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
    expect(en.text).toBe('No execution environment is installed: work, /do and delivery cannot run. Chat, MCP and governed tools work. Open /setup in the deckent terminal to set up execution.');
    // R8b: work set up on a connected subscription (execution without Docker) is not told to set Docker up.
    expect(docker('blocked', 'setup.execution.none', { firstJob: { execution: false, registry: true, connection: true } })).toEqual({ group: 'work', id: 'work.docker', state: 'ok',
      text: 'Docker gerekmez: işler bağlı aboneliğinle bu bilgisayarda deckent\'in korumalı alanında çalışır.' });
  });
  it('PRE-34: a current worker image without a version names the configured image instead of nothing', () => {
    const image = { ...report, imageRefresh: { status: 'current', reason: null, imageVersion: null } };
    const id = 'sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe';
    expect(doctorChecks(image, facts({ imageId: id }), 'en').find(row => row.id === 'work.image')?.text).toBe('Worker image is current (sha256:8ec5d7557396)');
    expect(doctorChecks(image, facts(), 'en').find(row => row.id === 'work.image')?.text).toBe('Worker image is current');
    expect(doctorChecks({ ...image, imageRefresh: { status: 'current', reason: null, imageVersion: 'v7' } }, facts({ imageId: id }), 'en').find(row => row.id === 'work.image')?.text)
      .toBe('Worker image is current (v7)');
    for (const locale of ['en', 'tr'] as const) { const failed = doctorChecks(report, facts({ imageId: id }), locale).find(row => row.id === 'work.image')!; expect(failed.fix).toBeUndefined(); // owner 114
      expect(failed).toMatchObject({ state: 'warning', needsAttention: true, next: expect.stringMatching(/deckent runtime restart$/u), text: locale === 'en' ? 'The last worker image refresh failed (BUILD_FAILED); task kinds keep the image they pin' : 'Son işçi imajı yenilemesi başarısız (BUILD_FAILED); iş türleri sabitledikleri imajı korur' }); }
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
    expect(fresh.find(row => row.id === 'security.audit')?.next).toContain('deckent audit verify --scope live');
    expect(fresh.find(row => row.id === 'security.audit')?.next).toContain('does not create a checkpoint');
    for (const locale of ['en', 'tr'] as const) {
      const audit = doctorChecks({ ...report, auditIntegrity: { schemaVersion: 1, scopeId: 'live', status: 'unknown', reason: 'no-checkpoint-yet', head: null, checkpoint: null } } as never, facts(), locale).filter(row => row.id === 'security.audit');
      expect(audit[0]!.next).toContain('deckent runtime serve');
      expect(audit[0]!.next).toContain('deckent audit verify --scope live');
      expect(audit[0]).toMatchObject({ needsAttention: true });
      expect(renderDoctorChecks(audit, locale).split('\n')[0]).toBe(locale === 'en' ? 'Status: needs attention · 1 not tested · no warnings' : 'Durum: ilgi bekliyor · 1 sınanmadı · uyarı yok');
    }
    expect(doctorChecks({ ...report, auditIntegrity: { schemaVersion: 1, scopeId: 'live', status: 'match', head: null, checkpoint: null } } as never, facts(), 'en')
      .find(row => row.id === 'security.audit')).toMatchObject({ state: 'ok' });
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
    expect(en[0]).toMatchObject({ state: 'warning', text: 'New model: role pending — model-new-0 (anthropic-api); no tier-based role may use it until a person assigns one',
      next: 'deckent models roles set --channel anthropic-api --model model-new-0 --tier <tier> --roles <roles> --scope live' });
    expect(en[5]).toMatchObject({ state: 'warning', text: 'New model: role pending — 2 more catalog models; see deckent models roles', next: 'deckent models roles --scope live' });
    expect(doctorChecks(report, facts({ pendingRoleModels: pending.slice(0, 1) }), 'tr').find(row => row.id === 'work.modelRoles')?.text).toContain('Yeni model: rol bekliyor');
    for (const value of [[], null, undefined]) expect(doctorChecks(report, facts({ pendingRoleModels: value }), 'en').some(row => row.id === 'work.modelRoles')).toBe(false);
  });
});

describe('doctor subscription rows (pure)', () => {
  it('S3-3 "Brain girişi": each subscription login with its kind, plan, directory, channel state and consent; unavailable verification is shown as unknown', () => {
    const logins = [{ state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.claude', consent: ['ai', 'system'] },
      { state: 'closed' as const, authMethod: null, subscriptionType: null, configDir: '/home/p/.claude-team', consent: [] },
      { state: 'unknown' as const, authMethod: null, subscriptionType: null, configDir: '/home/p/.other', consent: [] }];
    const connection = { profile: 'local-profile', tools: 'unknown' as const, stale: false };
    expect(doctorChecks(report, facts({ modelConnections: [connection] }), 'en').find(row => row.id === 'work.modelConnection')).toMatchObject({ state: 'warning', text: 'local-profile · tool support unknown', next: 'deckent models connect --scope live' });
    expect(doctorChecks(report, facts({ modelConnections: [{ ...connection, tools: 'none' }] }), 'tr').find(row => row.id === 'work.modelConnection')?.text).toContain('araç');
    expect(doctorChecks(report, facts({ modelConnections: [{ ...connection, tools: 'available' }] }), 'en').some(row => row.id === 'work.modelConnection')).toBe(false);
    expect(doctorChecks(report, facts({ modelConnections: [{ ...connection, stale: true }] }), 'en').find(row => row.id === 'work.modelConnection')?.text).toContain('No matching current invocation profile');
    for (const locale of ['en', 'tr'] as const) {
      const updated = doctorChecks(report, facts({ headlessLogins: [{ ...logins[0]!, cliUpdated: { cli: 'fixture-cli', from: '1', to: '2' } }] }), locale).find(row => row.id === 'work.cliUpdated');
      expect(updated?.text).toBe(locale === 'en' ? 'CLI fixture-cli updated 1 → 2 (checked again before use)' : 'CLI fixture-cli güncellendi: 1 → 2 (kullanmadan önce yeniden denetlendi)');
      const checks = doctorChecks(report, facts({ headlessLogins: [...Array.from({ length: 7 }, () => logins[0]!), logins[1]!] }), locale).filter(row => row.id === 'work.brainLogin');
      const before = JSON.stringify(checks), rendered = renderDoctorChecks(checks, locale);
      expect(checks).toHaveLength(8);
      expect(rendered.match(/(?:Brain login|Brain girişi):/gu)).toHaveLength(2);
      expect(rendered).toContain(`${checks[0]!.text} × 7`);
      expect(rendered).toContain(checks[7]!.text);
      // Different next steps stay separate even when the subject and state are identical.
      expect(renderDoctorChecks([{ ...checks[0]!, next: 'first' }, { ...checks[0]!, next: 'second' }], locale)).not.toContain('×');
      expect(JSON.stringify(checks)).toBe(before);
    }
    const rows = doctorChecks(report, facts({ headlessLogins: logins }), 'tr').filter(row => row.id === 'work.brainLogin');
    expect(rows.map(row => [row.state, row.text, row.next])).toEqual([
      ['ok', 'Brain girişi: claude.ai (max), dizin /home/p/.claude, kanal son kaydedilen denetimde açık (şimdi doğrulanmadı), onay ai, system', undefined],
      ['warning', 'Brain girişi: -, dizin /home/p/.claude-team, kanal kapalı, onay yok (yalnız siz)', undefined],
      ['untested', 'Brain girişi: güncel doğrulama kullanılamıyor (dizin /home/p/.other).', undefined]]);
    expect(doctorChecks(report, facts({ headlessLogins: logins.slice(0, 1) }), 'en').find(row => row.id === 'work.brainLogin')?.text)
      .toBe('Brain login: claude.ai (max), directory /home/p/.claude, channel open at the last recorded check (not verified now), consent ai, system');
    for (const value of [[], null, undefined]) expect(doctorChecks(report, facts({ headlessLogins: value }), 'en').some(row => row.id === 'work.brainLogin')).toBe(false);
  });
  it('s3c "Brain girişi" names the Brain\'s own login dir; a connection sealed to another dir keeps working and the next step is the move', () => {
    // Historical open status supports checking current status before any sign-in or reconnect.
    const logins = [{ state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.deckent/headless/logins/claude', owned: true, consent: [] },
      { state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.deckent/custom', owned: false, connection: 'claude-cli-subscription', consent: [] }];
    expect(doctorChecks(report, facts({ headlessLogins: logins }), 'en').filter(row => row.id === 'work.brainLogin').map(row => [row.state, row.text, row.next])).toEqual([
      ['ok', 'Brain login: claude.ai (max), directory /home/p/.deckent/headless/logins/claude, channel open at the last recorded check (not verified now), consent none (you only); the Brain\'s own login directory', undefined],
      ['ok', "Brain login: claude.ai (max), directory /home/p/.deckent/custom, channel open at the last recorded check (not verified now), consent none (you only); not the Brain's own login directory. "
        + "Verify the connection's current status before acting.", undefined]]);
    expect(doctorChecks(report, facts({ headlessLogins: logins.slice(1) }), 'tr').find(row => row.id === 'work.brainLogin')?.text).toContain(
      "Brain'in kendi giriş dizini değil. İşlem yapmadan önce bağlantının güncel durumunu doğrulayın.");
    const outside = { ...logins[1]!, configDir: '/fixture/external', governedUse: 'outside-installation' as const };
    for (const locale of ['en', 'tr'] as const) {
      const shown = doctorChecks(report, facts({ headlessLogins: [outside] }), locale).find(row => row.id === 'work.brainLogin')!;
      expect(shown.state).toBe('warning');
      expect(shown.text).toContain(locale === 'en' ? 'Governed chat and workers are not ready' : 'yönetilen sohbet ve işçiler hazır değil');
      expect(shown.next).toContain('deckent models login --connection claude-cli-subscription');
      expect(shown.next).toContain('--config-dir');
      const unresolved = doctorChecks(report, facts({ headlessLogins: [{ state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/fixture/external', owned: false,
        governedUse: 'outside-installation' as const, consent: [] }] }), locale).find(row => row.id === 'work.brainLogin')!;
      expect(unresolved.state).toBe('warning');
      expect(unresolved.text).toContain(locale === 'en' ? 'Governed chat and workers are not ready' : 'yönetilen sohbet ve işçiler hazır değil');
      expect(unresolved.next).toBeUndefined();
    }
  });
  it('S3-5 "Brain girişi" names the isolation realm of the last passing check, or that the realm closed the channel', () => {
    const logins = [{ state: 'open' as const, authMethod: 'claude.ai', subscriptionType: 'max', configDir: '/home/p/.claude', consent: [], isolation: { launcher: 'bundled', version: '0.13.0' } },
      { state: 'closed' as const, authMethod: null, subscriptionType: null, configDir: '/home/p/.claude', consent: [], isolation: 'unavailable' as const }];
    expect(doctorChecks(report, facts({ headlessLogins: logins }), 'en').filter(row => row.id === 'work.brainLogin').map(row => [row.state, row.text])).toEqual([
      ['ok', 'Brain login: claude.ai (max), directory /home/p/.claude, channel open at the last recorded check (not verified now), consent none (you only); isolated by bubblewrap 0.13.0 (bundled)'],
      ['warning', 'Brain login: -, directory /home/p/.claude, channel closed, consent none (you only). The check recorded an isolation refusal.']]);
    expect(doctorChecks(report, facts({ headlessLogins: logins.slice(0, 1) }), 'tr').find(row => row.id === 'work.brainLogin')?.text).toContain('bubblewrap 0.13.0 (bundled) ile yalıtılmış');
  });
  it('f5 "Brain girişi" names the realm gateway refusals: counts and host names (most refused first, bounded), never a payload', () => {
    const egress = { refused: 9, hosts: ['h1.example', 'h2.example', 'h3.example', 'h4.example', 'h5.example', 'h6.example', 'h7.example'], other: 1 };
    const login = { state: 'open' as const, authMethod: 'claude.ai', subscriptionType: null, configDir: '/home/p/.claude', consent: [], isolation: null, egress };
    expect(doctorChecks(report, facts({ headlessLogins: [login] }), 'en').find(row => row.id === 'work.brainLogin')?.text).toBe('Brain login: claude.ai, directory '
      + '/home/p/.claude, channel open at the last recorded check (not verified now), consent none (you only); network: 9 connection(s) outside the provider allowlist refused (hosts: h1.example, h2.example, h3.example, '
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

// Owner 114: the failed image row no longer carries the update fix (a manual build re-pins nothing); the stale tool row does, so the card is still reached.
const fixable = { inspectToolchainRefresh: async () => ({ status: 'failed', reason: 'BUILD_FAILED', imageVersion: null }), inspectToolchainCurrency: async () => ({ schemaVersion: 1,
  measuredAt: '2026-11-27T00:00:00.000Z', mode: 'report', registryEndpoint: 'https://registry.npmjs.org', basis: 'fixture', providers: [{ provider: 'codex', mechanism: 'npm',
    admitted: [], latest: { version: '0.156.0', source: 'fixture', observedAt: '2026-11-27T00:00:00.000Z' }, status: 'stale', update: 'fixture' }] }) };
const doctorRegistry = fixtureDockerRegistry(['coding']);
const doctorDocker = {
  docker: Object.fromEntries(Object.entries({ ...doctorRegistry.profiles[0]!.parameters, executable: 'docker' }).filter(([key]) => key !== 'argv')),
  git: { gitExecutable: 'git', timeoutMs: 5000 },
};
const doctorDockerReady = async () => ({ state: 'done', reason: { code: 'setup.execution.ready', params: { runtime: 'Docker', version: '1' } } });
const monitorPool = (held = false) => async () => ({ installs: [
  { id: 'current', status: 'available', runs: [], pools: [{ poolId: 'fixture-pool', held, capacity: 1, inFlight: 0, executionCapacity: 1, executing: 0 }] },
] }) as never;

describe('first-worker health verdict', () => {
  async function check(workerReadiness: DoctorCheckFacts['workerReadiness'], status: 'ready' | 'degraded', pending: number) {
    registerProviderConfig();
    const capacity = { executionSlots: 1, inFlightSlots: 1 };
    const root = await project({ terminal: { scopeId: 'fixture' }, admission: { poolId: 'fixture-pool', ...capacity,
      ordering: 'input-order', registry: doctorRegistry }, execution: doctorDocker });
    const env = { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') };
    await mkdir(join(env.HOME, '.deckent'), { recursive: true });
    await writeFile(join(env.HOME, '.deckent/config.json'), JSON.stringify({ identity: { profile: { id: 'core:solo', version: 1 } } }));
    const context = { root, env, inspectMonitor: monitorPool(), inspectExecutionEnvironment: doctorDockerReady, inspectWorkerImage: async () => 'present' as const,
      inspectExecutionPermission: async () => ({ actor: 'fixture/mcp/person', total: 6, allowed: workerReadiness?.ready ? 0 : 6, restricted: false }), inspectPoolCapacity: async () => ({ schemaVersion: 1 as const, scopeId: 'fixture', poolId: 'fixture-pool', capacity,
      occupancy: { execution: 0, inFlight: 0 }, receipt: null }),
      inspectWorkerReadiness: async (_root: string, scope: string, _options: unknown, kind?: string) => {
        expect(scope).toBe('fixture'); expect(kind).toBe('coding'); return workerReadiness ?? null;
      } };
    for (const locale of ['en', 'tr'] as const) {
      let json = '', human = '';
      await runKernelCommand(['doctor', '--json', '--lang', locale], { ...context, stdout: { write: chunk => { json += chunk; } } });
      const result = JSON.parse(json.trim().split('\n').at(-1)!);
      expect(result).toMatchObject({ schemaVersion: 2, status, poolReadiness: { status: 'ready' }, summary: { check: workerReadiness?.ready === false ? 1 : 0, failed: 0 } });
      expect(result).not.toHaveProperty('workerReadiness'); expect(result).not.toHaveProperty('checks');
      const verdict = t(status === 'ready' ? 'doctor.summary.ready' : 'doctor.summary.attention', {}, locale);
      await runKernelCommand(['doctor', '--lang', locale], { ...context, stdout: { write: chunk => { human += chunk; } } });
      expect(human.split('\n')[0]).toContain(verdict);
      expect(human.split('\n')[0]).toContain(t('doctor.summary.untested', { n: result.summary.untested }, locale));
      const pool = doctorChecks(report, facts({ workerReadiness }), locale).find(row => row.id === 'work.pool')!;
      expect(pool).toMatchObject({ state: workerReadiness === null ? 'untested' : workerReadiness?.ready ? 'ok' : 'warning' });
      expect(pool.needsAttention).toBe(status === 'degraded' ? true : undefined);
      expect(human).toContain(pool.text);
      if (workerReadiness?.ready === false) {
        expect(human.split('\n')[0]).toContain(t('doctor.summary.warnings', { n: 1 }, locale));
        expect(human).toContain(workerReadiness.cli.join(' '));
      }
      const model = (await terminalAdminPorts({ root, scopeId: 'fixture', installationId: 'fixture-install', projectId: 'fixture-project', locale, options: { env }, context: {}, status: async () => '',
        doctor: async sink => { sink.write(human); }, doctorReport: async sink => { sink.write(json); } }).info.ports.doctor!({ usage: EMPTY_SESSION_USAGE })).model;
      const [first, permission] = result.summary.checks;
      const directory = process.env['DECKENT_I_S3_TRANSCRIPTS'];
      if (directory && workerReadiness) await writeFile(join(directory, `119-doctor-${locale}-${workerReadiness.ready ? 'absent' : 'present'}.json`),
        JSON.stringify({ text: human.split('\n').slice(1, 3), checks: result.summary.checks }, null, 2));
      expect(first).toMatchObject({ id: 'work.firstWorker', state: workerReadiness === null ? 'untested' : workerReadiness?.ready ? 'ok' : 'warning' });
      expect(permission).toMatchObject({ id: 'work.aiExecution', state: workerReadiness?.ready ? 'warning' : 'ok' });
      expect(permission.text).toContain('fixture/mcp/person');
      if (workerReadiness?.ready) expect(permission.next).toBe('deckent policy upgrade --template current --only ai-execution --scope fixture --preview');
      for (const row of [first, permission]) {
        expect(human.split('\n').slice(1, 3).join('\n')).toContain(row.text);
        expect(model.sections[0]?.notes?.join('\n')).toContain(row.text);
      }
      expect(model.summary).toBe(`${verdict} · ${t('terminal.info.doctor.summary', result.summary, locale)} · ${t('doctor.summary.untested', { n: result.summary.untested }, locale)}`);
    }
    expect(await doctorVerdict(root, context, { env })).toEqual({ state: pending ? 'warnings' : 'ok', pending });
  }
  it('reports a measured not-ready first worker as degraded in JSON, human and terminal summaries and pending in init', async () => {
    await check({ ready: false, code: 'WORKER_MODEL_NOT_ACTIVE', cli: ['deckent', 'models', 'connect', '--scope', 'fixture'] }, 'degraded', 1);
  });
  it('keeps a measured ready first worker ready in JSON, human and terminal summaries and clear in init', async () => {
    await check({ ready: true, code: 'WORKER_READY', cli: [] }, 'ready', 0);
  });
  it('reports an unknown first worker as degraded in JSON, human and terminal summaries and pending in init', async () => {
    await check(null, 'degraded', 1);
  });
});
it.each(['held pool', 'missing image', 'narrow grant'] as const)('3349 doctor reports the observed %s in text and JSON', async scenario => {
  registerProviderConfig();
  const capacity = { executionSlots: 1, inFlightSlots: 1 };
  const person = { id: 'fixture-person', issuer: 'fixture', subject: 'person', assurance: 'os-user' as const, scopeIds: ['fixture'] };
  const [reserve] = firstRunExecutionRules([], person, ['fixture']).wanted;
  const policy = resolvePolicyBindings({ schemaVersion: 2, revision: 'p', roles: [], restrictions: [], separationOfDuties: [],
    grants: [{ ...reserve, resource: { kind: 'run', ids: ['one-run'] }, principals: [mcpPrincipalRef(person)] }] },
  { schemaVersion: 1, revision: 'b', bindings: [] });
  expect(evaluatePolicy(policy, { principal: { ...person, ...mcpPrincipalRef(person), assurance: 'workload-verified' }, scopeId: 'fixture', action: 'reserve', resource: { kind: 'run', id: 'one-run' } }).decision).toBe('allow');
  const coverage = executionPermissionCoverage(policy, person, 'fixture');
  expect(coverage).toMatchObject({ allowed: 0, total: 6, restricted: false });
  const root = await project({ terminal: { scopeId: 'fixture' }, admission: { poolId: 'fixture-pool', ...capacity, ordering: 'input-order', registry: doctorRegistry },
    execution: doctorDocker });
  const context = { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h') },
    inspectPoolCapacity: async () => ({ schemaVersion: 1 as const, poolId: 'fixture-pool', capacity, occupancy: { execution: 0, inFlight: 0 }, receipt: null }),
    inspectMonitor: scenario === 'narrow grant' ? async () => { throw new Error('monitor unavailable'); } : monitorPool(scenario === 'held pool'),
    inspectWorkerReadiness: async () => ({ ready: true, code: 'WORKER_READY', cli: [] }),
    inspectExecutionPermission: async () => coverage,
    inspectExecutionEnvironment: doctorDockerReady,
    inspectWorkerImage: async () => scenario === 'missing image' ? 'missing' as const : 'present' as const };
  for (const locale of ['en', 'tr'] as const) {
    const run = async (args: string[]) => {
      let output = '';
      await runKernelCommand(['doctor', '--lang', locale, ...args], { ...context, stdout: { write: chunk => { output += chunk; } } });
      return output;
    };
    const data = JSON.parse(await run(['--json'])), human = await run([]);
    const [first, permission] = data.summary.checks;
    const directory = process.env['DECKENT_I_S3_TRANSCRIPTS'];
    if (directory) await writeFile(join(directory, `3349-doctor-${scenario.replace(' ', '-')}-${locale}.json`),
      JSON.stringify({ text: human.split('\n').slice(1, 3), checks: data.summary.checks }, null, 2));
    expect(data.poolReadiness.status).toBe('ready');
    if (scenario === 'narrow grant') {
      expect(permission).toMatchObject({ id: 'work.aiExecution', state: 'warning',
        text: locale === 'en' ? 'No scope-wide standing AI execution permission for fixture/mcp/person in fixture.' : 'fixture/mcp/person için fixture kapsamının tamamında geçerli kalıcı yapay zekâ yürütme izni yok.' });
      expect(human).toContain(permission.text);
      expect(first).toMatchObject({ id: 'work.firstWorker', state: 'untested' });
    } else {
      expect(first).toMatchObject({ id: 'work.firstWorker', state: 'warning', next: expect.any(String) });
      expect(first.text).toContain(scenario === 'held pool'
        ? locale === 'en' ? 'pool on hold' : 'havuz bekletiliyor'
        : locale === 'en' ? 'not on this Docker' : "bu Docker'da yok");
      expect(human.split('\n')[1]).toContain(first.text);
    }
  }
});

it('3358 doctor reports full, available and unknown effective pool capacity in text and JSON (EN/TR)', async () => {
  registerProviderConfig();
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  const root = await project({ max_workers: 1, terminal: { scopeId: 'fixture' }, admission: { poolId: 'fixture-pool', ...capacity,
    ordering: 'input-order', registry: doctorRegistry }, execution: doctorDocker });
  const home = join(root, 'h'), env = { HOME: home, USERPROFILE: home };
  await mkdir(join(home, '.deckent'), { recursive: true });
  await writeFile(join(home, '.deckent/config.json'), JSON.stringify({ identity: { profile: { id: 'core:solo', version: 1 } } }));
  const next = 'deckent pool status --scope fixture';
  const scenarios = [
    { state: 'warning', executionCapacity: 1, used: 1, next,
      en: 'First worker is not ready (waiting for a pool slot).', tr: 'İlk işçi hazır değil (havuzda yer bekliyor).' },
    { state: 'ok', executionCapacity: 1, used: 0,
      en: 'First worker is ready.', tr: 'İlk işçi hazır.' },
    { state: 'untested', executionCapacity: null, used: 0, next,
      en: 'First worker readiness was not measured.', tr: 'İlk işçinin hazır olup olmadığı ölçülemedi.' },
  ];
  for (const locale of ['en', 'tr'] as const) {
    let health;
    for (const scenario of scenarios) {
      const context = { root, env, inspectExecutionEnvironment: doctorDockerReady, inspectWorkerImage: async () => 'present' as const,
        inspectWorkerReadiness: async () => ({ ready: true, code: 'WORKER_READY', cli: [] }),
        inspectPoolCapacity: async () => ({ schemaVersion: 1 as const, poolId: 'fixture-pool', capacity,
          occupancy: { execution: scenario.used, inFlight: scenario.used }, receipt: null }),
        inspectMonitor: async () => ({ installs: [{ id: 'current', status: 'available', runs: [], pools: [
          { poolId: 'fixture-pool', held: false, capacity: 1, inFlight: scenario.used, executionCapacity: scenario.executionCapacity, executing: scenario.used },
        ] }] }) as never };
      const run = async (...args: string[]) => {
        let output = '';
        await runKernelCommand(['doctor', '--lang', locale, ...args], { ...context, stdout: { write: chunk => { output += chunk; } } });
        return output;
      };
      const data = JSON.parse(await run('--json')), human = await run();
      const { checks, ...counts } = data.summary;
      health ??= { status: data.status, counts };
      expect(data.poolReadiness.status).toBe('ready');
      expect({ status: data.status, counts }).toEqual(health);
      expect.soft(checks[0], `${locale} ${scenario.state}`).toEqual({ group: 'work', id: 'work.firstWorker', state: scenario.state,
        text: scenario[locale], ...(scenario.next ? { next: scenario.next } : {}) });
      expect.soft(human.split('\n')[1], `${locale} ${scenario.state}`).toBe([scenario[locale], scenario.next].filter(Boolean).join(' · '));
    }
  }
});

describe('deckent doctor (command)', () => {
  it('explains folder scope in the selected language without echoing a flag value or an unknown flag', async () => {
    const root = await project();
    const env = { HOME: join(root, 'h') };
    for (const [lang, heading, usage] of [
      ['en', 'Invalid --scope for deckent doctor.', 'deckent doctor checks the folder it is run in and that folder\'s scope, so it takes no --scope. Go to the project folder and run deckent doctor there.'],
      ['tr', 'deckent doctor için --scope geçersiz.', 'deckent doctor çalıştırıldığı klasörü ve o klasörün kapsamını denetler; bu yüzden --scope almaz. Proje klasörüne geçin ve deckent doctor komutunu orada çalıştırın.'],
    ] as const) {
      const args = ['doctor', '--scope', 'x', '--lang', lang];
      await expect.soft(runKernelCommand(args, { root, env })).rejects.toMatchObject({
        code: 'CLI_USAGE', params: { command: 'deckent doctor', flag: '--scope', usage },
      });
      for (const [flags, scoped] of [[['--scope', 'SECRETVALUE'], true], [['--not-a-flag-SECRETVALUE'], false]] as const) {
        let output = '';
        const writer = { write: (text: string) => { output += text; } };
        expect(await main(['doctor', ...flags, '--lang', lang], { root, env, stdout: writer, stderr: writer })).toBe(2);
        expect(output).toContain('[CLI_USAGE]');
        expect(output).not.toContain('SECRETVALUE');
        if (scoped) {
          expect.soft(output).toContain(heading);
          expect.soft(output).toContain(usage);
        } else {
          expect(output).not.toContain(usage);
        }
      }
    }
  });

  it('default output is grouped text; --verbose adds the old details; --json keeps the collected report contract', async () => {
    registerProviderConfig();
    const root = await project({ terminal: { scopeId: 'fixture' } });
    let legacy = true, logins: NonNullable<DoctorCheckFacts['headlessLogins']> = [];
    const run = async (args: string[]) => { const out: string[] = [];
      await runKernelCommand(['doctor', '--lang', 'en', ...args], { root, inspectLegacyProjectInstructions: async () => legacy, readHeadlessLogins: async () => logins, env: { HOME: join(root, 'h') }, stdout: { write: (v: string) => { out.push(v); } }, stderr: { write() {} } })
        .catch((error: unknown) => out.push(`[${(error as { code?: string }).code}]`));
      return out.join(''); };
    const grouped = await run([]);
    expect(grouped.split('\n')[0]).toMatch(/^Installation health: /u);
    expect(grouped).toContain('\nInstallation\n');
    expect(grouped).toContain('Tool versions were not checked (the check contacts the npm registry)');
    expect(grouped).not.toContain('Details (--verbose):');
    expect(grouped).toContain('Legacy DECKENT.md'); legacy = false;
    const withoutLegacy = await run([]);
    expect(withoutLegacy).not.toContain('Legacy DECKENT.md');
    const env = { HOME: join(root, 'h') };
    const verdict = await doctorVerdict(root, { env }, { env });
    expect(verdict).toEqual({ state: 'warnings', pending: withoutLegacy.split('\n').filter(line => /^ {2}(?:warning|error)\s/u.test(line)).length });
    expect(verdict.pending).toBeGreaterThan(0);
    const verbose = await run(['--verbose']);
    expect(verbose).toContain('Details (--verbose):');
    expect(verbose).toContain('Platform: ');
    // C-DOCTOR follow-up (J3): one status only — the grouped summary; the old report's ready/degraded line is not repeated.
    expect(verbose.match(/^(?:Installation health|Status): /gmu)).toHaveLength(1);
    const json = JSON.parse((await run(['--json'])).replace(/\[[A-Z_]+\]$/u, ''));
    expect(json.schemaVersion).toBe(2);
    expect(Object.keys(json)).not.toContain('checks');
    for (const key of ['platform', 'host', 'node', 'status', 'poolReadiness', 'secretStore', 'shellRealm', 'imageRefresh', 'recoveryFiles']) expect(Object.keys(json)).toContain(key);
    // A Brain login's re-read sandbox argument-count refusal is an optional field: code, safe counts and the row's sentence; an altered or
    // missing record adds nothing (the row keeps its generic text).
    const sandbox = producedSandboxRefusal('en'), closed = (check: unknown) => closedPreflightRefusal({ schemaVersion: 1, refusal: 'SANDBOX_VIEW_TOO_LARGE', check });
    const login = (check: unknown) => ({ state: 'closed' as const, authMethod: null, subscriptionType: null, configDir: '/fixture/login', consent: [], isolation: null,
      connection: 'claude-cli-subscription', profileId: 'fixture-profile', diagnostic: closed(check) });
    expect(json).not.toHaveProperty('headlessLoginRefusals');
    logins = [login(sandbox)];
    const withRefusal = JSON.parse((await run(['--json'])).replace(/\[[A-Z_]+\]$/u, ''));
    expect(withRefusal.headlessLoginRefusals).toEqual([{ connection: 'claude-cli-subscription', code: 'SANDBOX_VIEW_TOO_LARGE',
      params: readHeadlessDiagnosticRecord('SANDBOX_VIEW_TOO_LARGE', sandbox).params, message: sandbox }]);
    const hidden = producedSandboxRefusal('en', 1_500, true); logins = [login(hidden)];
    expect(JSON.parse((await run(['--json'])).replace(/\[[A-Z_]+\]$/u, '')).headlessLoginRefusals).toMatchObject([{ code: 'SANDBOX_VIEW_TOO_LARGE', message: hidden }]);
    // An altered sum, a missing check, the earlier example (its sum and text hold, but no isolated view yields "other setup 4") and one or four
    // "other setup" arguments more than the producer's (no composition of its groups gives them) add nothing.
    const made = readHeadlessDiagnosticRecord('SANDBOX_VIEW_TOO_LARGE', sandbox).params as Record<string, number>;
    const more = (extra: number) => argumentCountRefusal(made['count']! + extra, { home: 0, protective: made['protective']!, pins: 0, remounts: 2, tail: made['tail']! }, { DECKENT_LANGUAGE: 'en' }, true);
    for (const old of [sandbox.replace(/needs (\d+)/u, (_, n: string) => `needs ${Number(n) + 1}`), null, UNPRODUCIBLE_SANDBOX_REFUSAL, more(1), more(4)]) {
      logins = [login(old)];
      expect(JSON.parse((await run(['--json'])).replace(/\[[A-Z_]+\]$/u, ''))).not.toHaveProperty('headlessLoginRefusals');
    }
    logins = [];
    await mkdir(join(env.HOME, '.deckent'), { recursive: true });
    await writeFile(join(env.HOME, '.deckent/config.json'), JSON.stringify({ identity: { profile: { id: 'core:solo', version: 1 } } }));
    clearConfigCache();
    const healthy = { env, inspectCodingRepository: async () => ({ state: 'skipped', reason: { code: 'fixture.not-applicable', params: {} } }),
      verifyAudit: async () => ({ schemaVersion: 1 as const, scopeId: 'fixture', status: 'match' as const, head: null, checkpoint: null }) };
    expect(await doctorVerdict(root, healthy, { env })).toEqual({ state: 'ok', pending: 0 });
    const freshAudit = { ...healthy, verifyAudit: async () => ({ schemaVersion: 1 as const, scopeId: 'fixture', status: 'unknown' as const,
      reason: 'no-checkpoint-yet' as const, head: null, checkpoint: null }) };
    expect(await doctorVerdict(root, freshAudit, { env })).toEqual({ state: 'warnings', pending: 1 });
    for (const context of [healthy, freshAudit]) {
      const check = await doctorVerdict(root, context, { env });
      const observation: SetupObservation = { schemaVersion: 2, check,
        environment: { platform: 'linux', node: 'supported' }, language: { configured: 'en', requested: null, system: null },
        folder: { installation: 'present', homeRoot: false, configuredScope: 'fixture', suggestedScope: 'fixture' },
        profile: { available: [{ id: 'core:solo', version: 1 }], selected: { id: 'core:solo', version: 1 } }, policy: { state: 'current' },
        sandbox: { realm: 'bubblewrap', selfTest: 'ok', usernsRestricted: false }, model: { connections: 0 } };
      const plan = planSetup(observation, undefined, new SetupStageRegistry([]));
      for (const locale of ['en', 'tr'] as const) {
        const text = renderSetupLines(plan, locale, { requested: false, results: [] });
        if (context === healthy) {
          expect(text).toContain(locale === 'en' ? 'The final check ran; no items need attention.' : 'Son kontrol çalıştı; ilgi bekleyen madde yok.');
          expect(text).not.toContain(locale === 'en' ? 'wait for you' : 'sizi bekliyor');
        } else expect(text).toContain(locale === 'en' ? 'The final check ran; 1 item(s) wait for you.' : 'Son kontrol çalıştı; 1 madde sizi bekliyor.');
      }
    }
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
    // BeUser r-rest 3: a scope without a budget is warned about only when it has a metered model connection; subscription or no model: no money row.
    const reference = { providerId: 'remote-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
    const metered = { schemaVersion: 1, id: 'p-chat', version: 1, scopeId: 'live', reference, bindingDigest: 'b'.repeat(64), protocol: { family: 'openai-chat-completions', version: 'v1' },
      adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint: 'https://api.example.test/v1/chat/completions', maxOutputTokens: 256, authentication: { type: 'none' },
        tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 100, outputMinorUnitsPerMillionTokens: 100 } } },
      allocation: { id: 'a-chat', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
    for (const [profiles, warned] of [[[], false], [[metered], true]] as const) {
      clearConfigCache();
      const root = await project({ terminal: { scopeId: 'live' }, provider_invocation_profiles: { schemaVersion: 1, profiles } }), out: string[] = [];
      await runKernelCommand(['doctor', '--lang', 'en'], { root, env: { HOME: join(root, 'h') }, inspectProviderSpendAccount: async () => ({ checkpoint: null }),
        stdout: { write: (v: string) => { out.push(v); } }, stderr: { write() {} } } as never).catch((error: unknown) => out.push(`[${(error as { code?: string }).code}]`));
      expect(out.join('').includes('Scope live has no API budget yet')).toBe(warned);
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
      await runKernelCommand(['doctor', '--lang', 'en', '--toolchains', ...(json ? ['--json'] : [])], { root, env: { HOME: join(root, 'h'), ...env }, stdin: stdin as never,
        stdout: Object.assign({ write: (v: string) => { out.push(v); } }, { isTTY: true }) as never, stderr: { write() {} }, ...fixable,
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
    await runKernelCommand(['doctor', '--lang', 'en', '--toolchains'], { root, env: { HOME: join(root, 'h') }, stdin: io.stdin as never, stdout: io.stdout as never, stderr: { write() {} }, ...fixable,
      updateToolchains: async () => { applied++; return { decision: 'built', plan: null, build: null, proposalPath: null }; } } as never);
    expect(applied).toBe(0);
    expect(io.written.join('')).toContain('Not applied: nothing was changed.');
  });
  it('an accepted fix runs the existing operation once, then measures again', async () => {
    const root = await project(), io = terminal('y');
    const calls: unknown[] = [];
    await runKernelCommand(['doctor', '--lang', 'en', '--toolchains'], { root, env: { HOME: join(root, 'h') }, stdin: io.stdin as never, stdout: io.stdout as never, stderr: { write() {} }, ...fixable,
      updateToolchains: async (_root: string, input: unknown) => { calls.push(input); return { decision: 'built', plan: { next: { imageVersion: 'r9-20261019' } }, build: null, proposalPath: '/p.json' }; } } as never);
    expect(calls).toEqual([{ apply: true }]);
    const text = io.written.join('');
    expect(text).toContain('New worker image r9-20261019 built; profile proposal: /p.json');
    // Measured again: the summary line appears twice (before and after); the same fix is not offered a second time in one call.
    expect(text.split('Installation health: ').length - 1).toBe(2);
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
    const error = await runKernelCommand(['doctor', '--lang', 'en', '--toolchains'], { root, env: { HOME: join(root, 'h') }, stdin: io.stdin as never, stdout: io.stdout as never, stderr: { write() {} },
      ...fixable, updateToolchains: async () => { throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); } } as never).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'POLICY_DENIED' });
    expect(io.written.join('')).toContain('Installation health: ');
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
      inspectModelCatalog: stopped, inspectModelRoles: stopped, assignModelRole: stopped, setSecret: stopped, setProjectSecret: stopped, changeSecretGrant: stopped, inspectSecretTarget: stopped, listSecretStores: stopped, inspectPolicyAdministration: stopped, listSecretNames: stopped, inspectSecretStore: stopped, initializeNativeCodingRegistry: stopped,
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
  for (const locale of ['en', 'tr'] as const) {
    const refused = doctorChecks(report, facts({ siwcConnections: [{ reference, connection: 'fixture-subscription', state: 'unavailable', planUse: false,
      code: 'SIWC_STORE_NOT_PERSONAL', reason: 'binding-changed' }] }), locale).find(row => row.id === 'work.chatgptConnection');
    expect(refused?.text).toContain(locale === 'en'
      ? 'Subscription access is unavailable because deckent could not verify the personal store. Disconnecting and reconnecting does not fix the store verification problem. Ask the installation administrator to check the personal store folder, its backing device and its binding record.'
      : 'deckent kişisel depoyu doğrulayamadığı için aboneliğe erişilemiyor. Bağlantıyı kesip yeniden bağlamak depo doğrulama sorununu gidermez. Kurulum yöneticisinden kişisel depo klasörünü, bağlı olduğu aygıtı ve bağ kaydını kontrol etmesini isteyin.');
    expect(refused).not.toHaveProperty('next');
  }
});

it('names an open secret folder ssh-style with chmod 700 and says when ChatGPT sign-in custody would refuse (FIX8b E01, R22)', () => {
  const store = (extra: object) => ({ ...report, secretStore: { ...report.secretStore, ...extra } }) as typeof report;
  const custody = (extra: object, locale: 'en' | 'tr' = 'en') => doctorChecks(store(extra), facts(), locale).filter(row => row.id.startsWith('security.secretsRoot') || row.id === 'security.siwcCustody');
  const open = custody({ globalRoot: { path: '/fixture/global', mode: '0755' }, personalCustody: { status: 'refused', reason: 'unsafe-root', path: '/fixture/global', mode: '0755', folder: 'root' } });
  // One fix for one folder: the root row carries the exact command; the custody row would only repeat it.
  expect(open).toEqual([expect.objectContaining({ id: 'security.secretsRoot', state: 'warning', next: 'chmod 700 /fixture/global' })]);
  expect(open[0]!.text).toContain('0755');
  const parent = custody({ personalCustody: { status: 'refused', reason: 'unsafe-root', path: '/tmp', mode: '1777', folder: 'parent' } }, 'tr');
  expect(parent).toHaveLength(1); expect(parent[0]!.text).toContain('/tmp'); expect(parent[0]!.next).toContain('deckent config'); expect(parent[0]!.next).not.toContain('chmod');
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

it('shows bounded recorded plugin names or blind call counts and never says none for incomplete history (EN/TR)', () => {
  for (const locale of ['en', 'tr'] as const) {
    const nativePlugins = { calls: 2, hiddenCalls: 0, names: [{ cliVersion: '2.1.fixture', name: 'new-plugin' }], omitted: '0', complete: true };
    const rows = (value: typeof nativePlugins) => doctorChecks(report, facts({ nativePlugins: value }), locale).filter(row => row.id === 'work.nativePlugins');
    expect(rows(nativePlugins).map(row => row.text)).toEqual([t('doctor.check.plugins.name', { name: 'new-plugin', version: '2.1.fixture' }, locale)]);
    const blind = rows({ ...nativePlugins, names: [], hiddenCalls: 2 });
    expect(blind.map(row => row.text)).toEqual([t('doctor.check.plugins.count', { count: 2 }, locale)]);
    expect(JSON.stringify(blind)).not.toContain('new-plugin');
    expect(rows({ ...nativePlugins, names: [], calls: 0, complete: false }).map(row => row.text)).toEqual([t('doctor.check.plugins.incomplete', {}, locale)]);
    const many = rows({ ...nativePlugins, names: Array.from({ length: 6 }, (_, i) => ({ cliVersion: '2.1.fixture', name: `plugin-${i}` })) });
    expect(many).toHaveLength(6); expect(many.at(-1)!.text).toBe(t('doctor.check.plugins.more', { count: 1 }, locale));
    const exact = rows({ ...nativePlugins, omitted: '27021597764222973', names: Array.from({ length: 6 }, (_, i) => ({ cliVersion: '2.1.fixture', name: `plugin-${i}` })) });
    expect(exact.at(-1)!.text).toBe(locale === 'en' ? '+27021597764222974 more recorded names' : '+27021597764222974 kayıtlı ad daha');
  }
});

it('ATT-D: only source-local v3 lineage mismatches produce a read-only row with a true newer-version step (EN/TR)', async () => {
  const root = await project(), options = { env: { HOME: join(root, 'h') }, heal: false };
  let inspectAttachmentFolders!: NonNullable<Parameters<typeof runKernelCommand>[1]['inspectAttachmentFolders']>;
  // Capture the real host through its public composition entry; dispatch only the new read seam below.
  const dispatch = vi.spyOn(surface, 'main').mockImplementation(async (_argv, context) => {
    inspectAttachmentFolders = (await context!.loadHost!()).inspectAttachmentFolders!; return 0;
  });
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('HOME', options.env.HOME); vi.stubEnv('DECKENT_GLOBAL_HOME', join(options.env.HOME, '.deckent'));
  try { expect(await cliMain(['doctor', '--lang', 'en'])).toBe(0); }
  finally { dispatch.mockRestore(); cwd.mockRestore(); vi.unstubAllEnvs(); }
  if (process.platform === 'win32') {
    await expect(inspectAttachmentFolders(root, options)).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_UNAVAILABLE' });
    return; // The existing registration reader refuses before filesystem access on native Windows.
  }
  const matched = join(root, 'matched'); await mkdir(matched, { mode: 0o700 });
  const location = await captureAttachmentLocation(matched);
  const replaced = join(root, 'replaced'); await mkdir(replaced, { mode: 0o700 });
  const old = await captureAttachmentLocation(replaced);
  const base = readableInstallationRegistrationSchema.parse(JSON.parse(await readFile(new URL('../../fixtures/attachment-registration-v3.json', import.meta.url), 'utf8')));
  const entry = base.entries[0]!;
  const record = readableInstallationRegistrationSchema.parse({ ...base, source: { ...base.source, projectRoot: root },
    entries: [
      { ...entry, attachment: { ...entry.attachment, location: { ...entry.attachment.location, canonicalRoot: join(root, 'missing') } } },
      ...(['active', 'active', 'revoked', 'pending'] as const).map((state, i) => ({ ...entry, state, attachment: { ...entry.attachment, schemaVersion: 1,
        projectId: randomUUID(), commandId: randomUUID(), location: i === 0 ? { ...old, inode: String(BigInt(old.inode) + 1n) }
          : i === 1 ? location : { ...location, canonicalRoot: join(root, state) } } })),
    ] });
  if (record.schemaVersion !== 3) throw new Error('Expected the frozen registration v3 fixture');
  // The replaced folder has a different inode; the unreachable folder cannot be promised automatic completion.
  const store = configuredAttachmentStore(await loadComposedConfig(root, options), options), path = productResourcePath(store.global, 'installationRegistration');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const run = async (locale: 'en' | 'tr') => {
    const out: string[] = [];
    await runKernelCommand(['doctor', '--lang', locale], { root, env: options.env, inspectAttachmentFolders,
      stdout: { write: (value: string) => { out.push(value); } }, stderr: { write() {} } });
    return out.join('');
  };
  const check = async (value: unknown, count: number) => {
    await writeFile(path, serializeJsonDocument(value), { mode: 0o600 });
    const before = await readFile(path), names = await readdir(dirname(path));
    const attachmentFolders = await inspectAttachmentFolders(root, options);
    for (const locale of ['en', 'tr'] as const) {
      const text = await run(locale);
      const sentence = locale === 'en' ? '2 attached projects no longer match their recorded folder.' : '2 bağlı proje artık kayıtlı klasörüyle eşleşmiyor.';
      const row = doctorChecks(report, facts({ attachmentFolders }), locale).filter(item => item.id === 'work.attachments');
      if (!count) { expect(row).toHaveLength(0); expect(text).not.toContain(t('doctor.check.attachments.next', {}, locale)); continue; }
      expect(text.split(sentence)).toHaveLength(2);
      expect(text).toContain(locale === 'en'
        ? 'This record was written by a newer deckent, so only that version can reconcile them (some may then need `terminal attach --relocate`).'
        : 'Bu kayıt daha yeni bir deckent sürümüyle yazıldı; bu yüzden projeleri yalnız o sürüm uzlaştırabilir (bazıları için o sürümde `terminal attach --relocate` gerekebilir).');
      expect(row).toHaveLength(1); expect(row[0]).toMatchObject({ state: 'warning', text: sentence }); expect(row[0]!.fix).toBeUndefined();
      // Even an unreachable or foreign recorded folder is not promised automatic completion or a runnable repair on beta.2.
      expect(row[0]!.next).not.toBe('terminal attach --relocate');
      expect(JSON.stringify(row)).not.toMatch(/they finish|will (?:finish|complete)|automatically|kendiliğinden|otomatik/u);
    }
    expect(await readFile(path)).toEqual(before); expect(await readdir(dirname(path))).toEqual(names);
  };
  await check(record, 2);
  await check({ ...record, source: { ...record.source, projectRoot: join(root, 'outside') } }, 0);
  const { lineage: ignored, ...withoutLineage } = record; void ignored;
  await check(withoutLineage, 0);
  const legacy = { ...withoutLineage, schemaVersion: 2, source: { ...record.source, location }, entries: record.entries.map(item => ({ ...item,
    attachment: { ...item.attachment, schemaVersion: 1, location: { canonicalRoot: item.attachment.location.canonicalRoot,
      device: item.attachment.location.device, inode: item.attachment.location.inode } } })) };
  await check(legacy, 0);
  await check({ ...record, entries: record.entries.map(item => ({ ...item, state: 'revoked' })) }, 0);
});

it('119-rev F3: doctor distinguishes no grant, denial and approval while keeping model checks separate (EN/TR)', () => {
  const run = { runId: 'r', scopeId: 'live', revision: 1 }, now = Date.now();
  for (const locale of ['en', 'tr'] as const) for (const reason of ['NO_GRANT', 'DENIED', 'APPROVAL_REQUIRED']) {
    const progression = { schemaVersion: 1 as const, ...run, observedAtMs: now, validUntilMs: now + 60000, actorClass: 'ai' as const,
      state: 'blocked' as const, reason: 'POLICY_DENIED', session: 'eligible' as const, suspended: false, parkUnavailable: false,
      missing: [{ kind: 'run' as const, id: 'r', action: 'reserve', scope: 'live', reason, code: 'POLICY_DENIED' as const }] };
    const checks = doctorChecks(report, facts({ progressionRuns: [{ run, progression }], modelConnections: [{ profile: 'offline-model', tools: 'unknown', stale: false }] }), locale);
    const text = checks.find(row => row.id === 'work.progression')!.text;
    expect(text).toContain(reason === 'DENIED' ? locale === 'en' ? 'AI execution is explicitly denied' : 'Yapay zekâ yürütmesi açıkça reddedildi'
      : reason === 'APPROVAL_REQUIRED' ? locale === 'en' ? 'AI execution requires approval' : 'Yapay zekâ yürütmesi için onay gerekiyor'
        : locale === 'en' ? 'AI execution permission is missing' : 'Yapay zekâ yürütme izni eksik');
    if (reason !== 'NO_GRANT') expect(text).not.toContain('--only ai-execution');
    expect(checks.find(row => row.id === 'work.modelConnection')!.text).toContain('offline-model');
  }
});

it('119-C4: doctor separates service policy diagnosis from unavailable login/model; missing or stale diagnosis is unknown (EN/TR)', () => {
  const run = { runId: 'r', scopeId: 'live', revision: 1 }, now = Date.now();
  const diagnostic = { schemaVersion: 1 as const, ...run, observedAtMs: now, validUntilMs: now + 60000, actorClass: 'ai' as const,
    state: 'blocked' as const, reason: 'POLICY_DENIED', session: 'eligible' as const, suspended: true, parkUnavailable: true,
    missing: [{ kind: 'run' as const, id: 'r', action: 'reserve', scope: 'live', reason: 'NO_GRANT', code: 'POLICY_DENIED' as const }] };
  for (const locale of ['en', 'tr'] as const) {
    const checks = doctorChecks(report, facts({ progressionRuns: [{ run, progression: diagnostic }], modelConnections: [{ profile: 'offline-model', tools: 'unknown', stale: false }] }), locale);
    const policy = checks.find(row => row.id === 'work.progression')!;
    expect(policy.state).toBe('warning'); expect(policy.text).toContain('--only ai-execution --scope live --preview');
    expect(policy.text).toContain('run/r/reserve'); expect(policy.text).toContain('RUN_PROGRESSION_PARK_UNAVAILABLE');
    expect(checks.find(row => row.id === 'work.modelConnection')!.text).toContain('offline-model');
    const stale = doctorChecks(report, facts({ progressionRuns: [{ run: { ...run, revision: 2 }, progression: diagnostic }] }), locale).find(row => row.id === 'work.progression')!;
    expect(stale.state).toBe('untested'); expect(stale.text).not.toContain('--only ai-execution');
    expect(doctorChecks(report, facts({ progressionRuns: null }), locale).find(row => row.id === 'work.progression')).toMatchObject({ state: 'untested' });
    for (const closed of [{ ...run, state: { kind: 'terminal' as const, outcome: 'completed' as const, reason: 'completed' as const } }, { ...run, cancellationRequested: true }]) {
      expect(doctorChecks(report, facts({ progressionRuns: [{ run: closed, progression: diagnostic }] }), locale).find(row => row.id === 'work.progression')).toBeUndefined();
    }
  }
});

it('D1 doctor reports the shared Git directory warning and command without offering repair', async () => {
  const root = await project();
  for (const command of ["chmod go-w -- '/project/.git'", '']) for (const lang of ['en', 'tr']) for (const json of [false, true]) {
    let out = '', inspections = 0;
    await runKernelCommand(['doctor', '--lang', lang, ...(json ? ['--json'] : [])], { root, env: { HOME: join(root, 'home') }, stdout: { write: (text: string) => { out += text; } }, stderr: { write() {} },
      gitDeliveryPermission: async (_root, _options, confirm) => { expect(confirm).toBeUndefined(); inspections++; return { path: '/project/.git', command, before: '0775', after: '0755' }; },
    });
    expect(inspections).toBe(1);
    if (json) { expect(JSON.parse(out)).toHaveProperty('summary'); expect(out).not.toContain('chmod go-w'); continue; }
    expect(out).toContain('/project/.git');
    expect(out).toContain(command || (lang === 'en' ? 'no command is offered' : 'komut sunulmuyor'));
    if (!command) expect(out).not.toContain('chmod go-w');
  }
});


it('D2 a recorded pool does not mean the small worker is ready (EN/TR)', () => {
  const workerReadiness = { ready: false, code: 'WORKER_MODEL_NOT_ACTIVE', cli: ['deckent', 'models', 'connect', '--scope', 'live', '--connection', 'fixture-connection', '--model', 'fixture-small'] };
  for (const locale of ['en', 'tr'] as const) {
    const rows = doctorChecks(report, facts({ poolStatus: 'ready', workerReadiness } as never), locale);
    const pool = rows.find(row => row.id === 'work.pool')!;
    expect(pool.state).toBe('warning'); expect(pool.next).toBe(workerReadiness.cli.join(' '));
    expect(pool.text).toContain(locale === 'en' ? 'Small worker is not ready' : 'Küçük iş çalışanı hazır değil');
  }
});

it('recommends plain deckent doctor in both unmeasured worker rows for a configured scope', () => {
  const scoped = facts({ workerReadiness: null, poolHeld: false, poolHasRoom: true });
  const checks = doctorChecks(report, scoped, 'en');
  expect.soft(checks.find(row => row.id === 'work.pool')).toMatchObject({ state: 'untested', next: 'deckent doctor' });
  expect(doctorReadinessChecks(scoped, checks, 'en').find(row => row.id === 'work.firstWorker'))
    .toMatchObject({ state: 'untested', next: 'deckent doctor' });
  // Owner 114: a first work kind that cannot run (its CLI's login may not be used in Docker) blocks the first worker with that reason, image present or not.
  const closed = facts({ workerReadiness: null, poolHeld: false, poolHasRoom: true, workerKinds: [{ kind: firstJobKind, reason: null, rebind: false, notRunnable: 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' }] });
  expect(doctorReadinessChecks(closed, doctorChecks(report, closed, 'en'), 'en').find(row => row.id === 'work.firstWorker'))
    .toMatchObject({ state: 'warning', text: expect.stringContaining(`Task kind ${firstJobKind} cannot run`) });
});

it('guides setup without a scope and keeps the permission preview for an unreadable configured scope (EN/TR)', () => {
  for (const [locale, text] of [
    ['en', 'AI execution permission was not checked: this folder has no deckent scope yet. Set the folder up with deckent init, or run deckent doctor inside a project that is already set up.'],
    ['tr', 'Yapay zekâ yürütme izni denetlenmedi: bu klasörün henüz bir deckent kapsamı yok. Klasörü deckent init ile kurun ya da deckent doctor komutunu kurulmuş bir proje klasöründe çalıştırın.'],
  ] as const) {
    const noScope = facts({ scopeId: null, executionPermission: null, policyFileAbsent: true });
    const configured = facts({ executionPermission: null });
    expect.soft(doctorReadinessChecks(noScope, doctorChecks(report, noScope, locale), locale).find(row => row.id === 'work.aiExecution'))
      .toMatchObject({ state: 'untested', text, next: 'deckent init' });
    expect(doctorReadinessChecks(configured, doctorChecks(report, configured, locale), locale).find(row => row.id === 'work.aiExecution'))
      .toMatchObject({ state: 'untested', text: t('doctor.aiExecution.unknown', { scope: 'live' }, locale), next: 'deckent policy upgrade --template current --only ai-execution --scope live --preview' });
  }
});

it('suggests setup only when the policy file is known to be absent (EN/TR)', async () => {
  const root = await project();
  const home = join(root, 'home'), env = { HOME: home, USERPROFILE: home };
  const { productLayout } = await loadConfig(root, { env, heal: false });
  const policyPath = productResourcePath(productLayout, 'policy');
  const locales = [
    ['en', 'AI execution permission was not checked because no default scope could be selected. Check which scope to use for this project, or run deckent doctor in the folder for that scope.'],
    ['tr', 'Varsayılan kapsam seçilemediği için yapay zekâ yürütme izni denetlenmedi. Bu proje için hangi kapsamı kullanacağınızı kontrol edin ya da deckent doctor komutunu o kapsama ait klasörde çalıştırın.'],
  ] as const;
  const run = async (locale: 'en' | 'tr', json = true) => {
    let output = '';
    await runKernelCommand(['doctor', '--lang', locale, ...(json ? ['--json'] : [])], {
      root, env, inspectPolicyTemplate: async () => null, stdout: { write: text => { output += text; } },
    });
    return output;
  };
  const permission = (output: string) => JSON.parse(output).summary.checks.find((row: { id: string }) => row.id === 'work.aiExecution');
  for (const [locale] of locales) {
    expect(permission(await run(locale))).toMatchObject({ state: 'untested', next: 'deckent init' });
  }

  await mkdir(dirname(policyPath), { recursive: true });
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 2, revision: 'custom', roles: [], grants: [], restrictions: [], separationOfDuties: [] }));
  for (const [locale, text] of locales) {
    const row = permission(await run(locale));
    expect.soft(row, `custom policy (${locale})`).toMatchObject({ state: 'untested', text });
    expect.soft(row, `custom policy (${locale})`).not.toHaveProperty('next');
    expect.soft(await run(locale, false)).toContain(text);
  }

  const original = fs.lstat;
  const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === policyPath) throw Object.assign(new Error('policy metadata unreadable'), { code: 'EACCES' });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const [locale, text] of locales) {
      const row = permission(await run(locale));
      expect.soft(row, `unreadable policy (${locale})`).toMatchObject({ state: 'untested', text });
      expect.soft(row, `unreadable policy (${locale})`).not.toHaveProperty('next');
    }
    expect(lstat).toHaveBeenCalledWith(policyPath);
  } finally {
    lstat.mockRestore();
    syncBuiltinESMExports();
  }
});
