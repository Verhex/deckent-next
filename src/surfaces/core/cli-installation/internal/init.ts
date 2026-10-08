import { identityCommand } from './identity.js';
import { isAbsolute } from 'node:path';
import { ErrorRegistry, emit, formatValue, loadConfigLanguage, resolveLocale, t, terminalSafeText, type Locale } from '#platform/index.js';
import type { InstallationPreview, InstallationEvidencePreview, InstallationPublicationApplication } from '#engine/index.js';
import type { InstallationCommandContext } from './context.js';

export interface InstallationPreviewInput { readonly profilePath: string; readonly allowShutdown: boolean }
export type InstallationPreviewHandler = (projectRoot: string, input: InstallationPreviewInput) => Promise<InstallationPreview>;
export type InstallationInspectionHandler = (projectRoot: string, input: InstallationPreviewInput & { readonly dockerExecutable: string }) => Promise<InstallationEvidencePreview>;
export interface InstallationApplyInput extends InstallationPreviewInput {
  readonly profilePath: string; readonly dockerExecutable: string; readonly proposalDigest: string; readonly acceptCustom: true;
}
export interface InstallationResumeInput {
  readonly allowShutdown: boolean; readonly dockerExecutable: string; readonly proposalDigest: string; readonly acceptCustom: true;
}
export type InstallationPublicationResult = Awaited<ReturnType<InstallationPublicationApplication['apply']>>;
export type InstallationApplyHandler = (projectRoot: string, input: InstallationApplyInput) => Promise<InstallationPublicationResult>;
export type InstallationResumeHandler = (projectRoot: string, input: InstallationResumeInput) => Promise<InstallationPublicationResult>;
// SCR-B (owner 2026-09-28, checkpoint option B): a Docker/pool-free installation of just policy.json + bindings.json,
// journaled the same way as the resources above, for a fresh, terminal-only project. No supplied profile: the
// versioned default template is product-fixed (proof/SCR-B-2026-09-28/review.md), the only input is which scope
// it is granted for.
export type PolicyTemplatePreviewHandler = (projectRoot: string, scopeId: string) => Promise<unknown>;
export type PolicyTemplateApplyHandler = (projectRoot: string, scopeId: string) => Promise<unknown>;
type Person = { readonly issuer: string; readonly subject: string };
/** Owner 2026-10-07: the first-run v4 → v5 migration (`--upgrade`); `apply: false` reads only. `person` (lead 2026-10-08): the person a hand-built
 * policy's file owner names (`--person <issuer>/<subject>`). */
export type PolicyTemplateUpgradeHandler = (projectRoot: string, scopeId: string, apply: boolean, expect?: string, person?: Person) => Promise<{ readonly status: string;
  readonly reason?: string | null; readonly revision?: string | null; readonly rules?: readonly unknown[]; readonly conflicts?: readonly string[]; readonly wireRules?: readonly string[];
  readonly basis?: string | null; readonly person?: Person | null; readonly people?: readonly Person[] }>;
/** `<issuer>/<subject>`, split at the last `/` (an issuer may itself contain one); both parts non-empty. Identity rules are the engine's. */
function parsePerson(value: string | undefined): Person {
  const at = value?.lastIndexOf('/') ?? -1;
  if (!value || value.startsWith('-') || at <= 0 || at === value.length - 1) throw ErrorRegistry.createError('CLI_USAGE');
  return { issuer: value.slice(0, at), subject: value.slice(at + 1) };
}

