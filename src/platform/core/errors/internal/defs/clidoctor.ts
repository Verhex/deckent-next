import { plainErrors, type ErrorDefinitions } from '../definition.js';
/** Error codes owned by the `clidoctor` family (i18n `locales/<locale>/clidoctor.json`); texts live in that family. */
export const clidoctorErrors: ErrorDefinitions = plainErrors('error.', {
  // C-DOCTOR: `deckent terminal snapshot` without an inference_serving profile: one error with the reason and the next step (was a notice plus CLI_USAGE).
  TERMINAL_SNAPSHOT_NOT_CONFIGURED: 'usage',
});
