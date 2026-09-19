import { resolve } from 'node:path';
import { registerProviderConfig, readLocalOsIdentity, resolveDockerTaskProfile } from '#adapters/index.js';
import { validateInstalledProcessExitEvaluator } from '#capabilities/index.js';
import { InstallationPreviewApplication, InstallationProfileError, type InstallationPreviewChoices } from '#engine/index.js';
import { immutableJsonObjectSchema, type JsonObject } from '#domain/index.js';
import { PROJECT_CONFIG_PATH, inspectProductLayout, resolveProductLayout } from '#platform/index.js';
import { validateConfig, versionedConfig } from '#platform/index.js';

export type InstallationPreview = Awaited<ReturnType<InstallationPreviewApplication['preview']>>;

/** Pure supplied-profile preview: it neither reads installed config nor creates product paths or stores. */
export async function previewSuppliedInstallation(projectRoot: string, supplied: unknown,
  choices: Pick<InstallationPreviewChoices, 'allowShutdown'>): Promise<InstallationPreview> {
  return (await prepareSuppliedInstallation(projectRoot, supplied, choices)).preview;
}

/** Internal installer preparation; the full configuration never becomes public preview output. */
export async function prepareSuppliedInstallation(projectRoot: string, supplied: unknown,
  choices: Pick<InstallationPreviewChoices, 'allowShutdown'>, retainedConfiguration?: JsonObject) {
  registerProviderConfig();
  const identity = readLocalOsIdentity();
  const application = new InstallationPreviewApplication({
    async resolvePaths(root, authoredConfig) {
      const resolvedRoot = resolve(root);
      const config = validateConfig(versionedConfig(retainedConfiguration ?? authoredConfig)).config;
      if (retainedConfiguration && JSON.stringify(immutableJsonObjectSchema.parse(config)) !== JSON.stringify(immutableJsonObjectSchema.parse(retainedConfiguration))) {
        throw new InstallationProfileError('INSTALLATION_PROFILE_CONFIG');
      }
      const layout = resolveProductLayout({ projectRoot: resolvedRoot, bootstrapConfigPath: resolve(resolvedRoot, PROJECT_CONFIG_PATH),
        ...(config.layout.root ? { root: config.layout.root } : {}), resources: config.layout.resources });
      return { config: config as unknown as JsonObject, layout: { schemaVersion: layout.schemaVersion, revision: layout.revision, root: layout.root,
        bootstrapConfigPath: layout.bootstrapConfigPath }, paths: inspectProductLayout(layout).resources };
    },
    validateProfile(profile) {
      const resolved = resolveDockerTaskProfile(profile);
      return { imageId: resolved.options.imageId };
    },
    validateEvaluator: validateInstalledProcessExitEvaluator,
  });
  return application.prepare(projectRoot, supplied, { principal: { issuer: identity.issuer, subject: identity.subject }, allowShutdown: choices.allowShutdown });
}
