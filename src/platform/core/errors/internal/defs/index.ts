import type { ErrorDefinitions } from '../definition.js';
import { cliErrors } from './cli.js';
import { clirunErrors } from './clirun.js';
import { clitaskErrors } from './clitask.js';
import { cliapprovalErrors } from './cliapproval.js';
import { clisetupErrors } from './clisetup.js';
import { cliadminErrors } from './cliadmin.js';
import { climodelsErrors } from './climodels.js';
import { clidoctorErrors } from './clidoctor.js';
import { monitorErrors } from './monitor.js';
import { setupErrors } from './setup.js';
import { securityErrors } from './security.js';
import { memoryErrors } from './memory.js';
import { agentsErrors } from './agents.js';
import { assignmentErrors } from './assignment.js';
import { headlessErrors } from './headless.js';

/** Family fragments merged after the core table, in this fixed order (alpha.48 A2); each lane writes only its own fragment file. */
export const ERROR_DEFINITION_FRAGMENTS: readonly (readonly [string, ErrorDefinitions])[] = Object.freeze([
  ['cli', cliErrors],
  ['clirun', clirunErrors],
  ['clitask', clitaskErrors],
  ['cliapproval', cliapprovalErrors],
  ['clisetup', clisetupErrors],
  ['cliadmin', cliadminErrors],
  ['climodels', climodelsErrors],
  ['clidoctor', clidoctorErrors],
  ['monitor', monitorErrors],
  ['setup', setupErrors],
  ['security', securityErrors],
  ['memory', memoryErrors],
  ['assignment', assignmentErrors],
  ['agents', agentsErrors],
  ['headless', headlessErrors],
]);
