import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { measureInstalledPackage, probeDockerImageAvailability, registerProviderConfig } from '#adapters/index.js';
import { InstallationEvidenceApplication, InstallationProfileError, type PreparedInstallation } from '#engine/index.js';
import { getConfigFieldDefault, validateConfig, versionedConfig } from '#platform/index.js';
import { prepareSuppliedInstallation } from './preview.js';

/** The package root comes from the running module, never from supplied profile paths. */
export async function inspectSuppliedInstallation(projectRoot: string, supplied: unknown,
  choices: { readonly allowShutdown: boolean; readonly dockerExecutable: string }) {
  if (!choices || typeof choices.allowShutdown !== 'boolean' || typeof choices.dockerExecutable !== 'string') {
    throw new InstallationProfileError('INSTALLATION_PROFILE_CONFIG');
  }
  const operator = { ...choices };
  const prepared = await prepareSuppliedInstallation(projectRoot, supplied, { allowShutdown: operator.allowShutdown });
  return inspectPreparedInstallation(prepared, operator.dockerExecutable);
}

/** The installer reuses its exact normalized snapshot instead of consulting mutable defaults again. */
export async function inspectPreparedInstallation(prepared: PreparedInstallation, dockerExecutable: string) {
  registerProviderConfig();
  if (typeof dockerExecutable !== 'string' || !isAbsolute(dockerExecutable)) throw new InstallationProfileError('INSTALLATION_PROFILE_CONFIG');
  const config = validateConfig(versionedConfig(prepared.material.configuration)).config;
  const control = config.execution?.docker;
  if (!control || control.executable !== dockerExecutable) throw new InstallationProfileError('INSTALLATION_PROFILE_CONFIG');
  const host = getConfigFieldDefault('installation');
  const packageLimits = Object.fromEntries(Object.entries(host.packageMeasurement)
    .map(([key, cap]) => [key, Math.min(cap, config.installation.packageMeasurement[key as keyof typeof host.packageMeasurement])])) as typeof host.packageMeasurement;
  const packageRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  return new InstallationEvidenceApplication({
    preview: async () => prepared.preview,
    async measurePackage() {
      const measured = await measureInstalledPackage(packageRoot, packageLimits);
      return { name: measured.packageName, version: measured.packageVersion, measurementDigest: measured.measurementDigest,
        fileCount: measured.files.length, totalBytes: measured.files.reduce((sum, file) => sum + file.size, 0),
        missingDeclarations: measured.declaredMissing, source: measured.origin, dependencyCoverage: measured.dependencyCoverage };
    },
    inspectImage: imageId => probeDockerImageAvailability({ executable: dockerExecutable,
      timeoutMs: Math.min(host.imageProbe.timeoutMs, config.installation.imageProbe.timeoutMs, control.controlTimeoutMs),
      outputBytes: Math.min(host.imageProbe.outputBytes, config.installation.imageProbe.outputBytes, control.outputBytes), imageId }),
  }).inspect();
}