/** Preview is deliberately non-mutating. No surface invents profile data or policy grants. */
export async function initCommand(argv: readonly string[], context: InstallationCommandContext): Promise<void> {
  if (argv[1] === 'identity') return identityCommand(argv, context);
  const action = argv[1]; let profilePath: string | undefined, language: string | undefined, dockerExecutable: string | undefined;
  let proposalDigest: string | undefined, json = false, allowShutdown = false, acceptCustom = false;
  let scopeId: string | undefined, policyPreview = false, policyApply = false, policyUpgrade = false, expect: string | undefined, person: Person | undefined;
  if (!['preview', 'inspect', 'apply', 'resume', 'policy', '--help', '-h'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--allow-shutdown' && !allowShutdown) { allowShutdown = true; continue; }
    if (flag === '--no-color') continue;
    if (flag === '--preview' && action === 'policy' && !policyPreview && !policyApply) { policyPreview = true; continue; }
    if (flag === '--apply' && action === 'policy' && !policyApply && !policyPreview) { policyApply = true; continue; }
    if (flag === '--upgrade' && action === 'policy' && !policyUpgrade) { policyUpgrade = true; continue; }
    if (flag === '--expect' && action === 'policy' && expect === undefined) {
      expect = argv[++i];
      if (!expect || expect.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    if (flag === '--person' && action === 'policy' && person === undefined) { person = parsePerson(argv[++i]); continue; }
    if (flag === '--scope' && action === 'policy' && scopeId === undefined) {
      scopeId = argv[++i];
      if (!scopeId || scopeId.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    if (flag === '--docker-executable' && ['inspect', 'apply', 'resume'].includes(action ?? '') && dockerExecutable === undefined) {
      dockerExecutable = argv[++i];
      if (!dockerExecutable || dockerExecutable.startsWith('-') || !isAbsolute(dockerExecutable)) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    if (flag === '--proposal' && ['apply', 'resume'].includes(action ?? '') && proposalDigest === undefined) {
      proposalDigest = argv[++i];
      if (!proposalDigest || !/^[a-f0-9]{64}$/.test(proposalDigest)) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    if (flag === '--accept-custom' && ['apply', 'resume'].includes(action ?? '') && !acceptCustom) { acceptCustom = true; continue; }
    if (flag === '--profile' && action !== 'resume' && profilePath === undefined) {
      profilePath = argv[++i];
      if (!profilePath || profilePath.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    if (flag === '--lang' && language === undefined) {
      language = argv[++i];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      continue;
    }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const locale = resolveLocale(language, context.env, policyUpgrade && language === undefined
    ? await loadConfigLanguage(context.root, { ...(context.env ? { env: context.env } : {}) }) : undefined); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === '--help' || action === '-h') {
    if (profilePath || dockerExecutable || proposalDigest || acceptCustom || allowShutdown || json) throw ErrorRegistry.createError('CLI_USAGE');
    emit(t('cli.help.initPreview', {}, locale), sinks); return;
  }
  const root = context.root ?? process.cwd();
  if (action === 'resume') {
    if (!dockerExecutable || !proposalDigest || !acceptCustom || !context.resumeInstallation) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.resumeInstallation(root, { allowShutdown, dockerExecutable, proposalDigest, acceptCustom: true });
    emit(result, { ...sinks, json, render: value => `${t('cli.init.applied', {}, locale)}\n${formatValue(value)}` });
    return;
  }
  if (action === 'policy') {
    if ((expect !== undefined || person !== undefined) && !policyUpgrade) throw ErrorRegistry.createError('CLI_USAGE');
    if (!scopeId || policyPreview === policyApply || profilePath || dockerExecutable || proposalDigest || acceptCustom || allowShutdown) {
      throw ErrorRegistry.createError('CLI_USAGE');
    }
    if (policyUpgrade) {
      if (!context.upgradePolicyTemplateInstallation || (expect !== undefined && !policyApply)) throw ErrorRegistry.createError('CLI_USAGE');
      const result = await context.upgradePolicyTemplateInstallation(root, scopeId, policyApply, expect, ...(person === undefined ? [] : [person]));
      emit(result, { ...sinks, json, render: value => policyUpgradeText(value, scopeId!, locale) });
      return;
    }
    if (policyApply) {
      if (!context.applyPolicyTemplateInstallation) throw ErrorRegistry.createError('CLI_USAGE');
      const result = await context.applyPolicyTemplateInstallation(root, scopeId);
      emit(result, { ...sinks, json, render: value => formatValue(value) });
      return;
    }
    if (!context.previewPolicyTemplateInstallation) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.previewPolicyTemplateInstallation(root, scopeId);
    emit(result, { ...sinks, json, render: value => formatValue(value) });
    return;
  }
  if (!profilePath) throw ErrorRegistry.createError('INSTALL_PROFILE_REQUIRED');
  if (action === 'apply') {
    if (!dockerExecutable || !proposalDigest || !acceptCustom || !context.applyInstallation) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.applyInstallation(root, { profilePath, allowShutdown, dockerExecutable, proposalDigest, acceptCustom: true });
    emit(result, { ...sinks, json, render: value => `${t('cli.init.applied', {}, locale)}\n${formatValue(value)}` });
    return;
  }
  if (action === 'inspect') {
    if (!dockerExecutable) throw ErrorRegistry.createError('INSTALL_INSPECTION_CONTROL_REQUIRED');
    if (!context.inspectInstallation) throw ErrorRegistry.createError('INSTALL_INSPECTION_UNAVAILABLE');
    const result = await context.inspectInstallation(root, { profilePath, allowShutdown, dockerExecutable });
    emit(result, { ...sinks, json, render: value => `${t('cli.init.evidenceOnly', {}, locale)}\n${formatValue(value)}` });
    return;
  }
  if (!context.previewInstallation) throw ErrorRegistry.createError('INSTALL_PREVIEW_UNAVAILABLE');
  const result = await context.previewInstallation(root, { profilePath, allowShutdown });
  emit(result, { ...sinks, json, render: value => `${t('cli.init.previewOnly', {}, locale)}\n${formatValue(value)}` });
}

/** `init policy --upgrade` in the person's words: what happened, the exact next command, the rules added, and what is kept as it is. */
function policyUpgradeText(value: Awaited<ReturnType<PolicyTemplateUpgradeHandler>>, scope: string, locale: Locale): string {
  const revision = value.revision ?? '-', who = (item: Person) => terminalSafeText(`${item.issuer}/${item.subject}`), named = value.person ? who(value.person) : '-';
  // The next command repeats `--person` whenever it was given: without it the apply could be refused or name another person.
  const person = value.person ? ` --person ${named}` : '', handBuilt = value.basis === 'named-person';
  const people = (value.people ?? []).map(who).join(', ') || '-';
  const head = value.status === 'preview' ? handBuilt ? t('cli.init.policyUpgrade.previewPerson', { scope, revision, person }, locale) : t('cli.init.policyUpgrade.preview', { scope, revision, person }, locale)
    : value.status === 'upgraded' ? handBuilt ? t('cli.init.policyUpgrade.upgradedPerson', {}, locale) : t('cli.init.policyUpgrade.upgraded', {}, locale)
    : value.status === 'current' ? handBuilt ? t('cli.init.policyUpgrade.currentPerson', {}, locale) : t('cli.init.policyUpgrade.current', {}, locale)
    : value.status === 'conflict' ? t('cli.init.policyUpgrade.conflict', { revision }, locale)
    : value.reason === 'not-owner' ? t('cli.init.policyUpgrade.notOwner', { scope }, locale)
    : value.reason === 'not-first-run' ? t('cli.init.policyUpgrade.handBuilt', { scope, people }, locale)
    : value.reason === 'person-not-named' ? t('cli.init.policyUpgrade.personNotNamed', { scope, person: named, people }, locale)
    : t('cli.init.policyUpgrade.unavailable', {}, locale);
  const rules = (value.rules ?? []).map(rule => { const grant = rule as { id?: string; resource?: { kind?: string; ids?: unknown } };
    return `  + ${grant.id ?? '-'}: ${grant.resource?.kind ?? '-'} ${Array.isArray(grant.resource?.ids) ? grant.resource!.ids.join(', ') : '*'}`; });
  const kept = (value.conflicts ?? []).length ? [t('cli.init.policyUpgrade.conflicts', { ids: value.conflicts!.join(', ') }, locale)] : [];
  const wire = (value.wireRules ?? []).length ? [t('cli.init.policyUpgrade.wireRules', { ids: value.wireRules!.join(', ') }, locale)] : [];
  return [head, ...rules, ...kept, ...wire].join('\n');
}
