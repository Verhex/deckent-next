import { createRequire } from 'node:module';

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly engines: { readonly node: string };
}

const manifest = createRequire(import.meta.url)('../../../../../package.json') as PackageManifest;

/** Package identity as shipped; the single source for name/version at runtime. */
export const PACKAGE_NAME: string = manifest.name;
export const PACKAGE_VERSION: string = manifest.version;

export const NODE_ENGINE_RANGE: string = manifest.engines.node;
export const DECKENT_VERSION = PACKAGE_VERSION;
