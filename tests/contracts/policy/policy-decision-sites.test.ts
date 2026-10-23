import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import map from '../../fixtures/audit/policy-decision-sites.json' with { type: 'json' };

// S5 D1 (AUDITOR-MODEL 2026-10-17): every `evaluatePolicy` call site is mapped to whether its refusals are sealed, or explicitly excluded.
// A new or moved call site fails here until it is classified (and, if it gates an effect, its refusal is sealed or named as open).
const root = join(import.meta.dirname, '../../..');
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []; });

it('maps every evaluatePolicy call site in src to exactly one class', () => {
  const found: Record<string, number> = {};
  for (const path of files(join(root, 'src'))) {
    const rel = relative(root, path).replaceAll('\\', '/');
    if (rel === 'src/domain/core/policy/internal/evaluate.ts') continue;
    const count = readFileSync(path, 'utf8').split('evaluatePolicy(').length - 1;
    if (count) found[rel] = count;
  }
  expect(Object.fromEntries(Object.entries(map.sites).map(([path, site]) => [path, site.sites]))).toEqual(found);
  for (const site of Object.values(map.sites)) expect(Object.keys(map.classes)).toContain(site.class);
  // The agent tool call path (the auditor's first producer) is sealed in the policy-turn record.
  for (const path of ['src/engine/core/policy/internal/permission-mode.ts', 'src/engine/core/policy/internal/agent-tool.ts'])
    expect(map.sites[path as keyof typeof map.sites]).toMatchObject({ class: 'sealed', kind: 'policy-turn' });
});
