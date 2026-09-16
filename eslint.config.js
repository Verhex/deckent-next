// Size discipline is enforced mechanically (ADR-D-006 amendment, owner 2026-09-16):
// every file ≤ 800 lines, every function ≤ 150 lines (warning). Architecture rules
// (package direction, internal/ isolation, i18n, literals, .md write gate, budgets)
// live in scripts/lint-arch.mjs and arch.json.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'apps/**/dist/**', 'apps/**/node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'max-lines': ['error', { max: 800, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/internal/**'], message: 'internal/ modules are package-private; import the package index instead.' }] }],
    },
  },
  {
    // Inside a package, internal modules may import each other.
    files: ['src/*/internal/**/*.ts', 'src/*/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
