// `deckent/extensions` (ENTERPRISE-EXT-1, owner K7 = A): the one public entry through which an Enterprise, ERP or custom package layers on
// Core without editing it. Registration is open until the composition root seals the registries at the first composed entry (any SDK call,
// a CLI command, the runtime service); afterwards it is the typed `RegistryError('REGISTRY_SEALED')`. Registration grants nothing: the
// installation's configuration selects targets and backends, and policy decides every operation. The SDK entry (`deckent`) exports no
// registration function of these registries (lint-arch G-i). Inventory: tests/contracts/composition/extensions-entry.test.ts.
export { registerOperationAdapterModule, registerSecretStoreBackend } from '#adapters/index.js';
export { createSecretHelperFactory, type SecretHelperOptions } from '#adapters/index.js';
export { CORE_API_VERSION, RegistryError } from '#domain/index.js';
export { registerMcpCapabilityGroup, registerProviderSpendNoChargeCertification } from '#engine/index.js';
export type { McpCapabilityGroup } from '#domain/index.js';
export type { AdapterModuleManifest, EffectTargetRef, OperationDescriptor } from '#domain/index.js';
export { EffectTargetError, SECRET_STORE_ID_PATTERN } from '#engine/index.js';
export type { AdapterModuleRegistration, TargetAdapterFactory, TargetAdapterOptions, EffectTarget, EffectApplyRequest, SecretStore, SecretStoreContext,
  SecretStoreDescriptor, SecretStoreFactory, SecretStoreInspection } from '#engine/index.js';
export type { StandardSchemaV1 } from '#platform/index.js';

/** Runs the Core command line in this process after the caller's registrations, so a distribution's own executable (Core plus its
 * modules) serves `deckent <command>` with the same commands, policy and ledger. Loaded lazily: registering never loads the terminal UI.
 * Resolves to the process exit code. */
export async function runCli(argv: readonly string[] = process.argv.slice(2),
  options: { readonly serviceEntry?: string } = {}): Promise<number> {
  const { main } = await import('#composition/core/cli/index.js');
  // A detached service is a new process: replay the distribution executable's registrations there.
  return main(argv, options.serviceEntry ?? process.argv[1]);
}

/** Runs the distribution's stdio MCP server after its registrations. Catalog hints resolve here; execution uses the same governed
 * runtime service as Core MCP. The server SDK stays lazy until this entry is called. Accepts Core's `--project` argument. */
export async function runMcp(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { run } = await import('#composition/core/mcp/index.js');
  await run(argv);
}
