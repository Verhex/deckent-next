import { isAbsolute } from 'node:path';
import { ErrorRegistry, emit, formatValue, resolveLocale, t } from '#platform/index.js';
import type { InstallationPreview, InstallationEvidencePreview, InstallationPublicationApplication } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

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

/** Preview is deliberately non-mutating. No surface invents profile data or policy grants. */
export async function initCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1]; let profilePath: string | undefined, language: string | undefined, dockerExecutable: string | undefined;
  let proposalDigest: string | undefined, json = false, allowShutdown = false, acceptCustom = false;
  if (!['preview', 'inspect', 'apply', 'resume', '--help', '-h'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--allow-shutdown' && !allowShutdown) { allowShutdown = true; continue; }
    if (flag === '--no-color') continue;
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
  const locale = resolveLocale(language, context.env); context.onLocale?.(locale);
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
