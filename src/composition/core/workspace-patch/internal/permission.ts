import { resolve } from 'node:path';
import { ErrorRegistry, isCodedError, automationMarker, getConfigFieldDefault, GIT_EXECUTION_SETTINGS, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, detectCodingFacts, inspectGitDeliveryDirectory, prepareAttachmentDirectory, resolveGitWorkTarget } from '#adapters/index.js';
import { assertAuthorityWitness, WorkspacePatchError } from '#engine/index.js';
/** Local UI preflight only: no ledger, policy, protocol operation or automatic permission change. */
export async function configuredGitDeliveryPermission(root: string, options: ConfigLoadOptions, confirm?: (path: string, before: string, after: string, command: string) => Promise<boolean>) {
  const config = await loadConfig(root, { ...options, heal: false });
  const executable = config.execution?.git.gitExecutable ?? (await detectCodingFacts({ root, env: options.env ?? process.env })).gitPath;
  if (!executable) return null;
  const git = config.execution?.git ?? GIT_EXECUTION_SETTINGS.parse({ gitExecutable: executable });
  const source = await resolveGitWorkTarget(resolve(root), config.execution, config.productLayout);
  const settings = { ...git, ...source.git, workspaceRoot: source.git.sourceRoot };
  let directory = '';
  const inspect = async () => {
    try { await inspectGitDeliveryDirectory(settings, path => { directory = path; }); return null; }
    catch (error) {
      if (error instanceof WorkspacePatchError && error.params?.['reason'] === 'git-directory-write') {
        const { path, command, before, after } = error.params;
        return { path: String(path), command: String(command), before: String(before), after: String(after) };
      }
      return null; // Warning only: other causes retain their own delivery refusal.
    }
  };
  const warning = await inspect();
  if (!warning || !confirm) return warning;
  const markers = (config['cli'] as { agentEnvironment: readonly string[] } | undefined)?.agentEnvironment ?? getConfigFieldDefault('cli').agentEnvironment;
  const authorize = async () => {
    await assertAuthorityWitness('git-directory-permission', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), { attest: async () =>
      !automationMarker(process.env, markers) && !automationMarker(options.env ?? process.env, markers) && await attestLocalInteractiveTerminal() });
    let current = '';
    await inspectGitDeliveryDirectory(settings, path => { current = path; }).catch(error => {
      if (!(error instanceof WorkspacePatchError) || error.params?.['reason'] !== 'git-directory-write') throw error;
    });
    if (current !== directory) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED');
  };
  let declined = false;
  try {
    await prepareAttachmentDirectory(directory, authorize,
      async () => { const yes = await confirm(warning.path, warning.before, warning.after, warning.command); declined = !yes; return yes; });
  } catch (error) {
    if (declined) throw ErrorRegistry.createError('PATCH_UNSAFE', { params: { ...warning, reason: 'git-directory-declined' } });
    if (isCodedError(error, 'PROJECT_ATTACHMENT_DENIED') && error.params?.['path'] === directory) throw ErrorRegistry.createError(error.code, { params: { ...error.params, path: warning.path } });
    throw error;
  }
  await inspectGitDeliveryDirectory(settings);
  return null;
}
