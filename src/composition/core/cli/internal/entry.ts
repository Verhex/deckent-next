#!/usr/bin/env node
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { startConfiguredCliRuntimeService } from './runtime-host.js';
import { pathToFileURL } from 'node:url';
import { main as runCli } from '#surfaces/index.js';
import { registerProviderConfig } from '#adapters/index.js';

/** Only the composition root chooses adapters for the shipped executable. */
export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const root = process.cwd(), runtime = createConfiguredRuntimeClient(root);
  const isRuntimeServe = argv[0] === 'runtime' && argv[1] === 'serve';
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (isRuntimeServe) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  try { return await runCli(argv, { initialize: registerProviderConfig, root, signal: controller.signal, startRuntimeService: startConfiguredCliRuntimeService,
    describeRuntimeService: (_root, options) => createConfiguredRuntimeClient(_root, options).describeService(),
    shutdownRuntimeService: (_root, command, options) => createConfiguredRuntimeClient(_root, options).shutdownService(command),
    inspectInventory: (_root, input) => runtime.inspectInventory(input),
    inspectRun: (_root, input) => runtime.inspectRun(input),
    deliverRunCancellation: (_root, input) => runtime.deliverRunCancellation(input),
    reserveRunTasks: (_root, input) => runtime.reserveRunTasks(input),
    createRun: (_root, input) => runtime.createRun(input),
    executeTask: (_root, input) => runtime.executeTask(input),
    evaluateTask: (_root, input) => runtime.evaluateTask(input),
  }); } finally { if (isRuntimeServe) { process.off('SIGINT', stop); process.off('SIGTERM', stop); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { if (process.argv[2] === 'runtime' && process.argv[3] === 'serve' && code !== 0) process.exit(code); else process.exitCode = code; });
}
