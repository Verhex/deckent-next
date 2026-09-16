import { createRequire } from 'node:module';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
}

const manifest = createRequire(import.meta.url)('../../package.json') as PackageManifest;

/** Package identity as shipped; the single source for name/version at runtime. */
export const PACKAGE_NAME: string = manifest.name;
export const PACKAGE_VERSION: string = manifest.version;
