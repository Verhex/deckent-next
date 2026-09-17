#!/usr/bin/env node
import { inspectConfiguredRun } from '#composition/core/runs/index.js';
import { pathToFileURL } from 'node:url';
import { main as runCli } from '#surfaces/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { registerProviderConfig } from '#adapters/index.js';

/** Only the composition root chooses adapters for the shipped executable. */
export function main(argv: readonly string[] = process.argv.slice(2)) {
  return runCli(argv, { initialize: registerProviderConfig, inspectInventory: inspectConfiguredInventory, inspectRun: inspectConfiguredRun });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { process.exitCode = code; });
}
