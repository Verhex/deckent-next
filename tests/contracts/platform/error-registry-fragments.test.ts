import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_DEFINITION_FRAGMENTS, ErrorRegistry, mergeErrorDefinitions, type ErrorDefinition } from '../../../src/platform/index.js';

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
      ['cli', 'clirun', 'clitask', 'cliapproval', 'clisetup', 'cliadmin', 'climodels', 'clidoctor', 'monitor', 'setup', 'security', 'memory', 'assignment', 'agents', 'agentsign', 'headless', 'agentstats']);
    for (const [, fragment] of ERROR_DEFINITION_FRAGMENTS) {
      expect(Object.isFrozen(fragment)).toBe(true);
      for (const code of Object.keys(fragment)) expect(ErrorRegistry.has(code)).toBe(true);
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});
