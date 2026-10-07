#!/usr/bin/env node
// The fixture distribution's executable: Core's command line plus this package's module, registered before the first command composes Core.
import { registerOperationAdapterModule, runCli } from 'deckent/extensions';
import { overlayModule } from './module.mjs';

registerOperationAdapterModule(overlayModule);
process.exitCode = await runCli(process.argv.slice(2));
