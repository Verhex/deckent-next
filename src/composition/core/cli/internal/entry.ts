#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main as runCli } from '#surfaces/index.js';
import { registerProviderConfig } from '#adapters/index.js';

/** Only the composition root chooses adapters for the shipped executable. */
export function main(argv: readonly string[] = process.argv.slice(2)) {
  return runCli(argv, { initialize: registerProviderConfig });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { process.exitCode = code; });
}
