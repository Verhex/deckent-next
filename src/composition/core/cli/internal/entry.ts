#!/usr/bin/env node
import { createConfiguredRun, inspectConfiguredRun, deliverConfiguredRunCancellation, reserveConfiguredRunTasks, evaluateConfiguredTask } from '#composition/core/runs/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { pathToFileURL } from 'node:url';
import { main as runCli } from '#surfaces/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { registerProviderConfig } from '#adapters/index.js';

/** Only the composition root chooses adapters for the shipped executable. */
export function main(argv: readonly string[] = process.argv.slice(2)) {
  return runCli(argv, { initialize: registerProviderConfig, inspectInventory: inspectConfiguredInventory, inspectRun: inspectConfiguredRun,
    deliverRunCancellation: deliverConfiguredRunCancellation, reserveRunTasks: reserveConfiguredRunTasks,
    createRun: createConfiguredRun, executeTask: executeConfiguredTask, evaluateTask: evaluateConfiguredTask });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { process.exitCode = code; });
}
