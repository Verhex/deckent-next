import { MESSAGE_REGISTRY, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { DoctorRenderInput } from './report.js';
import { renderAuditReason, renderAuditStatus } from './audit.js';
import { shortImageId } from './report.js';
import registry from './doctor.json' with { type: 'json' };
import { firstJobCommand, firstJobSteps, firstJobTitle } from './first-job.js';
import type { RecoveryModeState } from '#engine/index.js';
import { recoveryStateLines } from '#surfaces/core/recovery-text/index.js';

/** The four groups of the owner-accepted doctor view (CLI review 2026-10-19 §doctor): Kurulum / Güvenlik / Çalışma / Araçlar. */
export type DoctorGroup = 'setup' | 'security' | 'work' | 'tools';
/** A row's verdict as a word, never colour alone: tamam / uyarı / hata / sınanmadı. */
export type DoctorCheckState = 'ok' | 'warning' | 'error' | 'untested';
/** One row: what was measured in plain words, and for a warning or error the one next command (or step) that resolves it. `fix` names a
 * registry fix the interactive doctor may offer on a terminal; it is offered only when its port is wired and it is not a hard-floor item. */
export type DoctorCheck = Readonly<{ group: DoctorGroup; id: string; state: DoctorCheckState; text: string; next?: string; fix?: string }>;

/** Facts the grouped view reads besides the collected report; each is null when it was not measured (the row then says "not tested"). */
export interface DoctorCheckFacts {
  readonly scopeId: string | null;
  readonly toolchainsRequested: boolean;
  /** `missing` when the configuration selects no identity profile (solo / team / enterprise / custom). */
  readonly identityProfile: Readonly<{ state: 'selected'; id: string } | { state: 'missing' }> | null;
  /** True when the backup passphrase is kept in this installation's own secret store (names only, never the value). */
  readonly backupPassphraseStored: boolean | null;
  /** Active models whose catalog lifecycle is past `active` (registry `retirementStates`); null when the catalog could not be read. */
  readonly retiringModels: readonly Readonly<{ modelId: string; channelId: string; state: string; date: string | null }>[] | null;
  /** M2: catalog models no tier/role row names (every role refuses them until a person assigns one); null or absent when not read. */
  readonly pendingRoleModels?: readonly Readonly<{ modelId: string; channelId: string }>[] | null;
  /** S3-3: each subscription Brain connection of the scope (from its profile and last preflight record; no spawn): login kind, plan, directory,
   * channel state and consent; `state: unknown` when no check ran yet. Absent or null when not read. */
  readonly headlessLogins?: readonly Readonly<{ state: 'open' | 'closed' | 'unknown'; authMethod: string | null; subscriptionType: string | null; configDir: string;
    consent: readonly string[]; isolation?: Readonly<{ launcher: string; version: string }> | 'unavailable' | null }>[] | null;
  /** `missing`: the admission names a pool whose ledger row does not exist yet (`deckent init pool` provisions it). */
  readonly poolStatus: 'ready' | 'drift' | 'unavailable' | 'unconfigured' | 'missing';
  /** I-S7: whether an execution section (worker image) and an admission registry are configured; absent → the pool status alone decides. */
  readonly firstJob?: Readonly<{ execution: boolean; registry: boolean }> | null;
  readonly toolchainUpdateEnabled: boolean;
  /** PRE-34: the configured worker image (evidence when the refresh marker names no version); null when no execution section sets one. */
  readonly imageId?: string | null;
  /** BR1 1c: whether the daemon has the configured image (read-only `image inspect`); null when not checked (no image, Docker not ready). */
  readonly workerImage?: 'present' | 'missing' | 'unknown' | null;
  /** PRE-34: the execution environment as `deckent init` decides it (same detection and setup decision; read-only); null when it could not be asked. */
  readonly executionEnvironment?: ExecutionEnvironmentDoctorView | null;
  /** S6R-6: lost-worker recovery modes and the owner's standing continuation grant in this scope; null or absent when not read. */
  readonly recoveryMode?: RecoveryModeState | null;
  /** PRE-8 v2: keys this project's profiles use that cannot be read here (no grant, not declared, not stored); names only, never a value. */
  readonly secretUse?: readonly DoctorSecretUse[] | null;
}
export type DoctorSecretUse = Readonly<{ kind: 'grant-required' | 'undeclared-project-key' | 'declared-missing' | 'not-stored'; name: string }>;
/** The setup family's decision for the execution environment: its state and its reason (a `setup.execution.*` key and parameters). */
export type ExecutionEnvironmentDoctorView = Readonly<{ state: string; reason: Readonly<{ code: string; params: Readonly<Record<string, string | number>> }> }>;

/** Core secret store backends in plain words; another backend shows its id. */
function secretBackendWord(backend: string, l: Locale): string {
  if (backend === 'core.secret-store.encrypted-file@1') return t('doctor.check.secretStore.backend.encryptedFile', {}, l);
  if (backend === 'core.secret-store.file@1') return t('doctor.check.secretStore.backend.file', {}, l);
  return backend === 'core.secret-store.env@1' ? t('doctor.check.secretStore.backend.env', {}, l) : backend;
}
const row = (group: DoctorGroup, id: string, state: DoctorCheckState, text: string, next?: string, fix?: string): DoctorCheck =>
  Object.freeze({ group, id, state, text, ...(next ? { next } : {}), ...(fix ? { fix } : {}) });
const scoped = (command: string, facts: DoctorCheckFacts) => facts.scopeId ? `${command} --scope ${facts.scopeId}` : command;
const gigabytes = (mb: number) => (Math.round(mb / 102.4) / 10).toString();

function setupChecks(r: DoctorRenderInput, f: DoctorCheckFacts, l: Locale): DoctorCheck[] {
  const rows: DoctorCheck[] = [];
  const node = r.node;
  if (node) rows.push(node.status === 'supported' ? row('setup', 'setup.node', 'ok', t('doctor.check.node.ok', { version: node.version, floor: node.floor ?? '-' }, l))
    : node.status === 'unsupported' ? row('setup', 'setup.node', 'error', t('doctor.check.node.old', { version: node.version, floor: node.floor ?? '-' }, l), t('doctor.check.node.next', { floor: node.floor ?? '-' }, l))
      : row('setup', 'setup.node', 'untested', t('doctor.check.node.unknown', { version: node.version }, l)));
  rows.push(row('setup', 'setup.host', 'ok', t('doctor.check.host', { platform: r.platform, cpu: r.host.cpuCores, memory: gigabytes(r.host.totalMemMB), workers: r.host.recommendedMaxWorkers }, l)));
  if (r.startability) rows.push(r.startability.status === 'ready' ? row('setup', 'setup.startability', 'ok', t('doctor.check.startability.ok', {}, l))
    : row('setup', 'setup.startability', 'error', t('doctor.check.startability.blocked', { reason: r.startability.checks[0]?.message ?? '-' }, l), 'deckent doctor --verbose'));
  if (r.serviceConfig === 'stale') rows.push(row('setup', 'setup.service', 'warning', t('doctor.check.service.stale', {}, l), 'deckent runtime restart'));
  else if (r.serviceConfig === 'current') rows.push(row('setup', 'setup.service', 'ok', t('doctor.check.service.current', {}, l)));
  else if (r.serviceConfig === 'stopped') rows.push(row('setup', 'setup.service', 'ok', t('doctor.check.service.stopped', {}, l)));
  else if (r.serviceConfig === 'unknown') rows.push(row('setup', 'setup.service', 'untested', t('doctor.check.service.unknown', {}, l)));
  if (f.identityProfile) rows.push(f.identityProfile.state === 'selected' ? row('setup', 'setup.identity', 'ok', t('doctor.check.identity.ok', { profile: f.identityProfile.id }, l))
    : row('setup', 'setup.identity', 'warning', t('doctor.check.identity.missing', {}, l), 'deckent config set identity.profile --global'));
  const admin = r.policyAdministration;
  if (admin) rows.push(admin.recoveryRequired ? row('setup', 'setup.policy', 'error', t('doctor.check.policy.recovery', {}, l), scoped('deckent policy status', f))
    : admin.bootstrapRequired ? row('setup', 'setup.policy', 'warning', t('doctor.check.policy.bootstrap', {}, l), 'deckent init')
      : row('setup', 'setup.policy', 'ok', t('doctor.check.policy.ok', { count: admin.usableAdminCount }, l)));
  else if (admin === null) rows.push(row('setup', 'setup.policy', 'untested', t('doctor.check.policy.unavailable', {}, l)));
  const binding = r.installationBinding;
  if (binding) rows.push(binding.capability === 'source-invalid' ? row('setup', 'setup.binding', 'error', t('doctor.check.binding.invalid', {}, l), 'deckent config get installation')
    : binding.required && binding.strength !== 'machine' ? row('setup', 'setup.binding', 'error', t('doctor.check.binding.required', {}, l), 'deckent config get installation')
      : binding.capability === 'unsupported' ? row('setup', 'setup.binding', 'untested', t('doctor.check.binding.unsupported', { platform: r.platform }, l))
        : row('setup', 'setup.binding', 'ok', binding.strength === 'weak' ? t('doctor.check.binding.weak', {}, l) : t('doctor.check.binding.machine', {}, l)));
  if (r.recoveryFiles?.leftovers.length) rows.push(row('setup', 'setup.recovery', 'warning', t('doctor.check.recovery', { count: r.recoveryFiles.leftovers.length }, l), 'deckent doctor --verbose'));
  return rows;
}

function securityChecks(r: DoctorRenderInput, f: DoctorCheckFacts, l: Locale): DoctorCheck[] {
  const rows: DoctorCheck[] = [], fix = (check: string) => registry.fixes.find(entry => entry.checks.includes(check))?.id;
  const audit = r.auditIntegrity;
  if (audit) rows.push(audit.status === 'match' ? row('security', 'security.audit', 'ok', t('doctor.check.audit.ok', {}, l))
    // A new installation has no checkpoint to compare with yet: nothing to fix, nothing verified.
    : audit.status === 'unknown' && audit.reason === 'no-checkpoint-yet' ? row('security', 'security.audit', 'untested', t('doctor.check.audit.noCheckpoint', {}, l))
    : row('security', 'security.audit', audit.status === 'unknown' ? 'warning' : 'error', t('doctor.check.audit.problem', { status: renderAuditStatus(audit.status, l), reason: renderAuditReason(audit.reason, l) }, l), scoped('deckent audit verify', f), fix('security.audit')));
  const directory = r.recoveryFiles?.installationDirectory;
  if (directory) rows.push((parseInt(directory.mode, 8) & 0o077)
    ? row('security', 'security.directory', 'warning', t('doctor.check.directory.open', { mode: directory.mode }, l), `chmod 700 ${directory.path}`, fix('security.directory'))
    : row('security', 'security.directory', 'ok', t('doctor.check.directory.private', {}, l)));
  const store = r.secretStore;
  if (store) {
    const backend = secretBackendWord(store.backend, l);
    rows.push(store.status === 'ready' ? row('security', 'security.secrets', 'ok', t('doctor.check.secretStore.ok', { backend }, l))
      : row('security', 'security.secrets', 'error', t('doctor.check.secretStore.problem', { backend, code: store.code ?? store.status }, l), 'deckent secret store'));
    const missing = Object.values(store.envGuard ?? {}).some(guard => guard.code || guard.names.length);
    if (missing || store.leftover?.entries || store.leftover?.unverified?.length) rows.push(row('security', 'security.secretsLeftover', 'warning', t('doctor.check.secretStore.leftover', {}, l), 'deckent secret store'));
  }
  // PRE-8 v2: one row per key a profile uses that this project cannot read now, with the exact next command (names only).
  for (const use of f.secretUse ?? []) {
    const params = { name: use.name };
    rows.push(use.kind === 'grant-required' ? row('security', 'security.secretUse', 'warning', t('doctor.check.secretUse.grant', params, l), scoped(`deckent secret grant ${use.name}`, f))
      : use.kind === 'undeclared-project-key' ? row('security', 'security.secretUse', 'warning', t('doctor.check.secretUse.undeclared', params, l), t('doctor.check.secretUse.undeclared.next', params, l))
      : use.kind === 'declared-missing' ? row('security', 'security.secretUse', 'warning', t('doctor.check.secretUse.declaredMissing', params, l), scoped(`deckent secret set ${use.name} --project`, f))
      : row('security', 'security.secretUse', 'warning', t('doctor.check.secretUse.notStored', params, l), scoped(`deckent secret set ${use.name} --main`, f)));
  }
  if (f.backupPassphraseStored) rows.push(row('security', 'security.backupPassphrase', 'warning', t('doctor.check.backupPassphrase', {}, l), t('doctor.check.backupPassphrase.next', {}, l)));
  const self = r.shellRealm?.selfTest;
  if (self && self.status !== 'not-run') rows.push(self.status === 'ok' ? row('security', 'security.sandbox', 'ok', t('doctor.check.sandbox.ok', {}, l))
    : row('security', 'security.sandbox', 'error', t('doctor.check.sandbox.failed', {}, l), 'deckent doctor --verbose'));
  else if (r.shellRealm) rows.push(r.shellRealm.selected === 'host' ? row('security', 'security.sandbox', 'warning', t('doctor.check.sandbox.host', {}, l), 'deckent doctor --verbose')
    : row('security', 'security.sandbox', 'untested', t('doctor.check.sandbox.notRun', {}, l)));
  return rows;
}

function workChecks(r: DoctorRenderInput, f: DoctorCheckFacts, l: Locale): DoctorCheck[] {
  const rows: DoctorCheck[] = [], fix = registry.fixes.find(entry => entry.checks.includes('work.image'))?.id;
  // Not set up yet (no registry, or no ledger row): a warning naming the first missing first-job step, the same ordered list `deckent init` shows.
  const first = firstJobSteps({ execution: f.firstJob?.execution ?? true, registry: f.firstJob?.registry ?? f.poolStatus !== 'unconfigured', pool: false }, f.scopeId)[0];
  rows.push(f.poolStatus === 'ready' ? row('work', 'work.pool', 'ok', t('doctor.check.pool.ok', {}, l))
    : (f.poolStatus === 'unconfigured' || f.poolStatus === 'missing') && first ? row('work', 'work.pool', 'warning',
      f.poolStatus === 'missing' ? t('doctor.check.pool.missing', {}, l) : t('doctor.check.pool.unconfigured', {}, l), t('doctor.firstJob.next', { step: firstJobTitle(first, l), command: firstJobCommand(first) }, l))
      : row('work', 'work.pool', 'error', f.poolStatus === 'drift' ? t('doctor.check.pool.drift', {}, l) : t('doctor.check.pool.unavailable', {}, l), scoped('deckent pool status', f)));
  const image = r.imageRefresh;
  if (image && image.status !== 'unknown') rows.push(image.status === 'failed'
    ? row('work', 'work.image', 'warning', t('doctor.check.image.failed', {}, l), 'deckent toolchains update', f.toolchainUpdateEnabled ? fix : undefined)
    : row('work', 'work.image', 'ok', image.status === 'updating' ? t('doctor.check.image.updating', {}, l)
      : image.imageVersion || shortImageId(f.imageId) ? t('doctor.check.image.current', { version: image.imageVersion ?? shortImageId(f.imageId)! }, l) : t('doctor.check.image.currentUnnamed', {}, l)));
  rows.push(executionRow(f, l));
  const worker = f.workerImage && f.imageId ? { image: shortImageId(f.imageId) ?? '-' } : null;
  if (worker) rows.push(f.workerImage === 'present' ? row('work', 'work.workerImage', 'ok', t('doctor.check.workerImage.ok', worker, l))
    : f.workerImage === 'missing' ? row('work', 'work.workerImage', 'error', t('doctor.check.workerImage.missing', worker, l), 'deckent init')
      : row('work', 'work.workerImage', 'untested', t('doctor.check.workerImage.unknown', worker, l)));
  for (const finding of r.modelInvocationDelivery ?? []) rows.push(row('work', 'work.delivery', 'warning', t('doctor.check.delivery', { profile: finding.profileId, model: finding.reference.modelId }, l),
    finding.surface === 'mcp' ? 'deckent config set mcp.responseMaxBytes' : 'deckent config set service.responseMaxBytes'));
  if (f.retiringModels === null) rows.push(row('work', 'work.models', 'untested', t('doctor.check.models.unknown', {}, l)));
  else if (!f.retiringModels.length) rows.push(row('work', 'work.models', 'ok', t('doctor.check.models.ok', {}, l)));
  else for (const model of f.retiringModels) rows.push(row('work', 'work.models', 'warning', t('doctor.check.models.retiring', { model: model.modelId, channel: model.channelId, state: model.state === 'retired' ? t('doctor.check.models.state.retired', {}, l) : t('doctor.check.models.state.deprecated', {}, l), date: model.date ?? '-' }, l),
    scoped('deckent models list', f)));
  // M2: a new catalog model fails closed until a person gives it a tier and roles; shown up to the registry bound, then counted.
  const pending = f.pendingRoleModels ?? [], shown = pending.slice(0, registry.pendingRoleRowsShown);
  for (const model of shown) rows.push(row('work', 'work.modelRoles', 'warning', t('doctor.check.roles.pending', { model: terminalSafeText(model.modelId), channel: terminalSafeText(model.channelId) }, l),
    scoped(`deckent models roles set --channel ${model.channelId} --model ${model.modelId} --tier <tier> --roles <roles>`, f)));
  if (pending.length > shown.length) rows.push(row('work', 'work.modelRoles', 'warning', t('doctor.check.roles.more', { count: pending.length - shown.length }, l), scoped('deckent models roles', f)));
  // S3-3 doctor line "Brain girişi: hesap türü, dizin": which login the subscription Brain uses and whether its channel is open.
  for (const login of f.headlessLogins ?? []) {
    const dir = terminalSafeText(login.configDir), consent = login.consent.length ? login.consent.join(', ') : t('doctor.headless.none', {}, l);
    // S3-5: the realm the last passing check ran in, or that the realm itself closed the channel.
    const isolated = !login.isolation ? '' : login.isolation === 'unavailable' ? t('doctor.headless.isolationUnavailable', {}, l)
      : t('doctor.headless.isolated', { version: terminalSafeText(login.isolation.version), launcher: terminalSafeText(login.isolation.launcher) }, l);
    rows.push(login.state === 'unknown' ? row('work', 'work.brainLogin', 'untested', t('doctor.headless.loginUnknown', { dir }, l))
      : row('work', 'work.brainLogin', login.state === 'open' ? 'ok' : 'warning', t('doctor.headless.login', { method: terminalSafeText(login.authMethod ?? '-'),
        plan: login.subscriptionType ? ` (${terminalSafeText(login.subscriptionType)})` : '', dir, state: login.state === 'open' ? t('doctor.headless.open', {}, l) : t('doctor.headless.closed', {}, l), consent }, l) + isolated,
      login.state === 'open' ? undefined : scoped('deckent models connect --connection claude-cli-subscription', f)));
  }
  // S6R-6: lost-worker recovery — the protected modes and the owner's standing grant; live without the grant sends every case to a person.
  const recovery = f.recoveryMode;
  if (recovery) {
    const text = recoveryStateLines(recovery, l).join(' ');
    rows.push(recovery.recovery !== 'live' || recovery.continuation === 'automatic' ? row('work', 'work.recovery', 'ok', text)
      : recovery.continuation === 'unknown' ? row('work', 'work.recovery', 'untested', text) : row('work', 'work.recovery', 'warning', text, scoped('deckent policy grants', f)));
  }
  return rows;
}

/** The setup family's reason in the catalogs' words (the same `setup.execution.*` text `deckent init` shows); an unknown key stays visible as itself. */
function setupReasonText(key: string, params: Readonly<Record<string, string | number>>, l: Locale): string {
  const text = (MESSAGE_REGISTRY.catalogs[l] as Readonly<Record<string, string>>)[key];
  return text === undefined ? key : text.replace(/\{(\w+)\}/gu, (whole, name: string) => Object.hasOwn(params, name) ? terminalSafeText(String(params[name])) : whole);
}
/** PRE-34: Docker (the execution environment) through the same detection and decision `deckent init` uses: ready is ok; not reachable is an
 * error when work is configured to run in it, else a warning; no answer in time is "not tested". The reason text is the setup's own. */
function executionRow(f: DoctorCheckFacts, l: Locale): DoctorCheck {
  const view = f.executionEnvironment;
  if (!view) return row('work', 'work.docker', 'untested', t('doctor.check.docker.unknown', {}, l));
  const text = setupReasonText(view.reason.code, view.reason.params, l);
  if (view.state === 'done') return row('work', 'work.docker', 'ok', text);
  if (view.reason.code === 'setup.execution.unknown' || view.reason.code === 'setup.execution.unavailable') return row('work', 'work.docker', 'untested', text);
  return row('work', 'work.docker', f.firstJob?.execution ? 'error' : 'warning', text, 'deckent init');
}

function toolChecks(r: DoctorRenderInput, f: DoctorCheckFacts, l: Locale): DoctorCheck[] {
  if (!f.toolchainsRequested || !r.toolchains) return [row('tools', 'tools.toolchains', 'untested', t('doctor.check.toolchains.notRequested', {}, l), 'deckent doctor --toolchains')];
  const fix = f.toolchainUpdateEnabled ? registry.fixes.find(entry => entry.checks.includes('tools.toolchains'))?.id : undefined;
  return r.toolchains.providers.map(entry => {
    const params = { provider: entry.provider, latest: entry.latest?.version ?? '-', reason: entry.reason ?? entry.status };
    if (entry.status === 'fresh' || entry.status === 'ahead') return row('tools', 'tools.toolchains', 'ok', t('doctor.check.toolchains.fresh', params, l));
    if (entry.status === 'stale') return row('tools', 'tools.toolchains', 'warning', t('doctor.check.toolchains.stale', params, l), 'deckent toolchains update', fix);
    if (entry.status === 'unparsed' || entry.status === 'unsupported') return row('tools', 'tools.toolchains', 'warning', t('doctor.check.toolchains.unreadable', params, l), 'deckent doctor --toolchains --verbose');
    if (entry.status === 'not-admitted') return row('tools', 'tools.toolchains', 'untested', t('doctor.check.toolchains.notAdmitted', params, l));
    if (entry.status === 'disabled') return row('tools', 'tools.toolchains', 'untested', t('doctor.check.toolchains.disabled', params, l));
    return row('tools', 'tools.toolchains', 'untested', t('doctor.check.toolchains.unknown', params, l));
  });
}

/** Every doctor row in group order (pure: the same report and facts always give the same rows). */
export function doctorChecks(report: DoctorRenderInput, facts: DoctorCheckFacts, locale: Locale): readonly DoctorCheck[] {
  return Object.freeze([...setupChecks(report, facts, locale), ...securityChecks(report, facts, locale), ...workChecks(report, facts, locale), ...toolChecks(report, facts, locale)]);
}

/** The registry fixes, in order; a hard-floor item is listed so the rule is data, and is never offered. */
export const DOCTOR_FIXES: readonly Readonly<{ id: string; checks: readonly string[]; port: string; hardFloor: boolean; policyAction?: string }>[] = Object.freeze(registry.fixes);
export const DOCTOR_RETIREMENT_STATES: readonly string[] = Object.freeze(registry.retirementStates);
/** The secret NAME the scheduled backup reads. The registry key says "Name", never "secret": the S6 gate refuses a `*secret*` key with a literal-looking value in any config file, and this is a reference, not a value. */
export const DOCTOR_BACKUP_PASSPHRASE_SECRET: string = registry.backupPassphraseName;

const markWord = (state: DoctorCheckState, l: Locale) => state === 'ok' ? t('doctor.mark.ok', {}, l) : state === 'warning' ? t('doctor.mark.warning', {}, l)
  : state === 'error' ? t('doctor.mark.error', {}, l) : t('doctor.mark.untested', {}, l);
const groupWord = (group: DoctorGroup, l: Locale) => group === 'setup' ? t('doctor.group.setup', {}, l) : group === 'security' ? t('doctor.group.security', {}, l)
  : group === 'work' ? t('doctor.group.work', {}, l) : t('doctor.group.tools', {}, l);

/** "Durum: hazır · 2 uyarı": the summary line; any error row reads as needing attention. Every condition behind the JSON report's
 * `degraded` verdict is an error row, except an audit chain with no checkpoint yet (a new installation), which is "not tested". */
export function doctorSummary(checks: readonly DoctorCheck[], locale: Locale): string {
  const count = (state: DoctorCheckState) => checks.filter(check => check.state === state).length;
  const errors = count('error'), warnings = count('warning'), untested = count('untested');
  return [errors ? t('doctor.summary.attention', {}, locale) : t('doctor.summary.ready', {}, locale),
    ...(errors ? [t('doctor.summary.errors', { n: errors }, locale)] : []), ...(warnings ? [t('doctor.summary.warnings', { n: warnings }, locale)] : []),
    ...(untested ? [t('doctor.summary.untested', { n: untested }, locale)] : []), ...(!errors && !warnings ? [t('doctor.summary.clean', {}, locale)] : [])].join(' · ');
}

/** The grouped human view: summary, then each group with a word marker per row and its next step on the line below. */
export function renderDoctorChecks(checks: readonly DoctorCheck[], locale: Locale): string {
  const marks = { ok: markWord('ok', locale), warning: markWord('warning', locale), error: markWord('error', locale), untested: markWord('untested', locale) };
  const width = Math.max(...Object.values(marks).map(mark => mark.length));
  const lines = [doctorSummary(checks, locale)];
  for (const group of registry.groups as DoctorGroup[]) {
    const rows = checks.filter(check => check.group === group);
    if (!rows.length) continue;
    lines.push('', groupWord(group, locale));
    for (const check of rows) {
      lines.push(`  ${marks[check.state].padEnd(width)}  ${check.text}`);
      if (check.next) lines.push(`  ${' '.repeat(width)}  ${t('doctor.next', { step: check.next }, locale)}`);
    }
  }
  return lines.join('\n');
}
