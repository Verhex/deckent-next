import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_DEFINITION_FRAGMENTS, ErrorRegistry, isAuthorizationRefusal, launchRefusal, mergeErrorDefinitions, PERSON_AUTHORIZATION_REFUSALS, type AuthorizationRefusal,
  type ErrorDefinition } from '../../../src/platform/index.js';
import { ENVIRONMENT_NOT_READY_CODE, ENVIRONMENT_TIMED_OUT_CODE, ENVIRONMENT_UNCERTAIN_CODE } from '../../../src/domain/index.js';
import { classifyLaunchRefusal } from '../../../src/engine/index.js';

const definition = (message: string): ErrorDefinition => ({ category: 'error', render: () => ({ message }) });

// alpha.48 A2: lanes add codes in their own family fragment; the merge refuses a code defined twice instead of letting the last one win.
describe('error registry family fragments', () => {
  it('refuses a code defined in two fragments and names the code and both sources', () => {
    expect(() => mergeErrorDefinitions([['clirun', { RUN_X: definition('one') }], ['clitask', { RUN_X: definition('two') }]]))
      .toThrow('ERROR_REGISTRY_DUPLICATE:RUN_X:clirun:clitask');
  });
  it('refuses a fragment that redefines a core code', () => {
    expect(() => mergeErrorDefinitions([['core', { CLI_USAGE: definition('core') }], ['cli', { CLI_USAGE: definition('again') }]]))
      .toThrow('ERROR_REGISTRY_DUPLICATE:CLI_USAGE:core:cli');
  });
  it('keeps disjoint codes in source order and freezes the merged table', () => {
    const merged = mergeErrorDefinitions([['core', { A_CODE: definition('a') }], ['setup', { B_CODE: definition('b') }], ['security', {}]]);
    expect(Object.keys(merged)).toEqual(['A_CODE', 'B_CODE']);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(merged['B_CODE']!.render({}, 'en').message).toBe('b');
  });
  it('registers one frozen fragment per lane family, in a fixed order, and every fragment code is a registered code', () => {
    expect(ERROR_DEFINITION_FRAGMENTS.map(([family]) => family)).toEqual(
      ['beuser', 'cli', 'clirun', 'clitask', 'cliapproval', 'clisetup', 'cliadmin', 'climodels', 'clidoctor', 'monitor', 'setup', 'security', 'memory', 'assignment', 'agents', 'agentsign', 'headless', 'agentstats', 'agentsevo', 'recovery']);
    for (const [, fragment] of ERROR_DEFINITION_FRAGMENTS) {
      expect(Object.isFrozen(fragment)).toBe(true);
      for (const code of Object.keys(fragment)) expect(ErrorRegistry.has(code)).toBe(true);
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
  it('KG3 F3: the refusal classes reproduce every inline refusal set exactly, and the launch dispositions equal the closure classifier', () => {
    const P = 'POLICY_DENIED', A = 'POLICY_APPROVAL_UNSUPPORTED', S = 'SCOPE_UNKNOWN', D = 'APPROVAL_DENIED';
    // Today's membership per site (KG3 §F3); the delivery refusals belong to none of them yet.
    const sets: readonly (readonly [readonly AuthorizationRefusal[], readonly string[]])[] = [
      [['policy-denied', 'approval-unsupported', 'approval-denied'], [P, A, D]], [['policy-denied', 'approval-unsupported', 'scope-unknown', 'approval-denied'], [P, A, S, D]],
      [['policy-denied', 'approval-unsupported', 'scope-unknown'], [P, A, S]], [['policy-denied', 'approval-unsupported'], [P, A]],
      [['policy-denied', 'approval-unsupported', 'scope-unknown', 'policy-unavailable'], [P, A, S, 'POLICY_UNAVAILABLE']],
      [['policy-denied', 'approval-unsupported', 'scope-unknown', 'authentication'], [P, A, S, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_SCOPE_DENIED']],
      [['policy-denied', 'approval-denied'], [P, D]], [['delivery'], ['DELIVERY_WORKING_TREE_DENIED', 'DELIVERY_WORKING_TREE_APPROVAL_UNSUPPORTED']]];
    for (const [include, codes] of sets) expect(ERROR_CODES.filter(code => isAuthorizationRefusal(code, { include })).sort(), include.join()).toEqual([...codes].sort());
    expect([isAuthorizationRefusal('ENTERPRISE_POLICY_DENIED', { include: ['policy-denied'] }), isAuthorizationRefusal(undefined, { include: ['policy-denied'] })]).toEqual([false, false]);
    // B2-1: the one person-facing class (owner 2026-11-09); the delivery refusals join it (traced: they reach no classifier today).
    expect(ERROR_CODES.filter(code => isAuthorizationRefusal(code, { include: PERSON_AUTHORIZATION_REFUSALS })).sort()).toEqual([P, A, S, D, 'DELIVERY_WORKING_TREE_DENIED', 'DELIVERY_WORKING_TREE_APPROVAL_UNSUPPORTED'].sort());
    // S2-e4: over every registered code, `classifyLaunchRefusal` (its private sets) agrees with the registry field; an environment refusal carries its requirement.
    const disposition = (code: string) => classifyLaunchRefusal({ code, params: { requirement: 'r', ...(code === ENVIRONMENT_UNCERTAIN_CODE ? { probe: 'p' } : {}) } }).disposition;
    expect(Object.fromEntries(ERROR_CODES.map(code => [code, disposition(code)]).filter(([, value]) => value !== 'transient')))
      .toEqual(Object.fromEntries(ERROR_CODES.flatMap(code => launchRefusal(code) ? [[code, launchRefusal(code)]] : [])));
    // The closure classifier reads the registry field, so the parity above holds by construction; the membership itself is pinned here.
    expect([ERROR_CODES.filter(code => launchRefusal(code) === 'permanent').sort(), ERROR_CODES.filter(code => launchRefusal(code) === 'held')]).toEqual([['EXECUTION_NOT_CONFIGURED',
      'EXECUTION_HOST_UNSUPPORTED', 'EXECUTION_PROFILE_INVALID', 'DISPATCH_ARTIFACT_REQUIRED', 'HUB_SKILL_FILES_UNAVAILABLE', 'WORKER_TREE_SECRET_REFUSED', 'WORKER_TREE_SCAN_INCOMPLETE',
      'PATCH_WORKING_TREE_SUBFOLDER', 'PATCH_WORKING_TREE_FILTER', 'PATCH_WORKING_TREE_GIT_VERSION', 'PATCH_WORKING_TREE_LISTING_LIMIT', 'PATCH_WORKING_TREE_UNSUPPORTED', 'PATCH_WORKING_TREE_COPY_LIMIT',
      ENVIRONMENT_NOT_READY_CODE, ENVIRONMENT_UNCERTAIN_CODE, 'SIWC_WORKER_ISOLATION_UNAVAILABLE', 'SIWC_APP_SERVER_AUTH_UNAVAILABLE'].sort(), [ENVIRONMENT_TIMED_OUT_CODE]]);
  });
});
