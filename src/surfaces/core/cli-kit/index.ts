export { readJsonInput, type JsonInputErrors } from './internal/json-input.js';
export type { CliBaseContext } from './internal/context.js';
export { CLI_CATALOG, HELP_GROUPS, hasCliAction, type CliCommandSpec, type CliCommandName } from './internal/command-catalog.js';
export { registerCliCommands, renderTopHelp, renderCommandHelp, cliHelpRequest, wrapHelp, type RegisteredCliCommand } from './internal/help.js';
